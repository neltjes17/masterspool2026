const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Constants ──────────────────────────────────────────────────────────────

const MASTERS_FEED_URL = 'https://www.masters.com/en_US/scores/feeds/2026/scores.json';
const COURSE_PAR = 72;

// In-memory score cache — poll every 60 s during live rounds
const cache = {
  data: null,
  lastFetched: null,      // timestamp of last SUCCESSFUL fetch
  lastAttempt: null,      // timestamp of last fetch attempt (success or failure)
  lastAttemptFailed: false, // true when last attempt returned nothing from either source
  ttl: 60 * 1000,         // 60 seconds
};

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const HISTORY_PATH = path.join(__dirname, 'data', 'standings_history.json');

// Persist per-round standings snapshots so rank deltas survive restarts
function loadStandingsHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); }
  catch { return {}; }
}

function saveRoundSnapshot(round, standings) {
  const history = loadStandingsHistory();
  history[String(round)] = standings.map(s => ({ name: s.name, rank: s.rank }));
  try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2)); }
  catch (err) { console.warn('[history] Failed to save snapshot:', err.message); }
}

// Returns { participantName → rank } for the round before currentRound
function getPreviousRoundRanks(currentRound) {
  const prevRound = currentRound - 1;
  if (prevRound < 1) return {};
  const snapshot = loadStandingsHistory()[String(prevRound)];
  if (!snapshot) return {};
  const ranks = {};
  for (const s of snapshot) ranks[s.name] = s.rank;
  return ranks;
}

// Returns a stale-data warning object when both sources are failing and
// cached data is older than STALE_THRESHOLD_MS, otherwise null.
function getStaleWarning() {
  if (!cache.data || !cache.lastAttemptFailed) return null;
  const ageMs = Date.now() - (cache.lastFetched ?? 0);
  if (ageMs < STALE_THRESHOLD_MS) return null;
  return {
    isStale: true,
    minutesOld: Math.floor(ageMs / 60000),
    lastUpdated: cache.data.lastUpdated,
  };
}

// ── Name helpers ───────────────────────────────────────────────────────────

// Normalize a player name: lowercase, trim, remove accents, handle "Last, First"
function normalizeName(name) {
  if (!name) return '';
  let s = name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // masters.com sometimes returns "McIlroy, Rory" — flip to "rory mcilroy"
  if (s.includes(',')) {
    const [last, first] = s.split(',').map(p => p.trim());
    s = `${first} ${last}`;
  }
  return s;
}

// ── Score parsers ──────────────────────────────────────────────────────────

// Parse a net score string ("E", "-5", "+3", "0") → integer or null
function parseScore(str) {
  if (str === null || str === undefined || str === '') return null;
  const s = String(str).trim();
  if (s === 'E' || s === '0') return 0;
  if (s === '-' || s === '--') return null;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

// Parse a gross score string ("67") → net-to-par integer or null
function grossToNet(grossStr) {
  const g = parseInt(grossStr, 10);
  return isNaN(g) ? null : g - COURSE_PAR;
}

// Parse a "thru" value: "F" → "F", "14" → 14, "" → null
function parseThru(thruStr) {
  const s = String(thruStr ?? '').trim();
  if (s === 'F') return 'F';
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

// ── masters.com feed fetch + parse ────────────────────────────────────────

async function fetchMastersScores() {
  const res = await fetch(MASTERS_FEED_URL, {
    headers: {
      Referer: 'https://www.masters.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`masters.com returned ${res.status}`);
  return res.json();
}

function parseMastersData(json) {
  // Players live at data.player (singular), not data.players
  const rawPlayers = json?.data?.player ?? json?.player ?? [];
  if (rawPlayers.length === 0) return null;

  const players = {};
  for (const raw of rawPlayers) {
    // Each round is now an object: { total: 67, roundStatus: "Finished", scores: [...] }
    const roundDefs = [raw.round1, raw.round2, raw.round3, raw.round4];
    const rounds = roundDefs.map(r => {
      const gross = r?.total;          // integer gross score, null if not played
      const grossInt = parseInt(gross, 10);

      // Hole-by-hole scores: try several field name patterns (varies across feed versions)
      const holesRaw = r?.scores ?? r?.holeScores ?? r?.holes ?? r?.scorecard ?? null;
      let holes = null;
      if (Array.isArray(holesRaw) && holesRaw.length > 0) {
        holes = holesRaw.map((h, i) => {
          if (typeof h === 'number') return { hole: i + 1, score: h, par: null };
          // Values may come as strings ("4") or integers (4)
          const score = parseInt(h.score ?? h.strokes ?? h.value ?? h.s, 10);
          const par   = parseInt(h.par ?? h.p, 10);
          return {
            hole:  parseInt(h.hole ?? h.holeNumber ?? h.number ?? h.n ?? (i + 1), 10) || (i + 1),
            score: isNaN(score) ? null : score,
            par:   isNaN(par)   ? null : par,
          };
        });
      }

      return { score: grossToNet(gross), display: isNaN(grossInt) ? '-' : String(grossInt), holes };
    });
    const currentRound = roundDefs.reduce((last, r, i) =>
      r?.total != null ? i + 1 : last, null);

    // Status: "F"=finished round, "A"=active, "C"/"CUT"=missed cut, "WD"=withdrew, "DQ"=dq
    const s = String(raw.status ?? '').toUpperCase();
    let status = 'active';
    if (s === 'C' || s === 'CUT' || /CUT/i.test(raw.newStatus ?? '')) status = 'cut';
    else if (s === 'WD') status = 'wd';
    else if (s === 'DQ') status = 'dq';

    const name = raw.full_name || raw.display_name;
    if (!name) continue;
    players[normalizeName(name)] = {
      name,
      total: parseScore(raw.topar) ?? 0,
      rounds,
      status,
      thru: parseThru(raw.thru),
      position: raw.pos || '',
      currentRound,
    };
  }

  // Determine current round: highest round number where any player has started
  // (roundStatus !== '' and !== 'pre' means the player has teed off)
  let currentRound = 1;
  for (let r = 4; r >= 1; r--) {
    const key = `round${r}`;
    const anyStarted = rawPlayers.some(p => {
      const rs = (p[key]?.roundStatus ?? '').toLowerCase();
      return rs !== '' && rs !== 'pre';
    });
    if (anyStarted) { currentRound = r; break; }
  }

  // Round is complete when every non-WD/DQ player's roundStatus is "finished"
  const roundKey = `round${currentRound}`;
  const countingPlayers = rawPlayers.filter(p => {
    const s = String(p.status ?? '').toUpperCase();
    return s !== 'WD' && s !== 'DQ';
  });
  const allFinishedRound = countingPlayers.length > 0 &&
    countingPlayers.every(p => (p[roundKey]?.roundStatus ?? '').toLowerCase() === 'finished');

  let eventStatus;
  if (currentRound === 4 && allFinishedRound) eventStatus = 'FINAL';
  else if (allFinishedRound) eventStatus = 'ROUND_COMPLETE';
  else eventStatus = 'IN_PROGRESS';

  return {
    eventName: 'Masters Tournament',
    source: 'masters.com',
    currentRound,
    eventStatus,
    players,
    lastUpdated: new Date().toISOString(),
  };
}

// ── ESPN fallback fetch + parse ────────────────────────────────────────────

const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga';

async function fetchESPNScores() {
  const res = await fetch(ESPN_URL, {
    headers: { 'User-Agent': 'MastersPoolTracker/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  return res.json();
}

function parseESPNData(json) {
  const event = json?.events?.[0];
  const comp = event?.competitions?.[0];
  if (!comp) return null;

  const players = {};
  for (const c of comp.competitors ?? []) {
    const name = c.athlete?.displayName;
    if (!name) continue;

    // c.score is { value: 76, displayValue: "+4" } — use displayValue for net total
    const total = parseScore(c.score?.displayValue) ?? parseScore(c.score) ?? 0;

    // linescores: each { value: 76 (gross), displayValue: "+4" (round net), period: 1 }
    const lsMap = {};
    for (const ls of c.linescores ?? []) {
      if (ls.period) lsMap[ls.period] = ls;
    }
    const rounds = [1, 2, 3, 4].map(period => {
      const ls = lsMap[period];
      if (!ls || ls.value == null) return { score: null, display: '-' };
      const grossInt = parseInt(ls.value, 10);
      return { score: grossToNet(ls.value), display: isNaN(grossInt) ? '-' : String(grossInt) };
    });

    const statusName = c.status?.type?.name ?? '';
    let status = 'active';
    if (/CUT/i.test(statusName)) status = 'cut';
    else if (/WD|WITHDRAWN/i.test(statusName)) status = 'wd';
    else if (/DQ/i.test(statusName)) status = 'dq';

    // thru: ESPN resets to 0 between rounds; use todayDetail "(F)" to detect finished
    let thru = c.status?.thru ?? null;
    if (/\(F\)/i.test(c.status?.todayDetail ?? '')) thru = 'F';
    else if (!thru) thru = null;

    players[normalizeName(name)] = {
      name,
      total,
      rounds,
      status,
      thru,
      position: c.status?.position?.displayName ?? '',
      currentRound: c.status?.period ?? null,
    };
  }

  if (Object.keys(players).length === 0) return null;

  const currentRound = comp.status?.period ?? 1;
  // state: 'pre' | 'in' | 'post'
  const compState = comp.status?.type?.state ?? '';
  const compName  = comp.status?.type?.name  ?? '';
  const roundComplete = compState === 'post' || /COMPLETE/i.test(compName);

  let eventStatus;
  if (roundComplete && currentRound === 4) eventStatus = 'FINAL';
  else if (roundComplete) eventStatus = 'ROUND_COMPLETE';
  else eventStatus = 'IN_PROGRESS';

  return {
    eventName: event.shortName || event.name || 'Masters Tournament',
    source: 'espn',
    currentRound,
    eventStatus,
    players,
    lastUpdated: new Date().toISOString(),
  };
}

// ── Cache / getScores (masters.com → ESPN fallback) ────────────────────────

async function getScores() {
  const now = Date.now();
  if (cache.data && cache.lastFetched && now - cache.lastFetched < cache.ttl) {
    return cache.data;
  }

  // Try masters.com first, fall back to ESPN
  let parsed = null;
  try {
    const raw = await fetchMastersScores();
    parsed = parseMastersData(raw);
    if (parsed) console.log('[scores] Fetched from masters.com');
  } catch (err) {
    console.warn('[scores] masters.com failed:', err.message, '— trying ESPN');
  }

  if (!parsed) {
    try {
      const raw = await fetchESPNScores();
      parsed = parseESPNData(raw);
      if (parsed) console.log('[scores] Fetched from ESPN');
    } catch (err) {
      console.error('[scores] ESPN also failed:', err.message);
    }
  }

  cache.lastAttempt = now;
  cache.lastAttemptFailed = !parsed;

  if (parsed) {
    cache.data = parsed;
    cache.lastFetched = now;
  }
  return cache.data;
}

// Find a pick in the player map using multiple strategies
function findPlayer(pick, playerMap) {
  const pickKey = normalizeName(pick);

  // 1. Exact normalized match
  if (playerMap[pickKey]) return playerMap[pickKey];

  // 2. Scan all players for a match where one contains the other
  for (const [key, player] of Object.entries(playerMap)) {
    if (key.includes(pickKey) || pickKey.includes(key)) return player;
  }

  // 3. Last-name-only match
  const lastName = pickKey.split(' ').pop();
  if (lastName.length >= 4) {
    for (const [key, player] of Object.entries(playerMap)) {
      if (key.endsWith(lastName) || key.includes(lastName)) return player;
    }
  }

  return null;
}

// Format a score integer to display string (+3, E, -5)
function formatScore(n) {
  if (n === null || n === undefined) return 'E';
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `${n}`;
}

// Calculate pool standings from participants + live scores
function calculateStandings(participants, scores) {
  const playerMap = scores?.players ?? {};

  const standings = participants.map(participant => {
    const picks = participant.picks.map(pick => {
      const found = findPlayer(pick, playerMap);
      return {
        name: found ? found.name : pick,
        pickInput: pick,
        total: found ? found.total : 0,
        rounds: found ? found.rounds : [],
        status: found ? found.status : 'unknown',
        thru: found ? found.thru : null,
        position: found ? found.position : '',
        currentRound: found ? found.currentRound : null,
        found: !!found,
      };
    });

    // Best 4 = 4 lowest (best) scores; sort ascending
    const sorted = [...picks].sort((a, b) => a.total - b.total);
    const best4 = sorted.slice(0, 4);
    const bench = sorted.slice(4);
    const total = best4.reduce((sum, p) => sum + p.total, 0);

    return {
      name: participant.name,
      total,
      totalDisplay: formatScore(total),
      best4: best4.map(p => ({ ...p, totalDisplay: formatScore(p.total) })),
      bench: bench.map(p => ({ ...p, totalDisplay: formatScore(p.total) })),
    };
  });

  // Sort by total score ascending (lowest wins)
  standings.sort((a, b) => a.total - b.total);

  // Apply tied ranks
  for (let i = 0; i < standings.length; i++) {
    if (i > 0 && standings[i].total === standings[i - 1].total) {
      standings[i].rank = standings[i - 1].rank;
    } else {
      standings[i].rank = i + 1;
    }
  }

  return standings;
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Pool standings
app.get('/api/standings', async (req, res) => {
  try {
    const dataPath = path.join(__dirname, 'data', 'participants.json');
    let participants = [];
    if (fs.existsSync(dataPath)) {
      const raw = fs.readFileSync(dataPath, 'utf8');
      participants = JSON.parse(raw).participants ?? [];
    }

    const scores = await getScores();
    const standings = calculateStandings(participants, scores);

    // Snapshot standings when a round finishes so next round can show deltas
    if (scores && scores.eventStatus !== 'IN_PROGRESS') {
      saveRoundSnapshot(scores.currentRound, standings);
    }

    // Attach rank delta (positive = moved up) vs previous round snapshot
    const prevRanks = scores ? getPreviousRoundRanks(scores.currentRound) : {};
    const standingsWithDelta = standings.map(s => ({
      ...s,
      rankDelta: prevRanks[s.name] !== undefined ? prevRanks[s.name] - s.rank : null,
    }));

    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=30');
    res.json({
      standings: standingsWithDelta,
      eventInfo: scores
        ? {
            eventName: scores.eventName,
            lastUpdated: scores.lastUpdated,
            currentRound: scores.currentRound,
            eventStatus: scores.eventStatus,
          }
        : null,
      hasParticipants: participants.length > 0,
      participantCount: participants.length,
      staleWarning: getStaleWarning(),
    });
  } catch (err) {
    console.error('[standings]', err);
    res.status(500).json({ error: err.message });
  }
});

// Full leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const scores = await getScores();
    if (!scores) return res.json({ players: [], lastUpdated: null, eventName: null });

    // Build set of all picked player keys for highlighting
    const dataPath = path.join(__dirname, 'data', 'participants.json');
    const pickedKeys = new Set();
    if (fs.existsSync(dataPath)) {
      const raw = fs.readFileSync(dataPath, 'utf8');
      const participants = JSON.parse(raw).participants ?? [];
      for (const p of participants) {
        for (const pick of p.picks ?? []) {
          const found = findPlayer(pick, scores.players);
          if (found) pickedKeys.add(normalizeName(found.name));
        }
      }
    }

    const players = Object.values(scores.players).sort((a, b) => {
      // WD/DQ players always sort to the bottom
      const aOut = a.status === 'wd' || a.status === 'dq';
      const bOut = b.status === 'wd' || b.status === 'dq';
      if (aOut !== bOut) return aOut ? 1 : -1;
      return a.total - b.total;
    });
    const formatted = players.map(p => ({
      ...p,
      totalDisplay: formatScore(p.total),
      inPool: pickedKeys.has(normalizeName(p.name)),
    }));

    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=30');
    res.json({
      players: formatted,
      eventName: scores.eventName,
      currentRound: scores.currentRound,
      lastUpdated: scores.lastUpdated,
      staleWarning: getStaleWarning(),
    });
  } catch (err) {
    console.error('[leaderboard]', err);
    res.status(500).json({ error: err.message });
  }
});

// Force refresh cache
app.post('/api/refresh', async (req, res) => {
  cache.lastFetched = null;
  const scores = await getScores();
  res.json({ ok: true, source: scores?.source ?? null, lastUpdated: scores?.lastUpdated ?? null });
});

// Hole data diagnostic — confirm holes are parsed and included in player rounds
app.get('/api/holes-check', async (req, res) => {
  const scores = await getScores();
  if (!scores) return res.json({ ok: false, error: 'No score data' });
  const sample = Object.values(scores.players).slice(0, 3).map(p => ({
    name: p.name,
    source: scores.source,
    currentRound: scores.currentRound,
    roundsCount: p.rounds?.length ?? 0,
    r1: {
      score: p.rounds?.[0]?.score,
      display: p.rounds?.[0]?.display,
      holesType: Array.isArray(p.rounds?.[0]?.holes) ? `Array(${p.rounds[0].holes.length})` : String(p.rounds?.[0]?.holes),
      firstHole: p.rounds?.[0]?.holes?.[0] ?? null,
    },
    r2: {
      score: p.rounds?.[1]?.score,
      holesType: Array.isArray(p.rounds?.[1]?.holes) ? `Array(${p.rounds[1].holes.length})` : String(p.rounds?.[1]?.holes),
    },
  }));
  res.json({ ok: true, sample });
});

// Debug — raw responses from both sources (useful for diagnosing parsing issues)
app.get('/api/debug', async (req, res) => {
  const results = {};

  try {
    const raw = await fetchMastersScores();
    const parsed = parseMastersData(raw);
    // Walk up to 3 levels deep to expose the actual shape
    const topLevelKeys = Object.keys(raw ?? {});
    const secondLevel = {};
    for (const k of topLevelKeys) {
      const v = raw[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        secondLevel[k] = Object.keys(v);
      } else if (Array.isArray(v)) {
        secondLevel[k] = `Array(${v.length})`;
      } else {
        secondLevel[k] = v;
      }
    }
    // Find any array that looks like it might contain players
    const arrayPaths = [];
    function findArrays(obj, path = '') {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        const p = path ? `${path}.${k}` : k;
        if (Array.isArray(v)) arrayPaths.push({ path: p, length: v.length, sample: v[0] });
        else if (typeof v === 'object') findArrays(v, p);
      }
    }
    findArrays(raw);
    // Expose raw round objects from first player so we can verify hole score fields
    const sampleRaw = raw?.data?.player?.[0] ?? raw?.player?.[0] ?? null;
    // Show every key on the player and full round1/round2 objects
    const samplePlayerKeys = sampleRaw ? Object.keys(sampleRaw) : [];
    const samplePlayerRound1 = sampleRaw?.round1 ?? null;
    const samplePlayerRound2 = sampleRaw?.round2 ?? null;
    // Also show any top-level array fields (might contain hole scores)
    const samplePlayerArrayFields = sampleRaw
      ? Object.fromEntries(
          Object.entries(sampleRaw)
            .filter(([, v]) => Array.isArray(v))
            .map(([k, v]) => [k, { length: v.length, first: v[0] }])
        )
      : {};
    results.masters = {
      ok: true,
      playerCount: parsed ? Object.keys(parsed.players).length : 0,
      topLevelKeys,
      secondLevel,
      arrayPaths: arrayPaths.slice(0, 15),
      samplePlayerKeys,
      samplePlayerRound1,
      samplePlayerRound2,
      samplePlayerArrayFields,
    };
  } catch (err) {
    results.masters = { ok: false, error: err.message };
  }

  try {
    const raw = await fetchESPNScores();
    const parsed = parseESPNData(raw);
    results.espn = {
      ok: true,
      eventName: raw?.events?.[0]?.name ?? null,
      playerCount: parsed ? Object.keys(parsed.players).length : 0,
      topKeys: Object.keys(parsed?.players ?? {}).slice(0, 5),
      sampleRaw: raw?.events?.[0]?.competitions?.[0]?.competitors?.[0] ?? null,
    };
  } catch (err) {
    results.espn = { ok: false, error: err.message };
  }

  results.cache = {
    hasData: !!cache.data,
    source: cache.data?.source ?? null,
    playerCount: cache.data ? Object.keys(cache.data.players).length : 0,
    lastFetched: cache.lastFetched ? new Date(cache.lastFetched).toISOString() : null,
  };

  res.json(results);
});

// Export for Vercel (serverless); also listen when run directly (local dev)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Masters Pool Tracker → http://localhost:${PORT}`);
  });
}

module.exports = app;
