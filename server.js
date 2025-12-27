// A-League backend (FULL FILE) — FIXED for FixtureDownload JSON schema
// Key fixes:
//  - Supports DateUtc format: "2025-10-17 08:00:00Z"
//  - Supports HomeTeamScore / AwayTeamScore (played matches)
// Endpoints:
//  - /health
//  - /api/seasons
//  - /api/fixtures
//  - /api/value
//  - /api/teams
//  - /api/backtest (season=auto)

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ------------ CONFIG ------------
const BRISBANE_TZ = "Australia/Brisbane";
const COMMISSION = 0.05;
const MAX_GOALS = 8;

const SEASON_FEEDS = [
  { season: "2022/23", url: "https://fixturedownload.com/feed/json/aleague-2022" },
  { season: "2023/24", url: "https://fixturedownload.com/feed/json/aleague-men-2023" },
  { season: "2024/25", url: "https://fixturedownload.com/feed/json/aleague-men-2024" },
  { season: "2025/26", url: "https://fixturedownload.com/feed/json/aleague-men-2025" }
];

const FIXTURE_CACHE_MS = 6 * 60 * 60 * 1000;
const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;

// ------------ UTIL ------------
function pick(obj, keys, fallback = null) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

function parseDateFlexible(v) {
  if (!v) return null;

  // Handle FixtureDownload "2025-10-17 08:00:00Z"
  if (typeof v === "string" && v.includes(" ") && v.endsWith("Z") && !v.includes("T")) {
    const isoish = v.replace(" ", "T");
    const d = new Date(isoish);
    if (!isNaN(d.getTime())) return d;
  }

  const asDate = new Date(v);
  if (!isNaN(asDate.getTime())) return asDate;

  // fallback dd/mm/yyyy
  const s = String(v).trim();
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

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function poissonP(k, lam) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return Math.exp(-lam) * Math.pow(lam, k) / fact;
}

function logSafe(x) {
  return Math.log(clamp(x, 1e-12, 1 - 1e-12));
}

// legacy string score parser (kept for compatibility)
function parseScore(resultStr) {
  if (!resultStr) return null;
  const s = String(resultStr).trim();
  if (s === "-" || s === "–" || s === "—") return null;
  const m = s.match(/(\d+)\s*[-–—:]\s*(\d+)/);
  if (!m) return null;
  return { hg: Number(m[1]), ag: Number(m[2]) };
}

// ------------ FETCH + CACHE ------------
let feedCache = { byUrl: new Map() };
let modelCache = { ts: 0, key: "", model: null };

async function loadFeed(url) {
  const now = Date.now();
  const cached = feedCache.byUrl.get(url);
  if (cached && (now - cached.ts) < FIXTURE_CACHE_MS) return cached.data;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`feed fetch failed ${url} HTTP ${r.status}`);
  const json = await r.json();

  // FixtureDownload typically returns an array at root
  const rows = Array.isArray(json) ? json : (json?.data || json?.matches || json?.fixtures || []);

  feedCache.byUrl.set(url, { ts: now, data: rows });
  return rows;
}

function rowToUnified(row, seasonLabel) {
  const home = pick(row, ["HomeTeam", "Home Team", "HomeTeamName", "HomeTeamShort", "Home"]);
  const away = pick(row, ["AwayTeam", "Away Team", "AwayTeamName", "AwayTeamShort", "Away"]);
  const location = pick(row, ["Location", "Venue", "venue", "stadium"], "");
  const round = pick(row, ["RoundNumber", "Round Number", "Round", "matchday"], "");

  // ✅ FixtureDownload uses DateUtc
  const rawDate = pick(row, ["DateUtc", "DateUTC", "Date", "date", "Kickoff", "kickoff", "Start", "start_time"], null);
  const dt = parseDateFlexible(rawDate);

  // ✅ FixtureDownload uses HomeTeamScore / AwayTeamScore
  const hs = pick(row, ["HomeTeamScore", "HomeScore", "homeScore", "home_score"], null);
  const as = pick(row, ["AwayTeamScore", "AwayScore", "awayScore", "away_score"], null);

  let hg = (hs === null || hs === "" ? null : Number(hs));
  let ag = (as === null || as === "" ? null : Number(as));

  if (!Number.isFinite(hg)) hg = null;
  if (!Number.isFinite(ag)) ag = null;

  // fallback if a feed uses Result string instead
  if (hg == null || ag == null) {
    const res = parseScore(pick(row, ["Result", "result", "Score", "score"], null));
    hg = res ? res.hg : hg;
    ag = res ? res.ag : ag;
  }

  return {
    season: seasonLabel,
    round: round ? String(round) : "",
    location,
    home: home || "TBD",
    away: away || "TBD",
    kickoffISO: dt ? dt.toISOString() : null,
    kickoffLocal: formatKickoffLocal(dt),
    hg,
    ag
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

// --- HELPERS: seasons that actually have results ---
function seasonCountsWithResults(all) {
  const counts = {};
  for (const m of all) {
    if (!m.season) continue;
    const played = (m.kickoffISO && m.hg != null && m.ag != null);
    if (!counts[m.season]) counts[m.season] = { total: 0, played: 0 };
    counts[m.season].total += 1;
    if (played) counts[m.season].played += 1;
  }
  return counts;
}

function pickAutoBacktestSeason(counts) {
  const candidates = Object.keys(counts)
    .map(s => ({ s, ...counts[s] }))
    .filter(x => x.played > 0);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.s < b.s) return 1;
    if (a.s > b.s) return -1;
    return b.played - a.played;
  });

  return candidates[0].s;
}

// ------------ MODEL ------------
function buildModelFromMatches(matches, { halfLifeDays = 240, minGamesPerTeam = 6 } = {}) {
  const played = matches.filter(m => m.kickoffISO && m.hg != null && m.ag != null);

  const teamsSet = new Set();
  for (const m of played) { teamsSet.add(m.home); teamsSet.add(m.away); }
  const teams = [...teamsSet].sort();
  const idx = new Map(teams.map((t, i) => [t, i]));
  const n = teams.length;
  if (n === 0) return null;

  const games = new Array(n).fill(0);
  let totalGoals = 0;
  let totalMatches = 0;

  for (const m of played) {
    games[idx.get(m.home)]++;
    games[idx.get(m.away)]++;
    totalGoals += (m.hg + m.ag);
    totalMatches += 1;
  }

  const leagueAvgGoals = totalMatches > 0 ? totalGoals / totalMatches : 2.8;

  let att = new Array(n).fill(0);
  let def = new Array(n).fill(0);
  let ha = 0.12;

  const now = Date.now();
  const lam = Math.log(2) / (halfLifeDays * 24 * 3600 * 1000);

  const iters = 220;
  const lr = 0.035;

  for (let it = 0; it < iters; it++) {
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
      gAtt[iH] += eH; gDef[iA] += eH;
      gAtt[iA] += eA; gDef[iH] += eA;
    }

    for (let i = 0; i < n; i++) {
      att[i] += lr * gAtt[i];
      def[i] += lr * gDef[i];
    }
    ha += lr * gHa;

    const meanAtt = att.reduce((a, b) => a + b, 0) / n;
    const meanDef = def.reduce((a, b) => a + b, 0) / n;
    for (let i = 0; i < n; i++) {
      att[i] -= meanAtt;
      def[i] -= meanDef;
    }

    ha = clamp(ha, -0.25, 0.45);
    for (let i = 0; i < n; i++) {
      att[i] = clamp(att[i], -1.2, 1.2);
      def[i] = clamp(def[i], -1.2, 1.2);
    }
  }

  const teamMeta = {};
  for (let i = 0; i < n; i++) {
    teamMeta[teams[i]] = { games: games[i], att: att[i], def: def[i] };
  }

  return { teams, idx, att, def, ha, halfLifeDays, minGamesPerTeam, teamMeta, leagueAvgGoals };
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

  let pH = 0, pD = 0, pA = 0;
  let pOver25 = 0, pOver35 = 0;

  for (let hg = 0; hg <= MAX_GOALS; hg++) {
    const ph = poissonP(hg, muH);
    for (let ag = 0; ag <= MAX_GOALS; ag++) {
      const pa = poissonP(ag, muA);
      const p = ph * pa;

      if (hg > ag) pH += p;
      else if (hg === ag) pD += p;
      else pA += p;

      const tg = hg + ag;
      if (tg >= 3) pOver25 += p;
      if (tg >= 4) pOver35 += p;
    }
  }

  const s = pH + pD + pA;
  if (s > 0) {
    pH /= s; pD /= s; pA /= s;
    pOver25 /= s; pOver35 /= s;
  }

  const okSample =
    (model.teamMeta[home]?.games || 0) >= model.minGamesPerTeam &&
    (model.teamMeta[away]?.games || 0) >= model.minGamesPerTeam;

  return { muH, muA, p1x2: { H: pH, D: pD, A: pA }, pOver25, pOver35, okSample };
}

// ------------ SYNTHETIC ODDS ------------
function synthOdds1x2(pH, pD, pA, margin = 0.055) {
  const sum = pH + pD + pA;
  if (sum <= 0) return { H: null, D: null, A: null };
  pH /= sum; pD /= sum; pA /= sum;
  const qH = pH * (1 + margin), qD = pD * (1 + margin), qA = pA * (1 + margin);
  return { H: 1 / qH, D: 1 / qD, A: 1 / qA };
}

function synthOddsBinary(p, margin = 0.05) {
  const q = clamp(p * (1 + margin), 0.02, 0.98);
  return 1 / q;
}

function profit1uBinary(win, odds) {
  if (odds == null) return 0;
  return win ? (odds - 1) * (1 - COMMISSION) : -1;
}

// model cache keyed by training seasons
async function getModelFor(trainSeasonsKey, filterFn) {
  const now = Date.now();
  if (modelCache.model && modelCache.key === trainSeasonsKey && (now - modelCache.ts) < MODEL_CACHE_MS) {
    return modelCache.model;
  }

  const all = await loadAllSeasonsUnified();
  const train = all.filter(filterFn);
  const model = buildModelFromMatches(train, { halfLifeDays: 240, minGamesPerTeam: 6 });

  modelCache = { ts: now, key: trainSeasonsKey, model };
  return model;
}

async function getDefaultModel() {
  return getModelFor("default_all", _ => true);
}

// ------------ ROUTES ------------
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get("/api/seasons", async (req, res) => {
  try {
    const all = await loadAllSeasonsUnified();
    const counts = seasonCountsWithResults(all);
    const seasons = Object.keys(counts).sort();
    res.json({ seasons: seasons.map(s => ({ season: s, total: counts[s].total, played: counts[s].played })) });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// fixtures: upcoming in latest season
app.get("/api/fixtures", async (req, res) => {
  try {
    const days = clamp(Number(req.query.days || 14), 1, 90);
    const limit = clamp(Number(req.query.limit || 30), 1, 200);

    const all = await loadAllSeasonsUnified();
    const latestSeason = all.filter(m => m.season === "2025/26");

    const now = Date.now();
    const horizon = now + days * 24 * 3600 * 1000;

    const upcoming = latestSeason
      .filter(m => m.kickoffISO &&
        new Date(m.kickoffISO).getTime() >= (now - 2 * 3600 * 1000) &&
        new Date(m.kickoffISO).getTime() <= horizon)
      .sort((a, b) => new Date(a.kickoffISO).getTime() - new Date(b.kickoffISO).getTime())
      .slice(0, limit);

    res.json({ days, limit, count: upcoming.length, matches: upcoming });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/api/value", async (req, res) => {
  try {
    const days = clamp(Number(req.query.days || 14), 1, 90);
    const limit = clamp(Number(req.query.limit || 20), 1, 200);
    const minEv = clamp(Number(req.query.min_ev || 0), 0, 10);
    const minP = clamp(Number(req.query.min_p || 0), 0, 1);
    const minSample = String(req.query.min_sample || "1") === "1";

    const model = await getDefaultModel();
    const all = await loadAllSeasonsUnified();
    const latestSeason = all.filter(m => m.season === "2025/26");

    const now = Date.now();
    const horizon = now + days * 24 * 3600 * 1000;

    const upcoming = latestSeason
      .filter(m => m.kickoffISO &&
        new Date(m.kickoffISO).getTime() >= (now - 2 * 3600 * 1000) &&
        new Date(m.kickoffISO).getTime() <= horizon)
      .sort((a, b) => new Date(a.kickoffISO).getTime() - new Date(b.kickoffISO).getTime())
      .slice(0, limit);

    const ui = upcoming.map(m => {
      const probs = matchProbs(model, m.home, m.away);
      const p = probs.p1x2;

      const odds1x2 = synthOdds1x2(p.H, p.D, p.A, 0.055);
      const oddsOver25 = synthOddsBinary(probs.pOver25, 0.05);
      const oddsOver35 = synthOddsBinary(probs.pOver35, 0.05);

      return {
        fixtureId: (m.kickoffISO || "") + "|" + m.home + "|" + m.away,
        league: `A-LEAGUE (MEN)${m.round ? ` • Round ${m.round}` : ""}${m.location ? ` • ${m.location}` : ""}`,
        kickoffLocal: m.kickoffLocal,
        kickoffISO: m.kickoffISO,
        home: m.home,
        away: m.away,
        model: { muH: probs.muH, muA: probs.muA, okSample: probs.okSample },
        markets: {
          "1x2": { probs: p, odds: odds1x2 },
          "ou25": { line: 2.5, probOver: probs.pOver25, oddsOver: oddsOver25 },
          "ou35": { line: 3.5, probOver: probs.pOver35, oddsOver: oddsOver35 }
        }
      };
    });

    const filtered = ui.filter(m => {
      if (minSample && m.model?.okSample !== true) return false;
      if (minEv <= 0 && minP <= 0) return true;

      const p = m.markets["1x2"].probs;
      const o = m.markets["1x2"].odds;
      const cands = [
        { p: p.H, odds: o.H },
        { p: p.D, odds: o.D },
        { p: p.A, odds: o.A },
        { p: m.markets["ou25"].probOver, odds: m.markets["ou25"].oddsOver },
        { p: m.markets["ou35"].probOver, odds: m.markets["ou35"].oddsOver }
      ];

      return cands.some(x =>
        x.p != null && x.odds != null &&
        x.p >= minP &&
        (x.p * (x.odds - 1) * (1 - COMMISSION) - (1 - x.p) >= minEv)
      );
    });

    res.json({
      meta: {
        model: model ? `Poisson+TimeDecay (HL ${model.halfLifeDays}d)` : "neutral",
        leagueAvgGoals: model?.leagueAvgGoals || null,
        minGamesPerTeam: model?.minGamesPerTeam || 0
      },
      matches: filtered
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/api/teams", async (req, res) => {
  try {
    const model = await getDefaultModel();
    if (!model) return res.json({ meta: {}, teams: [] });

    const teams = model.teams.map(t => {
      const tm = model.teamMeta[t] || { games: 0, att: 0, def: 0 };
      const attackRating = Math.exp(tm.att);
      const defenseStrength = Math.exp(-tm.def);
      return { team: t, games: tm.games, att: tm.att, def: tm.def, attackRating, defenseStrength };
    });

    teams.sort((a, b) => (b.attackRating + b.defenseStrength) - (a.attackRating + a.defenseStrength));

    res.json({
      meta: {
        model: `Poisson+TimeDecay (HL ${model.halfLifeDays}d)`,
        minGamesPerTeam: model.minGamesPerTeam,
        leagueAvgGoals: model.leagueAvgGoals
      },
      teams
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/api/backtest", async (req, res) => {
  try {
    let season = String(req.query.season || "auto");
    const minEv = clamp(Number(req.query.min_ev || 0.02), 0, 10);
    const minP = clamp(Number(req.query.min_p || 0.10), 0, 1);

    const all = await loadAllSeasonsUnified();
    const counts = seasonCountsWithResults(all);

    if (season === "auto") {
      const auto = pickAutoBacktestSeason(counts);
      if (!auto) {
        return res.json({ meta: { season: "auto", note: "No seasons with played matches were found in the feeds." }, seasons: counts, summary: {}, calibration: {} });
      }
      season = auto;
    }

    const test = all.filter(m => m.season === season && m.kickoffISO && m.hg != null && m.ag != null);
    if (test.length === 0) {
      return res.json({ meta: { season, note: "No played matches found for that season." }, seasons: counts, summary: {}, calibration: {} });
    }

    const trainKey = `train_excluding_${season}`;
    const model = await getModelFor(trainKey, m => m.season !== season);

    let brier1x2 = 0, logloss1x2 = 0, n1x2 = 0, accTop = 0;
    let brier25 = 0, logloss25 = 0, n25 = 0;
    let brier35 = 0, logloss35 = 0, n35 = 0;

    const makeBins = () => Array.from({ length: 10 }, (_, i) => ({ bin: i, n: 0, pSum: 0, ySum: 0 }));
    const cal = { oneXtwoTop: makeBins(), ou25: makeBins(), ou35: makeBins() };

    function addCal(bins, p, y) {
      const b = clamp(Math.floor(p * 10), 0, 9);
      bins[b].n += 1;
      bins[b].pSum += p;
      bins[b].ySum += y;
    }

    for (const m of test) {
      const probs = matchProbs(model, m.home, m.away);
      const p = probs.p1x2;

      const yH = m.hg > m.ag ? 1 : 0;
      const yD = m.hg === m.ag ? 1 : 0;
      const yA = m.hg < m.ag ? 1 : 0;

      brier1x2 += (p.H - yH) ** 2 + (p.D - yD) ** 2 + (p.A - yA) ** 2;
      logloss1x2 += -(yH * logSafe(p.H) + yD * logSafe(p.D) + yA * logSafe(p.A));
      n1x2 += 1;

      const top = [{ k: "H", v: p.H }, { k: "D", v: p.D }, { k: "A", v: p.A }].sort((a, b) => b.v - a.v)[0];
      const topY = top.k === "H" ? yH : top.k === "D" ? yD : yA;
      accTop += topY;
      addCal(cal.oneXtwoTop, top.v, topY);

      const tg = m.hg + m.ag;
      const y25 = tg >= 3 ? 1 : 0;
      const y35 = tg >= 4 ? 1 : 0;

      brier25 += (probs.pOver25 - y25) ** 2;
      logloss25 += -(y25 * logSafe(probs.pOver25) + (1 - y25) * logSafe(1 - probs.pOver25));
      n25 += 1;
      addCal(cal.ou25, probs.pOver25, y25);

      brier35 += (probs.pOver35 - y35) ** 2;
      logloss35 += -(y35 * logSafe(probs.pOver35) + (1 - y35) * logSafe(1 - probs.pOver35));
      n35 += 1;
      addCal(cal.ou35, probs.pOver35, y35);
    }

    function finalizeBins(bins) {
      return bins.map(b => ({ bin: b.bin, n: b.n, pAvg: b.n ? b.pSum / b.n : null, yAvg: b.n ? b.ySum / b.n : null }));
    }

    res.json({
      meta: {
        season,
        trainedOn: SEASON_FEEDS.map(x => x.season).filter(s => s !== season),
        model: model ? `Poisson+TimeDecay (HL ${model.halfLifeDays}d)` : "neutral",
        thresholds: { minEv, minP }
      },
      summary: {
        matches: test.length,
        oneXtwo: { topPickAcc: n1x2 ? accTop / n1x2 : null, brier: n1x2 ? brier1x2 / n1x2 : null, logloss: n1x2 ? logloss1x2 / n1x2 : null },
        ou25: { brier: n25 ? brier25 / n25 : null, logloss: n25 ? logloss25 / n25 : null },
        ou35: { brier: n35 ? brier35 / n35 : null, logloss: n35 ? logloss35 / n35 : null }
      },
      calibration: {
        oneXtwoTop: finalizeBins(cal.oneXtwoTop),
        ou25: finalizeBins(cal.ou25),
        ou35: finalizeBins(cal.ou35)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log("Server running on", PORT));
