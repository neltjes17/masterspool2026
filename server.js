const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory score cache
const cache = {
  data: null,
  lastFetched: null,
  ttl: 3 * 60 * 1000, // 3 minutes
};

// Normalize a player name for matching: lowercase, trim, remove accents
function normalizeName(name) {
  return name
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Parse a golf score string to integer (e.g. "E" -> 0, "-5" -> -5, "+3" -> 3)
function parseScore(str) {
  if (!str || str === '-' || str === '--') return null;
  if (str === 'E' || str === 'Even') return 0;
  const n = parseInt(str, 10);
  return isNaN(n) ? null : n;
}

// Fetch live Masters/PGA leaderboard from ESPN's unofficial API
async function fetchESPNScores() {
  const url = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/leaderboard';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MastersPoolTracker/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ESPN API returned ${res.status}`);
  return res.json();
}

// Parse ESPN response into a flat player map keyed by normalized name
function parseESPNData(espnJson) {
  const event = espnJson?.events?.[0];
  if (!event) return null;

  const comp = event.competitions?.[0];
  if (!comp) return null;

  const players = {};

  for (const competitor of comp.competitors || []) {
    const displayName = competitor.athlete?.displayName;
    if (!displayName) continue;

    const key = normalizeName(displayName);
    const totalStr = competitor.score;
    const total = parseScore(totalStr) ?? 0;

    // Round-by-round scores
    const rounds = (competitor.linescores || []).map(ls => ({
      score: parseScore(ls.value),
      display: ls.value ?? '-',
    }));

    // Status: CUT, WD, DQ, active, complete
    const statusName = competitor.status?.type?.name ?? '';
    let status = 'active';
    if (/CUT/i.test(statusName)) status = 'cut';
    else if (/WD/i.test(statusName) || /WITHDRAWN/i.test(statusName)) status = 'wd';
    else if (/DQ/i.test(statusName)) status = 'dq';
    else if (/COMPLETE/i.test(statusName)) status = 'complete';

    const thru = competitor.status?.thru ?? null;
    const position = competitor.status?.position?.displayText ?? '';
    const currentRound = competitor.status?.period ?? null;

    players[key] = {
      name: displayName,
      total,
      rounds,
      status,
      thru,
      position,
      currentRound,
    };
  }

  const currentRound = comp.status?.period ?? 1;
  const compStatus = comp.status?.type?.name ?? '';

  return {
    eventName: event.shortName || event.name || 'Masters Tournament',
    currentRound,
    eventStatus: compStatus,
    players,
    lastUpdated: new Date().toISOString(),
  };
}

// Get scores from cache or fetch fresh
async function getScores() {
  const now = Date.now();
  if (cache.data && cache.lastFetched && now - cache.lastFetched < cache.ttl) {
    return cache.data;
  }

  try {
    const raw = await fetchESPNScores();
    const parsed = parseESPNData(raw);
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
