// A-League backend v5 (FULL FILE)
// ✅ FixtureDownload schema support (DateUtc, HomeTeamScore, AwayTeamScore)
// ✅ xG-style adjustment: shrink extreme scores (cap + shrink to league mean)
// ✅ Home/Away split strengths: attH/defH + attA/defA
// ✅ Totals calibration: Platt scaling for OU2.5 & OU3.5 with guardrails
// ✅ /api/diagnostics: season drift, base rates, top scorelines
// ✅ /api/backtest: baselines + deltaLogloss + fixed-odds ROI sim
// ✅ /api/backtest: mode=static or mode=walk (walk-forward expanding)
// Endpoints:
//  - /health
//  - /api/seasons
//  - /api/fixtures
//  - /api/value
//  - /api/teams
//  - /api/backtest
//  - /api/diagnostics

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ------------------- CONFIG -------------------
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

// xG-style shrink knobs (less aggressive)
const GOAL_CAP = 7;
const SHRINK_ALPHA = 0.10;

// Regularization to prevent HA overfit
const HA_L2 = 0.015;
const HA_L2_HA = 0.01; // home-adv reg

// Walk-forward rebuild frequency
const WALK_REBUILD_EVERY = 6;

// Platt calibration thresholds + guardrail
const PLATT_MIN_SAMPLES = 60;
const PLATT_IMPROVE_EPS = 0.002;

// ------------------- UTIL -------------------
function pick(obj, keys, fallback = null) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
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

function parseScore(resultStr) {
  if (!resultStr) return null;
  const s = String(resultStr).trim();
  if (s === "-" || s === "–" || s === "—") return null;
  const m = s.match(/(\d+)\s*[-–—:]\s*(\d+)/);
  if (!m) return null;
  return { hg: Number(m[1]), ag: Number(m[2]) };
}

// ------------------- FETCH + CACHE -------------------
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

  // FixtureDownload scores
  const hs = pick(row, ["HomeTeamScore", "HomeScore", "homeScore", "home_score"], null);
  const as = pick(row, ["AwayTeamScore", "AwayScore", "awayScore", "away_score"], null);

  let hg = (hs === null || hs === "" ? null : Number(hs));
  let ag = (as === null || as === "" ? null : Number(as));
  if (!Number.isFinite(hg)) hg = null;
  if (!Number.isFinite(ag)) ag = null;

  // fallback "Result" format
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

// ------------------- SEASON HELPERS -------------------
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

// ------------------- DIAGNOSTICS -------------------
function summarizeSeason(matches) {
  const played = matches.filter(m => m.kickoffISO && m.hg != null && m.ag != null);
  const n = played.length;
  if (!n) return null;

  let totalGoals = 0;
  let homeWins = 0, draws = 0, awayWins = 0;
  let over25 = 0, over35 = 0;

  const freq = {};
  const cap = (x) => Math.max(0, Math.min(6, x));

  for (const m of played) {
    totalGoals += (m.hg + m.ag);

    if (m.hg > m.ag) homeWins++;
    else if (m.hg === m.ag) draws++;
    else awayWins++;

    const tg = m.hg + m.ag;
    if (tg >= 3) over25++;
    if (tg >= 4) over35++;

    const k = `${cap(m.hg)}-${cap(m.ag)}`;
    freq[k] = (freq[k] || 0) + 1;
  }

  const leagueAvgGoals = totalGoals / n;

  const topScorelines = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k, c]) => ({ score: k, count: c, pct: c / n }));

  return {
    played: n,
    leagueAvgGoals,
    oneXtwo: { homeWin: homeWins / n, draw: draws / n, awayWin: awayWins / n },
    totals: { over25: over25 / n, over35: over35 / n },
    topScorelines
  };
}

// ------------------- xG-STYLE SCORE SHRINK -------------------
function shrinkGoals(hg, ag, leagueAvgGoals) {
  const muTeam = (leagueAvgGoals || 2.8) / 2;
  const cap = (g) => clamp(g, 0, GOAL_CAP);

  const hgC = cap(hg);
  const agC = cap(ag);

  const hgAdj = (1 - SHRINK_ALPHA) * hgC + SHRINK_ALPHA * muTeam;
  const agAdj = (1 - SHRINK_ALPHA) * agC + SHRINK_ALPHA * muTeam;

  return { hgAdj, agAdj };
}

// ------------------- CALIBRATION (PLATT) -------------------
function fitPlatt(rawPs, ys, { iters = 350, lr = 0.02, l2 = 5e-3 } = {}) {
  let a = 1.0;
  let b = 0.0;

  for (let it = 0; it < iters; it++) {
    let ga = 0;
    let gb = 0;

    for (let i = 0; i < rawPs.length; i++) {
      const x = logit(rawPs[i]);
      const p = sigmoid(a * x + b);
      const y = ys[i];
      const dz = (p - y);
      ga += dz * x;
      gb += dz;
    }

    ga += l2 * a;
    gb += l2 * b;

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

function loglossBinary(ps, ys) {
  let s = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = clamp(ps[i], 1e-12, 1 - 1e-12);
    const y = ys[i];
    s += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return s / ps.length;
}

// ------------------- BASELINES + METRICS -------------------
function baselineProbsFromSeasonStats(seasonStats) {
  const homeWin = seasonStats?.oneXtwo?.homeWin ?? 0.40;
  const draw = seasonStats?.oneXtwo?.draw ?? 0.27;
  const awayWin = seasonStats?.oneXtwo?.awayWin ?? 0.33;

  const leagueAvgGoals = seasonStats?.leagueAvgGoals ?? 2.8;
  const muTeam = leagueAvgGoals / 2;

  let pOver25 = 0, pOver35 = 0;
  for (let hg = 0; hg <= MAX_GOALS; hg++) {
    const ph = poissonP(hg, muTeam);
    for (let ag = 0; ag <= MAX_GOALS; ag++) {
      const pa = poissonP(ag, muTeam);
      const p = ph * pa;
      const tg = hg + ag;
      if (tg >= 3) pOver25 += p;
      if (tg >= 4) pOver35 += p;
    }
  }

  return { p1x2: { H: homeWin, D: draw, A: awayWin }, pOver25, pOver35 };
}

function logloss1x2(p, yH, yD, yA) {
  return -(yH * logSafe(p.H) + yD * logSafe(p.D) + yA * logSafe(p.A));
}

function loglossBinaryP(p, y) {
  return -(y * logSafe(p) + (1 - y) * logSafe(1 - p));
}

// ------------------- FIXED-ODDS ROI SIM -------------------
function fixedOddsPack() {
  return {
    oneXtwo: { H: 2.55, D: 3.40, A: 2.75 },
    ou25_over: 1.90,
    ou35_over: 2.40
  };
}

function profit1uBinary(win, odds) {
  if (odds == null) return 0;
  return win ? (odds - 1) * (1 - COMMISSION) : -1;
}

// ------------------- MODEL (HOME/AWAY SPLIT) -------------------
function buildModelFromMatches(matches, { halfLifeDays = HALF_LIFE_DAYS, minGamesPerTeam = MIN_GAMES_PER_TEAM } = {}) {
  const played = matches.filter(m => m.kickoffISO && m.hg != null && m.ag != null);
  const teamsSet = new Set();
  for (const m of played) { teamsSet.add(m.home); teamsSet.add(m.away); }
  const teams = [...teamsSet].sort();
  const idx = new Map(teams.map((t, i) => [t, i]));
  const n = teams.length;
  if (n === 0) return null;

  // League avg goals from raw scores (stable)
  let totalGoals = 0, totalMatches = 0;
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

  // Params:
  // muH = exp(ha + attH[H] + defA[A])
  // muA = exp(attA[A] + defH[H])
  let attH = new Array(n).fill(0);
  let defH = new Array(n).fill(0);
  let attA = new Array(n).fill(0);
  let defA = new Array(n).fill(0);
  let ha = 0.12;

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

      const eH = (m.hgAdj - muH) * w;
      const eA = (m.agAdj - muA) * w;

      gHa += eH;

      gAttH[iH] += eH;
      gDefA[iA] += eH;

      gAttA[iA] += eA;
      gDefH[iH] += eA;
    }

    // L2 regularization to prevent overfit
    for (let i = 0; i < n; i++) {
      gAttH[i] -= HA_L2 * attH[i];
      gDefH[i] -= HA_L2 * defH[i];
      gAttA[i] -= HA_L2 * attA[i];
      gDefA[i] -= HA_L2 * defA[i];
    }
    gHa -= HA_L2_HA * ha;

    for (let i = 0; i < n; i++) {
      attH[i] += lr * gAttH[i];
      defH[i] += lr * gDefH[i];
      attA[i] += lr * gAttA[i];
      defA[i] += lr * gDefA[i];
    }
    ha += lr * gHa;

    // identifiability: zero-mean each group
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
    leagueAvgGoals,
    calibration: null
  };
}

function matchProbs(model, home, away) {
  if (!model || !model.idx.has(home) || !model.idx.has(away)) {
    return {
      muH: 1.45, muA: 1.30,
      p1x2: { H: 0.40, D: 0.27, A: 0.33 },
      pOver25_raw: 0.56, pOver35_raw: 0.33,
      pOver25: 0.56, pOver35: 0.33,
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

  const pOver25_cal = model.calibration?.ou25 ? applyPlatt(pOver25_raw, model.calibration.ou25) : pOver25_raw;
  const pOver35_cal = model.calibration?.ou35 ? applyPlatt(pOver35_raw, model.calibration.ou35) : pOver35_raw;

  return {
    muH, muA,
    p1x2: { H: pH, D: pD, A: pA },
    pOver25_raw, pOver35_raw,
    pOver25: pOver25_cal,
    pOver35: pOver35_cal,
    okSample
  };
}

// ------------------- PLATT FIT ON A MODEL + DATA (GUARDED) -------------------
function fitTotalsCalibrationForModel(model, trainMatchesPlayed) {
  if (!model) return null;
  const raw25 = [], y25 = [];
  const raw35 = [], y35 = [];

  for (const m of trainMatchesPlayed) {
    const iH = model.idx.get(m.home);
    const iA = model.idx.get(m.away);
    if (iH == null || iA == null) continue;

    const muH = Math.exp(model.ha + model.attH[iH] + model.defA[iA]);
    const muA = Math.exp(model.attA[iA] + model.defH[iH]);

    let pO25 = 0, pO35 = 0;
    for (let hg = 0; hg <= MAX_GOALS; hg++) {
      const ph = poissonP(hg, muH);
      for (let ag = 0; ag <= MAX_GOALS; ag++) {
        const pa = poissonP(ag, muA);
        const p = ph * pa;
        const tg = hg + ag;
        if (tg >= 3) pO25 += p;
        if (tg >= 4) pO35 += p;
      }
    }

    const tgObs = m.hg + m.ag;
    raw25.push(clamp(pO25, 1e-6, 1 - 1e-6)); y25.push(tgObs >= 3 ? 1 : 0);
    raw35.push(clamp(pO35, 1e-6, 1 - 1e-6)); y35.push(tgObs >= 4 ? 1 : 0);
  }

  const cal = {};

  if (raw25.length >= PLATT_MIN_SAMPLES) {
    const fit = fitPlatt(raw25, y25, { iters: 350, lr: 0.02, l2: 5e-3 });
    const rawLL = loglossBinary(raw25, y25);
    const calLL = loglossBinary(raw25.map(p => applyPlatt(p, fit)), y25);
    if (calLL + PLATT_IMPROVE_EPS < rawLL) cal.ou25 = fit;
  }

  if (raw35.length >= PLATT_MIN_SAMPLES) {
    const fit = fitPlatt(raw35, y35, { iters: 350, lr: 0.02, l2: 5e-3 });
    const rawLL = loglossBinary(raw35, y35);
    const calLL = loglossBinary(raw35.map(p => applyPlatt(p, fit)), y35);
    if (calLL + PLATT_IMPROVE_EPS < rawLL) cal.ou35 = fit;
  }

  return cal;
}

// ------------------- MODEL CACHE (STATIC MODEL) -------------------
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

  model.calibration = fitTotalsCalibrationForModel(model, trainPlayed) || null;

  modelCache = { ts: now, key: trainKey, model };
  return model;
}

async function getDefaultModel() {
  return getModelFor("default_all", _ => true);
}

// ------------------- ROUTES -------------------
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

app.get("/api/diagnostics", async (req, res) => {
  try {
    const all = await loadAllSeasonsUnified();
    const bySeason = {};
    for (const s of SEASON_FEEDS.map(x => x.season)) {
      bySeason[s] = summarizeSeason(all.filter(m => m.season === s));
    }
    res.json({ seasons: bySeason });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// upcoming fixtures (latest season label in config)
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

// team stats (home/away splits)
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
        attH: tm.attH ?? 0,
        defH: tm.defH ?? 0,
        attA: tm.attA ?? 0,
        defA: tm.defA ?? 0,
        attackHome,
        defenceHome,
        attackAway,
        defenceAway
      };
    });

    teams.sort((a, b) => {
      const sa = (a.attackHome + a.defenceHome + a.attackAway + a.defenceAway);
      const sb = (b.attackHome + b.defenceHome + b.attackAway + b.defenceAway);
      return sb - sa;
    });

    res.json({
      meta: {
        model: `Poisson+TimeDecay+HA (HL ${model.halfLifeDays}d) + xG-shrink + Platt(guarded)`,
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

// value endpoint (synthetic odds remain fine for UI ranking; totals show raw->cal)
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
        model: { muH: probs.muH, muA: probs.muA, okSample: probs.okSample },
        markets: {
          "1x2": { probs: p, odds: odds1x2 },
          "ou25": { line: 2.5, probOver_raw: probs.pOver25_raw, probOver: probs.pOver25, oddsOver: oddsOver25 },
          "ou35": { line: 3.5, probOver_raw: probs.pOver35_raw, probOver: probs.pOver35, oddsOver: oddsOver35 }
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
        model: model ? `Poisson+TimeDecay+HA (HL ${model.halfLifeDays}d) + xG-shrink + Platt(guarded)` : "neutral",
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

// backtest: mode=static|walk
app.get("/api/backtest", async (req, res) => {
  try {
    let season = String(req.query.season || "auto");
    const minEv = clamp(Number(req.query.min_ev || 0.02), 0, 10);
    const minP = clamp(Number(req.query.min_p || 0.10), 0, 1);
    const mode = String(req.query.mode || "static"); // static or walk

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

    const seasonStats = summarizeSeason(all.filter(m => m.season === season));
    const baseline = baselineProbsFromSeasonStats(seasonStats);

    // Static model: trained on all seasons except test
    const staticKey = `train_excluding_${season}`;
    const staticModel = await getModelFor(staticKey, m => m.season !== season);

    // Walk-forward state
    let walkModel = staticModel;
    const seen = []; // prior test matches

    const testSorted = [...test].sort((a, b) => new Date(a.kickoffISO).getTime() - new Date(b.kickoffISO).getTime());
    const oddsFixed = fixedOddsPack();

    // metrics
    let brier1x2 = 0, logloss1x2_sum = 0, n1x2 = 0, accTop = 0;
    let brier25 = 0, logloss25_sum = 0, n25 = 0;
    let brier35 = 0, logloss35_sum = 0, n35 = 0;

    // baselines (logloss only)
    let baseLL_1x2 = 0, baseLL_25 = 0, baseLL_35 = 0;

    // ROI
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

    function finalizeBins(bins) {
      return bins.map(b => ({ bin: b.bin, n: b.n, pAvg: b.n ? b.pSum / b.n : null, yAvg: b.n ? b.ySum / b.n : null }));
    }

    for (let i = 0; i < testSorted.length; i++) {
      const m = testSorted[i];

      let modelToUse = staticModel;

      if (mode === "walk") {
        if (i > 0 && (i % WALK_REBUILD_EVERY === 0)) {
          const allTrain = all.filter(x => x.season !== season).concat(seen);
          const nextModel = buildModelFromMatches(allTrain, { halfLifeDays: HALF_LIFE_DAYS, minGamesPerTeam: MIN_GAMES_PER_TEAM });

          if (nextModel) {
            const trainPlayed = allTrain.filter(x => x.kickoffISO && x.hg != null && x.ag != null);
            nextModel.calibration = fitTotalsCalibrationForModel(nextModel, trainPlayed) || null;
          }
          walkModel = nextModel || walkModel;
        }
        modelToUse = walkModel || staticModel;
      }

      const probs = matchProbs(modelToUse, m.home, m.away);

      // observed 1x2
      const yH = m.hg > m.ag ? 1 : 0;
      const yD = m.hg === m.ag ? 1 : 0;
      const yA = m.hg < m.ag ? 1 : 0;

      const p = probs.p1x2;

      brier1x2 += (p.H - yH) ** 2 + (p.D - yD) ** 2 + (p.A - yA) ** 2;
      const ll1 = -(yH * logSafe(p.H) + yD * logSafe(p.D) + yA * logSafe(p.A));
      logloss1x2_sum += ll1;
      n1x2 += 1;

      const top = [{ k: "H", v: p.H }, { k: "D", v: p.D }, { k: "A", v: p.A }].sort((a, b) => b.v - a.v)[0];
      const topY = top.k === "H" ? yH : top.k === "D" ? yD : yA;
      accTop += topY;
      addCal(calBins.oneXtwoTop, top.v, topY);

      // totals observed
      const tg = m.hg + m.ag;
      const y25 = tg >= 3 ? 1 : 0;
      const y35 = tg >= 4 ? 1 : 0;

      addCal(calBins.ou25_raw, probs.pOver25_raw, y25);
      addCal(calBins.ou25_cal, probs.pOver25, y25);
      addCal(calBins.ou35_raw, probs.pOver35_raw, y35);
      addCal(calBins.ou35_cal, probs.pOver35, y35);

      brier25 += (probs.pOver25 - y25) ** 2;
      logloss25_sum += -(y25 * logSafe(probs.pOver25) + (1 - y25) * logSafe(1 - probs.pOver25));
      n25 += 1;

      brier35 += (probs.pOver35 - y35) ** 2;
      logloss35_sum += -(y35 * logSafe(probs.pOver35) + (1 - y35) * logSafe(1 - probs.pOver35));
      n35 += 1;

      // baseline logloss accumulation
      baseLL_1x2 += logloss1x2(baseline.p1x2, yH, yD, yA);
      baseLL_25 += loglossBinaryP(baseline.pOver25, y25);
      baseLL_35 += loglossBinaryP(baseline.pOver35, y35);

      // ROI sim using FIXED odds (so bets exist)
      const odds1x2 = oddsFixed.oneXtwo;
      const oddsO25 = oddsFixed.ou25_over;
      const oddsO35 = oddsFixed.ou35_over;

      // 1x2: bet top pick if EV passes
      const topOdds = top.k === "H" ? odds1x2.H : top.k === "D" ? odds1x2.D : odds1x2.A;
      const topP = top.v;
      const topEV = topP * (topOdds - 1) * (1 - COMMISSION) - (1 - topP);
      if (topP >= minP && topEV >= minEv) {
        roi.oneXtwo.bets++; roi.combined.bets++;
        if (topY === 1) { roi.oneXtwo.wins++; roi.combined.wins++; }
        const pr = profit1uBinary(topY === 1, topOdds);
        roi.oneXtwo.profit += pr; roi.combined.profit += pr;
      }

      // OU2.5 Over
      const ev25 = probs.pOver25 * (oddsO25 - 1) * (1 - COMMISSION) - (1 - probs.pOver25);
      if (probs.pOver25 >= minP && ev25 >= minEv) {
        roi.ou25.bets++; roi.combined.bets++;
        if (y25 === 1) { roi.ou25.wins++; roi.combined.wins++; }
        const pr = profit1uBinary(y25 === 1, oddsO25);
        roi.ou25.profit += pr; roi.combined.profit += pr;
      }

      // OU3.5 Over
      const ev35 = probs.pOver35 * (oddsO35 - 1) * (1 - COMMISSION) - (1 - probs.pOver35);
      if (probs.pOver35 >= minP && ev35 >= minEv) {
        roi.ou35.bets++; roi.combined.bets++;
        if (y35 === 1) { roi.ou35.wins++; roi.combined.wins++; }
        const pr = profit1uBinary(y35 === 1, oddsO35);
        roi.ou35.profit += pr; roi.combined.profit += pr;
      }

      if (mode === "walk") seen.push(m);
    }

    const fmtRoi = (x) => ({
      ...x,
      roi: x.bets ? x.profit / x.bets : null,
      winRate: x.bets ? x.wins / x.bets : null
    });

    const modelText = `Poisson+TimeDecay+HA (HL ${HALF_LIFE_DAYS}d) + xG-shrink + Platt(guarded)`;

    res.json({
      meta: {
        season,
        mode,
        trainedOn: SEASON_FEEDS.map(x => x.season).filter(s => s !== season),
        model: modelText,
        thresholds: { minEv, minP },
        xgShrink: { alpha: SHRINK_ALPHA, goalCap: GOAL_CAP },
        roiSim: { type: "fixed_odds", odds: oddsFixed },
        calibration_static: staticModel?.calibration || null
      },
      summary: {
        matches: testSorted.length,
        oneXtwo: {
          topPickAcc: n1x2 ? accTop / n1x2 : null,
          brier: n1x2 ? brier1x2 / n1x2 : null,
          logloss: n1x2 ? logloss1x2_sum / n1x2 : null,
          roi: fmtRoi(roi.oneXtwo)
        },
        ou25: {
          brier: n25 ? brier25 / n25 : null,
          logloss: n25 ? logloss25_sum / n25 : null,
          roi: fmtRoi(roi.ou25)
        },
        ou35: {
          brier: n35 ? brier35 / n35 : null,
          logloss: n35 ? logloss35_sum / n35 : null,
          roi: fmtRoi(roi.ou35)
        },
        combined: fmtRoi(roi.combined),
        baseline: {
          oneXtwo_logloss: baseLL_1x2 / testSorted.length,
          ou25_logloss: baseLL_25 / testSorted.length,
          ou35_logloss: baseLL_35 / testSorted.length
        },
        deltaLogloss: {
          oneXtwo: (logloss1x2_sum / n1x2) - (baseLL_1x2 / testSorted.length),
          ou25: (logloss25_sum / n25) - (baseLL_25 / testSorted.length),
          ou35: (logloss35_sum / n35) - (baseLL_35 / testSorted.length)
        }
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
