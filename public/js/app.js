/* Masters Pool Tracker 2026 – Frontend */

const REFRESH_INTERVAL = 3 * 60 * 1000; // 3 minutes

// ── Utility helpers ────────────────────────────────────────────────────────

function scoreClass(n) {
  if (n < 0) return 'under';
  if (n > 0) return 'over';
  return 'even';
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function roundLabel(round, status) {
  if (!round) return '';
  const labels = { 1: 'Round 1', 2: 'Round 2', 3: 'Round 3', 4: 'Round 4' };
  const base = labels[round] || `Round ${round}`;
  if (/COMPLETE/i.test(status || '') && round === 4) return 'Final';
  if (/COMPLETE/i.test(status || '')) return base + ' · Complete';
  return base + ' · In Progress';
}

// ── Standings rendering ────────────────────────────────────────────────────

function renderPickChip(pick, isCounting) {
  const chip = el('div', `pick-chip${isCounting ? ' counting' : ''}${pick.status === 'cut' ? ' cut-player' : ''}`);

  if (isCounting) {
    chip.appendChild(el('span', 'count-dot'));
  }

  const nameSpan = el('span', 'pick-name', escHtml(pick.name));
  chip.appendChild(nameSpan);

  const meta = el('div', '', '');
  meta.style.display = 'flex';
  meta.style.flexDirection = 'column';
  meta.style.alignItems = 'flex-end';

  const scoreSpan = el('span', `pick-score ${scoreClass(pick.total)}`, pick.totalDisplay);
  meta.appendChild(scoreSpan);

  if (pick.status === 'cut') {
    meta.appendChild(el('span', 'pick-status', 'CUT'));
  } else if (pick.status === 'wd') {
    meta.appendChild(el('span', 'pick-status', 'WD'));
  } else if (pick.thru !== null && pick.thru !== undefined) {
    const thruText = pick.thru === 18 ? 'F' : `Thru ${pick.thru}`;
    meta.appendChild(el('span', 'pick-status', thruText));
  }

  chip.appendChild(meta);
  return chip;
}

function renderStandingCard(standing) {
  const isFirst = standing.rank === 1;
  const card = el('div', `standing-card${isFirst ? ' rank-1' : ''}`);

  // Card header
  const header = el('div', 'card-header');
  header.appendChild(el('div', 'rank-number', standing.rank === 1 ? '&#127942;' : `${standing.rank}`));
  header.appendChild(el('div', 'participant-name', escHtml(standing.name)));

  const scoreBlock = el('div', '');
  scoreBlock.style.textAlign = 'right';
  scoreBlock.appendChild(el('div', `total-score ${scoreClass(standing.total)}`, standing.totalDisplay));
  scoreBlock.appendChild(el('div', 'score-label', 'Total'));
  header.appendChild(scoreBlock);

  card.appendChild(header);

  // Best 4 picks
  const picks = el('div', 'card-picks');
  picks.appendChild(el('div', 'picks-label', 'Counting picks (best 4)'));
  const grid = el('div', 'picks-grid');
  for (const pick of standing.best4) {
    grid.appendChild(renderPickChip(pick, true));
  }
  picks.appendChild(grid);

  // Bench picks
  if (standing.bench && standing.bench.length > 0) {
    const bench = el('div', 'bench-section');
    bench.style.marginTop = '10px';
    bench.appendChild(el('div', 'picks-label', 'Bench'));
    const benchGrid = el('div', 'picks-grid');
    for (const pick of standing.bench) {
      benchGrid.appendChild(renderPickChip(pick, false));
    }
    bench.appendChild(benchGrid);
    picks.appendChild(bench);
  }

  card.appendChild(picks);
  return card;
}

function renderStandings(data) {
  const container = document.getElementById('standingsContainer');
  container.innerHTML = '';

  if (!data.hasParticipants) {
    container.appendChild(el('div', 'empty-state', 'No participants loaded yet. Add picks to <code>data/participants.json</code>.'));
    return;
  }

  if (!data.standings || data.standings.length === 0) {
    container.appendChild(el('div', 'empty-state', 'No standings available.'));
    return;
  }

  for (const standing of data.standings) {
    container.appendChild(renderStandingCard(standing));
  }
}

// ── Leaderboard rendering ──────────────────────────────────────────────────

function renderLeaderboard(data) {
  const container = document.getElementById('leaderboardContainer');
  container.innerHTML = '';

  if (!data.players || data.players.length === 0) {
    container.appendChild(el('div', 'empty-state', 'Leaderboard data unavailable. Scores will appear once the tournament begins.'));
    return;
  }

  const table = document.createElement('table');
  table.className = 'lb-table';

  // Header
  table.innerHTML = `
    <thead>
      <tr>
        <th>Pos</th>
        <th>Player</th>
        <th class="num">Total</th>
        <th class="num">R1</th>
        <th class="num">R2</th>
        <th class="num">R3</th>
        <th class="num">R4</th>
        <th class="num">Thru</th>
      </tr>
    </thead>`;

  const tbody = document.createElement('tbody');

  // Determine cut line and WD section positions
  const CUT_POSITION = 50;
  const players = data.players;
  // WD/DQ players are already sorted to the bottom by the server
  const wdStartIndex = players.findIndex(p => p.status === 'wd' || p.status === 'dq');
  const nonWdCount = wdStartIndex === -1 ? players.length : wdStartIndex;

  // Find cut line: after the 50th player, extended through ties with same score
  let cutAfterIndex = -1;
  if (nonWdCount > CUT_POSITION) {
    cutAfterIndex = CUT_POSITION - 1; // 0-indexed
    const cutScore = players[cutAfterIndex].total;
    while (cutAfterIndex + 1 < nonWdCount && players[cutAfterIndex + 1].total === cutScore) {
      cutAfterIndex++;
    }
  }

  for (let i = 0; i < players.length; i++) {
    const player = players[i];

    // Insert cut line divider after the last player making the cut
    if (cutAfterIndex >= 0 && i === cutAfterIndex + 1) {
      const cutRow = document.createElement('tr');
      cutRow.className = 'divider-row cut-divider-row';
      const cutTd = document.createElement('td');
      cutTd.colSpan = 8;
      cutTd.className = 'divider-cell';
      cutTd.textContent = '— CUT —';
      cutRow.appendChild(cutTd);
      tbody.appendChild(cutRow);
    }

    // Insert WD section divider before first WD player
    if (wdStartIndex >= 0 && i === wdStartIndex) {
      const wdRow = document.createElement('tr');
      wdRow.className = 'divider-row wd-divider-row';
      const wdTd = document.createElement('td');
      wdTd.colSpan = 8;
      wdTd.className = 'divider-cell';
      wdTd.textContent = '— WITHDRAWN —';
      wdRow.appendChild(wdTd);
      tbody.appendChild(wdRow);
    }

    const tr = document.createElement('tr');

    // Highlight if in pool (inPool flag set by server)
    if (player.inPool) tr.classList.add('in-pool');
    if (player.status === 'cut') tr.classList.add('is-cut');

    // Position
    const tdPos = el('td', 'lb-pos', escHtml(player.position || ''));
    tr.appendChild(tdPos);

    // Name
    const tdName = el('td', 'lb-name', escHtml(player.name));
    if (player.inPool) {
      tdName.innerHTML += '<span class="pool-indicator" title="In pool"></span>';
    }
    tr.appendChild(tdName);

    // Total
    const cls = `lb-score-${scoreClass(player.total)}`;
    tr.appendChild(el('td', `num ${cls}`, player.totalDisplay));

    // Round scores
    for (let i = 0; i < 4; i++) {
      const r = player.rounds?.[i];
      const val = r?.display ?? '-';
      const rCls = r?.score != null ? `lb-round ${scoreClass(r.score)}` : 'lb-round';
      tr.appendChild(el('td', `num ${rCls}`, escHtml(val)));
    }

    // Thru / status
    let thruContent = '-';
    if (player.status === 'cut') {
      thruContent = '<span class="lb-status-cut">CUT</span>';
    } else if (player.status === 'wd') {
      thruContent = '<span class="lb-status-wd">WD</span>';
    } else if (player.thru !== null && player.thru !== undefined) {
      thruContent = player.thru === 18 ? 'F' : `${player.thru}`;
    }
    const tdThru = el('td', 'num lb-thru', thruContent);
    tr.appendChild(tdThru);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  container.appendChild(table);

  const legend = el('div', 'pool-legend');
  legend.innerHTML = '<span class="dot"></span> Player is in someone\'s pool picks';
  container.appendChild(legend);
}

// ── Stale data banner ──────────────────────────────────────────────────────

let staleBannerDismissed = false;

function updateStaleBanner(staleWarning) {
  const banner = document.getElementById('staleBanner');
  if (!banner) return;
  if (staleBannerDismissed) return;

  if (staleWarning?.isStale) {
    const msg = document.getElementById('staleMessage');
    if (msg) {
      msg.textContent = `Score data is ${staleWarning.minutesOld} minute${staleWarning.minutesOld !== 1 ? 's' : ''} old — live sources are temporarily unavailable.`;
    }
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

// ── Header updates ─────────────────────────────────────────────────────────

function updateHeader(eventInfo) {
  if (!eventInfo) return;

  const nameEl = document.getElementById('eventName');
  if (nameEl && eventInfo.eventName) {
    nameEl.textContent = eventInfo.eventName + ' · Augusta National';
  }

  const badge = document.getElementById('roundBadge');
  if (badge) {
    badge.textContent = roundLabel(eventInfo.currentRound, eventInfo.eventStatus);
  }

  const ts = document.getElementById('lastUpdated');
  if (ts) ts.textContent = formatTime(eventInfo.lastUpdated);
}

// ── Fetch & render ─────────────────────────────────────────────────────────

async function loadStandings() {
  try {
    const res = await fetch('/api/standings');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderStandings(data);
    updateHeader(data.eventInfo);
    updateStaleBanner(data.staleWarning);
  } catch (err) {
    document.getElementById('standingsContainer').innerHTML =
      `<div class="error-state">Could not load standings: ${escHtml(err.message)}</div>`;
  }
}

async function loadLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderLeaderboard(data);
    // Update timestamp if standings hasn't run yet
    if (data.lastUpdated) {
      const ts = document.getElementById('lastUpdated');
      if (ts && ts.textContent === '—') ts.textContent = formatTime(data.lastUpdated);
    }
  } catch (err) {
    document.getElementById('leaderboardContainer').innerHTML =
      `<div class="error-state">Could not load leaderboard: ${escHtml(err.message)}</div>`;
  }
}

async function refreshAll(showSpinner = false) {
  const btn = document.getElementById('refreshBtn');
  if (showSpinner && btn) btn.classList.add('spinning');

  await Promise.all([loadStandings(), loadLeaderboard()]);

  if (btn) btn.classList.remove('spinning');
}

// ── XSS protection ─────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  refreshAll();
  setInterval(() => refreshAll(), REFRESH_INTERVAL);

  document.getElementById('refreshBtn')?.addEventListener('click', () => refreshAll(true));

  document.getElementById('staleDismiss')?.addEventListener('click', () => {
    staleBannerDismissed = true;
    document.getElementById('staleBanner').hidden = true;
  });
});
