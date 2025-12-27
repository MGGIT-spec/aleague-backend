// A-League backend (fixtures + results + simple goals model + synthetic odds)
// Deploy on Render. No Betfair needed yet.
//
// Data source: FixtureDownload JSON feeds (updated ~daily; schema can change).
// See: https://fixturedownload.com/ (export -> JSON feed)
//
// Endpoints:
//   GET /health
//   GET /api/fixtures?days=14&limit=20
//   GET /api/value?days=14&limit=20&odds=synthetic&min_sample=1&min_ev=0.02&min_p=0.10
//
// Notes:
// - odds=synthetic gives "book-like" odds so you can test EV workflow now.
// - odds=live is a placeholder (Betfair later).

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ------------ CONFIG ------------
const BRISBANE_TZ = "Australia/Brisbane";
const COMMISSION = 0.05; // used client-side too
const MAX_GOALS = 8; // scoreline grid cap for probabilities

// Seasons to use for training (results included in feeds)
const SEASON_FEEDS = [
  { season: "2022/23", url: "https://fixturedownload.com/feed/json/aleague-2022" },
  { season: "2023/24", url: "https://fixturedownload.com/feed/json/aleague-men-2023" },
  { season: "2024/25", url: "https://fixturedownload.com/feed/json/aleague-men-2024" },
  { season: "2025/26", url: "https://fixturedownload.com/feed/json/aleague-men-2025" }
];

// Cache intervals
const FIXTURE_CACHE_MS = 6 * 60 * 60 * 1000;     // 6h
const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;       // 6h

// ------------ UTIL ------------
function pick(obj, keys, fallback = null) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

function parseDateFlexible(v) {
  if (!v) return null;

  // ISO, RFC, etc.
  const asDate = new Date(v);
  if (!isNaN(asDate.getTime())) return asDate;

  const s = String(v).trim();

  // dd/mm/yyyy or dd/mm/yyyy hh:mm
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]) - 1;
    const yyyy = Number(m[3]);
    const hh = m[4] ? Number(m[4]) : 0;
    const min = m[5] ? Number(m[5]) : 0;
    return new Date(Date.UTC(yyyy, mm, dd, hh, min, 0));
  }

  return null;
}

function formatKickoffLocal(dateObj) {
  if (!dateObj) return "TBC";
  return dateObj.toLocaleString("en-AU", {
    timeZone: BRISBANE_TZ,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function poissonP(k, lam) {
  // stable enough for k<=8
  let fact = 1;
  for (let i=2;i<=k;i++) fact*=i;
  return Math.exp(-lam) * Math.pow(lam, k) / fact;
}

// ------------ FETCH + CACHE ------------
let feedCache = { byUrl: new Map() };
let modelCache = { ts: 0, model: null };

async function loadFeed(url) {
  const now = Date.now();
  const cached = feedCache.byUrl.get(url);
  if (cached && (now - cached.ts) < FIXTURE_CACHE_MS) return cached.data;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`feed fetch failed ${url} HTTP ${r.status}`);
  const json = await r.json();
  const rows = Array.isArray(json) ? json : (json?.data || json?.matches || json?.fixtures || []);

  feedCache.byUrl.set(url, { ts: now, data: rows });
  return rows;
}

function parseScore(resultStr) {
  if (!resultStr) return null;
  const m = String(resultStr).match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return null;
  return { hg: Number(m[1]), ag: Number(m[2]) };
}

function rowToUnified(row, seasonLabel) {
  const home = pick(row, ["Home Team","HomeTeam","homeTeam","home","Home"]);
  const away = pick(row, ["Away Team","AwayTeam","awayTeam","away","Away"]);
  const location = pick(row, ["Location","Venue","venue","stadium"], "");
  const round = pick(row, ["Round Number","RoundNumber","round","matchday"], "");
  const rawDate = pick(row, ["Date","date","Kickoff","kickoff","Start","start_time"], null);
  const dt = parseDateFlexible(rawDate);
  const res = parseScore(pick(row, ["Result","result","Score","score"], null));

  return {
    season: seasonLabel,
    round: round ? String(round) : "",
    location,
    home: home || "TBD",
    away: away || "TBD",
    kickoffISO: dt ? dt.toISOString() : null,
    kickoffLocal: formatKickoffLocal(dt),
    hg: res ? res.hg : null,
    ag: res ? res.ag : null
  };
}

async function loadAllSeasonsUnified() {
  const all = [];
  for (const s of SEASON_FEEDS) {
    const rows = await loadFeed(s.url);
    for (const r of rows) all.push(rowToUnified(r, s.season));
  }
  return all;
}

// ------------ MODEL (Poisson attack/defence with time-decay) ------------
function buildModelFromMatches(matches, { halfLifeDays = 240, minGamesPerTeam = 6 } = {}) {
  const played = matches.filter(m => m.kickoffISO && m.hg != null && m.ag != null);
  const teamsSet = new Set();
  for (const m of played) { teamsSet.add(m.home); teamsSet.add(m.away); }
  const teams = [...teamsSet].sort();
  const idx = new Map(teams.map((t,i)=>[t,i]));
  const n = teams.length;
  if (n === 0) return null;

  const games = new Array(n).fill(0);
  for (const m of played) {
    games[idx.get(m.home)]++;
    games[idx.get(m.away)]++;
  }

  let att = new Array(n).fill(0);
  let def = new Array(n).fill(0);
  let ha = 0.12;

  const now = Date.now();
  const lam = Math.log(2) / (halfLifeDays * 24 * 3600 * 1000);

  const iters = 220;
  const lr = 0.035;

  for (let it=0; it<iters; it++) {
    const gAtt = new Array(n).fill(0);
    const gDef = new Array(n).fill(0);
    let gHa = 0;

    for (const m of played) {
      const iH = idx.get(m.home);
      const iA = idx.get(m.away);

      const t = new Date(m.kickoffISO).getTime();
      const w = Math.exp(-lam * Math.max(0, now - t));

      const muH = Math.exp(ha + att[iH] + def[iA]);
      const muA = Math.exp(att[iA] + def[iH]);

      const eH = (m.hg - muH) * w;
      const eA = (m.ag - muA) * w;

      gHa += eH;

      gAtt[iH] += eH;
      gDef[iA] += eH;

      gAtt[iA] += eA;
      gDef[iH] += eA;
    }

    for (let i=0;i<n;i++){
      att[i] += lr * gAtt[i];
      def[i] += lr * gDef[i];
    }
    ha += lr * gHa;

    const meanAtt = att.reduce((a,b)=>a+b,0)/n;
    const meanDef = def.reduce((a,b)=>a+b,0)/n;
    for (let i=0;i<n;i++){
      att[i] -= meanAtt;
      def[i] -= meanDef;
    }

    ha = clamp(ha, -0.25, 0.45);
    for (let i=0;i<n;i++){
      att[i] = clamp(att[i], -1.2, 1.2);
      def[i] = clamp(def[i], -1.2, 1.2);
    }
  }

  const teamMeta = {};
  for (let i=0;i<n;i++){
    teamMeta[teams[i]] = { games: games[i], att: att[i], def: def[i] };
  }

  return { teams, idx, att, def, ha, halfLifeDays, minGamesPerTeam, teamMeta };
}

function matchProbs(model, home, away) {
  if (!model || !model.idx.has(home) || !model.idx.has(away)) {
    return {
      muH: 1.45, muA: 1.30,
      p1x2: { H: 0.40, D: 0.27, A: 0.33 },
      pOver25: 0.56,
      pOver35: 0.33,
      okSample: false
    };
  }

  const iH = model.idx.get(home);
  const iA = model.idx.get(away);

  const muH = Math.exp(model.ha + model.att[iH] + model.def[iA]);
  const muA = Math.exp(model.att[iA] + model.def[iH]);

  let pH=0, pD=0, pA=0;
  let pOver25=0, pOver35=0;

  for (let hg=0; hg<=MAX_GOALS; hg++){
    const ph = poissonP(hg, muH);
    for (let ag=0; ag<=MAX_GOALS; ag++){
      const pa = poissonP(ag, muA);
      const p = ph * pa;

      if (hg>ag) pH += p;
      else if (hg===ag) pD += p;
      else pA += p;

      const tg = hg+ag;
      if (tg >= 3) pOver25 += p;
      if (tg >= 4) pOver35 += p;
    }
  }

  const s = pH+pD+pA;
  if (s > 0){
    pH/=s; pD/=s; pA/=s;
    pOver25/=s;
    pOver35/=s;
  }

  const okSample =
    (model.teamMeta[home]?.games || 0) >= model.minGamesPerTeam &&
    (model.teamMeta[away]?.games || 0) >= model.minGamesPerTeam;

  return { muH, muA, p1x2:{H:pH,D:pD,A:pA}, pOver25, pOver35, okSample };
}

// ------------ SYNTHETIC ODDS ------------
function synthOdds1x2(pH, pD, pA, margin = 0.055) {
  const sum = pH+pD+pA;
  if (sum <= 0) return { H: null, D: null, A: null };
  pH/=sum; pD/=sum; pA/=sum;

  const qH = pH*(1+margin);
  const qD = pD*(1+margin);
  const qA = pA*(1+margin);

  return { H: 1/qH, D: 1/qD, A: 1/qA };
}
function synthOddsBinary(p, margin = 0.05) {
  const q = clamp(p*(1+margin), 0.02, 0.98);
  return 1 / q;
}

// ------------ SHAPE FOR UI ------------
function toUiMatch(base, probs, oddsMode) {
  const fixtureId = (base.kickoffISO || "") + "|" + base.home + "|" + base.away;

  const p = probs.p1x2;
  const probOver25 = probs.pOver25;
  const probOver35 = probs.pOver35;

  let odds1x2 = { H: null, D: null, A: null };
  let oddsOver25 = null;
  let oddsOver35 = null;

  if (oddsMode === "synthetic") {
    odds1x2 = synthOdds1x2(p.H, p.D, p.A, 0.055);
    oddsOver25 = synthOddsBinary(probOver25, 0.05);
    oddsOver35 = synthOddsBinary(probOver35, 0.05);
  }

  return {
    fixtureId,
    league: `A-LEAGUE (MEN)${base.round ? ` • Round ${base.round}` : ""}${base.location ? ` • ${base.location}` : ""}`,
    kickoffLocal: base.kickoffLocal,
    kickoffISO: base.kickoffISO,
    home: base.home,
    away: base.away,
    model: { muH: probs.muH, muA: probs.muA, okSample: probs.okSample },
    markets: {
      "1x2": { probs: p, odds: odds1x2 },
      "ou25": { line: 2.5, probOver: probOver25, oddsOver: oddsOver25 },
      "ou35": { line: 3.5, probOver: probOver35, oddsOver: oddsOver35 }
    }
  };
}

// ------------ MODEL CACHE WRAPPER ------------
async function getModel() {
  const now = Date.now();
  if (modelCache.model && (now - modelCache.ts) < MODEL_CACHE_MS) return modelCache.model;

  const all = await loadAllSeasonsUnified();
  const model = buildModelFromMatches(all, { halfLifeDays: 240, minGamesPerTeam: 6 });

  modelCache = { ts: now, model };
  return model;
}

// ------------ ROUTES ------------
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get("/api/fixtures", async (req, res) => {
  try{
    const days = clamp(Number(req.query.days || 14), 1, 90);
    const limit = clamp(Number(req.query.limit || 30), 1, 200);

    const all = await loadAllSeasonsUnified();
    const latestSeason = all.filter(m => m.season === "2025/26");

    const now = Date.now();
    const horizon = now + days*24*3600*1000;

    const upcoming = latestSeason
      .filter(m => m.kickoffISO && new Date(m.kickoffISO).getTime() >= (now - 2*3600*1000) && new Date(m.kickoffISO).getTime() <= horizon)
      .sort((a,b)=> new Date(a.kickoffISO).getTime() - new Date(b.kickoffISO).getTime())
      .slice(0, limit);

    res.json({ days, limit, count: upcoming.length, matches: upcoming });
  }catch(e){
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/api/value", async (req, res) => {
  try{
    const days = clamp(Number(req.query.days || 14), 1, 90);
    const limit = clamp(Number(req.query.limit || 20), 1, 200);
    const minEv = clamp(Number(req.query.min_ev || 0), 0, 10);
    const minP = clamp(Number(req.query.min_p || 0), 0, 1);
    const minSample = String(req.query.min_sample || "1") === "1";
    const oddsMode = String(req.query.odds || "synthetic"); // synthetic|live

    const model = await getModel();
    const all = await loadAllSeasonsUnified();
    const latestSeason = all.filter(m => m.season === "2025/26");

    const now = Date.now();
    const horizon = now + days*24*3600*1000;

    const upcoming = latestSeason
      .filter(m => m.kickoffISO && new Date(m.kickoffISO).getTime() >= (now - 2*3600*1000) && new Date(m.kickoffISO).getTime() <= horizon)
      .sort((a,b)=> new Date(a.kickoffISO).getTime() - new Date(b.kickoffISO).getTime())
      .slice(0, limit);

    const ui = upcoming.map(m => {
      const probs = matchProbs(model, m.home, m.away);
      return toUiMatch(m, probs, oddsMode);
    });

    const filtered = ui.filter(m => {
      const ok = !minSample || (m.model?.okSample === true);
      if (!ok) return false;

      if (minEv <= 0 && minP <= 0) return true;

      const cands = [];
      const p = m.markets["1x2"].probs;
      const o = m.markets["1x2"].odds;
      cands.push({p:p.H,odds:o.H}); cands.push({p:p.D,odds:o.D}); cands.push({p:p.A,odds:o.A});
      cands.push({p:m.markets["ou25"].probOver, odds:m.markets["ou25"].oddsOver});
      cands.push({p:m.markets["ou35"].probOver, odds:m.markets["ou35"].oddsOver});

      const any = cands.some(x => x.p != null && x.odds != null && (x.p >= minP) && (x.p*(x.odds-1)*(1-COMMISSION) - (1-x.p) >= minEv));
      return any;
    });

    res.json({
      meta: {
        model: model ? `Poisson+TimeDecay (HL ${model.halfLifeDays}d)` : "neutral",
        odds: oddsMode === "synthetic" ? "synthetic" : "live (placeholder)",
        minGamesPerTeam: model?.minGamesPerTeam || 0
      },
      matches: filtered
    });

  }catch(e){
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log("Server running on", PORT));
