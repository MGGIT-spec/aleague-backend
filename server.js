// A-League backend v4 (FULL FILE)
// ✅ FixtureDownload schema support (DateUtc, HomeTeamScore, AwayTeamScore)
// ✅ xG-style adjustment: shrink extreme scores (preprocess goals)
// ✅ Home/Away split strengths: attH/defH + attA/defA
// ✅ Totals calibration: Platt scaling for OU2.5 & OU3.5
// Endpoints:
//  - /health
//  - /api/seasons
//  - /api/fixtures
//  - /api/value
//  - /api/teams
//  - /api/backtest (season=auto)

// ------------------- deps -------------------
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ------------------- config -------------------
const BRISBANE_TZ = "Australia/Brisbane";
const COMMISSION = 0.05;
const MAX_GOALS = 8;

// FixtureDownload feeds
const SEASON_FEEDS = [
  { season: "2022/23", url: "https://fixturedownload.com/feed/json/aleague-2022" },
  { season: "2023/24", url: "https://fixturedownload.com/feed/json/aleague-men-2023" },
  { season: "2024/25", url: "https://fixturedownload.com/feed/json/aleague-men-2024" },
  { season: "2025/26", url: "https://fixturedownload.com/feed/json/aleague-men-2025" }
];

const FIXTURE_CACHE_MS = 6 * 60 * 60 * 1000;
const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;

// Model knobs
const HALF_LIFE_DAYS = 240;
const MIN_GAMES_PER_TEAM = 6;

// xG-style shrink knobs
const GOAL_CAP = 6;        // cap extreme scores (winsorize)
const SHRINK_ALPHA = 0.22; // 0=no shrink, 1=fully league mean

// ------------------- util -------------------
function pick(obj, keys, fallback = null) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

function parseDateFlexible(v) {
  if (!v) return null;

  // FixtureDownload uses "YYYY-MM-DD HH:mm:ssZ"
  if (typeof v === "string" && v.includes(" ") && v.endsWith("Z") && !v.includes("T")) {
    const isoish = v.replace(" ", "T");
    const d = new Date(isoish);
    if (!isNaN(d.getTime())) return d;
  }

  const asDate = new Date(v);
  if (!isNaN(asDate.getTime())) return asDate;

  // dd/mm/yyyy fallback
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

function sigmoid(z) {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  } else {
    const e = Math.exp(z);
    return e / (1 + e);
  }
}

function logit(p) {
  p = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(p / (1 - p));
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

// ------------------- fetch + cache -------------------
let feedCache = { byUrl: new Map() };
let modelCache = { ts: 0, key: "", model: null };

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

function rowToUnified(row, seasonLabel) {
  const home = pick(row, ["HomeTeam", "Home Team", "HomeTeamName", "HomeTeamShort", "Home"]);
  const away = pick(row, ["AwayTeam", "Away Team", "AwayTeamName", "AwayTeamShort", "Away"]);
  const location = pick(row, ["Location", "Venue", "venue", "stadium"], "");
  const round = pick(row, ["RoundNumber", "Round Number", "Round", "matchday"], "");

  const rawDate = pick(row, ["DateUtc", "DateUTC", "Date", "date", "Kickoff", "kickoff", "Start", "start_time"], null);
  const dt = parseDateFlexible(rawDate);

  // FixtureDownload score fields
  const hs = pick(row, ["HomeTeamScore", "HomeScore", "homeScore", "home_score"], null);
  const as = pick(row, ["AwayTeamScore", "AwayScore", "awayScore", "away_score"], null);

  let hg = (hs === null || hs === "" ? null : Number(hs));
  let ag = (as === null || as === "" ? null : Number(as));
  if (!Number.isFinite(hg)) hg = null;
  if (!Number.isFinite(ag)) ag = null;

  // fallback if some feed uses Result string
  if (hg == null || ag == null) {
    const res = parseScore(pick(row, ["Result", "result", "Score", "score"], null));
    if (res) { hg = res.hg; ag = res.ag; }
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

// ------------------- season helpers -------------------
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

// ------------------- xG-style adjustment (preprocess goals) -------------------
function shrinkGoals(hg, ag, leagueAvgGoals) {
  // leagueAvgGoals is per match (total goals)
  // per-team mean ~ leagueAvgGoals/2
  const muTeam = (leagueAvgGoals || 2.8) / 2;

  // cap extremes then shrink towards per-team mean
  const cap = (g) => clamp(g, 0, GOAL_CAP);

  const hgC = cap(hg);
  const agC = cap(ag);

  const hgAdj = (1 - SHRINK_ALPHA) * hgC + SHRINK_ALPHA * muTeam;
  const agAdj = (1 - SHRINK_ALPHA) * agC + SHRINK_ALPHA * muTeam;

  return { hgAdj, agAdj };
}

// ------------------- calibration (Platt scaling) -------------------
// Fit a,b for: p_cal = sigmoid(a*logit(p_raw) + b)
function fitPlatt(rawPs, ys, { iters = 500, lr = 0.02, l2 = 1e-3 } = {}) {
  let a = 1.0;
  let b = 0.0;

  // gradient descent on logistic logloss
  for (let it = 0; it < iters; it++) {
    let ga = 0;
    let gb = 0;
    for (let i = 0; i < rawPs.length; i++) {
      const x = logit(rawPs[i]);
      const p = sigmoid(a * x + b);
      const y = ys[i];

      // d/dz of logloss = (p - y)
      const dz = (p - y);

      ga += dz * x;
      gb += dz;
    }

    // L2 regularization
    ga += l2 * a;
    gb += l2 * b;

    // normalize
    ga /= rawPs.length;
    gb /= rawPs.length;

    a -= lr * ga;
    b -= lr * gb;

    a = clamp(a, -5, 5);
    b = clamp(b, -5, 5);
  }

  return { a, b };
}

function applyPlatt(pRaw, cal) {
  if (!cal) return pRaw;
  const z = cal.a * logit(pRaw) + cal.b;
  return sigmoid(z);
}

// ------------------- model: home/away split strengths -------------------
function buildModelFromMatches(matches, { halfLifeDays = HALF_LIFE_DAYS, minGamesPerTeam = MIN_GAMES_PER_TEAM } = {}) {
  const played = matches.filter(m => m.kickoffISO && m.hg != null && m.ag != null);

  // Build team list
  const teamsSet = new Set();
  for (const m of played) { teamsSet.add(m.home); teamsSet.add(m.away); }
  const teams = [...teamsSet].sort();
  const idx = new Map(teams.map((t, i) => [t, i]));
  const n = teams.length;
  if (n === 0) return null;

  // League average goals
  let totalGoals = 0;
  let totalMatches = 0;
  for (const m of played) {
    totalGoals += (m.hg + m.ag);
    totalMatches += 1;
  }
  const leagueAvgGoals = totalMatches > 0 ? totalGoals / totalMatches : 2.8;

  // xG-style adjusted goals used for fitting
  const playedAdj = played.map(m => {
    const { hgAdj, agAdj } = shrinkGoals(m.hg, m.ag, leagueAvgGoals);
    return { ...m, hgAdj, agAdj };
  });

  // home/away split parameters
  // For match H vs A:
  //   muH = exp(ha + attH[H] + defA[A])
  //   muA = exp(attA[A] + defH[H])
  let attH = new Array(n).fill(0);
  let defH = new Array(n).fill(0);
  let attA = new Array(n).fill(0);
  let defA = new Array(n).fill(0);
  let ha = 0.12;

  // counts
  const gamesHome = new Array(n).fill(0);
  const gamesAway = new Array(n).fill(0);
  const gamesTotal = new Array(n).fill(0);

  for (const m of playedAdj) {
    const iH = idx.get(m.home);
    const iA = idx.get(m.away);
    gamesHome[iH]++; gamesAway[iA]++;
    gamesTotal[iH]++; gamesTotal[iA]++;
  }

  const now = Date.now();
  const lam = Math.log(2) / (halfLifeDays * 24 * 3600 * 1000);

  const iters = 260;
  const lr = 0.03;

  for (let it = 0; it < iters; it++) {
    const gAttH = new Array(n).fill(0);
    const gDefH = new Array(n).fill(0);
    const gAttA = new Array(n).fill(0);
    const gDefA = new Array(n).fill(0);
    let gHa = 0;

    for (const m of playedAdj) {
      const iH = idx.get(m.home);
      const iA = idx.get(m.away);

      const t = new Date(m.kickoffISO).getTime();
      const w = Math.exp(-lam * Math.max(0, now - t));

      const muH = Math.exp(ha + attH[iH] + defA[iA]);
      const muA = Math.exp(attA[iA] + defH[iH]);

      // use adjusted goals
      const eH = (m.hgAdj - muH) * w;
      const eA = (m.agAdj - muA) * w;

      gHa += eH;

      // Home scoring depends on home attack + away defence
      gAttH[iH] += eH;
      gDefA[iA] += eH;

      // Away scoring depends on away attack + home defence
      gAttA[iA] += eA;
      gDefH[iH] += eA;
    }

    for (let i = 0; i < n; i++) {
      attH[i] += lr * gAttH[i];
      defH[i] += lr * gDefH[i];
      attA[i] += lr * gAttA[i];
      defA[i] += lr * gDefA[i];
    }
    ha += lr * gHa;

    // identifiability: keep each param group zero-mean
    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / n;
    const zmean = (arr) => {
      const m = mean(arr);
      for (let i = 0; i < n; i++) arr[i] -= m;
    };
    zmean(attH); zmean(defH); zmean(attA); zmean(defA);

    // clamp
    ha = clamp(ha, -0.25, 0.50);
    for (let i = 0; i < n; i++) {
      attH[i] = clamp(attH[i], -1.4, 1.4);
      defH[i] = clamp(defH[i], -1.4, 1.4);
      attA[i] = clamp(attA[i], -1.4, 1.4);
      defA[i] = clamp(defA[i], -1.4, 1.4);
    }
  }

  // Build team meta
  const teamMeta = {};
  for (let i = 0; i < n; i++) {
    teamMeta[teams[i]] = {
      games: gamesTotal[i],
      homeGames: gamesHome[i],
      awayGames: gamesAway[i],
      attH: attH[i],
      defH: defH[i],
      attA: attA[i],
      defA: defA[i]
    };
  }

  return {
    teams, idx,
    attH, defH, attA, defA,
    ha,
    halfLifeDays,
    minGamesPerTeam,
    teamMeta,
    leagueAvgGoals
  };
}

// Compute match probabilities (returns calibrated totals probabilities too)
function matchProbs(model, home, away) {
  if (!model || !model.idx.has(home) || !model.idx.has(away)) {
    return {
      muH: 1.45, muA: 1.30,
      p1x2: { H: 0.40, D: 0.27, A: 0.33 },
      pOver25_raw: 0.56,
      pOver35_raw: 0.33,
      pOver25: 0.56,
      pOver35: 0.33,
      okSample: false
    };
  }

  const iH = model.idx.get(home);
  const iA = model.idx.get(away);

  const muH = Math.exp(model.ha + model.attH[iH] + model.defA[iA]);
  const muA = Math.exp(model.attA[iA] + model.defH[iH]);

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

  const pOver25_raw = pOver25;
  const pOver35_raw = pOver35;

  // apply Platt calibration if present
  const pOver25_cal = model.calibration?.ou25 ? applyPlatt(pOver25_raw, model.calibration.ou25) : pOver25_raw;
  const pOver35_cal = model.calibration?.ou35 ? applyPlatt(pOver35_raw, model.calibration.ou35) : pOver35_raw;

  return {
    muH, muA,
    p1x2: { H: pH, D: pD, A: pA },
    pOver25_raw,
    pOver35_raw,
    pOver25: pOver25_cal,
    pOver35: pOver35_cal,
    okSample
  };
}

// ------------------- synthetic odds -------------------
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

// ------------------- model cache (with calibration) -------------------
async function getModelFor(trainKey, filterFn) {
  const now = Date.now();
  if (modelCache.model && modelCache.key === trainKey && (now - modelCache.ts) < MODEL_CACHE_MS) {
    return modelCache.model;
  }

  const all = await loadAllSeasonsUnified();
  const trainAll = all.filter(filterFn);
  const trainPlayed = trainAll.filter(m => m.kickoffISO && m.hg != null && m.ag != null);

  const model = buildModelFromMatches(trainAll, { halfLifeDays: HALF_LIFE_DAYS, minGamesPerTeam: MIN_GAMES_PER_TEAM });
  if (!model) {
    modelCache = { ts: now, key: trainKey, model: null };
    return null;
  }

  // Fit Platt calibration on training data (for totals)
  // We fit on raw totals probs produced by the model (before calibration)
  const raw25 = [];
  const y25 = [];
  const raw35 = [];
  const y35 = [];

  for (const m of trainPlayed) {
    const probs = (function rawOnly() {
      const iH = model.idx.get(m.home);
      const iA = model.idx.get(m.away);
      if (iH == null || iA == null) return null;

      const muH = Math.exp(model.ha + model.attH[iH] + model.defA[iA]);
      const muA = Math.exp(model.attA[iA] + model.defH[iH]);

      let pOver25 = 0, pOver35 = 0;
      for (let hg = 0; hg <= MAX_GOALS; hg++) {
        const ph = poissonP(hg, muH);
        for (let ag = 0; ag <= MAX_GOALS; ag++) {
          const pa = poissonP(ag, muA);
          const p = ph * pa;
          const tg = hg + ag;
          if (tg >= 3) pOver25 += p;
          if (tg >= 4) pOver35 += p;
        }
      }
      // normalize by match mass (approx 1, but keep safe)
      return { pOver25: clamp(pOver25, 1e-6, 1 - 1e-6), pOver35: clamp(pOver35, 1e-6, 1 - 1e-6) };
    })();

    if (!probs) continue;

    const tg = m.hg + m.ag;
    raw25.push(probs.pOver25); y25.push(tg >= 3 ? 1 : 0);
    raw35.push(probs.pOver35); y35.push(tg >= 4 ? 1 : 0);
  }

  const cal = {};
  if (raw25.length >= 30) cal.ou25 = fitPlatt(raw25, y25, { iters: 550, lr: 0.02, l2: 1e-3 });
  if (raw35.length >= 30) cal.ou35 = fitPlatt(raw35, y35, { iters: 550, lr: 0.02, l2: 1e-3 });

  model.calibration = cal;

  modelCache = { ts: now, key: trainKey, model };
  return model;
}

async function getDefaultModel() {
  return getModelFor("default_all", _ => true);
}

// ------------------- routes -------------------
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

// upcoming fixtures (latest season label in our config)
app.get("/api/fixtures", async (req, res) => {
  try {
    const days = clamp(Number(req.query.days || 14), 1, 90);
    const limit = clamp(Number(req.query.limit || 40), 1, 200);

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

// value endpoint used by UI (synthetic odds; totals are calibrated)
app.get("/api/value", async (req, res) => {
  try {
    const days = clamp(Number(req.query.days || 14), 1, 90);
    const limit = clamp(Number(req.query.limit || 25), 1, 200);
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
        model: {
          muH: probs.muH,
          muA: probs.muA,
          okSample: probs.okSample
        },
        markets: {
          "1x2": { probs: p, odds: odds1x2 },
          "ou25": {
            line: 2.5,
            probOver_raw: probs.pOver25_raw,
            probOver: probs.pOver25,
            oddsOver: oddsOver25
          },
          "ou35": {
            line: 3.5,
            probOver_raw: probs.pOver35_raw,
            probOver: probs.pOver35,
            oddsOver: oddsOver35
          }
        }
      };
    });

    const filtered = ui.filter(m => {
      if (minSample && m.model?.okSample !== true) return false;
      if (minEv <= 0 && minP <= 0) return true;

      const cands = [];
      const p = m.markets["1x2"].probs;
      const o = m.markets["1x2"].odds;
      cands.push({ p: p.H, odds: o.H });
      cands.push({ p: p.D, odds: o.D });
      cands.push({ p: p.A, odds: o.A });
      cands.push({ p: m.markets["ou25"].probOver, odds: m.markets["ou25"].oddsOver });
      cands.push({ p: m.markets["ou35"].probOver, odds: m.markets["ou35"].oddsOver });

      return cands.some(x =>
        x.p != null && x.odds != null &&
        x.p >= minP &&
        (x.p * (x.odds - 1) * (1 - COMMISSION) - (1 - x.p) >= minEv)
      );
    });

    res.json({
      meta: {
        model: model ? `Poisson+TimeDecay+HA (HL ${model.halfLifeDays}d) + xG-shrink + Platt(OU)` : "neutral",
        calibration: model?.calibration || null,
        leagueAvgGoals: model?.leagueAvgGoals || null,
        minGamesPerTeam: model?.minGamesPerTeam || 0,
        xgShrink: { alpha: SHRINK_ALPHA, goalCap: GOAL_CAP }
      },
      matches: filtered
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// team stats (HOME/AWAY splits)
app.get("/api/teams", async (req, res) => {
  try {
    const model = await getDefaultModel();
    if (!model) return res.json({ meta: {}, teams: [] });

    const teams = model.teams.map(t => {
      const tm = model.teamMeta[t] || {};
      const attackHome = Math.exp(tm.attH ?? 0);
      const defenceHome = Math.exp(-(tm.defH ?? 0));
      const attackAway = Math.exp(tm.attA ?? 0);
      const defenceAway = Math.exp(-(tm.defA ?? 0));

      return {
        team: t,
        games: tm.games ?? 0,
        homeGames: tm.homeGames ?? 0,
        awayGames: tm.awayGames ?? 0,

        // raw params
        attH: tm.attH ?? 0,
        defH: tm.defH ?? 0,
        attA: tm.attA ?? 0,
        defA: tm.defA ?? 0,

        // readable ratings
        attackHome,
        defenceHome,
        attackAway,
        defenceAway
      };
    });

    // sort by combined strength (home+away balance)
    teams.sort((a, b) => {
      const sa = (a.attackHome + a.defenceHome + a.attackAway + a.defenceAway);
      const sb = (b.attackHome + b.defenceHome + b.attackAway + b.defenceAway);
      return sb - sa;
    });

    res.json({
      meta: {
        model: `Poisson+TimeDecay+HA (HL ${model.halfLifeDays}d) + xG-shrink + Platt(OU)`,
        minGamesPerTeam: model.minGamesPerTeam,
        leagueAvgGoals: model.leagueAvgGoals,
        xgShrink: { alpha: SHRINK_ALPHA, goalCap: GOAL_CAP },
        calibration: model.calibration || null
      },
      teams
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// backtest (calibration charts should now look better on totals)
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
        return res.json({
          meta: { season: "auto", note: "No seasons with played matches were found in the feeds." },
          seasons: counts,
          summary: {},
          calibration: {}
        });
      }
      season = auto;
    }

    const test = all.filter(m => m.season === season && m.kickoffISO && m.hg != null && m.ag != null);
    if (test.length === 0) {
      return res.json({
        meta: { season, note: "No played matches found for that season." },
        seasons: counts,
        summary: {},
        calibration: {}
      });
    }

    // Train excluding test season (also fits Platt calibration on train set)
    const trainKey = `train_excluding_${season}`;
    const model = await getModelFor(trainKey, m => m.season !== season);

    // metrics
    let brier1x2 = 0, logloss1x2 = 0, n1x2 = 0, accTop = 0;
    let brier25 = 0, logloss25 = 0, n25 = 0;
    let brier35 = 0, logloss35 = 0, n35 = 0;

    const roi = {
      oneXtwo: { bets: 0, wins: 0, profit: 0 },
      ou25: { bets: 0, wins: 0, profit: 0 },
      ou35: { bets: 0, wins: 0, profit: 0 },
      combined: { bets: 0, wins: 0, profit: 0 }
    };

    // calibration bins
    const makeBins = () => Array.from({ length: 10 }, (_, i) => ({ bin: i, n: 0, pSum: 0, ySum: 0 }));
    const calBins = {
      oneXtwoTop: makeBins(),
      ou25_raw: makeBins(),
      ou25_cal: makeBins(),
      ou35_raw: makeBins(),
      ou35_cal: makeBins()
    };

    function addCal(bins, p, y) {
      const b = clamp(Math.floor(p * 10), 0, 9);
      bins[b].n += 1;
      bins[b].pSum += p;
      bins[b].ySum += y;
    }

    for (const m of test) {
      const probs = matchProbs(model, m.home, m.away);

      // observed 1x2
      const yH = m.hg > m.ag ? 1 : 0;
      const yD = m.hg === m.ag ? 1 : 0;
      const yA = m.hg < m.ag ? 1 : 0;

      const p = probs.p1x2;

      brier1x2 += (p.H - yH) ** 2 + (p.D - yD) ** 2 + (p.A - yA) ** 2;
      logloss1x2 += -(yH * logSafe(p.H) + yD * logSafe(p.D) + yA * logSafe(p.A));
      n1x2 += 1;

      const top = [{ k: "H", v: p.H }, { k: "D", v: p.D }, { k: "A", v: p.A }].sort((a, b) => b.v - a.v)[0];
      const topY = top.k === "H" ? yH : top.k === "D" ? yD : yA;
      accTop += topY;
      addCal(calBins.oneXtwoTop, top.v, topY);

      // totals observed
      const tg = m.hg + m.ag;
      const y25 = tg >= 3 ? 1 : 0;
      const y35 = tg >= 4 ? 1 : 0;

      // raw & calibrated totals
      addCal(calBins.ou25_raw, probs.pOver25_raw, y25);
      addCal(calBins.ou25_cal, probs.pOver25, y25);
      addCal(calBins.ou35_raw, probs.pOver35_raw, y35);
      addCal(calBins.ou35_cal, probs.pOver35, y35);

      brier25 += (probs.pOver25 - y25) ** 2;
      logloss25 += -(y25 * logSafe(probs.pOver25) + (1 - y25) * logSafe(1 - probs.pOver25));
      n25 += 1;

      brier35 += (probs.pOver35 - y35) ** 2;
      logloss35 += -(y35 * logSafe(probs.pOver35) + (1 - y35) * logSafe(1 - probs.pOver35));
      n35 += 1;

      // ROI simulation (synthetic)
      const odds1x2 = synthOdds1x2(p.H, p.D, p.A, 0.055);
      const oddsO25 = synthOddsBinary(probs.pOver25, 0.05);
      const oddsO35 = synthOddsBinary(probs.pOver35, 0.05);

      // 1x2: bet top pick if EV passes
      const topOdds = top.k === "H" ? odds1x2.H : top.k === "D" ? odds1x2.D : odds1x2.A;
      const topP = top.v;
      const topEV = topP * (topOdds - 1) * (1 - COMMISSION) - (1 - topP);
      if (topOdds != null && topP >= minP && topEV >= minEv) {
        roi.oneXtwo.bets++; roi.combined.bets++;
        if (topY === 1) { roi.oneXtwo.wins++; roi.combined.wins++; }
        const pr = profit1uBinary(topY === 1, topOdds);
        roi.oneXtwo.profit += pr; roi.combined.profit += pr;
      }

      // OU2.5
      const ev25 = probs.pOver25 * (oddsO25 - 1) * (1 - COMMISSION) - (1 - probs.pOver25);
      if (oddsO25 != null && probs.pOver25 >= minP && ev25 >= minEv) {
        roi.ou25.bets++; roi.combined.bets++;
        if (y25 === 1) { roi.ou25.wins++; roi.combined.wins++; }
        const pr = profit1uBinary(y25 === 1, oddsO25);
        roi.ou25.profit += pr; roi.combined.profit += pr;
      }

      // OU3.5
      const ev35 = probs.pOver35 * (oddsO35 - 1) * (1 - COMMISSION) - (1 - probs.pOver35);
      if (oddsO35 != null && probs.pOver35 >= minP && ev35 >= minEv) {
        roi.ou35.bets++; roi.combined.bets++;
        if (y35 === 1) { roi.ou35.wins++; roi.combined.wins++; }
        const pr = profit1uBinary(y35 === 1, oddsO35);
        roi.ou35.profit += pr; roi.combined.profit += pr;
      }
    }

    function finalizeBins(bins) {
      return bins.map(b => ({
        bin: b.bin,
        n: b.n,
        pAvg: b.n ? b.pSum / b.n : null,
        yAvg: b.n ? b.ySum / b.n : null
      }));
    }

    const fmtRoi = (x) => ({
      ...x,
      roi: x.bets ? x.profit / x.bets : null,
      winRate: x.bets ? x.wins / x.bets : null
    });

    res.json({
      meta: {
        season,
        trainedOn: SEASON_FEEDS.map(x => x.season).filter(s => s !== season),
        model: model ? `Poisson+TimeDecay+HA (HL ${model.halfLifeDays}d) + xG-shrink + Platt(OU)` : "neutral",
        thresholds: { minEv, minP },
        xgShrink: { alpha: SHRINK_ALPHA, goalCap: GOAL_CAP },
        calibration: model?.calibration || null
      },
      summary: {
        matches: test.length,
        oneXtwo: {
          topPickAcc: n1x2 ? accTop / n1x2 : null,
          brier: n1x2 ? brier1x2 / n1x2 : null,
          logloss: n1x2 ? logloss1x2 / n1x2 : null,
          roi: fmtRoi(roi.oneXtwo)
        },
        ou25: {
          brier: n25 ? brier25 / n25 : null,
          logloss: n25 ? logloss25 / n25 : null,
          roi: fmtRoi(roi.ou25)
        },
        ou35: {
          brier: n35 ? brier35 / n35 : null,
          logloss: n35 ? logloss35 / n35 : null,
          roi: fmtRoi(roi.ou35)
        },
        combined: fmtRoi(roi.combined)
      },
      calibration: {
        oneXtwoTop: finalizeBins(calBins.oneXtwoTop),
        ou25_raw: finalizeBins(calBins.ou25_raw),
        ou25_cal: finalizeBins(calBins.ou25_cal),
        ou35_raw: finalizeBins(calBins.ou35_raw),
        ou35_cal: finalizeBins(calBins.ou35_cal)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log("Server running on", PORT));
