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
  lastFetched: null,
  ttl: 60 * 1000, // 60 seconds
};

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

// ── masters.com feed fetch ─────────────────────────────────────────────────

async function fetchMastersScores() {
  const res = await fetch(MASTERS_FEED_URL, {
    headers: {
      Referer: 'https://www.masters.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`masters.com feed returned ${res.status}`);
  return res.json();
}

// ── masters.com feed parser ────────────────────────────────────────────────

// Parse a single player entry from the masters.com feed.
// Normalizes into the internal shape used by the rest of the server:
//   { name, total, rounds[{score,display}], status, thru, position, currentRound }
function parsePlayer(raw) {
  const roundDefs = [
    { round: 1, gross: raw.round1 },
    { round: 2, gross: raw.round2 },
    { round: 3, gross: raw.round3 },
    { round: 4, gross: raw.round4 },
  ];

  const rounds = roundDefs.map(({ gross }) => {
    const net = grossToNet(gross);
    const grossInt = parseInt(gross, 10);
    return {
      score: net,                          // net-to-par (null if not played)
      display: isNaN(grossInt) ? '-' : String(grossInt),  // gross score string
    };
  });

  // Current round = last round that has a gross score
  const currentRound = roundDefs.reduce((last, { round, gross }) => {
    return parseInt(gross, 10) > 0 ? round : last;
  }, null);

  const status = (raw.status || 'active').toLowerCase();

  return {
    name: raw.full_name || raw.display_name,
    total: parseScore(raw.topar) ?? 0,   // overall net score
    rounds,
    status,                               // active | cut | wd | dq
    thru: parseThru(raw.thru),
    position: raw.pos || '',
    currentRound,
  };
}

// Parse the full masters.com JSON payload → internal players map
function parseMastersData(json) {
  const rawPlayers = json?.data?.players ?? json?.players ?? [];
  if (rawPlayers.length === 0) return null;

  const players = {};
  for (const raw of rawPlayers) {
    const player = parsePlayer(raw);
    if (!player.name) continue;
    players[normalizeName(player.name)] = player;
  }

  // Derive current round from the field
  const activePlayers = Object.values(players).filter(p => p.status === 'active');
  const currentRound = activePlayers.reduce((max, p) => Math.max(max, p.currentRound ?? 1), 1);

  // Derive event status
  const allFinished = activePlayers.every(p => p.thru === 'F' || p.thru === 18);
  const eventStatus = (currentRound === 4 && allFinished) ? 'FINAL' : 'IN_PROGRESS';

  return {
    eventName: 'Masters Tournament',
    currentRound,
    eventStatus,
    players,
    lastUpdated: new Date().toISOString(),
  };
}

// ── Cache / getScores ──────────────────────────────────────────────────────

async function getScores() {
  const now = Date.now();
  if (cache.data && cache.lastFetched && now - cache.lastFetched < cache.ttl) {
    return cache.data;
  }

  try {
    const raw = await fetchMastersScores();
    const parsed = parseMastersData(raw);
    if (parsed) {
      cache.data = parsed;
      cache.lastFetched = now;
    }
    return cache.data;
  } catch (err) {
    console.error('[scores] Fetch failed:', err.message);
    return cache.data; // return stale data rather than nothing
  }
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

    res.json({
      standings,
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

    const players = Object.values(scores.players).sort((a, b) => a.total - b.total);
    const formatted = players.map(p => ({
      ...p,
      totalDisplay: formatScore(p.total),
      inPool: pickedKeys.has(normalizeName(p.name)),
    }));

    res.json({
      players: formatted,
      eventName: scores.eventName,
      currentRound: scores.currentRound,
      lastUpdated: scores.lastUpdated,
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
  res.json({ ok: true, lastUpdated: scores?.lastUpdated ?? null });
});

app.listen(PORT, () => {
  console.log(`Masters Pool Tracker → http://localhost:${PORT}`);
});
