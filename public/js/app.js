/* Masters Pool Tracker 2026 – Frontend */

const REFRESH_INTERVAL = 3 * 60 * 1000; // 3 minutes

// ── Utility helpers ────────────────────────────────────────────────────────

function scoreClass(n) {
  if (n < 0) return 'under';
  if (n > 0) return 'over';
  return 'even';
}

function formatNet(n) {
  if (n === null || n === undefined) return '—';
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `${n}`;
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
  if (status === 'FINAL') return 'Final';
  if (status === 'ROUND_COMPLETE') return `${base} \u00b7 Completed`;
  return `${base} \u00b7 In Progress`;
}

// ── Standings rendering ────────────────────────────────────────────────────

function renderPickChip(pick, isCounting, currentRound) {
  const chip = el('div', `pick-chip${isCounting ? ' counting' : ''}${pick.status === 'cut' ? ' cut-player' : ''}`);

  // ── Top row: dot · name · total/status ──────────────────────────────────
  const top = el('div', 'chip-top');

  if (isCounting) top.appendChild(el('span', 'count-dot'));

  top.appendChild(el('span', 'pick-name', escHtml(pick.name)));

  const meta = el('div', 'chip-meta');
  meta.appendChild(el('span', `pick-score ${scoreClass(pick.total)}`, pick.totalDisplay));

  if (pick.status === 'cut') {
    meta.appendChild(el('span', 'pick-status', 'CUT'));
  } else if (pick.status === 'wd') {
    meta.appendChild(el('span', 'pick-status', 'WD'));
  } else if (pick.thru !== null && pick.thru !== undefined) {
    const thruVal = pick.thru;
    const isFinished = thruVal === 'F' || thruVal === 18;
    const isMidRound = !isFinished && typeof thruVal === 'number' && thruVal > 0;

    if (isCounting && isMidRound && currentRound) {
      const roundScore = pick.rounds?.[currentRound - 1]?.score ?? null;
      if (roundScore !== null && roundScore !== 0) {
        const isImproving = roundScore < 0;
        const arrow = isImproving ? '\u25b2' : '\u25bc'; // ▲ ▼
        const cls = isImproving ? 'pick-movement trending-up' : 'pick-movement trending-down';
        meta.appendChild(el('span', cls, `${arrow} ${formatNet(roundScore)} · Thru ${thruVal}`));
      } else {
        meta.appendChild(el('span', 'pick-status', `Thru ${thruVal}`));
      }
    } else {
      meta.appendChild(el('span', 'pick-status', isFinished ? 'F' : `Thru ${thruVal}`));
    }
  }

  top.appendChild(meta);
  chip.appendChild(top);

  // ── Round scores row (counting chips only, when any round has been played) ─
  if (isCounting) {
    const rounds = pick.rounds ?? [];
    const hasAnyRound = rounds.some(r => r.score !== null && r.score !== undefined);
    if (hasAnyRound) {
      const roundsRow = el('div', 'chip-rounds');
      ['R1', 'R2', 'R3', 'R4'].forEach((label, i) => {
        const r = rounds[i];
        const played = r?.score !== null && r?.score !== undefined;
        const roundEl = el('div', `chip-round${played ? '' : ' not-played'}`);
        roundEl.appendChild(el('span', 'chip-round-label', label));
        roundEl.appendChild(el('span', played ? `chip-round-score ${scoreClass(r.score)}` : 'chip-round-score', played ? formatNet(r.score) : '—'));
        roundsRow.appendChild(roundEl);
      });
      chip.appendChild(roundsRow);
    }
  }

  return chip;
}

function renderStandingCard(standing, currentRound) {
  const isFirst = standing.rank === 1;
  const card = el('div', `standing-card${isFirst ? ' rank-1' : ''}`);

  // Card header
  const header = el('div', 'card-header');

  // Rank + delta
  const rankWrap = el('div', 'rank-wrap');
  rankWrap.appendChild(el('div', 'rank-number', standing.rank === 1 ? '&#127942;' : `${standing.rank}`));
  if (standing.rankDelta !== null && standing.rankDelta !== undefined) {
    let cls, text;
    if (standing.rankDelta > 0)      { cls = 'rank-delta up';   text = `&#9650;${standing.rankDelta}`; }
    else if (standing.rankDelta < 0) { cls = 'rank-delta down'; text = `&#9660;${Math.abs(standing.rankDelta)}`; }
    else                             { cls = 'rank-delta same'; text = '&mdash;'; }
    rankWrap.appendChild(el('div', cls, text));
  }
  header.appendChild(rankWrap);
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
    grid.appendChild(renderPickChip(pick, true, currentRound));
  }
  picks.appendChild(grid);

  // Bench picks
  if (standing.bench && standing.bench.length > 0) {
    const bench = el('div', 'bench-section');
    bench.style.marginTop = '10px';
    bench.appendChild(el('div', 'picks-label', 'Bench'));
    const benchGrid = el('div', 'picks-grid');
    for (const pick of standing.bench) {
      benchGrid.appendChild(renderPickChip(pick, false, currentRound));
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

  const currentRound = data.eventInfo?.currentRound ?? null;
  const isLive = data.eventInfo?.eventStatus === 'IN_PROGRESS';

  for (const standing of data.standings) {
    container.appendChild(renderStandingCard(standing, isLive ? currentRound : null));
  }
}

// ── Leaderboard scorecard helpers ─────────────────────────────────────────

// Augusta National par by hole (1-18): front 36, back 36, total 72
const AUGUSTA_PAR = [4, 5, 4, 3, 4, 3, 4, 5, 4, 4, 4, 3, 5, 4, 5, 3, 4, 4];

// Track which players have their scorecard expanded (survives re-renders)
const expandedPlayers = new Set();

function holeScoreBadge(score, par) {
  if (score === null || score === undefined) return '<span class="hs-empty">-</span>';
  if (par === null || par === undefined) return `<span class="hs">${score}</span>`;
  const diff = score - par;
  let cls = 'hs';
  if (diff <= -2) cls += ' hs-eagle';
  else if (diff === -1) cls += ' hs-birdie';
  else if (diff === 1) cls += ' hs-bogey';
  else if (diff >= 2) cls += ' hs-double';
  return `<span class="${cls}">${score}</span>`;
}

function buildScorecardRow(player, currentRound) {
  const tr = document.createElement('tr');
  tr.className = 'scorecard-row';
  const td = document.createElement('td');
  td.colSpan = 9;

  // Use the latest round that has hole data, preferring currentRound
  let holes = null;
  let shownRound = currentRound ?? 1;
  for (let r = shownRound; r >= 1; r--) {
    const h = player.rounds?.[r - 1]?.holes;
    if (h && h.length > 0) { holes = h; shownRound = r; break; }
  }

  if (!holes) {
    // Fall back to ESPN front/back 9 summary when full hole data isn't available
    let summary = null;
    for (let r = shownRound; r >= 1; r--) {
      const rd = player.rounds?.[r - 1];
      if (rd && (rd.outScore != null || rd.inScore != null)) {
        const frontPar = AUGUSTA_PAR.slice(0, 9).reduce((s, p) => s + p, 0); // 36
        const backPar  = AUGUSTA_PAR.slice(9).reduce((s, p) => s + p, 0);   // 36
        const total    = rd.outScore != null && rd.inScore != null ? rd.outScore + rd.inScore : null;
        summary = `<div class="scorecard-summary">
          <div class="scorecard-title">Round ${r} · Scorecard</div>
          <table class="sc-table">
            <thead><tr>
              <th class="sc-label"></th>
              <th class="sc-subtotal">OUT</th>
              <th class="sc-subtotal">IN</th>
              <th class="sc-subtotal">TOT</th>
            </tr></thead>
            <tbody>
              <tr>
                <td class="sc-label">Par</td>
                <td class="sc-subtotal">${frontPar}</td>
                <td class="sc-subtotal">${backPar}</td>
                <td class="sc-subtotal">${frontPar + backPar}</td>
              </tr>
              <tr>
                <td class="sc-label">Score</td>
                <td class="sc-subtotal sc-score-total">${rd.outScore ?? '—'}</td>
                <td class="sc-subtotal sc-score-total">${rd.inScore ?? '—'}</td>
                <td class="sc-subtotal sc-score-total">${total ?? '—'}</td>
              </tr>
            </tbody>
          </table>
          <p class="scorecard-note">Hole-by-hole data loads after refresh when masters.com is available.</p>
        </div>`;
        break;
      }
    }
    td.innerHTML = summary ?? '<div class="scorecard-unavailable">Scorecard data unavailable for this round.</div>';
    tr.appendChild(td);
    return tr;
  }

  const pars   = holes.map((h, i) => h.par ?? AUGUSTA_PAR[i] ?? null);
  const scores = holes.map(h => h.score ?? null);

  const sumAll = arr => arr.every(v => v !== null) ? arr.reduce((s, v) => s + v, 0) : null;

  const frontPars   = pars.slice(0, 9);
  const backPars    = pars.slice(9, 18);
  const frontScores = scores.slice(0, 9);
  const backScores  = scores.slice(9, 18);
  const frontParSum   = frontPars.reduce((s, p) => s + (p ?? 0), 0);
  const backParSum    = backPars.reduce((s, p) => s + (p ?? 0), 0);
  const frontScoreSum = sumAll(frontScores);
  const backScoreSum  = sumAll(backScores);
  const totalScore    = frontScoreSum !== null && backScoreSum !== null
    ? frontScoreSum + backScoreSum : frontScoreSum ?? null;

  const fmt = v => v !== null && v !== undefined ? v : '-';

  let html = `<div class="scorecard-wrap">
    <div class="scorecard-title">Round ${shownRound} · Scorecard</div>
    <table class="sc-table">
      <thead><tr>
        <th class="sc-label"></th>`;
  for (let h = 1; h <= 9; h++)  html += `<th>${h}</th>`;
  html += `<th class="sc-subtotal">OUT</th>`;
  for (let h = 10; h <= 18; h++) html += `<th>${h}</th>`;
  html += `<th class="sc-subtotal">IN</th><th class="sc-subtotal">TOT</th>
      </tr></thead>
      <tbody>
        <tr>
          <td class="sc-label">Par</td>`;
  frontPars.forEach(p => { html += `<td>${fmt(p)}</td>`; });
  html += `<td class="sc-subtotal">${frontParSum}</td>`;
  backPars.forEach(p => { html += `<td>${fmt(p)}</td>`; });
  html += `<td class="sc-subtotal">${backParSum}</td><td class="sc-subtotal">${frontParSum + backParSum}</td>
        </tr>
        <tr>
          <td class="sc-label">Score</td>`;
  frontScores.forEach((s, i) => { html += `<td>${holeScoreBadge(s, pars[i])}</td>`; });
  html += `<td class="sc-subtotal sc-score-total">${fmt(frontScoreSum)}</td>`;
  backScores.forEach((s, i)  => { html += `<td>${holeScoreBadge(s, pars[i + 9])}</td>`; });
  html += `<td class="sc-subtotal sc-score-total">${fmt(backScoreSum)}</td>
           <td class="sc-subtotal sc-score-total">${fmt(totalScore)}</td>
        </tr>
      </tbody>
    </table>
  </div>`;

  td.innerHTML = html;
  tr.appendChild(td);
  return tr;
}

// ── Leaderboard rendering ──────────────────────────────────────────────────

function renderLeaderboard(data) {
  const container = document.getElementById('leaderboardContainer');
  container.innerHTML = '';

  if (!data.players || data.players.length === 0) {
    container.appendChild(el('div', 'empty-state', 'Leaderboard data unavailable. Scores will appear once the tournament begins.'));
    return;
  }

  const currentRound = data.currentRound ?? 1;
  const table = document.createElement('table');
  table.className = 'lb-table';

  // 9 columns: Pos, Player, Total, R1-R4, Thru, expand-arrow
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
        <th class="lb-expand-col"></th>
      </tr>
    </thead>`;

  const tbody = document.createElement('tbody');

  // Determine cut line and WD section positions
  const CUT_POSITION = 50;
  const players = data.players;
  const wdStartIndex = players.findIndex(p => p.status === 'wd' || p.status === 'dq');
  const nonWdCount = wdStartIndex === -1 ? players.length : wdStartIndex;

  let cutAfterIndex = -1;
  if (nonWdCount > CUT_POSITION) {
    cutAfterIndex = CUT_POSITION - 1;
    const cutScore = players[cutAfterIndex].total;
    while (cutAfterIndex + 1 < nonWdCount && players[cutAfterIndex + 1].total === cutScore) {
      cutAfterIndex++;
    }
  }

  for (let i = 0; i < players.length; i++) {
    const player = players[i];

    // Cut divider
    if (cutAfterIndex >= 0 && i === cutAfterIndex + 1) {
      const cutRow = document.createElement('tr');
      cutRow.className = 'divider-row cut-divider-row';
      const cutTd = document.createElement('td');
      cutTd.colSpan = 9;
      cutTd.className = 'divider-cell';
      cutTd.textContent = '— CUT —';
      cutRow.appendChild(cutTd);
      tbody.appendChild(cutRow);
    }

    // WD divider
    if (wdStartIndex >= 0 && i === wdStartIndex) {
      const wdRow = document.createElement('tr');
      wdRow.className = 'divider-row wd-divider-row';
      const wdTd = document.createElement('td');
      wdTd.colSpan = 9;
      wdTd.className = 'divider-cell';
      wdTd.textContent = '— WITHDRAWN —';
      wdRow.appendChild(wdTd);
      tbody.appendChild(wdRow);
    }

    const tr = document.createElement('tr');
    tr.classList.add('expandable-row');
    if (player.inPool) tr.classList.add('in-pool');
    if (player.status === 'cut') tr.classList.add('is-cut');
    if (expandedPlayers.has(player.name)) tr.classList.add('expanded');

    // Position
    tr.appendChild(el('td', 'lb-pos', escHtml(player.position || '')));

    // Name
    const tdName = el('td', 'lb-name', escHtml(player.name));
    if (player.inPool) tdName.innerHTML += '<span class="pool-indicator" title="In pool"></span>';
    tr.appendChild(tdName);

    // Total
    tr.appendChild(el('td', `num lb-score-${scoreClass(player.total)}`, player.totalDisplay));

    // Round scores
    for (let r = 0; r < 4; r++) {
      const rd = player.rounds?.[r];
      const val = rd?.display ?? '-';
      const rCls = rd?.score != null ? `lb-round ${scoreClass(rd.score)}` : 'lb-round';
      tr.appendChild(el('td', `num ${rCls}`, escHtml(val)));
    }

    // Thru / status
    let thruContent = '-';
    if (player.status === 'cut')       thruContent = '<span class="lb-status-cut">CUT</span>';
    else if (player.status === 'wd')   thruContent = '<span class="lb-status-wd">WD</span>';
    else if (player.thru !== null && player.thru !== undefined)
      thruContent = player.thru === 18 ? 'F' : `${player.thru}`;
    tr.appendChild(el('td', 'num lb-thru', thruContent));

    // Expand arrow
    tr.appendChild(el('td', 'lb-expand', '<span class="expand-arrow">&#9654;</span>'));

    // Click to toggle scorecard
    tr.addEventListener('click', () => {
      if (expandedPlayers.has(player.name)) {
        const next = tr.nextElementSibling;
        if (next?.classList.contains('scorecard-row')) next.remove();
        expandedPlayers.delete(player.name);
        tr.classList.remove('expanded');
      } else {
        tr.insertAdjacentElement('afterend', buildScorecardRow(player, currentRound));
        expandedPlayers.add(player.name);
        tr.classList.add('expanded');
      }
    });

    tbody.appendChild(tr);

    // Re-insert scorecard after re-render if it was previously expanded
    if (expandedPlayers.has(player.name)) {
      tbody.appendChild(buildScorecardRow(player, currentRound));
    }
  }

  table.appendChild(tbody);
  container.appendChild(table);

  const legend = el('div', 'pool-legend');
  legend.innerHTML = '<span class="dot"></span> Player is in someone\'s pool picks';
  container.appendChild(legend);
}

// ── Theme toggle ───────────────────────────────────────────────────────────

function getTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  updateToggleBtn(theme);
}

function updateToggleBtn(theme) {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  if (theme === 'dark') {
    btn.innerHTML = '&#9728;'; // sun — click to go light
    btn.title = 'Switch to light mode';
  } else {
    btn.innerHTML = '&#9790;'; // crescent moon — click to go dark
    btn.title = 'Switch to dark mode';
  }
}

function initTheme() {
  // Theme may already be set by the anti-FOUC script in <head>;
  // just sync the button icon to match.
  updateToggleBtn(getTheme());
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
  initTheme();
  refreshAll();
  setInterval(() => refreshAll(), REFRESH_INTERVAL);

  document.getElementById('themeToggle')?.addEventListener('click', () => {
    applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
  });

  document.getElementById('refreshBtn')?.addEventListener('click', () => refreshAll(true));

  document.getElementById('staleDismiss')?.addEventListener('click', () => {
    staleBannerDismissed = true;
    document.getElementById('staleBanner').hidden = true;
  });
});
