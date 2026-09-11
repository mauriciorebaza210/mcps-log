// ─────────────────────────────────────────────────────────────────────────────
// Fleet Monitor — the board.
//
// Renders one row per pool and keeps it current. Two rules shape everything:
//
//   1. Calm at rest, informative on approach. Actions stay hidden until a row is
//      hovered or focused, changed values fade rather than strobe, and nothing
//      animates unless something actually happened.
//   2. Every row can DO something. A board that only reports makes you go
//      somewhere else to act; the row actions and lifecycle badges are here so
//      the answer and the fix live in the same place.
// ─────────────────────────────────────────────────────────────────────────────

const MON_BOARD = {
  filter: 'all',
  search: '',
  sortKey: 'score',
  sortDir: 'asc',      // worst-first: the pools needing attention float up
  focusIdx: -1,
  rendered: [],        // pool ids in current display order
  prevValues: new Map()// poolId -> {field: value} for flash-on-change
};

// FC leads: it's the reading that decides whether the pool is safe to swim in
// today, so it gets the first column. pH second — it drives everything else.
const MON_COLS = ['Free Chlorine (FC)','pH','Total Alkalinity (TA)',
                  'Calcium Hardness (CH)','Cyanuric Acid (CYA)','Salt Level'];

function monEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function monToast(msg, isErr) {
  const t = document.getElementById('mon-toast');
  t.textContent = msg;
  t.className = isErr ? 'show err' : 'show';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3200);
}

// ── sparkline ────────────────────────────────────────────────────────────────
// Inline SVG, no library. Points are per-visit Balance Scores, oldest to newest.
function monSparkline(visits) {
  const scores = visits.slice().reverse()
    .map(v => monScore(v.readings)).filter(s => s !== null);
  if (scores.length < 2) return '<span style="color:var(--text3);font-size:.7rem">—</span>';

  const W = 62, H = 20, pad = 2;
  const min = Math.min.apply(null, scores), max = Math.max.apply(null, scores);
  const range = (max - min) || 1;
  const pts = scores.map((s, i) => {
    const x = pad + (i / (scores.length - 1)) * (W - pad * 2);
    const y = pad + (1 - (s - min) / range) * (H - pad * 2);
    return [x, y];
  });

  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = line + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + (H - pad) +
               ' L' + pts[0][0].toFixed(1) + ' ' + (H - pad) + ' Z';
  const falling = scores[scores.length - 1] < scores[0];

  return '<svg class="mon-spark' + (falling ? ' down' : '') + '" width="' + W + '" height="' + H +
         '" viewBox="0 0 ' + W + ' ' + H + '">' +
         '<path class="area" d="' + area + '"/><path class="line" d="' + line + '"/></svg>';
}

// ── one reading cell, with its band micro-meter ──────────────────────────────
function monReadingCell(field, val) {
  const band = monBand(field, val);
  const txt  = monFmtReading(field, val);
  if (txt === null) {
    return '<td class="num" data-field="' + monEsc(field) + '">' +
           '<div class="mon-reading"><span class="v empty">Not tested</span></div></td>';
  }
  const zone = monIdealZone(field);
  const pct  = monMeterPct(field, val);
  const meter = '<div class="mon-meter">' +
    '<div class="zone" style="left:' + zone.start.toFixed(1) + '%;right:' + (100 - zone.end).toFixed(1) + '%"></div>' +
    '<div class="mark" style="left:calc(' + pct.toFixed(1) + '% - 1px)"></div></div>';

  return '<td class="num" data-field="' + monEsc(field) + '">' +
         '<div class="mon-reading"><span class="v ' + (band || '') + '">' + monEsc(txt) + '</span>' +
         meter + '</div></td>';
}

// ── lifecycle badge ──────────────────────────────────────────────────────────
function monLifeBadge(d) {
  if (d.lifecycle === 'convert')
    return '<span class="mon-life convert" title="Startup finished but this pool is not on a weekly route yet">Needs Conversion</span>';
  if (d.lifecycle === 'startup')
    return '<span class="mon-life startup">Startup</span>';
  return '<span class="mon-life active">Active</span>';
}

// ── row actions ──────────────────────────────────────────────────────────────
function monRowActions(p) {
  const d = p.derived;
  let html = '<div class="mon-actions">';
  if (d.lifecycle === 'convert') {
    html += '<button class="mon-act gold" data-act="convert" title="Open the Jobs page to convert this startup to a weekly route">Convert →</button>';
  }
  html += '<button class="mon-act" data-act="log" title="Open the service log">Log Visit</button>';
  if (d.alerts && d.alerts.length) {
    html += '<button class="mon-act gold" data-act="resolve" title="Resolve the open alert on this pool">Resolve</button>';
  } else {
    html += '<button class="mon-act" data-act="flag" title="Flag this pool for follow-up">Flag</button>';
  }
  return html + '</div>';
}

// ── filtering + sorting ──────────────────────────────────────────────────────
function monPassesFilter(p) {
  const d = p.derived, f = MON_BOARD.filter;
  if (f === 'weekly'  && d.lifecycle !== 'active') return false;
  if (f === 'startup' && d.lifecycle !== 'startup') return false;
  if (f === 'convert' && d.lifecycle !== 'convert') return false;
  if (f === 'out'     && d.status !== 'out') return false;
  if (f === 'overdue' && !(d.daysAgo !== null && d.daysAgo > 8)) return false;
  if (f === 'watch'   && !d.watched) return false;

  const q = MON_BOARD.search.trim().toLowerCase();
  if (q) {
    const hay = (d.name + ' ' + d.address + ' ' + p.id + ' ' + d.city).toLowerCase();
    if (hay.indexOf(q) === -1) return false;
  }
  return true;
}

function monSortValue(p, key) {
  const d = p.derived;
  switch (key) {
    case 'name':      return d.name.toLowerCase();
    case 'score':     return d.score === null ? 999 : d.score;  // untested sinks
    case 'delta':     return d.delta === null ? 0 : d.delta;
    case 'lastvisit': return d.daysAgo === null ? -1 : d.daysAgo;
    // Conversion-needed first, then startups, then active.
    case 'lifecycle': return d.lifecycle === 'convert' ? 0 : (d.lifecycle === 'startup' ? 1 : 2);
    default:          return 0;
  }
}

function monVisiblePools() {
  const list = [];
  MON.pools.forEach(p => { if (monPassesFilter(p)) list.push(p); });

  const key = MON_BOARD.sortKey, dir = MON_BOARD.sortDir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    // Watchlisted pools always pin to the top, whatever the sort.
    if (a.derived.watched !== b.derived.watched) return a.derived.watched ? -1 : 1;
    const av = monSortValue(a, key), bv = monSortValue(b, key);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return a.derived.name.localeCompare(b.derived.name);
  });
  return list;
}

// ── main render ──────────────────────────────────────────────────────────────
function monBoardRender(changedIds) {
  const pools = monVisiblePools();
  MON_BOARD.rendered = pools.map(p => p.id);
  const changed = new Set(changedIds || []);
  const body = document.getElementById('board-body');

  document.getElementById('board-empty').hidden = pools.length > 0;

  body.innerHTML = pools.map((p, i) => {
    const d = p.derived;
    const deltaCls = d.delta === null ? 'flat' : (d.delta > 0 ? 'up' : (d.delta < 0 ? 'down' : 'flat'));
    const deltaTxt = d.delta === null ? '—' : (d.delta > 0 ? '▲' : (d.delta < 0 ? '▼' : '')) + Math.abs(d.delta).toFixed(1);

    let lastCls = '', lastTxt = 'No visits';
    if (d.daysAgo !== null) {
      lastTxt = d.daysAgo === 0 ? 'Today' : d.daysAgo === 1 ? 'Yesterday' : d.daysAgo + ' days ago';
      if (d.daysAgo > 14) lastCls = 'verystale'; else if (d.daysAgo > 8) lastCls = 'stale';
    }

    const fc = d.forecast;
    const fcHtml = fc
      ? '<span class="mon-forecast' + (fc.days <= 3 ? ' urgent' : '') + '">' +
        monEsc(fc.short) + ' leaves range in ~' + fc.days + 'd</span>'
      : '<span class="mon-forecast none">—</span>';

    const alertFlag = (d.alerts && d.alerts.length)
      ? '<span class="mon-alert-flag" title="' + monEsc(d.alerts[0].message || 'Open alert') + '">⚑</span>' : '';

    return '<tr data-pool="' + monEsc(p.id) + '" data-idx="' + i + '"' +
      (d.lifecycle === 'convert' ? ' class="needs-convert"' : '') +
      (d.provisional ? ' class="provisional"' : '') + '>' +
      '<td><span class="mon-status-dot ' + d.status + '" title="' + d.status + '"></span></td>' +
      '<td><div class="mon-pool-cell">' +
        '<span class="mon-star' + (d.watched ? ' on' : '') + '" data-act="star">' + (d.watched ? '★' : '☆') + '</span>' +
        '<div><div class="mon-pool-name">' + monEsc(d.name) + alertFlag + '</div>' +
        '<div class="mon-pool-addr">' + monEsc(d.address || d.city || '—') + '</div></div>' +
      '</div></td>' +
      '<td>' + monLifeBadge(d) + '</td>' +
      '<td class="num" data-field="score"><span class="mon-score">' +
        (d.score === null ? '—' : d.score.toFixed(1)) + '</span></td>' +
      '<td class="num"><span class="mon-delta ' + deltaCls + '">' + deltaTxt + '</span></td>' +
      '<td>' + monSparkline(d.visits) + '</td>' +
      MON_COLS.map(f => monReadingCell(f, d.latest ? d.latest.readings[f] : null)).join('') +
      '<td><span class="mon-lastvisit ' + lastCls + '">' + lastTxt + '</span></td>' +
      '<td>' + fcHtml + '</td>' +
      '<td>' + monRowActions(p) + '</td>' +
    '</tr>';
  }).join('');

  monFlashChanges_(pools, changed);
  monRenderHeader_();
  monRenderMovers_();
  monRenderTicker_();
  monRenderCounts_();
  monApplyFocus_();
}

// Flash only cells whose value actually moved, batched into one frame.
function monFlashChanges_(pools, changed) {
  const updates = [];
  pools.forEach(p => {
    const d = p.derived;
    const prev = MON_BOARD.prevValues.get(p.id) || {};
    const cur = {};
    MON_COLS.forEach(f => { cur[f] = d.latest ? monNum(d.latest.readings[f]) : null; });
    cur.score = d.score;

    if (changed.has(p.id)) {
      Object.keys(cur).forEach(f => {
        if (prev[f] !== undefined && prev[f] !== null && cur[f] !== null && prev[f] !== cur[f]) {
          updates.push({ pool: p.id, field: f, up: cur[f] > prev[f] });
        }
      });
    }
    MON_BOARD.prevValues.set(p.id, cur);
  });

  if (!updates.length) return;
  requestAnimationFrame(() => {
    updates.forEach(u => {
      const row = document.querySelector('tr[data-pool="' + CSS.escape(u.pool) + '"]');
      if (!row) return;
      const cell = row.querySelector('[data-field="' + CSS.escape(u.field) + '"]');
      if (!cell) return;
      cell.classList.remove('flash-up', 'flash-down');
      void cell.offsetWidth;                    // restart the animation
      cell.classList.add(u.up ? 'flash-up' : 'flash-down');
    });
  });
}

function monRenderHeader_() {
  document.querySelectorAll('.mon-board thead th[data-sort]').forEach(th => {
    const key = th.getAttribute('data-sort');
    th.classList.toggle('sorted', key === MON_BOARD.sortKey);
    const old = th.querySelector('.arrow');
    if (old) old.remove();
    if (key === MON_BOARD.sortKey) {
      const s = document.createElement('span');
      s.className = 'arrow';
      s.textContent = MON_BOARD.sortDir === 'asc' ? '↑' : '↓';
      th.appendChild(s);
    }
  });
}

function monRenderCounts_() {
  let ok = 0, drift = 0, out = 0, weekly = 0, startup = 0, convert = 0, overdue = 0, watch = 0;
  MON.pools.forEach(p => {
    const d = p.derived;
    if (d.status === 'ok') ok++; else if (d.status === 'drift') drift++; else if (d.status === 'out') out++;
    if (d.lifecycle === 'active') weekly++;
    else if (d.lifecycle === 'startup') startup++;
    else convert++;
    if (d.daysAgo !== null && d.daysAgo > 8) overdue++;
    if (d.watched) watch++;
  });

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('cnt-total', MON.pools.size); set('cnt-ok', ok); set('cnt-drift', drift); set('cnt-out', out);
  set('fc-all', MON.pools.size); set('fc-weekly', weekly); set('fc-startup', startup);
  set('fc-convert', convert); set('fc-out', out); set('fc-overdue', overdue); set('fc-watch', watch);

  // Fleet index — weekly pools only. A startup is legitimately out of range, so
  // averaging it in would make the business look worse every time one is sold.
  const idx = monFleetIndex(Array.from(MON.pools.values()).map(p => ({
    score: p.derived.score, is_startup: p.derived.lifecycle !== 'active'
  })));
  const idxEl = document.getElementById('idx-val');
  if (idxEl) idxEl.textContent = idx === null ? '—' : idx.toFixed(1);
}

function monRenderMovers_() {
  const movers = [];
  MON.pools.forEach(p => { if (p.derived.delta !== null && p.derived.delta !== 0) movers.push(p); });
  const wrap = document.getElementById('movers-wrap');
  if (!movers.length) { wrap.classList.add('empty'); return; }
  wrap.classList.remove('empty');

  const up = movers.filter(p => p.derived.delta > 0).sort((a,b) => b.derived.delta - a.derived.delta).slice(0,3);
  const dn = movers.filter(p => p.derived.delta < 0).sort((a,b) => a.derived.delta - b.derived.delta).slice(0,3);

  const row = (p, cls) => '<div class="mon-mover-row" data-pool="' + monEsc(p.id) + '">' +
    '<span class="name">' + monEsc(p.derived.name) + '</span>' +
    '<span class="delta ' + cls + '">' + (p.derived.delta > 0 ? '▲' : '▼') +
    Math.abs(p.derived.delta).toFixed(1) + '</span></div>';

  document.getElementById('movers-up').innerHTML = up.map(p => row(p,'up')).join('') || '<div class="mon-mover-row"><span class="name">No gainers yet</span></div>';
  document.getElementById('movers-down').innerHTML = dn.map(p => row(p,'down')).join('') || '<div class="mon-mover-row"><span class="name">No decliners</span></div>';
}

function monRenderTicker_() {
  const items = [];
  MON.pools.forEach(p => {
    const d = p.derived;
    if (d.lifecycle === 'convert')
      items.push({ cls:'alert', html:'<span class="name">' + monEsc(d.name) + '</span> startup complete — needs conversion', id:p.id });
    if (d.alerts && d.alerts.length)
      items.push({ cls:'alert', html:'⚑ <span class="name">' + monEsc(d.name) + '</span> ' + monEsc(d.alerts[0].message || 'Open alert'), id:p.id });
    if (d.delta !== null && Math.abs(d.delta) >= 3)
      items.push({ cls: d.delta > 0 ? 'up' : 'down',
        html:'<span class="name">' + monEsc(d.name) + '</span> ' + (d.delta>0?'▲':'▼') + Math.abs(d.delta).toFixed(1), id:p.id });
  });

  const wrap = document.getElementById('ticker-wrap');
  if (!items.length) { wrap.classList.add('empty'); return; }
  wrap.classList.remove('empty');
  // Duplicated once so the CSS marquee loops seamlessly at -50%.
  const one = items.map(i => '<span class="mon-tick-item ' + i.cls + '" data-pool="' + monEsc(i.id) + '">' + i.html + '</span>').join('');
  document.getElementById('ticker-track').innerHTML = one + one;
}

function monBoardSetLive(isLive) {
  const el = document.getElementById('mon-live');
  if (!el) return;
  el.classList.toggle('stale', !isLive);
  document.getElementById('mon-live-txt').textContent = isLive ? 'LIVE · 60s' : 'RECONNECTING…';
}

// ── focus / keyboard ─────────────────────────────────────────────────────────
function monApplyFocus_() {
  document.querySelectorAll('.mon-board tbody tr').forEach((tr, i) => {
    tr.classList.toggle('focused', i === MON_BOARD.focusIdx);
  });
}

function monMoveFocus_(delta) {
  const n = MON_BOARD.rendered.length;
  if (!n) return;
  MON_BOARD.focusIdx = Math.max(0, Math.min(n - 1, MON_BOARD.focusIdx + delta));
  monApplyFocus_();
  const row = document.querySelectorAll('.mon-board tbody tr')[MON_BOARD.focusIdx];
  if (row) row.scrollIntoView({ block:'nearest', behavior:'smooth' });
}

// ── actions ──────────────────────────────────────────────────────────────────
function monDoAction(act, poolId) {
  const p = MON.pools.get(poolId);
  if (!p) return;

  if (act === 'star') { monToggleWatch(poolId); monBoardRender([]); return; }

  if (act === 'log') {
    // Lands on the service log page. The pool isn't pre-selected — service-log-v2
    // reads only the in-page _pendingSvcPoolId global, which a separate page load
    // can't set, and wiring a ?pool= param into it is a change to a shared core
    // feature file, outside this page's scope.
    window.open('/#service_log', '_blank');
    return;
  }

  if (act === 'convert') {
    window.open('/#jobs', '_blank');
    monToast('Opened Jobs — convert ' + p.derived.name + ' to a weekly route there.');
    return;
  }

  if (act === 'flag') {
    const msg = prompt('Flag ' + p.derived.name + ' for follow-up:\n\nThis creates an alert in the portal.');
    if (!msg || !msg.trim()) return;
    monToast('Saving flag…');
    monFlagPool(poolId, msg.trim())
      .then(() => { monToast('Flagged ' + p.derived.name + '.'); monBoardRender([]); })
      .catch(e => monToast(e.message || 'Could not save the flag.', true));
    return;
  }

  if (act === 'resolve') {
    const a = (p.derived.alerts || [])[0];
    if (!a) return;
    if (!confirm('Resolve this alert on ' + p.derived.name + '?\n\n' + (a.message || ''))) return;
    monToast('Resolving…');
    monResolveAlert(a.id)
      .then(() => { monToast('Alert resolved.'); monBoardRender([]); })
      .catch(e => monToast(e.message || 'Could not resolve.', true));
    return;
  }
}

// ── CSV export ───────────────────────────────────────────────────────────────
function monExportCsv() {
  const rows = [['Pool ID','Name','Address','Status','Lifecycle','Score','Delta',
                 'pH','FC','TA','CH','CYA','Salt','Last Visit (days)','Technician']];
  monVisiblePools().forEach(p => {
    const d = p.derived, r = d.latest ? d.latest.readings : {};
    rows.push([p.id, d.name, d.address, d.status, d.lifecycle,
      d.score === null ? '' : d.score, d.delta === null ? '' : d.delta,
      ...MON_COLS.map(f => monFmtReading(f, r[f]) || ''),
      d.daysAgo === null ? '' : d.daysAgo, d.latest ? d.latest.tech : '']);
  });
  const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g,'""') + '"').join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mcps-fleet-' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  monToast('Exported ' + (rows.length - 1) + ' pools.');
}

// ── wiring ───────────────────────────────────────────────────────────────────
function monBoardInit() {
  const body = document.getElementById('board-body');

  body.addEventListener('click', e => {
    const actEl = e.target.closest('[data-act]');
    const row = e.target.closest('tr[data-pool]');
    if (!row) return;
    const poolId = row.getAttribute('data-pool');
    if (actEl) { e.stopPropagation(); monDoAction(actEl.getAttribute('data-act'), poolId); return; }
    location.hash = 'pool/' + poolId;
  });

  document.getElementById('mon-filters').addEventListener('click', e => {
    const chip = e.target.closest('.mon-chip');
    if (!chip) return;
    document.querySelectorAll('.mon-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    MON_BOARD.filter = chip.getAttribute('data-filter');
    MON_BOARD.focusIdx = -1;
    monBoardRender([]);
  });

  document.querySelectorAll('.mon-board thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (MON_BOARD.sortKey === key) MON_BOARD.sortDir = MON_BOARD.sortDir === 'asc' ? 'desc' : 'asc';
      else { MON_BOARD.sortKey = key; MON_BOARD.sortDir = 'asc'; }
      monBoardRender([]);
    });
  });

  const search = document.getElementById('mon-search');
  search.addEventListener('input', () => {
    MON_BOARD.search = search.value;
    MON_BOARD.focusIdx = -1;
    monBoardRender([]);
  });

  [['movers-up','click'],['movers-down','click'],['ticker-track','click']].forEach(([id]) => {
    document.getElementById(id).addEventListener('click', e => {
      const el = e.target.closest('[data-pool]');
      if (el) location.hash = 'pool/' + el.getAttribute('data-pool');
    });
  });

  document.getElementById('btn-tv').addEventListener('click', monToggleTv);

  document.addEventListener('keydown', monKeydown_);
  monPaletteInit_();
  monTvInit_();
}

function monKeydown_(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const paletteOpen = !document.getElementById('palette').hidden;

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); monPaletteOpen_(); return; }
  if (e.key === 'Escape') {
    if (paletteOpen) return monPaletteClose_();
    if (!document.getElementById('shortcuts-modal').hidden) return void (document.getElementById('shortcuts-modal').hidden = true);
    if (location.hash) location.hash = '';
    if (typing) e.target.blur();
    return;
  }
  if (typing || paletteOpen) return;

  if (e.key === '/') { e.preventDefault(); document.getElementById('mon-search').focus(); return; }
  if (e.key === '?') { document.getElementById('shortcuts-modal').hidden = false; return; }
  if (e.key === 'j') { e.preventDefault(); monMoveFocus_(1); return; }
  if (e.key === 'k') { e.preventDefault(); monMoveFocus_(-1); return; }
  if (e.key === 'Enter' && MON_BOARD.focusIdx >= 0) {
    location.hash = 'pool/' + MON_BOARD.rendered[MON_BOARD.focusIdx]; return;
  }
  if (e.key === 'w' && MON_BOARD.focusIdx >= 0) {
    monToggleWatch(MON_BOARD.rendered[MON_BOARD.focusIdx]); monBoardRender([]); return;
  }
}

// ── command palette ──────────────────────────────────────────────────────────
const MON_COMMANDS = [
  { label:'Show pools that are out of spec', tag:'Filter', run:() => monSetFilter('out') },
  { label:'Show pools needing conversion',   tag:'Filter', run:() => monSetFilter('convert') },
  { label:'Show overdue pools',              tag:'Filter', run:() => monSetFilter('overdue') },
  { label:'Show all pools',                  tag:'Filter', run:() => monSetFilter('all') },
  { label:'Export current view to CSV',      tag:'Action', run:monExportCsv },
  { label:'Refresh now',                     tag:'Action', run:() => { monToast('Refreshing…'); monPoll_(); } },
  { label:'Toggle wall display (TV) mode',   tag:'View',   run:monToggleTv }
];

function monSetFilter(f) {
  MON_BOARD.filter = f;
  document.querySelectorAll('.mon-chip').forEach(c =>
    c.classList.toggle('active', c.getAttribute('data-filter') === f));
  monBoardRender([]);
}

function monPaletteInit_() {
  const input = document.getElementById('palette-input');
  input.addEventListener('input', () => monPaletteRender_(input.value));
  input.addEventListener('keydown', e => {
    const items = Array.from(document.querySelectorAll('.mon-palette-item'));
    let idx = items.findIndex(i => i.classList.contains('active'));
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length-1, idx+1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx-1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[idx]) items[idx].click(); return; }
    else return;
    items.forEach((it,i) => it.classList.toggle('active', i === idx));
  });
  document.getElementById('palette').addEventListener('click', e => {
    if (e.target.id === 'palette') monPaletteClose_();
  });
}

function monPaletteOpen_() {
  document.getElementById('palette').hidden = false;
  const input = document.getElementById('palette-input');
  input.value = '';
  monPaletteRender_('');
  input.focus();
}
function monPaletteClose_() { document.getElementById('palette').hidden = true; }

function monPaletteRender_(q) {
  const query = q.trim().toLowerCase();
  const results = [];

  MON_COMMANDS.forEach(c => {
    if (!query || c.label.toLowerCase().indexOf(query) !== -1)
      results.push({ label:c.label, sub:'', tag:c.tag, run:c.run });
  });

  MON.pools.forEach(p => {
    const d = p.derived;
    const hay = (d.name + ' ' + d.address + ' ' + p.id).toLowerCase();
    if (!query || hay.indexOf(query) !== -1) {
      results.push({
        label: d.name,
        sub: p.id + (d.address ? ' · ' + d.address : ''),
        tag: d.lifecycle === 'convert' ? 'Needs conversion' : 'Pool',
        run: () => { location.hash = 'pool/' + p.id; }
      });
    }
  });

  document.getElementById('palette-list').innerHTML = results.slice(0, 40).map((r, i) =>
    '<div class="mon-palette-item' + (i === 0 ? ' active' : '') + '" data-i="' + i + '">' +
    '<div><div>' + monEsc(r.label) + '</div>' +
    (r.sub ? '<div class="sub">' + monEsc(r.sub) + '</div>' : '') + '</div>' +
    '<span class="tag">' + monEsc(r.tag) + '</span></div>').join('')
    || '<div class="mon-palette-item"><span class="sub">Nothing matches.</span></div>';

  document.querySelectorAll('.mon-palette-item[data-i]').forEach(el => {
    el.addEventListener('click', () => {
      const r = results[parseInt(el.getAttribute('data-i'), 10)];
      monPaletteClose_();
      if (r && r.run) r.run();
    });
  });
}

// ── TV mode ──────────────────────────────────────────────────────────────────
let MON_TV = { on:false, cycle:null, step:0, wakeLock:null };

function monTvInit_() {
  if (new URLSearchParams(location.search).get('tv') === '1') monToggleTv();
}

function monToggleTv() {
  MON_TV.on = !MON_TV.on;
  document.body.classList.toggle('tv', MON_TV.on);
  if (MON_TV.on) {
    monTvWakeLock_();
    MON_TV.cycle = setInterval(() => {
      MON_TV.step = (MON_TV.step + 1) % 3;
      monSetFilter(['all','out','convert'][MON_TV.step]);
    }, 20000);
  } else {
    clearInterval(MON_TV.cycle);
    if (MON_TV.wakeLock) { MON_TV.wakeLock.release().catch(()=>{}); MON_TV.wakeLock = null; }
    monSetFilter('all');
  }
}

function monTvWakeLock_() {
  if (!navigator.wakeLock) return;
  navigator.wakeLock.request('screen')
    .then(l => { MON_TV.wakeLock = l; })
    .catch(() => { /* denied or unsupported — the board still works, screen may sleep */ });
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && MON_TV.on && !MON_TV.wakeLock) monTvWakeLock_();
});
