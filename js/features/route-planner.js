// Route Planner - admin bulk rescheduling workspace.
// Depends on: api/apiLocalGet/apiGet, auth globals, constants, app route cache helpers.

const RP_DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

let _rp = {
  weekStart: '',
  data: null,
  selected: new Set(),
  staged: {},
  filter: { q: '', day: 'all', operator: 'all' },
  preflight: null,
  history: [],
  dragPoolId: '',
  timer: null,
  scope: 'week',
  weeksCount: 4,
  notify: { batchId: '', subject: '', body: '', preview: null, previewLoading: false, previewError: '' },
  view: 'board',
  mapDrag: null,
  mapPoints: [],
  // Drawer is rendered outside .rp-layout so history/impact re-renders never touch it.
  detail: { mode: '', batchId: '', loading: false, batch: null, items: [], error: '', expanded: {} },
  warmup: null,
  // Constraints the board warns about before a move is staged: who works which
  // day and how many stops they take, frozen days, blackouts, unrouted pools.
  ctx: null,
  showUnrouted: false,
  // Active temporary/first-month visit series. Creating these has always worked;
  // seeing and ending them had no home until now.
  series: null,
  showSeries: false,
  keysBound: false
};

const RP_NOTIFY_DEFAULTS = {
  subject: 'Your pool service schedule is changing',
  body: 'Hi {{first_name}},\n\nYour pool service is moving from {{old_day}} to {{new_day}} effective {{effective_date}}.\n\nQuestions? Just reply to this email.'
};

function loadRoutePlanner() {
  if (!_s || !isAdmin()) return;
  if (!_rp.weekStart) _rp.weekStart = rpCurrentWeekStart_();
  rpRenderShell_();
  rpLoadWeek_(true);
  rpLoadHistory_();
  rpLoadWarmupStatus_();
  rpLoadPlannerContext_();
  rpLoadSeries_();
}

function rpRenderShell_() {
  const root = document.getElementById('route-planner-root');
  if (!root) return;
  root.innerHTML = `
    <div class="rp-wrap">
      <div class="rp-head">
        <div>
          <h1 class="rp-title">Route Planner</h1>
          <div class="rp-week">
            <button class="rp-icon-btn" title="Previous week" onclick="rpShiftWeek_(-1)">&#8592;</button>
            <input class="rp-date" type="date" value="${escHtml(_rp.weekStart)}" onchange="rpSetWeek_(this.value)">
            <button class="rp-icon-btn" title="Next week" onclick="rpShiftWeek_(1)">&#8594;</button>
          </div>
        </div>
        <div class="rp-actions">
          <button class="rp-btn" onclick="rpClearStage_()">Clear</button>
          <button class="rp-btn primary" id="rp-apply-btn" onclick="rpApply_()" disabled>Review &amp; apply</button>
        </div>
      </div>

      <div class="rp-toolbar">
        <input class="rp-search" placeholder="Search" oninput="rpSetFilter_('q', this.value)">
        <select class="rp-select" onchange="rpSetFilter_('day', this.value)">
          <option value="all">All days</option>
          ${RP_DAYS.map(d => `<option value="${d}">${d}</option>`).join('')}
        </select>
        <select class="rp-select" id="rp-filter-op" onchange="rpSetFilter_('operator', this.value)">
          <option value="all">All technicians</option>
        </select>
        <div class="rp-view-toggle">
          <button class="rp-mini-btn" id="rp-board-view-btn" onclick="rpSetView_('board')">Board</button>
          <button class="rp-mini-btn" id="rp-map-view-btn" onclick="rpSetView_('map')">Map</button>
        </div>
        <button class="rp-btn" onclick="rpSelectVisible_()">Select visible</button>
        <button class="rp-btn" onclick="rpClearSelection_()">Deselect</button>
      </div>

      <div class="rp-stagebar">
        <div class="rp-stage-controls">
          <select class="rp-select" id="rp-scope" onchange="rpSetScope_(this.value)">
            <option value="week"${_rp.scope === 'week' ? ' selected' : ''}>This week only</option>
            <option value="range"${_rp.scope === 'range' ? ' selected' : ''}>For multiple weeks</option>
            <option value="permanent"${_rp.scope === 'permanent' ? ' selected' : ''}>Permanent route change</option>
          </select>
          <label class="rp-weeks" id="rp-weeks-control">
            <span>Weeks</span>
            <input type="number" id="rp-week-count" min="2" max="26" step="1" value="${Number(_rp.weeksCount) || 4}" oninput="rpSetWeeksCount_(this.value)">
          </label>
          <span class="rp-range-summary" id="rp-range-summary"></span>
          <select class="rp-select" id="rp-target-day" onchange="rpTargetDayChanged_()">
            ${RP_DAYS.map(d => `<option value="${d}">${d}</option>`).join('')}
          </select>
          <select class="rp-select" id="rp-target-op"></select>
          <button class="rp-btn primary" onclick="rpStageSelected_()">Stage move</button>
        </div>
        <label class="rp-check"><input type="checkbox" id="rp-ack" onchange="rpUpdateApplyState_()"> Acknowledge warnings</label>
      </div>

      <div id="rp-trays"></div>

      <div class="rp-layout">
        <section class="rp-board" id="rp-board"></section>
        <aside class="rp-side">
          <div class="rp-warmup" id="rp-warmup"></div>
          <div class="rp-impact" id="rp-impact"></div>
          <div class="rp-history" id="rp-history"></div>
        </aside>
      </div>

      <div id="rp-detail-drawer"></div>
    </div>`;
  rpUpdateScopeUi_();
  rpUpdateViewButtons_();
  rpBindDrawerKeys_();
}

function rpBindDrawerKeys_() {
  if (_rp.keysBound) return;
  _rp.keysBound = true;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _rp.detail.mode) rpCloseDetail_();
  });
}

function rpCurrentWeekStart_() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return rpYmd_(d);
}

function rpYmd_(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function rpShiftWeek_(delta) {
  const d = new Date(_rp.weekStart + 'T12:00:00');
  d.setDate(d.getDate() + delta * 7);
  rpSetWeek_(rpYmd_(d));
}

function rpSetWeek_(value) {
  if (!value) return;
  const d = new Date(value + 'T12:00:00');
  d.setDate(d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1));
  _rp.weekStart = rpYmd_(d);
  _rp.selected.clear();
  _rp.staged = {};
  _rp.preflight = null;
  _rp.ctx = null; // locks, blackouts and load are all week-specific
  rpRenderShell_();
  rpLoadWeek_(true);
  rpLoadHistory_();
  rpLoadPlannerContext_();
}

function rpAddWeeks_(weekStart, count) {
  const d = new Date(weekStart + 'T12:00:00');
  d.setDate(d.getDate() + (Number(count) || 0) * 7);
  return rpYmd_(d);
}

function rpSetScope_(scope) {
  _rp.scope = ['week', 'range', 'permanent'].includes(scope) ? scope : 'week';
  _rp.preflight = null;
  rpUpdateScopeUi_();
  rpPreflight_();
}

function rpSetWeeksCount_(value) {
  const n = Math.max(2, Math.min(26, Math.floor(Number(value) || 4)));
  _rp.weeksCount = n;
  const input = document.getElementById('rp-week-count');
  if (input && String(input.value) !== String(n)) input.value = String(n);
  _rp.preflight = null;
  rpUpdateScopeUi_();
  rpPreflight_();
}

function rpRangeEndWeek_() {
  return rpAddWeeks_(_rp.weekStart, Math.max(1, Number(_rp.weeksCount) || 4) - 1);
}

function rpUpdateScopeUi_() {
  const scopeEl = document.getElementById('rp-scope');
  if (scopeEl && scopeEl.value !== _rp.scope) scopeEl.value = _rp.scope;
  const weeksEl = document.getElementById('rp-weeks-control');
  const summary = document.getElementById('rp-range-summary');
  const isRange = _rp.scope === 'range';
  if (weeksEl) weeksEl.style.display = isRange ? 'flex' : 'none';
  if (summary) {
    if (isRange) {
      summary.textContent = _rp.weekStart + ' to ' + rpRangeEndWeek_();
    } else if (_rp.scope === 'permanent') {
      summary.textContent = 'Starts ' + _rp.weekStart;
    } else {
      summary.textContent = _rp.weekStart;
    }
  }
}

function rpSetView_(view) {
  _rp.view = view === 'map' ? 'map' : 'board';
  rpUpdateViewButtons_();
  rpRenderMain_();
}

function rpUpdateViewButtons_() {
  const board = document.getElementById('rp-board-view-btn');
  const map = document.getElementById('rp-map-view-btn');
  if (board) board.classList.toggle('active', _rp.view !== 'map');
  if (map) map.classList.toggle('active', _rp.view === 'map');
}

function rpLoadWeek_(refresh) {
  const root = document.getElementById('rp-board');
  if (root) root.innerHTML = '<div class="rp-loading">Loading routes...</div>';
  const params = { token: _s.token, operator: 'all', week_start: _rp.weekStart, cache_version: 'route-planner-v1' };
  if (refresh) params.refresh = '1';
  const direct = typeof apiLocalGet === 'function'
    ? apiLocalGet('/api/schedule', params)
    : Promise.reject(new Error('no local schedule'));
  direct.catch(() => apiGet({ action: 'route_data', token: _s.token, operator: 'all', week_start: _rp.weekStart }))
    .then(res => {
      if (!res || !res.ok) throw new Error((res && res.error) || 'Could not load routes.');
      _rp.data = res;
      rpPopulateOperators_();
      rpRenderMain_();
      rpRenderImpact_();
    })
    .catch(err => {
      if (root) root.innerHTML = `<div class="rp-empty err">${escHtml(err.message || err)}</div>`;
    });
}

function rpLoadHistory_() {
  api({ action: 'reschedule_list', token: _s.token })
    .then(res => {
      _rp.history = res && res.ok ? (res.batches || []) : [];
      rpRenderHistory_();
    })
    .catch(() => {
      _rp.history = [];
      rpRenderHistory_();
    });
}

function rpPopulateOperators_() {
  const ops = rpOperators_();
  const filter = document.getElementById('rp-filter-op');
  const target = document.getElementById('rp-target-op');
  if (filter) {
    filter.innerHTML = '<option value="all">All technicians</option>' + ops.map(op => `<option value="${escHtml(op)}">${escHtml(op)}</option>`).join('');
    filter.value = _rp.filter.operator;
  }
  if (target) {
    // Label techs who don't work the chosen target day. Preflight blocks these
    // anyway; saying so up front beats staging a doomed move and reading why.
    const prev = target.value;
    const targetDay = document.getElementById('rp-target-day');
    const dayKey = targetDay ? String(targetDay.value || '').toUpperCase() : '';
    target.innerHTML = '<option value="">Keep technician</option>' + ops.map(op => {
      const off = dayKey && !rpTechWorksDay_(op, dayKey);
      return `<option value="${escHtml(op)}"${off ? ' disabled' : ''}>${escHtml(op)}${off ? ' — off ' + escHtml(dayKey.slice(0, 1) + dayKey.slice(1).toLowerCase()) : ''}</option>`;
    }).join('');
    if (prev) target.value = prev;
    if (target.selectedIndex === -1 || (target.options[target.selectedIndex] || {}).disabled) target.value = '';
  }
}

function rpTechWorksDay_(name, dayKeyUpper) {
  const techs = (_rp.ctx && _rp.ctx.technicians) || [];
  const tech = techs.find(t => t.name === name);
  if (!tech || !tech.days || !tech.days.length) return true; // unknown → don't block
  return tech.days.indexOf(dayKeyUpper) !== -1;
}

// Re-labels the technician list whenever the target day changes.
function rpTargetDayChanged_() {
  rpPopulateOperators_();
}

function rpOperators_() {
  const set = new Set();
  // Active technicians from the Users sheet, not just whoever happens to have a
  // stop this week — otherwise an idle tech can never be a move target, which is
  // exactly who you want to move work to.
  ((_rp.ctx && _rp.ctx.technicians) || []).forEach(t => { if (t.name) set.add(t.name); });
  ((_rp.data && _rp.data.all_operators) || []).forEach(op => { if (op && op !== 'UNASSIGNED') set.add(op); });
  ((_rp.data && _rp.data.days) || []).forEach(day => (day.pools || []).forEach(p => {
    if (p.operator && p.operator !== 'UNASSIGNED') set.add(p.operator);
  }));
  return Array.from(set).sort();
}

function rpPoolIndex_() {
  const out = {};
  ((_rp.data && _rp.data.days) || []).forEach(day => {
    (day.pools || []).forEach(pool => {
      out[pool.pool_id] = Object.assign({}, pool, { _origin_day: day.day });
    });
  });
  return out;
}

function rpVisiblePools_() {
  const q = String(_rp.filter.q || '').toLowerCase();
  const shown = [];
  ((_rp.data && _rp.data.days) || []).forEach(day => {
    (day.pools || []).forEach(pool => {
      if (_rp.filter.day !== 'all' && day.day !== _rp.filter.day) return;
      if (_rp.filter.operator !== 'all' && String(pool.operator || '') !== _rp.filter.operator) return;
      const hay = [pool.customer_name, pool.address, pool.city, pool.service, pool.pool_id].join(' ').toLowerCase();
      if (q && hay.indexOf(q) === -1) return;
      shown.push(Object.assign({}, pool, { _origin_day: day.day }));
    });
  });
  return shown;
}

function rpMatchesFilter_(pool, dayName, operatorName) {
  const q = String(_rp.filter.q || '').toLowerCase();
  if (_rp.filter.day !== 'all' && dayName !== _rp.filter.day) return false;
  if (_rp.filter.operator !== 'all' && String(operatorName || pool.operator || '') !== _rp.filter.operator) return false;
  const hay = [pool.customer_name, pool.address, pool.city, pool.service, pool.pool_id].join(' ').toLowerCase();
  return !q || hay.indexOf(q) !== -1;
}

function rpRenderMain_() {
  if (_rp.view === 'map') rpRenderMap_();
  else rpRenderBoard_();
}

function rpRenderBoard_() {
  const board = document.getElementById('rp-board');
  if (!board || !_rp.data) return;
  board.className = 'rp-board';
  const source = rpPoolIndex_();
  const byDay = {};
  RP_DAYS.forEach(day => { byDay[day] = []; });

  ((_rp.data.days || [])).forEach(day => {
    (day.pools || []).forEach(pool => {
      if (!byDay[day.day]) return;
      if (!rpMatchesFilter_(pool, day.day, pool.operator)) return;
      byDay[day.day].push(Object.assign({}, pool, { _origin_day: day.day, _ghost: !!_rp.staged[pool.pool_id] }));
    });
  });
  Object.keys(_rp.staged).forEach(pid => {
    const staged = _rp.staged[pid];
    const base = source[pid];
    if (!base || !byDay[staged.new_day]) return;
    if (!rpMatchesFilter_(Object.assign({}, base, staged), staged.new_day, staged.new_operator || base.operator)) return;
    byDay[staged.new_day].push(Object.assign({}, base, staged, { _pending: true }));
  });

  board.innerHTML = RP_DAYS.map(day => {
    const pools = byDay[day] || [];
    const realCount = pools.filter(p => !p._pending && !p._ghost).length;
    const pendingIn = pools.filter(p => p._pending).length;
    const closed = rpDayClosed_(day);
    return `
      <div class="rp-col${closed ? ' closed' : ''}" ondragover="event.preventDefault()" ondrop="rpDropOnDay_(${jsArg(day)})">
        <div class="rp-col-head">
          <div class="rp-day">${day}</div>
          <div class="rp-count">${realCount}${pendingIn ? ' +' + pendingIn : ''}</div>
        </div>
        ${rpDayFlagsHtml_(day)}
        ${rpDayCapacityHtml_(day, pools)}
        <div class="rp-pools">
          ${pools.length ? pools.map(p => rpCardHtml_(p)).join('') : '<div class="rp-empty">No stops</div>'}
        </div>
      </div>`;
  }).join('');
  rpUpdateApplyState_();
}

// ─── Day constraints (locks, blackouts, capacity) ───────────────────────────
// Preflight is the authority and still blocks server-side. These are advisory:
// they stop a manager staging a move that was never going to be allowed.

// A day is "gone", not "locked" — there is no auto-recalculation to freeze it
// against. The only thing that closes a day is time: it already happened, or the
// route went out this morning.
function rpDayGoneReason_(day) {
  const closed = ((_rp.ctx && _rp.ctx.closed_days) || []).find(c => c.day === day);
  return closed ? (closed.reason || 'has already passed') : '';
}

function rpDayGone_(day) {
  return !!rpDayGoneReason_(day);
}

function rpDayBlackout_(day) {
  return ((_rp.ctx && _rp.ctx.blackout_days) || []).some(b => b.day === day);
}

function rpDayClosed_(day) {
  return rpDayGone_(day) || rpDayBlackout_(day);
}

function rpDayFlagsHtml_(day) {
  const flags = [];
  const gone = rpDayGoneReason_(day);
  if (gone) {
    const label = /already went out/.test(gone) ? 'Route is out' : 'Past';
    flags.push(`<span class="rp-badge bad" title="${escHtml(day + ' ' + gone)}">${label}</span>`);
  }
  if (rpDayBlackout_(day)) flags.push('<span class="rp-badge warn">Blackout</span>');
  return flags.length ? `<div class="rp-day-flags">${flags.join('')}</div>` : '';
}

// Per-technician load for the day, including anything staged into it, against
// that tech's max_per_day. Over-capacity turns red before you hit apply.
function rpDayCapacityHtml_(day, pools) {
  const techs = (_rp.ctx && _rp.ctx.technicians) || [];
  if (!techs.length) return '';
  const counts = {};
  (pools || []).forEach(p => {
    if (p._ghost) return; // leaving this day — don't count it against the target
    const op = String(p.operator || 'UNASSIGNED');
    counts[op] = (counts[op] || 0) + 1;
  });
  const dayKey = day.toUpperCase();
  const rows = Object.keys(counts).sort().map(op => {
    const tech = techs.find(t => t.name === op);
    const max = tech ? Number(tech.max_per_day) || 0 : 0;
    const worksDay = tech ? (!tech.days.length || tech.days.indexOf(dayKey) !== -1) : true;
    let cls = '';
    if (!worksDay) cls = 'bad';
    else if (max && counts[op] > max) cls = 'bad';
    else if (max && counts[op] === max) cls = 'warn';
    const title = !worksDay ? op + ' does not work ' + day : op + ' ' + counts[op] + (max ? ' of ' + max : '');
    return `<span class="rp-cap ${cls}" title="${escHtml(title)}">${escHtml(op === 'UNASSIGNED' ? 'Unassigned' : op)} ${counts[op]}${max ? '/' + max : ''}${!worksDay ? ' ⚠' : ''}</span>`;
  });
  return rows.length ? `<div class="rp-day-cap">${rows.join('')}</div>` : '';
}

// ─── Unrouted tray ──────────────────────────────────────────────────────────
// Active customers with no day/technician never appear on a Mon–Sat board, so
// the one screen built for placing work was the one screen that couldn't see
// what needed placing. Surfaced here rather than only on Home and Schedule.

function rpToggleUnrouted_() {
  _rp.showUnrouted = !_rp.showUnrouted;
  rpRenderUnrouted_();
}

// Both trays render into one node so they sit side by side and neither can
// clobber the other on refresh.
function rpRenderTrays_() {
  const el = document.getElementById('rp-trays');
  if (!el) return;
  const html = rpUnroutedHtml_() + rpSeriesHtml_();
  el.innerHTML = html ? `<div class="rp-trays">${html}</div>` : '';
}

function rpRenderUnrouted_() { rpRenderTrays_(); }

function rpUnroutedHtml_() {
  const un = (_rp.ctx && _rp.ctx.unrouted) || null;
  if (!un || !un.count) return '';

  const head = `
    <div class="rp-unrouted-head">
      <span class="rp-badge warn"><b>${Number(un.count)}</b> need routing</span>
      <button class="rp-mini-btn" onclick="rpToggleUnrouted_()">${_rp.showUnrouted ? 'Hide' : 'Show'}</button>
    </div>`;
  if (!_rp.showUnrouted) return `<div class="rp-unrouted">${head}</div>`;

  const rows = (un.pools || []).map(p => {
    // A pool already on a day/operator but missing a monthly week needs a week
    // picked, not a day — the planner can't do that, so say where to go.
    const note = p.needs_monthly_week
      ? 'Monthly pool — needs a service week'
      : 'No day or technician yet';
    return `
      <div class="rp-unrouted-row">
        <div>
          <b>${escHtml(p.customer_name || p.pool_id)}</b>
          <small>${escHtml([p.address, p.city].filter(Boolean).join(', ') || p.pool_id)}</small>
          <small>${escHtml(p.service || '')}${p.operator ? ' · ' + escHtml(p.operator) : ''}</small>
        </div>
        <span class="rp-badge ${p.needs_monthly_week ? 'warn' : ''}">${escHtml(note)}</span>
      </div>`;
  }).join('');

  return `
    <div class="rp-unrouted">
      ${head}
      <p class="rp-unrouted-note">These are active customers with no place on the board.
        Give them a day and technician from <b>Schedule</b> (or Home &rarr; Needs routing);
        once they have one they'll appear here and can be moved in bulk.</p>
      <div class="rp-unrouted-list">${rows}</div>
      ${un.truncated ? `<div class="rp-unrouted-note">Showing the first ${(un.pools || []).length} of ${Number(un.count)}.</div>` : ''}
    </div>`;
}

// ─── Temporary visit series ─────────────────────────────────────────────────
// A pool on a 6-week temporary schedule lives in Scheduled_Visits, not on the
// recurring route, so bulk moves can't touch it and nothing showed how many
// weeks were left. This is where a manager ends or extends one.

function rpToggleSeries_() {
  _rp.showSeries = !_rp.showSeries;
  rpRenderTrays_();
}

function rpLoadSeries_() {
  api({ action: 'visit_series_list', token: _s.token })
    .then(res => {
      _rp.series = res && res.ok ? res : null;
      rpRenderTrays_();
    })
    .catch(() => { _rp.series = null; rpRenderTrays_(); });
}

function rpSeriesHtml_() {
  const data = _rp.series;
  const list = (data && data.series) || [];
  if (!list.length) return '';

  const head = `
    <div class="rp-unrouted-head">
      <span class="rp-badge"><b>${list.length}</b> temporary series</span>
      <button class="rp-mini-btn" onclick="rpToggleSeries_()">${_rp.showSeries ? 'Hide' : 'Show'}</button>
    </div>`;
  if (!_rp.showSeries) return `<div class="rp-unrouted">${head}</div>`;

  const rows = list.map(s => {
    const done = Number(s.total) - Number(s.remaining);
    const label = s.series_type === 'first_month' ? 'First month' : 'Temporary';
    return `
      <div class="rp-unrouted-row">
        <div>
          <b>${escHtml(s.customer_name || s.pool_id)}</b>
          <small>${escHtml(label)} · ${escHtml(s.day_of_week || '?')} · ${escHtml(s.technician || 'Unassigned')}</small>
          <small>${Number(s.remaining)} of ${Number(s.total)} left${done > 0 ? ' · ' + done + ' done' : ''}${s.next_date ? ' · next ' + escHtml(s.next_date) : ''}</small>
        </div>
        <div class="rp-history-actions">
          <button class="rp-mini-btn" onclick="rpExtendSeries_(${jsArg(s.series_key)})">Extend</button>
          <button class="rp-mini-btn" onclick="rpCancelSeries_(${jsArg(s.series_key)})">End</button>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="rp-unrouted">
      ${head}
      <p class="rp-unrouted-note">Pools on a temporary weekly schedule. These live in
        Scheduled Visits, not the recurring route &mdash; a bulk move on the board
        won't touch them. Ending one keeps every completed visit.</p>
      <div class="rp-unrouted-list">${rows}</div>
    </div>`;
}

function rpExtendSeries_(seriesKey) {
  const raw = prompt('Extend this series by how many more weeks?', '4');
  if (raw === null) return;
  const weeks = Math.floor(Number(raw));
  if (!(weeks >= 1)) { alert('Enter 1 or more weeks.'); return; }
  api({ action: 'visit_series_extend', token: _s.token, series_key: seriesKey, weeks })
    .then(res => {
      if (!res || !res.ok) throw new Error((res && res.error) || 'Could not extend the series.');
      const skipped = (res.skipped_dates || []).length;
      alert('Added ' + res.created_count + ' visit' + (res.created_count === 1 ? '' : 's') +
            (skipped ? '. Skipped ' + skipped + ' date' + (skipped === 1 ? '' : 's') + ' that already had a visit.' : '.'));
      rpAfterSeriesChange_();
    })
    .catch(err => alert(err.message || err));
}

function rpCancelSeries_(seriesKey) {
  if (!confirm('End this series? Every visit still ahead is cancelled. Completed visits are kept.')) return;
  api({ action: 'visit_series_cancel', token: _s.token, series_key: seriesKey })
    .then(res => {
      if (!res || !res.ok) throw new Error((res && res.error) || 'Could not end the series.');
      alert('Cancelled ' + res.cancelled_count + ' upcoming visit' + (res.cancelled_count === 1 ? '' : 's') + '.');
      rpAfterSeriesChange_();
    })
    .catch(err => alert(err.message || err));
}

// Series rows are scheduled visits, so the board and route caches are both stale.
function rpAfterSeriesChange_() {
  if (typeof _clearRouteCache === 'function') _clearRouteCache();
  rpLoadSeries_();
  rpLoadWeek_(true);
}

function rpLoadPlannerContext_() {
  api({ action: 'reschedule_planner_context', token: _s.token, week_start: _rp.weekStart })
    .then(res => {
      _rp.ctx = res && res.ok ? res : null;
      rpPopulateOperators_();
      rpRenderMain_();
      rpRenderUnrouted_();
    })
    .catch(() => { _rp.ctx = null; });
}

function rpRenderMap_() {
  const board = document.getElementById('rp-board');
  if (!board || !_rp.data) return;
  board.className = 'rp-map-wrap';
  // A stop with no lat/lng cannot be plotted. Never drop those silently — a map
  // showing 6 of 30 stops looks like the whole route unless we say otherwise.
  const visible = rpVisiblePools_().map(p => Object.assign({}, p, _rp.staged[p.pool_id] || {}));
  const pools = visible.filter(p => Number(p.lat) && Number(p.lng));
  const missing = visible.length - pools.length;
  const missingNote = missing
    ? `<div class="rp-map-note">${pools.length} of ${visible.length} stops plotted &mdash;
         ${missing} ${missing === 1 ? 'has' : 'have'} no coordinates yet.
         Run <b>Calculate routes</b> to geocode them.</div>`
    : '';
  if (!pools.length) {
    _rp.mapPoints = [];
    board.innerHTML = missing
      ? `<div class="rp-map-empty err">None of these ${visible.length} stops have coordinates yet. Run <b>Calculate routes</b> to geocode them, then reopen Map.</div>`
      : '<div class="rp-map-empty">No mappable stops</div>';
    rpUpdateApplyState_();
    return;
  }
  const lats = pools.map(p => Number(p.lat));
  const lngs = pools.map(p => Number(p.lng));
  const minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
  const minLng = Math.min.apply(null, lngs), maxLng = Math.max.apply(null, lngs);
  const latSpan = Math.max(.001, maxLat - minLat);
  const lngSpan = Math.max(.001, maxLng - minLng);
  _rp.mapPoints = pools.map(p => {
    const x = 6 + ((Number(p.lng) - minLng) / lngSpan) * 88;
    const y = 94 - ((Number(p.lat) - minLat) / latSpan) * 88;
    return Object.assign({}, p, { _x: x, _y: y });
  });
  board.innerHTML = `
    ${missingNote}
    <div class="rp-map-canvas" onmousedown="rpMapStart_(event)" onmousemove="rpMapMove_(event)" onmouseup="rpMapEnd_(event)" onmouseleave="rpMapEnd_(event)">
      ${_rp.mapPoints.map(p => `
        <button class="rp-map-point${_rp.selected.has(p.pool_id) ? ' selected' : ''}" style="left:${p._x}%;top:${p._y}%"
          title="${escHtml((p.customer_name || p.pool_id) + ' · ' + (p.operator || 'UNASSIGNED'))}"
          onmousedown="event.stopPropagation()"
          onclick="event.stopPropagation();rpToggle_(${jsArg(p.pool_id)})">
          <span></span>
        </button>`).join('')}
      <div class="rp-map-rect" id="rp-map-rect"></div>
    </div>`;
  rpUpdateApplyState_();
}

function rpMapPointPixels_(canvas, point) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: rect.width * point._x / 100,
    y: rect.height * point._y / 100
  };
}

function rpMapStart_(event) {
  if (event.button !== 0) return;
  const rect = event.currentTarget.getBoundingClientRect();
  _rp.mapDrag = {
    x1: event.clientX - rect.left,
    y1: event.clientY - rect.top,
    x2: event.clientX - rect.left,
    y2: event.clientY - rect.top
  };
  rpMapDrawRect_();
}

function rpMapMove_(event) {
  if (!_rp.mapDrag) return;
  const rect = event.currentTarget.getBoundingClientRect();
  _rp.mapDrag.x2 = event.clientX - rect.left;
  _rp.mapDrag.y2 = event.clientY - rect.top;
  rpMapDrawRect_();
}

function rpMapEnd_(event) {
  if (!_rp.mapDrag) return;
  const canvas = event.currentTarget;
  const drag = _rp.mapDrag;
  _rp.mapDrag = null;
  const minX = Math.min(drag.x1, drag.x2), maxX = Math.max(drag.x1, drag.x2);
  const minY = Math.min(drag.y1, drag.y2), maxY = Math.max(drag.y1, drag.y2);
  if (maxX - minX > 6 && maxY - minY > 6) {
    _rp.mapPoints.forEach(p => {
      const px = rpMapPointPixels_(canvas, p);
      if (px.x >= minX && px.x <= maxX && px.y >= minY && px.y <= maxY) _rp.selected.add(p.pool_id);
    });
  }
  rpRenderMap_();
}

function rpMapDrawRect_() {
  const el = document.getElementById('rp-map-rect');
  if (!el || !_rp.mapDrag) return;
  const d = _rp.mapDrag;
  const x = Math.min(d.x1, d.x2), y = Math.min(d.y1, d.y2);
  const w = Math.abs(d.x2 - d.x1), h = Math.abs(d.y2 - d.y1);
  el.style.display = 'block';
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = w + 'px';
  el.style.height = h + 'px';
}

function rpCardHtml_(p) {
  const id = String(p.pool_id || '');
  const selected = _rp.selected.has(id);
  const cls = ['rp-card'];
  if (selected) cls.push('selected');
  if (p._ghost) cls.push('ghost');
  if (p._pending) cls.push('pending');
  return `
    <div class="${cls.join(' ')}" draggable="true" ondragstart="rpDragStart_(${jsArg(id)})" onclick="rpToggle_(${jsArg(id)})">
      <div class="rp-card-top">
        <input type="checkbox" ${selected ? 'checked' : ''} onclick="event.stopPropagation();rpToggle_(${jsArg(id)})">
        <span class="rp-name">${escHtml(p.customer_name || 'Unnamed')}</span>
      </div>
      <div class="rp-meta">${escHtml(p.operator || 'UNASSIGNED')} · ${escHtml(p.city || '')}</div>
      <div class="rp-addr">${escHtml(p.address || '')}</div>
    </div>`;
}

function rpToggle_(poolId) {
  if (_rp.selected.has(poolId)) _rp.selected.delete(poolId);
  else _rp.selected.add(poolId);
  rpRenderMain_();
}

function rpClearSelection_() {
  _rp.selected.clear();
  rpRenderMain_();
}

function rpSelectVisible_() {
  rpVisiblePools_().forEach(p => _rp.selected.add(p.pool_id));
  rpRenderMain_();
}

function rpSetFilter_(key, value) {
  _rp.filter[key] = value;
  rpRenderMain_();
}

function rpDragStart_(poolId) {
  _rp.dragPoolId = poolId;
}

function rpDropOnDay_(day) {
  const poolIds = _rp.selected.has(_rp.dragPoolId) ? Array.from(_rp.selected) : [_rp.dragPoolId];
  rpStagePoolIds_(poolIds, day, document.getElementById('rp-target-op') ? document.getElementById('rp-target-op').value : '');
}

function rpStageSelected_() {
  const day = document.getElementById('rp-target-day') ? document.getElementById('rp-target-day').value : '';
  const op = document.getElementById('rp-target-op') ? document.getElementById('rp-target-op').value : '';
  rpStagePoolIds_(Array.from(_rp.selected), day, op);
}

function rpStagePoolIds_(poolIds, day, operator) {
  if (!poolIds.length || !day) return;
  // Advisory only — preflight is the authority and will block server-side. This
  // just stops a manager staging 20 pools into a day that was never available.
  if (rpDayClosed_(day)) {
    const gone = rpDayGoneReason_(day);
    const why = gone ? day + ' ' + gone : day + ' is a scheduled blackout';
    if (!confirm(why + '. This move will be blocked when you apply. Stage it anyway?')) return;
  }
  const source = rpPoolIndex_();
  poolIds.forEach(pid => {
    const base = source[pid];
    if (!base) return;
    _rp.staged[pid] = {
      pool_id: pid,
      new_day: day,
      new_operator: operator || base.operator || ''
    };
  });
  _rp.selected.clear();
  rpRenderMain_();
  rpPreflight_();
}

function rpClearStage_() {
  _rp.staged = {};
  _rp.preflight = null;
  const ack = document.getElementById('rp-ack');
  if (ack) ack.checked = false;
  rpRenderMain_();
  rpRenderImpact_();
}

function rpScopePayload_() {
  const scope = document.getElementById('rp-scope') ? document.getElementById('rp-scope').value : _rp.scope;
  return {
    scope,
    effective_week: _rp.weekStart,
    end_week: scope === 'range' ? rpRangeEndWeek_() : _rp.weekStart,
    duration_weeks: scope === 'range' ? Math.max(2, Number(_rp.weeksCount) || 4) : 1
  };
}

function rpItems_() {
  return Object.keys(_rp.staged).map(pid => ({
    pool_id: pid,
    new_day: _rp.staged[pid].new_day,
    new_operator: _rp.staged[pid].new_operator
  }));
}

function rpPreflight_() {
  clearTimeout(_rp.timer);
  _rp.timer = setTimeout(() => {
    const items = rpItems_();
    if (!items.length) {
      _rp.preflight = null;
      rpRenderImpact_();
      return;
    }
    api(Object.assign({
      action: 'reschedule_preflight',
      token: _s.token,
      items
    }, rpScopePayload_())).then(res => {
      _rp.preflight = res;
      rpRenderImpact_();
      rpUpdateApplyState_();
    }).catch(err => {
      _rp.preflight = { ok: false, error: err.message || String(err) };
      rpRenderImpact_();
    });
  }, 180);
}

function rpRenderImpact_() {
  const el = document.getElementById('rp-impact');
  if (!el) return;
  const items = rpItems_();
  if (!items.length) {
    el.innerHTML = '<h2 class="rp-panel-title">Impact</h2><div class="rp-empty">No staged changes</div>';
    rpUpdateApplyState_();
    return;
  }
  const pf = _rp.preflight;
  if (!pf) {
    el.innerHTML = '<h2 class="rp-panel-title">Impact</h2><div class="rp-empty">Checking...</div>';
    return;
  }
  if (!pf.ok) {
    el.innerHTML = `<h2 class="rp-panel-title">Impact</h2><div class="rp-empty err">${escHtml(pf.error || 'Preflight failed')}</div>`;
    return;
  }
  const blocked = pf.verdicts.filter(v => v.blockers && v.blockers.length);
  const warned = pf.verdicts.filter(v => v.warnings && v.warnings.length);
  const over = (pf.capacity || []).filter(c => c.over_capacity);
  el.innerHTML = `
    <h2 class="rp-panel-title">Impact</h2>
    <div class="rp-stats">
      <div><b>${items.length}</b><span>staged</span></div>
      <div class="${blocked.length ? 'bad' : ''}"><b>${blocked.length}</b><span>blocked</span></div>
      <div class="${warned.length ? 'warn' : ''}"><b>${warned.length}</b><span>warnings</span></div>
    </div>
    ${over.length ? `<div class="rp-impact-list">${over.map(c => `<div class="rp-impact-row bad">${escHtml(c.week_start)} ${escHtml(c.day)} · ${escHtml(c.operator)} ${Number(c.projected)}/${Number(c.max)}</div>`).join('')}</div>` : ''}
    ${blocked.length ? `<div class="rp-impact-list">${blocked.map(v => `<div class="rp-impact-row bad">${escHtml(v.customer_name || v.pool_id)}: ${escHtml(v.blockers.join('; '))}</div>`).join('')}</div>` : ''}
    ${warned.length ? `<div class="rp-impact-list">${warned.slice(0, 8).map(v => `<div class="rp-impact-row warn">${escHtml(v.customer_name || v.pool_id)}: ${escHtml(v.warnings[0])}</div>`).join('')}</div>` : ''}
  `;
}

function rpRenderHistory_() {
  const el = document.getElementById('rp-history');
  if (!el) return;
  const rows = (_rp.history || []).slice(0, 8);
  const composer = _rp.notify.batchId ? `
    <div class="rp-notify-box">
      <div class="rp-notify-top">
        <b>Notify batch</b>
        <button class="rp-mini-btn" onclick="rpCancelNotify_()">Close</button>
      </div>
      <input class="rp-notify-input" id="rp-notify-subject" value="${escHtml(_rp.notify.subject)}"
             oninput="rpNotifyField_('subject', this.value)">
      <textarea class="rp-notify-body" id="rp-notify-body"
                oninput="rpNotifyField_('body', this.value)">${escHtml(_rp.notify.body)}</textarea>
      ${rpNotifyPreviewHtml_()}
      <div class="rp-notify-actions">
        <button class="rp-mini-btn" onclick="rpSendNotifyTest_()">Send test to me</button>
        <button class="rp-mini-btn" onclick="rpLoadNotifyPreview_()">Refresh preview</button>
      </div>
      <button class="rp-btn primary" id="rp-notify-queue" onclick="rpSendNotify_()"
              ${rpNotifySendable_() === 0 ? 'disabled' : ''}>${rpNotifyQueueLabel_()}</button>
    </div>` : '';
  el.innerHTML = `
    <h2 class="rp-panel-title">History</h2>
    ${composer}
    ${rows.length ? rows.map(b => `
      <div class="rp-history-row">
        <div>
          <b>${escHtml(b.scope || '')}</b>
          <span>${escHtml(b.effective_week || '')}${b.end_week && b.end_week !== b.effective_week ? ' to ' + escHtml(b.end_week) : ''}</span>
          <small>${escHtml(b.status || '')} · ${Number(b.item_count) || 0} pools</small>
        </div>
        <div class="rp-history-actions">
          <button class="rp-mini-btn" onclick="rpOpenBatchDetail_(${jsArg(b.batch_id)})">Detail</button>
          ${['applied','partially_applied'].includes(String(b.status)) ? `
            <button class="rp-mini-btn" onclick="rpOpenNotify_(${jsArg(b.batch_id)})">Notify</button>
            <button class="rp-mini-btn" onclick="rpRevert_(${jsArg(b.batch_id)})">Revert</button>` : ''}
        </div>
      </div>`).join('') : '<div class="rp-empty">No batches yet</div>'}
  `;
}

function rpOpenNotify_(batchId) {
  _rp.notify = {
    batchId,
    subject: RP_NOTIFY_DEFAULTS.subject,
    body: RP_NOTIFY_DEFAULTS.body,
    preview: null,
    previewLoading: true,
    previewError: ''
  };
  rpRenderHistory_();
  rpLoadNotifyPreview_();
}

function rpCancelNotify_() {
  _rp.notify = { batchId: '', subject: '', body: '', preview: null, previewLoading: false, previewError: '' };
  rpRenderHistory_();
}

// The composer's text lives in _rp.notify, not the DOM — a preview refresh
// re-renders #rp-history and would otherwise wipe whatever was typed.
function rpNotifyField_(key, value) {
  _rp.notify[key] = value;
}

function rpLoadNotifyPreview_() {
  const batchId = _rp.notify.batchId;
  if (!batchId) return;
  _rp.notify.previewLoading = true;
  _rp.notify.previewError = '';
  rpRenderHistory_();
  api({
    action: 'reschedule_notify_preview',
    token: _s.token,
    batch_id: batchId,
    subject: _rp.notify.subject,
    body_markup: _rp.notify.body
  }).then(res => {
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not load recipients.');
    if (_rp.notify.batchId !== batchId) return; // composer moved on while in flight
    _rp.notify.preview = res;
  }).catch(err => {
    if (_rp.notify.batchId !== batchId) return;
    _rp.notify.previewError = err.message || String(err);
  }).finally(() => {
    if (_rp.notify.batchId !== batchId) return;
    _rp.notify.previewLoading = false;
    rpRenderHistory_();
  });
}

function rpNotifySendable_() {
  const pv = _rp.notify.preview;
  if (!pv || !pv.totals) return -1; // unknown yet — do not block the button
  return Number(pv.totals.sendable) || 0;
}

function rpNotifyQueueLabel_() {
  const n = rpNotifySendable_();
  return n < 0 ? 'Queue notification' : `Queue notification (${n})`;
}

function rpNotifyPreviewHtml_() {
  if (_rp.notify.previewError) {
    return `<div class="rp-empty err">${escHtml(_rp.notify.previewError)}</div>`;
  }
  if (_rp.notify.previewLoading && !_rp.notify.preview) {
    return '<div class="rp-empty">Loading recipients...</div>';
  }
  const pv = _rp.notify.preview;
  if (!pv) return '';
  const tt = pv.totals || {};
  const chips = [
    { label: 'recipients', value: Number(tt.total) || 0, cls: '' },
    { label: 'sendable', value: Number(tt.sendable) || 0, cls: Number(tt.sendable) ? 'ok' : 'bad' },
    { label: 'no email', value: Number(tt.missing_email) || 0, cls: tt.missing_email ? 'warn' : '' },
    { label: 'opted out', value: Number(tt.opted_out) || 0, cls: tt.opted_out ? 'warn' : '' },
    { label: 'told recently', value: Number(tt.notified_recently) || 0, cls: tt.notified_recently ? 'warn' : '' }
  ];
  const rows = (pv.recipients || []).map(r => `
    <div class="rp-recipient${r.sendable ? '' : ' skip'}">
      <b>${escHtml(r.name || r.email || (r.pool_ids || []).join(', ') || 'Unknown')}</b>
      <span>${escHtml(r.sendable ? r.email : (r.skip_reason || 'skipped'))}</span>
      <small>${escHtml(r.old_day || '?')} &rarr; ${escHtml(r.new_day || '?')}${Number(r.week_count) > 1 ? ' · ' + Number(r.week_count) + ' weeks' : ''}${r.notified_recently ? ' · told recently' : ''}</small>
    </div>`).join('');
  // body_html comes from commsRenderBody_, which escapes before applying markup —
  // the same pipeline that builds the real email, so this is what customers see.
  const sample = pv.sample ? `
    <div class="rp-sample">
      <span>Preview</span>
      <b>${escHtml(pv.sample.subject || '')}</b>
      <div class="rp-sample-body">${pv.sample.body_html || ''}</div>
    </div>` : '';
  return `
    <div class="rp-notify-totals">
      ${chips.map(c => `<span class="rp-badge ${c.cls}"><b>${c.value}</b> ${escHtml(c.label)}</span>`).join('')}
    </div>
    <div class="rp-recipients">${rows || '<div class="rp-empty">No applied items to notify</div>'}</div>
    ${sample}`;
}

function rpSendNotifyTest_() {
  const batchId = _rp.notify.batchId;
  if (!batchId) return;
  api({
    action: 'reschedule_notify_test',
    token: _s.token,
    batch_id: batchId,
    subject: _rp.notify.subject,
    body_markup: _rp.notify.body,
    test_email: (_s && _s.email) || ''
  }).then(res => {
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not send test.');
    alert('Test sent to ' + (res.test_email || 'your address') + '. No customer was notified.');
  }).catch(err => alert(err.message || err));
}

function rpSendNotify_() {
  const batchId = _rp.notify.batchId;
  if (!batchId) return;
  const sendable = rpNotifySendable_();
  if (sendable === 0) return;
  const subject = _rp.notify.subject;
  const body = _rp.notify.body;
  api({
    action: 'reschedule_notify',
    token: _s.token,
    batch_id: batchId,
    subject,
    body_markup: body
  }).then(res => {
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not queue notification.');
    rpCancelNotify_();
    rpLoadHistory_();
  }).catch(err => alert(err.message || err));
}

function rpUpdateApplyState_() {
  const btn = document.getElementById('rp-apply-btn');
  if (!btn) return;
  const items = rpItems_();
  const pf = _rp.preflight;
  const ack = document.getElementById('rp-ack');
  const hasWarnings = pf && pf.ok && Number(pf.warnings || 0) > 0;
  const hasBlockers = pf && pf.ok && Number(pf.blockers || 0) > 0;
  btn.disabled = !items.length || !pf || !pf.ok || hasBlockers || (hasWarnings && !(ack && ack.checked));
}

// The apply button opens a confirmation instead of firing. rpUpdateApplyState_
// still decides whether it can be opened at all.
function rpApply_() {
  const items = rpItems_();
  if (!items.length) return;
  const pf = _rp.preflight;
  if (!pf || !pf.ok) return;
  _rp.detail = { mode: 'confirm', batchId: '', loading: false, batch: null, items: [], error: '', expanded: {} };
  rpRenderDetail_();
}

function rpConfirmApply_() {
  const items = rpItems_();
  if (!items.length) return;
  const btn = document.getElementById('rp-apply-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Applying...'; }
  const ack = document.getElementById('rp-ack');
  const confirmBtn = document.getElementById('rp-confirm-apply');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Applying...'; }
  api(Object.assign({
    action: 'reschedule_apply',
    token: _s.token,
    batch_id: 'rp-' + Date.now().toString(36),
    items,
    acknowledge_warnings: !!(ack && ack.checked),
    notify_enabled: false
  }, rpScopePayload_())).then(res => {
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not apply batch.');
    if (typeof _clearRouteCache === 'function') _clearRouteCache();
    _rp.staged = {};
    _rp.preflight = null;
    rpCloseDetail_();
    rpLoadWeek_(true);
    rpLoadHistory_();
    rpLoadWarmupStatus_();
  }).catch(err => {
    alert(err.message || err);
    rpUpdateApplyState_();
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Apply ' + items.length + ' pools'; }
  }).finally(() => {
    if (btn) btn.textContent = 'Review & apply';
  });
}

function rpRevert_(batchId) {
  if (!confirm('Revert this batch?')) return;
  api({ action: 'reschedule_revert', token: _s.token, batch_id: batchId })
    .then(res => {
      if (!res || !res.ok) throw new Error((res && res.error) || 'Could not revert batch.');
      if (typeof _clearRouteCache === 'function') _clearRouteCache();
      rpLoadWeek_(true);
      rpLoadHistory_();
      rpLoadWarmupStatus_();
    })
    .catch(err => alert(err.message || err));
}

// ─── Distance warmup status ─────────────────────────────────────────────────
// Warmups rebuild route ordering (computeRouteData_ repopulates the driving
// distance cache as a side effect), so the honest label is "route ordering".

function rpLoadWarmupStatus_() {
  api({ action: 'reschedule_warmup_status', token: _s.token })
    .then(res => {
      _rp.warmup = res && res.ok ? res : null;
      rpRenderWarmup_();
      if (_rp.detail.mode === 'batch') rpRenderDetail_();
    })
    .catch(() => { _rp.warmup = null; rpRenderWarmup_(); });
}

function rpWarmupBadge_() {
  const w = _rp.warmup;
  if (!w) return '';
  const queued = (Number(w.pending) || 0) + (Number(w.processing) || 0);
  if (queued > 0) {
    return `<span class="rp-badge warn">Route ordering updating &mdash; ${queued} week${queued === 1 ? '' : 's'} queued</span>`;
  }
  if (Number(w.failed) > 0) {
    return `<span class="rp-badge bad">Warmup failed &mdash; ${Number(w.failed)} week${Number(w.failed) === 1 ? '' : 's'}</span>`;
  }
  return '<span class="rp-badge ok">Route ordering ready</span>';
}

function rpRenderWarmup_() {
  const el = document.getElementById('rp-warmup');
  if (!el) return;
  const w = _rp.warmup;
  if (!w) { el.innerHTML = ''; return; }
  const queued = (Number(w.pending) || 0) + (Number(w.processing) || 0);
  el.innerHTML = `
    ${rpWarmupBadge_()}
    ${queued > 0 && isAdmin() ? '<button class="rp-mini-btn" onclick="rpWarmNow_()">Warm now</button>' : ''}`;
}

function rpWarmNow_() {
  const el = document.getElementById('rp-warmup');
  if (el) el.innerHTML = '<span class="rp-badge">Warming...</span>';
  api({ action: 'reschedule_warm_distances', token: _s.token, limit: 3 })
    .then(() => {
      if (typeof _clearRouteCache === 'function') _clearRouteCache();
      rpLoadWarmupStatus_();
    })
    .catch(err => { alert(err.message || err); rpLoadWarmupStatus_(); });
}

// ─── Batch detail drawer ────────────────────────────────────────────────────

function rpOpenBatchDetail_(batchId) {
  _rp.detail = { mode: 'batch', batchId, loading: true, batch: null, items: [], error: '', expanded: {} };
  rpRenderDetail_();
  api({ action: 'reschedule_detail', token: _s.token, batch_id: batchId })
    .then(res => {
      if (_rp.detail.batchId !== batchId) return;
      if (!res || !res.ok) throw new Error((res && res.error) || 'Could not load batch.');
      _rp.detail.batch = res.batch || null;
      _rp.detail.items = res.items || [];
    })
    .catch(err => {
      if (_rp.detail.batchId !== batchId) return;
      _rp.detail.error = err.message || String(err);
    })
    .finally(() => {
      if (_rp.detail.batchId !== batchId) return;
      _rp.detail.loading = false;
      rpRenderDetail_();
    });
}

function rpCloseDetail_() {
  _rp.detail = { mode: '', batchId: '', loading: false, batch: null, items: [], error: '', expanded: {} };
  rpRenderDetail_();
}

function rpToggleDetailPool_(poolId) {
  _rp.detail.expanded[poolId] = !_rp.detail.expanded[poolId];
  rpRenderDetail_();
}

function rpRenderDetail_() {
  const el = document.getElementById('rp-detail-drawer');
  if (!el) return;
  if (!_rp.detail.mode) { el.innerHTML = ''; return; }
  const body = _rp.detail.mode === 'confirm' ? rpConfirmBodyHtml_() : rpBatchDetailBodyHtml_();
  const title = _rp.detail.mode === 'confirm' ? 'Review &amp; apply' : 'Batch detail';
  el.innerHTML = `
    <div class="rp-drawer-backdrop" onclick="rpCloseDetail_()"></div>
    <aside class="rp-drawer open">
      <div class="rp-drawer-head">
        <h2 class="rp-panel-title">${title}</h2>
        <button class="rp-mini-btn" onclick="rpCloseDetail_()">Close</button>
      </div>
      <div class="rp-drawer-body">${body}</div>
    </aside>`;
}

function rpConfirmBodyHtml_() {
  const pf = _rp.preflight;
  const items = rpItems_();
  if (!pf || !pf.ok) return '<div class="rp-empty err">Preflight is not ready.</div>';
  const weeks = Number(pf.week_count) || 1;
  const entries = Number(pf.expanded_item_count) || items.length;
  const warnings = Number(pf.warnings) || 0;
  const blockers = Number(pf.blockers) || 0;
  const over = (pf.capacity || []).filter(c => c.over_capacity);
  return `
    <ul class="rp-confirm-list">
      <li><b>You are moving ${items.length} pool${items.length === 1 ? '' : 's'}.</b></li>
      <li>This affects ${weeks} week${weeks === 1 ? '' : 's'}.</li>
      <li>${entries} route entr${entries === 1 ? 'y' : 'ies'} will be changed.</li>
      <li class="${warnings ? 'warn' : ''}">${warnings} warning${warnings === 1 ? '' : 's'} need acknowledgement.</li>
      <li class="${blockers ? 'bad' : ''}">${blockers} blocker${blockers === 1 ? '' : 's'}.</li>
      <li>Notifications are not sent automatically.</li>
    </ul>
    ${over.length ? `<div class="rp-impact-list">${over.map(c => `<div class="rp-impact-row bad">${escHtml(c.week_start)} ${escHtml(c.day)} · ${escHtml(c.operator)} over capacity ${Number(c.projected)}/${Number(c.max)}</div>`).join('')}</div>` : ''}
    <div class="rp-drawer-actions">
      <button class="rp-btn" onclick="rpCloseDetail_()">Cancel</button>
      <button class="rp-btn primary" id="rp-confirm-apply" onclick="rpConfirmApply_()">Apply ${items.length} pool${items.length === 1 ? '' : 's'}</button>
    </div>`;
}

function rpBatchDetailBodyHtml_() {
  if (_rp.detail.loading) return '<div class="rp-loading">Loading batch...</div>';
  if (_rp.detail.error) return `<div class="rp-empty err">${escHtml(_rp.detail.error)}</div>`;
  const b = _rp.detail.batch;
  if (!b) return '<div class="rp-empty">Batch not found</div>';

  const facts = [
    ['Batch', b.batch_id],
    ['Status', b.status],
    ['Scope', b.scope],
    ['Effective', b.end_week && b.end_week !== b.effective_week
      ? `${b.effective_week} to ${b.end_week}` : (b.effective_week || '')],
    ['Created by', `${b.created_by || ''} ${b.created_at ? '· ' + String(b.created_at).slice(0, 16).replace('T', ' ') : ''}`],
    ['Applied', b.applied_at ? String(b.applied_at).slice(0, 16).replace('T', ' ') : '—'],
    ['Reverted', b.reverted_at ? String(b.reverted_at).slice(0, 16).replace('T', ' ') : '—'],
    ['Pools', `${Number(b.item_count) || 0} · ${Number(b.applied_count) || 0} applied · ${Number(b.failed_count) || 0} failed`],
    ['Notified', String(b.notify_enabled).toUpperCase() === 'TRUE'
      ? `${Number(b.notified_count) || 0} sent${b.campaign_id ? ' · campaign ' + String(b.campaign_id).slice(0, 8) : ''}`
      : 'not notified']
  ];
  if (b.error) facts.push(['Error', b.error]);

  // Range batches write one item per pool × week. Collapse to one row per pool
  // so an 18-pool × 4-week batch reads as 18 rows, not 72.
  const byPool = {};
  const order = [];
  (_rp.detail.items || []).forEach(it => {
    const key = String(it.pool_id || it.item_id || '');
    if (!byPool[key]) { byPool[key] = []; order.push(key); }
    byPool[key].push(it);
  });

  const rows = order.map(pid => {
    const group = byPool[pid];
    const first = group[0];
    const expanded = !!_rp.detail.expanded[pid];
    const problem = group.find(it => it.error || it.skip_reason);
    const statuses = {};
    group.forEach(it => { statuses[String(it.status || '')] = true; });
    const statusLabel = Object.keys(statuses).join(', ');
    return `
      <tr class="${problem ? 'bad' : ''}">
        <td>
          <b>${escHtml(first.customer_name || pid)}</b>
          <small>${escHtml(pid)}</small>
        </td>
        <td>${escHtml(first.prev_day || '?')}<small>${escHtml(first.prev_operator || '')}</small></td>
        <td>${escHtml(first.new_day || '?')}<small>${escHtml(first.new_operator || '')}</small></td>
        <td>
          ${escHtml(statusLabel)}
          ${problem ? `<small class="bad">${escHtml(problem.error || problem.skip_reason)}</small>` : ''}
          <small>${escHtml(first.notify_status || 'not queued')}</small>
        </td>
        <td>
          ${group.length > 1
            ? `<button class="rp-mini-btn" onclick="rpToggleDetailPool_(${jsArg(pid)})">${group.length} weeks</button>`
            : escHtml(first.week_start || '')}
        </td>
      </tr>
      ${expanded ? group.map(it => `
        <tr class="rp-detail-sub">
          <td colspan="5">${escHtml(it.week_start || '')} · ${escHtml(it.new_day || '')} · ${escHtml(it.new_operator || '')} · ${escHtml(it.status || '')}${it.error ? ' · ' + escHtml(it.error) : ''}</td>
        </tr>`).join('') : ''}`;
  }).join('');

  return `
    <div class="rp-detail-grid">
      ${facts.map(([k, v]) => `<div><span>${escHtml(k)}</span><b>${escHtml(String(v || '—'))}</b></div>`).join('')}
    </div>
    ${rpWarmupBadge_()}
    ${order.length ? `
      <div class="rp-detail-scroll">
        <table class="rp-detail-table">
          <thead><tr><th>Customer</th><th>From</th><th>To</th><th>Status</th><th>Week</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : '<div class="rp-empty">No items on this batch</div>'}`;
}
