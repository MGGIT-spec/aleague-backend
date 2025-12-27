const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ---- CONFIG ----
const FIXTURES_URL = "https://fixturedownload.com/feed/json/aleague-men-2025";
const BRISBANE_TZ = "Australia/Brisbane";
const FIXTURE_CACHE_MS = 6 * 60 * 60 * 1000; // 6h cache (Render free is slow if you hit external URLs too often)

// ---- HEALTH (helps your HTML warm-up) ----
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// ---- tiny helpers ----
function pick(obj, keys, fallback = null) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

function parseDateFlexible(v) {
  if (!v) return null;

  // If it’s already a Date-ish string
  const asDate = new Date(v);
  if (!isNaN(asDate.getTime())) return asDate;

  // Handle "dd/mm/yyyy" or "dd/mm/yyyy hh:mm"
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]) - 1;
    const yyyy = Number(m[3]);
    const hh = m[4] ? Number(m[4]) : 0;
    const min = m[5] ? Number(m[5]) : 0;
    // Create a Date in UTC first; we’ll display in Brisbane TZ later
    return new Date(Date.UTC(yyyy, mm, dd, hh, min, 0));
  }

  return null;
}

function formatKickoffLocal(dateObj) {
  if (!dateObj) return "TBC";
  // e.g. "Sat 6:00 PM"
  return dateObj.toLocaleString("en-AU", {
    timeZone: BRISBANE_TZ,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function todayISOinTZ() {
  // "YYYY-MM-DD" in Brisbane time
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: BRISBANE_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const day = parts.find(p => p.type === "day")?.value;
  return `${y}-${m}-${day}`;
}

// ---- fixture cache ----
let fixtureCache = { ts: 0, data: [] };

async function ensureFetch() {
  if (typeof fetch === "function") return fetch;
  // fallback if environment doesn’t have global fetch (rare on modern Render)
  const nodeFetch = await import("node-fetch");
  return nodeFetch.default;
}

async function loadFixtures() {
  const now = Date.now();
  if (fixtureCache.data.length && (now - fixtureCache.ts) < FIXTURE_CACHE_MS) {
    return fixtureCache.data;
  }

  const _fetch = await ensureFetch();
  const r = await _fetch(FIXTURES_URL, { headers: { "accept": "application/json" } });
  if (!r.ok) throw new Error(`fixtures fetch failed: HTTP ${r.status}`);
  const json = await r.json();

  // The feed *should* be an array, but we handle objects too
  const rows = Array.isArray(json) ? json : (json?.data || json?.matches || json?.fixtures || []);

  fixtureCache = { ts: now, data: rows };
  return rows;
}

// Convert fixture row -> your UI match shape (with placeholder markets for now)
function rowToMatch(row) {
  // Try multiple possible schema keys (they warn schema may change)
  const home = pick(row, ["Home Team", "HomeTeam", "homeTeam", "home", "team_home", "Home"]);
  const away = pick(row, ["Away Team", "AwayTeam", "awayTeam", "away", "team_away", "Away"]);
  const location = pick(row, ["Location", "Venue", "venue", "stadium"], "");
  const round = pick(row, ["Round Number", "RoundNumber", "round", "matchday"], "");
  const rawDate = pick(row, ["Date", "date", "Kickoff", "kickoff", "Start", "start_time"], null);
  const dt = parseDateFlexible(rawDate);

  // placeholder markets (we’ll replace with model + Betfair odds next)
  const probs = { H: 0.40, D: 0.27, A: 0.33 }; // neutral-ish
  const odds = { H: null, D: null, A: null };  // live odds will overwrite later

  return {
    league: `A-LEAGUE (MEN)${round ? ` • Round ${round}` : ""}${location ? ` • ${location}` : ""}`,
    kickoffLocal: formatKickoffLocal(dt),
    home: home || "TBD",
    away: away || "TBD",
    kickoffISO: dt ? dt.toISOString() : null,
    markets: {
      "1x2": { probs, odds },
      "ou25": { line: 2.5, probOver: 0.56, oddsOver: null },
      "ou35": { line: 3.5, probOver: 0.33, oddsOver: null }
    }
  };
}

// ---- API: fixtures only (debug) ----
app.get("/api/fixtures", async (req, res) => {
  try {
    const iso = (req.query.date || todayISOinTZ()).trim(); // YYYY-MM-DD in Brisbane time
    const start = new Date(iso + "T00:00:00Z");
    const end = new Date(iso + "T23:59:59Z");

    const rows = await loadFixtures();
    const matches = rows
      .map(rowToMatch)
      .filter(m => {
        if (!m.kickoffISO) return true; // keep TBC
        const t = new Date(m.kickoffISO).getTime();
        return t >= start.getTime() && t <= end.getTime();
      });

    res.json({ source: "fixturedownload", date: iso, count: matches.length, matches });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---- API: value (your dashboard uses this) ----
app.get("/api/value", async (req, res) => {
  try {
    const iso = (req.query.date || todayISOinTZ()).trim();

    // Return fixtures for the requested day.
    // If none that day, return the next N upcoming fixtures (so UI isn't empty).
    const rows = await loadFixtures();
    const all = rows.map(rowToMatch);

    const dayStart = new Date(iso + "T00:00:00Z").getTime();
    const dayEnd = new Date(iso + "T23:59:59Z").getTime();

    let matches = all.filter(m => {
      if (!m.kickoffISO) return false;
      const t = new Date(m.kickoffISO).getTime();
      return t >= dayStart && t <= dayEnd;
    });

    if (matches.length === 0) {
      // pick next 12 upcoming
      const now = Date.now();
      matches = all
        .filter(m => m.kickoffISO && new Date(m.kickoffISO).getTime() >= now - 6 * 60 * 60 * 1000)
        .sort((a, b) => new Date(a.kickoffISO).getTime() - new Date(b.kickoffISO).getTime())
        .slice(0, 12);
    }

    res.json({
      access: { used: 1, max: 19 },
      matches
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log("Server running on", PORT));
