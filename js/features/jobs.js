// ══════════════════════════════════════════════════════════════════════════════
// JOBS — work-type browser: Maintenance / Startups / Repairs / All Jobs
// Depends on: constants.js (escHtml), api.js (api), auth.js (isAdmin, hasRole),
//             router.js (navigateTo), routes.js (getSvcLabel_), service-log.js (goToSvcLog)
// ══════════════════════════════════════════════════════════════════════════════

let _jobsData = null;          // last get_my_jobs response
let _jobsScope = 'mine';       // 'mine' | 'all' (admin defaults to all)
let _jobsFetchInFlight = null;
let _jobsStartupFilter = 'all';
let _jobsRepairFilter = 'new';
let _jobsStartupSearch = '';
let _jobsMaintSort = 'day';    // 'day' | 'az'
let _jobsHubCache = {};        // pool_id → get_startup_hub response

const JOBS_CACHE_TTL = 5 * 60 * 1000;
const JOBS_CACHE_VERSION = 'v5';

const REPAIR_STATUSES = ['new', 'approved', 'waiting', 'scheduled', 'completed'];
const REPAIR_STATUS_LABELS = { new:'New', approved:'Approved', waiting:'Waiting', scheduled:'Scheduled', completed:'Completed' };
const STARTUP_QUEUE_LABELS = { in_progress:'In Progress', ready:'Ready to Start', review:'Needs Review', completed:'Completed' };
const STARTUP_DAY_TASKS = [
  'Equipment Set & Inspection',
  'Plumbing Pressure Test',
  'Water Fill & Balance',
  'Chemical Start',
  'Final Startup Photos'
];

// ── SVG icons (portal stroke style) ──────────────────────────────────────────
const JOBS_ICON_WRENCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
const JOBS_ICON_DROP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>`;
const JOBS_ICON_LIST = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
const JOBS_ICON_CHEV = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
const JOBS_ICON_BACK = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`;
const JOBS_ICON_CHEV_DOWN = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

// ── Entry point (called by router) ───────────────────────────────────────────
function loadJobsPage(sub) {
  const root = document.getElementById('jobs-root');
  if (!root) return;

  // Resolve view from subpath
  const parts = (sub || '').split('/').filter(Boolean);
  const view = parts[0] || 'landing';

  // Admins default to the company-wide view. Personal scope is explicit at
  // #jobs/mine so the main Jobs tab does not look empty for owners/admins.
  let wantScope = _jobsScope;
  if (!isAdmin()) wantScope = 'mine';
  else if (view === 'mine') wantScope = 'mine';
  else wantScope = 'all';
  if (wantScope !== _jobsScope) { _jobsScope = wantScope; _jobsData = null; }

  if (!_jobsData) {
    const cached = _appCacheGet('my_jobs_' + JOBS_CACHE_VERSION + '_' + _jobsScope, JOBS_CACHE_TTL);
    if (cached) _jobsData = cached;
  }

  if (_jobsData) {
    _renderJobsView(parts);
    _fetchJobs(true).then(changed => { if (changed) _renderJobsView(parts); });
  } else {
    root.innerHTML = '<div class="route-loading"><div class="spinner"></div></div>';
    _fetchJobs(false).then(() => _renderJobsView(parts))
      .catch(err => {
        const msg = err && err.message ? err.message : 'Please try again.';
        root.innerHTML = `<div class="route-empty" style="padding:3rem 1rem">
          <div class="route-empty-icon">⚠️</div>
          <div class="route-empty-text">Could not load jobs.</div>
          <div class="jobs-muted" style="margin:.5rem auto 1rem;max-width:520px">${escHtml(msg)}</div>
          <button class="jobs-retry-btn" onclick="loadJobsPage('${escHtml(sub || '')}')">Retry</button>
        </div>`;
      });
  }
}

function _fetchJobs(silent) {
  if (_jobsFetchInFlight) return _jobsFetchInFlight;
  _jobsFetchInFlight = api({ action: 'get_my_jobs', token: currentSessionToken_(), scope: _jobsScope })
    .then(res => {
      _jobsFetchInFlight = null;
      if (!res || !res.ok) { if (!silent) throw new Error(res && res.error || 'load failed'); return false; }
      const changed = JSON.stringify(res) !== JSON.stringify(_jobsData);
      _jobsData = res;
      _appCacheSet('my_jobs_' + JOBS_CACHE_VERSION + '_' + _jobsScope, res);
      return changed;
    })
    .catch(err => { _jobsFetchInFlight = null; if (!silent) throw err; return false; });
  return _jobsFetchInFlight;
}

function jobsNav(sub) {
  navigateTo('jobs' + (sub ? '/' + sub : ''));
}

function jobsRefresh() {
  _jobsData = null;
  localStorage.removeItem('mcps_my_jobs_v2_' + _jobsScope);
  localStorage.removeItem('mcps_my_jobs_v4_' + _jobsScope);
  localStorage.removeItem('mcps_my_jobs_' + JOBS_CACHE_VERSION + '_' + _jobsScope);
  const hash = location.hash.replace('#', '');
  const sub = hash.startsWith('jobs/') ? hash.slice(5) : '';
  loadJobsPage(sub);
}

// ── View dispatch ─────────────────────────────────────────────────────────────
function _renderJobsView(parts) {
  const view = parts[0] || 'landing';
  if (view === 'maintenance') return _renderMaintenanceList();
  if (view === 'startups') {
    return parts[1] ? _renderStartupHub(decodeURIComponent(parts[1])) : _renderStartupQueue();
  }
  if (view === 'repairs') {
    return parts[1] ? _renderRepairDetail(decodeURIComponent(parts[1])) : _renderRepairHub();
  }
  if (view === 'pool') return renderPoolProfile(decodeURIComponent(parts[1] || ''), parts[2] || '');
  if (view === 'all') return _renderAllJobs();
  if (view === 'mine') return _renderJobsLanding();
  return _renderJobsLanding();
}

// ── Shared bits ───────────────────────────────────────────────────────────────
function _jobsAvatar(name, size) {
  const n = String(name || '?').trim();
  const initials = n.split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
  const palette = ['#0d4d44', '#1a7a6e', '#c8a84b', '#7e22ce', '#1d4ed8', '#b45309'];
  let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  const bg = palette[h % palette.length];
  const px = size || 26;
  return `<span class="jobs-avatar" style="width:${px}px;height:${px}px;background:${bg};font-size:${Math.round(px * 0.4)}px">${escHtml(initials)}</span>`;
}

function _jobsHeader(title, subtitle, backSub, rightHtml) {
  return `<div class="jobs-hdr">
    <button class="jobs-hdr-back" aria-label="Back" onclick="jobsNav('${backSub || ''}')">${JOBS_ICON_BACK}</button>
    <div class="jobs-hdr-titles">
      <div class="jobs-hdr-title">${escHtml(title)}</div>
      ${subtitle ? `<div class="jobs-hdr-sub">${escHtml(subtitle)}</div>` : ''}
    </div>
    ${rightHtml || '<div class="jobs-hdr-spacer"></div>'}
  </div>`;
}

function _jobsPoolPhoto(url, alt) {
  return url
    ? `<img class="jobs-pool-photo jobs-pool-photo-clickable" src="${escHtml(url)}" alt="${escHtml(alt || 'Pool')}" loading="lazy" onclick="if(typeof _finPhotoLightbox==='function')_finPhotoLightbox('${escHtml(url)}')" onerror="this.classList.add('jobs-photo-missing');this.removeAttribute('src')">`
    : `<div class="jobs-pool-photo jobs-photo-missing">${JOBS_ICON_DROP}</div>`;
}

function _jobsPoolPhotoSpinner_() {
  return `<div class="jobs-pool-photo jobs-photo-missing"><div class="spinner jobs-pool-photo-spinner"></div></div>`;
}

const POOL_PHOTO_CACHE_TTL_MS = 5 * 60 * 1000;

// Renders the pool-photo slot: a cached URL (possibly '') shows immediately,
// otherwise a spinner shows while _fetchPoolPhoto_ resolves in the background.
function _jobsPoolPhotoSlotHtml_(poolId) {
  const cached = _appCacheGet('pool_photo_' + poolId, POOL_PHOTO_CACHE_TTL_MS);
  const inner = cached !== null ? _jobsPoolPhoto(cached, '') : _jobsPoolPhotoSpinner_();
  return `<div id="jobs-pool-photo-slot" data-pool-id="${escHtml(poolId)}">${inner}</div>`;
}

function _fetchPoolPhoto_(poolId) {
  api({ action: 'get_pool_photo', token: currentSessionToken_(), pool_id: poolId })
    .then(res => {
      if (!res || !res.ok) return;
      const url = res.photo_url || '';
      _appCacheSet('pool_photo_' + poolId, url);
      const slot = document.getElementById('jobs-pool-photo-slot');
      if (!slot || slot.dataset.poolId !== poolId) return;
      const cachedProfile = _poolProfileCache[poolId];
      const altName = cachedProfile && cachedProfile.info ? cachedProfile.info.customer_name : '';
      slot.innerHTML = _jobsPoolPhoto(url, altName);
    })
    .catch(() => {});
}

function _jobsFmtDate(raw) {
  if (!raw) return '—';
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
  if (Number.isNaN(d.getTime())) return escHtml(s);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

// ── Landing ───────────────────────────────────────────────────────────────────
function _renderJobsLanding() {
  const root = document.getElementById('jobs-root');
  const d = _jobsData || {};
  const c = d.counts || {};
  const mCt = c.maintenance || 0, sCt = c.startups || 0, rCt = c.repairs || 0;

  root.innerHTML = `
  <div class="jobs-wrap jobs-landing-wrap">
    <div class="jobs-landing-head">
      <h1 class="jobs-h1">Jobs</h1>
    </div>
    <div class="jobs-landing-sub">Choose work type</div>

    <button class="jobs-type-card jt-maint" onclick="jobsNav('maintenance')">
      <span class="jobs-type-icon">${JOBS_ICON_WRENCH}</span>
      <span class="jobs-type-txt">
        <span class="jobs-type-name">Maintenance</span>
        <span class="jobs-type-count">${mCt} ${mCt === 1 ? 'stop' : 'stops'}</span>
      </span>
      <span class="jobs-type-chev">${JOBS_ICON_CHEV}</span>
    </button>

    <button class="jobs-type-card jt-startup" onclick="jobsNav('startups')">
      <span class="jobs-type-icon">${JOBS_ICON_DROP}</span>
      <span class="jobs-type-txt">
        <span class="jobs-type-name">Startups</span>
        <span class="jobs-type-count">${sCt} ${sCt === 1 ? 'job' : 'jobs'}</span>
      </span>
      <span class="jobs-type-chev">${JOBS_ICON_CHEV}</span>
    </button>

    <button class="jobs-type-card jt-repair" onclick="jobsNav('repairs')">
      <span class="jobs-type-icon">${JOBS_ICON_WRENCH}</span>
      <span class="jobs-type-txt">
        <span class="jobs-type-name">Repairs</span>
        <span class="jobs-type-count">${rCt} ${rCt === 1 ? 'job' : 'jobs'}</span>
      </span>
      <span class="jobs-type-chev">${JOBS_ICON_CHEV}</span>
    </button>

    <button class="jobs-type-card jt-all" onclick="jobsNav('${isAdmin() ? 'all' : ''}')" ${isAdmin() ? '' : 'style="display:none"'}>
      <span class="jobs-type-icon">${JOBS_ICON_LIST}</span>
      <span class="jobs-type-txt">
        <span class="jobs-type-name">All Jobs</span>
        <span class="jobs-type-count">View all jobs across work types</span>
      </span>
      <span class="jobs-type-chev">${JOBS_ICON_CHEV}</span>
    </button>
  </div>`;
}

// ── Maintenance: full client book grouped by day (or A–Z by last name) ──────
let _jobsSortMenuOpen = false;
const JOBS_MAINT_SORT_OPTS = [
  { k: 'day', label: 'Schedule', sub: 'Grouped by service day', icon: '📅' },
  { k: 'az',  label: 'Alphabetical', sub: 'By customer last name', icon: '🔤' }
];

function jobsToggleSortMenu(e) {
  if (e) e.stopPropagation();
  if (_jobsSortMenuOpen) { _jobsCloseSortMenu(); return; }
  _jobsSortMenuOpen = true;
  const menu = document.getElementById('jobs-sort-menu');
  if (menu) menu.style.display = 'block';
  setTimeout(() => document.addEventListener('click', _jobsCloseSortMenu), 0);
}

function _jobsCloseSortMenu() {
  _jobsSortMenuOpen = false;
  const menu = document.getElementById('jobs-sort-menu');
  if (menu) menu.style.display = 'none';
  document.removeEventListener('click', _jobsCloseSortMenu);
}

function _jobsSortBtnHtml() {
  const current = JOBS_MAINT_SORT_OPTS.find(o => o.k === _jobsMaintSort) || JOBS_MAINT_SORT_OPTS[0];
  return `<div class="jobs-sort-wrap">
    <button class="jobs-sort-btn" onclick="jobsToggleSortMenu(event)">Sort by: ${escHtml(current.label)} ${JOBS_ICON_CHEV_DOWN}</button>
    <div class="jobs-sort-menu" id="jobs-sort-menu" style="display:none" onclick="event.stopPropagation()">
      ${JOBS_MAINT_SORT_OPTS.map(o => `<button class="jobs-sort-opt${_jobsMaintSort === o.k ? ' active' : ''}" onclick="jobsMaintSort('${o.k}')">
        <span class="jobs-sort-opt-icon">${o.icon}</span>
        <span class="jobs-sort-opt-txt"><span class="jobs-sort-opt-lbl">${escHtml(o.label)}</span><span class="jobs-sort-opt-sub">${escHtml(o.sub)}</span></span>
        ${_jobsMaintSort === o.k ? '<span class="jobs-sort-check">✓</span>' : ''}
      </button>`).join('')}
    </div>
  </div>`;
}

function jobsMaintSort(mode) {
  _jobsCloseSortMenu();
  if (_jobsMaintSort === mode) return;
  _jobsMaintSort = mode;
  _renderMaintenanceList();
}

function _jobsLastName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function _maintItemCardHtml(p, showOp) {
  const pid = encodeURIComponent(p.pool_id || '');
  return `<div class="jobs-item-card" onclick="jobsNav('pool/${pid}/maintenance')">
    <div class="jobs-item-main">
      <div class="jobs-item-title">${escHtml(p.customer_name || '—')}</div>
      <div class="jobs-item-addr">${escHtml(p.address || '')}${p.city ? ', ' + escHtml(p.city) : ''}</div>
      <div class="jobs-item-badges">
        <span class="ps-label ${typeof getSvcClass_ === 'function' ? getSvcClass_(p.service) : 'svc-other'}">${escHtml(typeof getSvcLabel_ === 'function' ? getSvcLabel_(p.service) : (p.service || 'Service'))}</span>
        ${showOp && p.op_name ? `<span class="jobs-assignee-chip">${_jobsAvatar(p.op_name, 18)} ${escHtml(p.op_name)}</span>` : ''}
      </div>
    </div>
    <span class="jobs-item-chev">${JOBS_ICON_CHEV}</span>
  </div>`;
}

function _renderMaintenanceList() {
  const root = document.getElementById('jobs-root');
  const pools = (_jobsData && _jobsData.maintenance) || [];
  const showOp = _jobsScope === 'all';

  let listHtml = '';
  if (!pools.length) {
    listHtml = `<div class="route-empty" style="padding:3rem 1rem">
      <div class="route-empty-icon">🏊</div>
      <div class="route-empty-text">No maintenance pools assigned${_jobsScope === 'all' ? '' : ' to you'} yet.</div>
    </div>`;
  } else if (_jobsMaintSort === 'az') {
    const sorted = pools.slice().sort((a, b) =>
      _jobsLastName(a.customer_name).localeCompare(_jobsLastName(b.customer_name)) ||
      String(a.customer_name || '').localeCompare(String(b.customer_name || '')));
    listHtml = sorted.map(p => _maintItemCardHtml(p, showOp)).join('');
  } else {
    const byDay = {};
    pools.forEach(p => {
      const day = p.day_of_week && p.day_of_week !== 'UNSCHEDULED' ? p.day_of_week : 'Unscheduled';
      (byDay[day] = byDay[day] || []).push(p);
    });
    const dayOrder = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday','Unscheduled'];
    dayOrder.forEach(day => {
      const list = byDay[day];
      if (!list || !list.length) return;
      listHtml += `<div class="jobs-day-group-hdr">${escHtml(day)} <span class="jobs-day-group-ct">${list.length}</span></div>`;
      list.forEach(p => { listHtml += _maintItemCardHtml(p, showOp); });
    });
  }

  root.innerHTML = `<div class="jobs-wrap jobs-wrap-flush">
    ${_jobsHeader('Maintenance', pools.length + ' active pool' + (pools.length !== 1 ? 's' : ''), '', pools.length ? _jobsSortBtnHtml() : '')}
    <div class="jobs-list-body">${listHtml}</div>
  </div>`;
}

// ── Startup queue status derivation ──────────────────────────────────────────
function _startupQueueStatus(s) {
  const days = s.days || [];
  const doneCt = days.filter(v => String(v.status).toLowerCase() === 'completed').length;
  if (doneCt >= 3) return 'completed';
  const todayISO = new Date(); todayISO.setHours(0, 0, 0, 0);
  const overdue = days.some(v => {
    if (String(v.status).toLowerCase() === 'completed') return false;
    const m = String(v.scheduled_date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return false;
    return new Date(+m[1], +m[2] - 1, +m[3]) < todayISO;
  });
  if (overdue) return 'review';
  return doneCt > 0 ? 'in_progress' : 'ready';
}

function _startupCurrentDay(s) {
  const days = (s.days || []).slice().sort((a, b) => (a.n || 0) - (b.n || 0));
  const next = days.find(v => String(v.status).toLowerCase() !== 'completed');
  return next ? next.n : 3;
}

// ── Startup Queue ─────────────────────────────────────────────────────────────
function jobsStartupFilter(f) { _jobsStartupFilter = f; _renderStartupQueue(); }
function jobsStartupSearch(val) {
  _jobsStartupSearch = String(val || '').toLowerCase();
  const listEl = document.getElementById('jobs-sq-list');
  if (listEl) listEl.innerHTML = _startupQueueCardsHtml();
}

function _startupQueueCardsHtml() {
  let list = ((_jobsData && _jobsData.startups) || []).map(s => Object.assign({ _qs: _startupQueueStatus(s) }, s));
  if (_jobsStartupFilter !== 'all') list = list.filter(s => s._qs === _jobsStartupFilter);
  if (_jobsStartupSearch) {
    list = list.filter(s =>
      String(s.customer_name || '').toLowerCase().includes(_jobsStartupSearch) ||
      String(s.address || '').toLowerCase().includes(_jobsStartupSearch));
  }
  if (!list.length) {
    return `<div class="route-empty" style="padding:2.5rem 1rem">
      <div class="route-empty-icon">💧</div>
      <div class="route-empty-text">No startups here right now.</div>
    </div>`;
  }
  return list.map(s => {
    const doneCt = (s.days || []).filter(v => String(v.status).toLowerCase() === 'completed').length;
    const pct = Math.round(doneCt / 3 * 100);
    const curDay = _startupCurrentDay(s);
    const pid = encodeURIComponent(s.pool_id || '');
    const badge = s._qs === 'completed' ? '<span class="jobs-badge jb-done">Completed</span>'
      : s._qs === 'review' ? '<span class="jobs-badge jb-review">Needs Review</span>'
      : s._qs === 'ready' ? '<span class="jobs-badge jb-ready">Ready</span>'
      : `<span class="jobs-badge jb-day">Day ${curDay}</span>`;
    return `<div class="jobs-sq-card" onclick="jobsNav('startups/${pid}')">
      ${_jobsPoolPhoto(s.photo_url, s.customer_name)}
      <div class="jobs-sq-main">
        <div class="jobs-item-title">${escHtml(s.customer_name || '—')}</div>
        <div class="jobs-item-addr">${escHtml(s.address || '')}${s.city ? ', ' + escHtml(s.city) : ''}</div>
        <div class="jobs-sq-tech">${_jobsAvatar(s.op_name || s.operator, 20)} <span>${escHtml(s.op_name || s.operator || 'Unassigned')}</span></div>
        <div class="jobs-sq-progress"><div class="jobs-sq-progress-fill${pct === 100 ? ' done' : ''}" style="width:${pct}%"></div></div>
      </div>
      <div class="jobs-sq-side">${badge}<span class="jobs-sq-pct">${pct}%</span></div>
    </div>`;
  }).join('');
}

function _renderStartupQueue() {
  const root = document.getElementById('jobs-root');
  const startups = ((_jobsData && _jobsData.startups) || []).map(s => Object.assign({ _qs: _startupQueueStatus(s) }, s));
  const ct = k => startups.filter(s => s._qs === k).length;

  const pills = [
    { k: 'in_progress', n: ct('in_progress'), cls: 'sqp-prog' },
    { k: 'ready',       n: ct('ready'),       cls: 'sqp-ready' },
    { k: 'review',      n: ct('review'),      cls: 'sqp-review' },
    { k: 'completed',   n: ct('completed'),   cls: 'sqp-done' }
  ];

  root.innerHTML = `<div class="jobs-wrap jobs-wrap-flush">
    ${_jobsHeader('Startup Queue', startups.length + ' startup' + (startups.length !== 1 ? 's' : ''), '')}
    <div class="jobs-sq-pills">
      ${pills.map(p => `<button class="jobs-sq-pill ${p.cls}${_jobsStartupFilter === p.k ? ' active' : ''}"
        onclick="jobsStartupFilter('${_jobsStartupFilter === p.k ? 'all' : p.k}')">
        <span class="jobs-sq-pill-n">${p.n}</span><span class="jobs-sq-pill-l">${STARTUP_QUEUE_LABELS[p.k]}</span>
      </button>`).join('')}
    </div>
    <div class="jobs-list-body">
      <input class="jobs-search" type="search" placeholder="Search pools or address" value="${escHtml(_jobsStartupSearch)}"
        oninput="jobsStartupSearch(this.value)">
      <div id="jobs-sq-list">${_startupQueueCardsHtml()}</div>
    </div>
  </div>`;
}

// ── Startup Hub (per pool) ────────────────────────────────────────────────────
let _jobsHubDay = null; // currently selected day tab

function _renderStartupHub(poolId) {
  const root = document.getElementById('jobs-root');
  const s = ((_jobsData && _jobsData.startups) || []).find(x => String(x.pool_id) === String(poolId));
  if (!s) {
    // Data may not include it (stale cache / completed) — send back to queue
    root.innerHTML = `<div class="jobs-wrap jobs-wrap-flush">
      ${_jobsHeader('Startup Hub', '', 'startups')}
      <div class="route-empty" style="padding:3rem 1rem">
        <div class="route-empty-icon">🔍</div>
        <div class="route-empty-text">Startup not found. It may have been converted or reassigned.</div>
      </div></div>`;
    return;
  }

  const doneCt = (s.days || []).filter(v => String(v.status).toLowerCase() === 'completed').length;
  const pct = Math.round(doneCt / 3 * 100);
  const qs = _startupQueueStatus(s);
  const curDay = _startupCurrentDay(s);
  if (_jobsHubDay === null || _jobsHubDay === undefined) _jobsHubDay = doneCt >= 3 ? 'completed' : curDay;

  const dayTabs = [1, 2, 3].map(n => {
    const v = (s.days || []).find(d => d.n === n) || {};
    const done = String(v.status).toLowerCase() === 'completed';
    return `<button class="jobs-hub-daytab${_jobsHubDay === n ? ' active' : ''}${done ? ' done' : ''}"
      onclick="jobsHubSelectDay('${encodeURIComponent(poolId)}', ${n})">Day ${n}</button>`;
  }).join('') + `<button class="jobs-hub-daytab${_jobsHubDay === 'completed' ? ' active' : ''}"
      onclick="jobsHubSelectDay('${encodeURIComponent(poolId)}', 'completed')">Completed</button>`;

  root.innerHTML = `<div class="jobs-wrap jobs-wrap-flush">
    ${_jobsHeader('Startup Hub', s.company_name || '', 'startups')}
    <div class="jobs-hub-pool-card">
      ${_jobsPoolPhoto(s.photo_url, s.customer_name)}
      <div class="jobs-hub-pool-info">
        <div class="jobs-item-title">${escHtml(s.customer_name || '—')}</div>
        <div class="jobs-item-addr">${escHtml(s.address || '')}${s.city ? ', ' + escHtml(s.city) : ''}</div>
        <div class="jobs-sq-tech">${_jobsAvatar(s.op_name || s.operator, 20)} <span>${escHtml(s.op_name || s.operator || 'Unassigned')}</span></div>
      </div>
      <div class="jobs-sq-side">
        ${qs === 'completed' ? '<span class="jobs-badge jb-done">Completed</span>' : `<span class="jobs-badge jb-day">Day ${curDay}</span>`}
        <span class="jobs-sq-pct">${pct}% Complete</span>
      </div>
    </div>
    <div class="jobs-hub-daytabs">${dayTabs}</div>
    <div class="jobs-list-body" id="jobs-hub-body">
      <div class="route-loading"><div class="spinner"></div></div>
    </div>
  </div>`;

  _loadStartupHubData(poolId, s);
}

function jobsHubSelectDay(pidEnc, day) {
  _jobsHubDay = day;
  _renderStartupHub(decodeURIComponent(pidEnc));
}

function _loadStartupHubData(poolId, s) {
  const cached = _jobsHubCache[poolId];
  if (cached) { _renderStartupHubBody(poolId, s, cached); }
  api({ action: 'get_startup_hub', token: currentSessionToken_(), pool_id: poolId })
    .then(res => {
      if (!res || !res.ok) return;
      _jobsHubCache[poolId] = res;
      // Only re-render if still on this pool's hub
      const hash = location.hash.replace('#', '');
      if (hash === 'jobs/startups/' + encodeURIComponent(poolId)) _renderStartupHubBody(poolId, s, res);
    })
    .catch(() => {
      if (!cached) {
        const body = document.getElementById('jobs-hub-body');
        if (body) body.innerHTML = '<div class="route-empty" style="padding:2rem 1rem"><div class="route-empty-text">Could not load checklist. Pull to retry.</div></div>';
      }
    });
}

function _renderStartupHubBody(poolId, s, hub) {
  const body = document.getElementById('jobs-hub-body');
  if (!body) return;
  const pidEnc = encodeURIComponent(poolId);

  if (_jobsHubDay === 'completed') {
    const doneDays = (s.days || []).filter(v => String(v.status).toLowerCase() === 'completed')
      .sort((a, b) => (a.n || 0) - (b.n || 0));
    const allDone = doneDays.length >= 3;
    body.innerHTML = `
      ${doneDays.length ? doneDays.map(v => `
        <div class="jobs-task-row done">
          <span class="jobs-task-check done">✓</span>
          <span class="jobs-task-name">Day ${v.n} — logged ${_jobsFmtDate(v.completed_at || v.scheduled_date)}</span>
        </div>`).join('') : '<div class="route-empty" style="padding:1.5rem"><div class="route-empty-text">No days completed yet.</div></div>'}
      ${isAdmin() ? `
        <button class="jobs-cta${allDone ? '' : ' disabled'}" ${allDone ? `onclick="jobsConvertStartup('${pidEnc}')"` : 'disabled'}>
          Convert to Maintenance
          <span class="jobs-cta-sub">${allDone ? 'Startup complete — move to a weekly route' : 'Available after Day 3 completion'}</span>
        </button>
        <button class="jobs-ghost-btn" onclick="jobsRescheduleStartup('${pidEnc}')">📅 Reschedule Startup Days</button>` : ''}
    `;
    return;
  }

  const dayN = _jobsHubDay;
  const visit = (s.days || []).find(v => v.n === dayN) || {};
  const dayDone = String(visit.status).toLowerCase() === 'completed';
  const tasks = ((hub && hub.tasks) || []).filter(t => Number(t.day) === Number(dayN));
  const taskList = tasks.length ? tasks : STARTUP_DAY_TASKS.map(t => ({ day: dayN, task: t, status: 'pending' }));
  const doneTasks = taskList.filter(t => String(t.status) === 'completed').length;

  const photos = (hub && hub.photos) || [];

  body.innerHTML = `
    <div class="jobs-checklist-card">
      <div class="jobs-checklist-hdr">
        <span>Day ${dayN} Checklist</span>
        <span class="jobs-checklist-ct">${doneTasks} of ${taskList.length}</span>
      </div>
      <div class="jobs-checklist-bar"><div class="jobs-checklist-fill" style="width:${taskList.length ? Math.round(doneTasks / taskList.length * 100) : 0}%"></div></div>
      ${taskList.map((t, i) => {
        const st = String(t.status || 'pending');
        return `<div class="jobs-task-row${st === 'completed' ? ' done' : ''}" onclick="jobsToggleTask('${pidEnc}', ${dayN}, ${i}, '${st}')">
          <span class="jobs-task-check ${st === 'completed' ? 'done' : st === 'in_progress' ? 'prog' : ''}">${st === 'completed' ? '✓' : st === 'in_progress' ? '◐' : ''}</span>
          <span class="jobs-task-name">${escHtml(t.task)}</span>
          <span class="jobs-task-status">${st === 'completed' ? 'Completed' : st === 'in_progress' ? 'In Progress' : 'Pending'}</span>
        </div>`;
      }).join('')}
    </div>

    ${dayDone
      ? `<div class="jobs-dayline done">✓ Day ${dayN} service logged ${visit.completed_at ? '· ' + _jobsFmtDate(visit.completed_at) : ''}</div>`
      : `<button class="jobs-cta" onclick="goToSvcLog('${escHtml(poolId)}','${escHtml(s.customer_name || '')}','${escHtml(visit.visit_id || '')}','startup_day_${dayN}')">
          📝 Log Day ${dayN} Service
          <span class="jobs-cta-sub">${visit.scheduled_date ? 'Scheduled ' + _jobsFmtDate(visit.scheduled_date) : 'Completes this day when submitted'}</span>
        </button>`}

    ${isAdmin() ? `<button class="jobs-ghost-btn" onclick="jobsRescheduleStartup('${pidEnc}')">📅 Reschedule Startup Days</button>` : ''}

    <div class="jobs-photos-card">
      <div class="jobs-checklist-hdr"><span>Uploaded Photos</span><span class="jobs-checklist-ct">${photos.length} Photo${photos.length !== 1 ? 's' : ''}</span></div>
      ${photos.length
        ? `<div class="jobs-photo-strip">${photos.slice(0, 8).map(u => `<a href="${escHtml(u)}" target="_blank" rel="noopener"><img src="${escHtml(u)}" loading="lazy" alt="Startup photo"></a>`).join('')}</div>`
        : '<div class="jobs-muted">Photos from day service logs will appear here.</div>'}
    </div>
  `;
}

function jobsToggleTask(pidEnc, day, idx, curStatus) {
  const poolId = decodeURIComponent(pidEnc);
  const next = curStatus === 'pending' ? 'in_progress' : curStatus === 'in_progress' ? 'completed' : 'pending';
  const hub = _jobsHubCache[poolId] || { ok: true, tasks: [], photos: [] };
  let tasks = (hub.tasks || []).filter(t => Number(t.day) === Number(day));
  if (!tasks.length) {
    // Seed the fixed template locally on first tick
    tasks = STARTUP_DAY_TASKS.map(t => ({ day: day, task: t, status: 'pending' }));
    hub.tasks = (hub.tasks || []).concat(tasks);
  }
  if (!tasks[idx]) return;
  tasks[idx].status = next;
  _jobsHubCache[poolId] = hub;

  // Optimistic re-render, then persist
  const s = ((_jobsData && _jobsData.startups) || []).find(x => String(x.pool_id) === String(poolId));
  if (s) _renderStartupHubBody(poolId, s, hub);
  api({ action: 'update_startup_task', token: currentSessionToken_(), pool_id: poolId, day: day, task: tasks[idx].task, status: next })
    .catch(() => { /* stays optimistic; next hub load re-syncs */ });
}

function jobsConvertStartup(pidEnc) {
  const poolId = decodeURIComponent(pidEnc);
  const s = ((_jobsData && _jobsData.startups) || []).find(x => String(x.pool_id) === String(poolId));
  const ops = (_jobsData && _jobsData.operators) || [];
  const dayOpts = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
    .map(d => `<option value="${d}">${d}</option>`).join('');
  const opOpts = ops.map(o => `<option value="${escHtml(o.username)}">${escHtml(o.name || o.username)}</option>`).join('');

  _jobsShowSheet(`
    <div class="jobs-sheet-title">Convert to Maintenance</div>
    <div class="jobs-sheet-sub">${escHtml(s ? s.customer_name : poolId)} moves to a weekly route.</div>
    <label class="jobs-sheet-label">Service day</label>
    <select class="si" id="jobs-cv-day">${dayOpts}</select>
    <label class="jobs-sheet-label">Operator</label>
    <select class="si" id="jobs-cv-op">${opOpts || '<option value="">No operators found</option>'}</select>
    <button class="jobs-cta" id="jobs-cv-go" onclick="jobsConvertStartupGo('${pidEnc}')">Convert Pool</button>
    <div class="jobs-sheet-msg" id="jobs-sheet-msg"></div>
  `);
}

function jobsConvertStartupGo(pidEnc) {
  const poolId = decodeURIComponent(pidEnc);
  const day = (document.getElementById('jobs-cv-day') || {}).value;
  const op = (document.getElementById('jobs-cv-op') || {}).value;
  const btn = document.getElementById('jobs-cv-go');
  const msg = document.getElementById('jobs-sheet-msg');
  if (!day || !op) { if (msg) msg.textContent = 'Pick a service day and operator.'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Converting…'; }
  api({ action: 'convert_startup_to_maintenance', token: currentSessionToken_(), pool_id: poolId, day_of_week: day, operator: op })
    .then(res => {
      if (!res || !res.ok) throw new Error(res && res.error || 'Convert failed');
      _jobsCloseSheet();
      if (typeof _clearRouteCache === 'function') _clearRouteCache();
      _jobsData = null;
      jobsNav('startups');
    })
    .catch(err => {
      if (btn) { btn.disabled = false; btn.textContent = 'Convert Pool'; }
      if (msg) msg.textContent = String(err.message || err);
    });
}

function jobsRescheduleStartup(pidEnc) {
  const poolId = decodeURIComponent(pidEnc);
  const s = ((_jobsData && _jobsData.startups) || []).find(x => String(x.pool_id) === String(poolId));
  _jobsShowSheet(`
    <div class="jobs-sheet-title">Reschedule Startup</div>
    <div class="jobs-sheet-sub">Pick the new Day 1 date. Days 2–3 follow on the next days. Completed days keep their checkmarks.</div>
    <label class="jobs-sheet-label">New Day 1 date</label>
    <input class="si" type="date" id="jobs-rs-date" value="${escHtml((s && s.startup_start_date || '').slice(0, 10))}">
    <button class="jobs-cta" id="jobs-rs-go" onclick="jobsRescheduleStartupGo('${pidEnc}')">Reschedule</button>
    <div class="jobs-sheet-msg" id="jobs-sheet-msg"></div>
  `);
}

function jobsRescheduleStartupGo(pidEnc) {
  const poolId = decodeURIComponent(pidEnc);
  const date = (document.getElementById('jobs-rs-date') || {}).value;
  const btn = document.getElementById('jobs-rs-go');
  const msg = document.getElementById('jobs-sheet-msg');
  if (!date) { if (msg) msg.textContent = 'Pick a date.'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Rescheduling…'; }
  api({ action: 'reschedule_startup', token: currentSessionToken_(), pool_id: poolId, day_1_date: date })
    .then(res => {
      if (!res || !res.ok) throw new Error(res && res.error || 'Reschedule failed');
      _jobsCloseSheet();
      if (typeof _clearRouteCache === 'function') _clearRouteCache();
      _jobsData = null;
      loadJobsPage('startups/' + encodeURIComponent(poolId));
    })
    .catch(err => {
      if (btn) { btn.disabled = false; btn.textContent = 'Reschedule'; }
      if (msg) msg.textContent = String(err.message || err);
    });
}

// ── Repair Hub ────────────────────────────────────────────────────────────────
function jobsRepairFilter(f) { _jobsRepairFilter = f; _renderRepairHub(); }

function _renderRepairHub() {
  const root = document.getElementById('jobs-root');
  const repairs = (_jobsData && _jobsData.repairs) || [];
  const list = repairs.filter(r => String(r.status || 'new').toLowerCase() === _jobsRepairFilter);

  root.innerHTML = `<div class="jobs-wrap jobs-wrap-flush">
    ${_jobsHeader('Repair Hub', 'Service & Repair Work Orders', '')}
    <div class="jobs-rh-tabs">
      ${REPAIR_STATUSES.map(st => {
        const n = repairs.filter(r => String(r.status || 'new').toLowerCase() === st).length;
        return `<button class="jobs-rh-tab${_jobsRepairFilter === st ? ' active' : ''}" onclick="jobsRepairFilter('${st}')">
          ${REPAIR_STATUS_LABELS[st]}${n ? ` <span class="jobs-rh-tab-n">${n}</span>` : ''}
        </button>`;
      }).join('')}
    </div>
    <div class="jobs-list-body">
      ${list.length ? list.map(r => _repairCardHtml(r)).join('') : `
        <div class="route-empty" style="padding:2.5rem 1rem">
          <div class="route-empty-icon">🔧</div>
          <div class="route-empty-text">No ${REPAIR_STATUS_LABELS[_jobsRepairFilter].toLowerCase()} work orders.</div>
        </div>`}
    </div>
  </div>`;
}

function _repairPriorityDot(p) {
  const pr = String(p || 'medium').toLowerCase();
  const color = pr === 'high' ? 'var(--error)' : pr === 'low' ? 'var(--success)' : 'var(--warn)';
  const label = pr.charAt(0).toUpperCase() + pr.slice(1);
  return `<span class="jobs-prio"><span class="jobs-prio-dot" style="background:${color}"></span>${label}</span>`;
}

function _repairCardHtml(r) {
  const oid = encodeURIComponent(r.order_id || '');
  const st = String(r.status || 'new').toLowerCase();
  const parts = Array.isArray(r.parts) ? r.parts : [];
  return `<div class="jobs-item-card jobs-repair-card" onclick="jobsNav('repairs/${oid}')">
    <div class="jobs-item-main">
      <div class="jobs-repair-toprow">
        <div class="jobs-item-title">${escHtml(r.job_name || 'Repair Job')}</div>
        <span class="jobs-badge jb-${st}">${REPAIR_STATUS_LABELS[st] || st}</span>
      </div>
      <div class="jobs-repair-cust">${escHtml(r.customer_name || '')}</div>
      <div class="jobs-item-addr">${escHtml(r.address || '')}${r.city ? ', ' + escHtml(r.city) : ''}</div>
      <div class="jobs-repair-meta">
        ${_repairPriorityDot(r.priority)}
        <span class="jobs-muted">Reported ${_jobsFmtDate(r.reported_at)}</span>
        ${st === 'scheduled' && r.scheduled_date ? `<span class="jobs-muted">· Visit ${_jobsFmtDate(r.scheduled_date)}</span>` : ''}
      </div>
      <div class="jobs-sq-tech">${_jobsAvatar(r.assigned_name || r.assigned_to, 20)} <span>${escHtml(r.assigned_name || r.assigned_to || 'Unassigned')}</span></div>
      ${parts.length ? `<div class="jobs-parts-mini">${parts.slice(0, 2).map(p => `<span>${escHtml(p.name)} <b>×${escHtml(String(p.qty || 1))}</b></span>`).join('')}${parts.length > 2 ? `<span>+${parts.length - 2} more</span>` : ''}</div>` : ''}
    </div>
    ${r.photo_url ? _jobsPoolPhoto(r.photo_url, r.job_name) : ''}
    <span class="jobs-item-chev">${JOBS_ICON_CHEV}</span>
  </div>`;
}

function _renderRepairDetail(orderId) {
  const root = document.getElementById('jobs-root');
  const r = ((_jobsData && _jobsData.repairs) || []).find(x => String(x.order_id) === String(orderId));
  if (!r) {
    root.innerHTML = `<div class="jobs-wrap jobs-wrap-flush">
      ${_jobsHeader('Work Order', '', 'repairs')}
      <div class="route-empty" style="padding:3rem 1rem"><div class="route-empty-text">Work order not found.</div></div></div>`;
    return;
  }
  const st = String(r.status || 'new').toLowerCase();
  const parts = Array.isArray(r.parts) ? r.parts : [];
  const oid = encodeURIComponent(r.order_id || '');
  const isMine = _s && (_s.username === r.assigned_to);
  const pidEnc = encodeURIComponent(r.pool_id || '');

  // Status timeline
  const timeline = REPAIR_STATUSES.map(s2 => {
    const reached = REPAIR_STATUSES.indexOf(s2) <= REPAIR_STATUSES.indexOf(st);
    return `<div class="jobs-tl-step${reached ? ' reached' : ''}${s2 === st ? ' current' : ''}">
      <span class="jobs-tl-dot"></span><span class="jobs-tl-lbl">${REPAIR_STATUS_LABELS[s2]}</span>
    </div>`;
  }).join('');

  // Role-gated actions
  let actions = '';
  if (isAdmin()) {
    if (st === 'new') actions += `<button class="jobs-cta" onclick="jobsRepairSetStatus('${oid}','approved')">Approve Work Order</button>`;
    if (st === 'approved') actions += `
      <button class="jobs-cta" onclick="jobsRepairSchedule('${oid}')">Schedule Visit</button>
      <button class="jobs-ghost-btn" onclick="jobsRepairSetStatus('${oid}','waiting')">Mark Waiting on Parts</button>`;
    if (st === 'waiting') actions += `<button class="jobs-cta" onclick="jobsRepairSchedule('${oid}')">Schedule Visit</button>`;
    if (st === 'scheduled') actions += `<button class="jobs-cta" onclick="jobsRepairSetStatus('${oid}','completed')">Mark Completed</button>`;
    if (st !== 'completed') actions += `<button class="jobs-ghost-btn" onclick="jobsRepairReassign('${oid}')">Reassign Technician</button>`;
  } else if (isMine && st !== 'completed') {
    actions += `<button class="jobs-cta" onclick="jobsRepairSetStatus('${oid}','completed')">Mark Completed</button>`;
  }
  if (r.pool_id) actions += `<button class="jobs-ghost-btn" onclick="jobsNav('pool/${pidEnc}/repairs')">View Pool Profile</button>`;

  root.innerHTML = `<div class="jobs-wrap jobs-wrap-flush">
    ${_jobsHeader(r.job_name || 'Work Order', r.order_id || '', 'repairs')}
    <div class="jobs-list-body">
      <div class="jobs-detail-card">
        <div class="jobs-repair-toprow">
          <div>
            <div class="jobs-repair-cust" style="font-weight:700">${escHtml(r.customer_name || '')}</div>
            <div class="jobs-item-addr">${escHtml(r.address || '')}${r.city ? ', ' + escHtml(r.city) : ''}</div>
          </div>
          <span class="jobs-badge jb-${st}">${REPAIR_STATUS_LABELS[st] || st}</span>
        </div>
        ${r.photo_url ? `<img class="jobs-detail-photo" src="${escHtml(r.photo_url)}" alt="Job photo" loading="lazy">` : ''}
        <div class="jobs-detail-grid">
          <div><div class="jobs-detail-lbl">Priority</div>${_repairPriorityDot(r.priority)}</div>
          <div><div class="jobs-detail-lbl">Reported</div><div>${_jobsFmtDate(r.reported_at)}</div></div>
          <div><div class="jobs-detail-lbl">Equipment</div><div>${escHtml(r.equipment || '—')}</div></div>
          <div><div class="jobs-detail-lbl">Assigned Tech</div><div class="jobs-sq-tech">${_jobsAvatar(r.assigned_name || r.assigned_to, 20)} <span>${escHtml(r.assigned_name || r.assigned_to || 'Unassigned')}</span></div></div>
          ${r.scheduled_date ? `<div><div class="jobs-detail-lbl">Scheduled</div><div>${_jobsFmtDate(r.scheduled_date)}</div></div>` : ''}
        </div>
        ${r.issue ? `<div class="jobs-detail-lbl" style="margin-top:.8rem">Issue</div><div class="jobs-detail-txt">${escHtml(r.issue)}</div>` : ''}
        ${r.description ? `<div class="jobs-detail-lbl" style="margin-top:.8rem">Description</div><div class="jobs-detail-txt">${escHtml(r.description)}</div>` : ''}
      </div>

      ${parts.length ? `<div class="jobs-detail-card">
        <div class="jobs-checklist-hdr"><span>Parts</span></div>
        ${parts.map(p => `<div class="jobs-part-row"><span>${escHtml(p.name)}</span><span class="jobs-muted">QTY ${escHtml(String(p.qty || 1))}</span></div>`).join('')}
      </div>` : ''}

      <div class="jobs-detail-card">
        <div class="jobs-checklist-hdr"><span>Status</span></div>
        <div class="jobs-timeline">${timeline}</div>
      </div>

      ${actions}
      <div class="jobs-sheet-msg" id="jobs-repair-msg"></div>
    </div>
  </div>`;
}

function jobsRepairSetStatus(oidEnc, status) {
  const orderId = decodeURIComponent(oidEnc);
  const msg = document.getElementById('jobs-repair-msg');
  api({ action: 'update_repair_order', token: currentSessionToken_(), order_id: orderId, status: status })
    .then(res => {
      if (!res || !res.ok) throw new Error(res && res.error || 'Update failed');
      _jobsData = null;
      loadJobsPage('repairs/' + oidEnc);
    })
    .catch(err => { if (msg) msg.textContent = String(err.message || err); });
}

function jobsRepairSchedule(oidEnc) {
  _jobsShowSheet(`
    <div class="jobs-sheet-title">Schedule Repair Visit</div>
    <div class="jobs-sheet-sub">The visit will appear on the assigned tech's Schedule.</div>
    <label class="jobs-sheet-label">Visit date</label>
    <input class="si" type="date" id="jobs-rp-date">
    <button class="jobs-cta" id="jobs-rp-go" onclick="jobsRepairScheduleGo('${oidEnc}')">Schedule</button>
    <div class="jobs-sheet-msg" id="jobs-sheet-msg"></div>
  `);
}

function jobsRepairScheduleGo(oidEnc) {
  const orderId = decodeURIComponent(oidEnc);
  const date = (document.getElementById('jobs-rp-date') || {}).value;
  const btn = document.getElementById('jobs-rp-go');
  const msg = document.getElementById('jobs-sheet-msg');
  if (!date) { if (msg) msg.textContent = 'Pick a date.'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Scheduling…'; }
  api({ action: 'update_repair_order', token: currentSessionToken_(), order_id: orderId, status: 'scheduled', scheduled_date: date })
    .then(res => {
      if (!res || !res.ok) throw new Error(res && res.error || 'Schedule failed');
      _jobsCloseSheet();
      if (typeof _clearRouteCache === 'function') _clearRouteCache();
      _jobsData = null;
      loadJobsPage('repairs/' + oidEnc);
    })
    .catch(err => {
      if (btn) { btn.disabled = false; btn.textContent = 'Schedule'; }
      if (msg) msg.textContent = String(err.message || err);
    });
}

function jobsRepairReassign(oidEnc) {
  const ops = (_jobsData && _jobsData.operators) || [];
  const opOpts = ops.map(o => `<option value="${escHtml(o.username)}">${escHtml(o.name || o.username)}</option>`).join('');
  _jobsShowSheet(`
    <div class="jobs-sheet-title">Reassign Technician</div>
    <label class="jobs-sheet-label">Technician</label>
    <select class="si" id="jobs-ra-op">${opOpts || '<option value="">No operators found</option>'}</select>
    <button class="jobs-cta" id="jobs-ra-go" onclick="jobsRepairReassignGo('${oidEnc}')">Reassign</button>
    <div class="jobs-sheet-msg" id="jobs-sheet-msg"></div>
  `);
}

function jobsRepairReassignGo(oidEnc) {
  const orderId = decodeURIComponent(oidEnc);
  const op = (document.getElementById('jobs-ra-op') || {}).value;
  const btn = document.getElementById('jobs-ra-go');
  const msg = document.getElementById('jobs-sheet-msg');
  if (!op) { if (msg) msg.textContent = 'Pick a technician.'; return; }
  if (btn) btn.disabled = true;
  api({ action: 'update_repair_order', token: currentSessionToken_(), order_id: orderId, assigned_to: op })
    .then(res => {
      if (!res || !res.ok) throw new Error(res && res.error || 'Reassign failed');
      _jobsCloseSheet();
      _jobsData = null;
      loadJobsPage('repairs/' + oidEnc);
    })
    .catch(err => {
      if (btn) btn.disabled = false;
      if (msg) msg.textContent = String(err.message || err);
    });
}

// ── All Jobs (admin, company-wide) ───────────────────────────────────────────
function _renderAllJobs() {
  const root = document.getElementById('jobs-root');
  const d = _jobsData || {};
  const c = d.counts || {};
  root.innerHTML = `<div class="jobs-wrap jobs-wrap-flush">
    ${_jobsHeader('All Jobs', 'Company-wide across work types', '')}
    <div class="jobs-list-body">
      <button class="jobs-type-card jt-maint" onclick="jobsNav('maintenance')">
        <span class="jobs-type-icon">${JOBS_ICON_WRENCH}</span>
        <span class="jobs-type-txt"><span class="jobs-type-name">Maintenance</span><span class="jobs-type-count">${c.maintenance || 0} stops</span></span>
        <span class="jobs-type-chev">${JOBS_ICON_CHEV}</span>
      </button>
      <button class="jobs-type-card jt-startup" onclick="jobsNav('startups')">
        <span class="jobs-type-icon">${JOBS_ICON_DROP}</span>
        <span class="jobs-type-txt"><span class="jobs-type-name">Startups</span><span class="jobs-type-count">${c.startups || 0} jobs</span></span>
        <span class="jobs-type-chev">${JOBS_ICON_CHEV}</span>
      </button>
      <button class="jobs-type-card jt-repair" onclick="jobsNav('repairs')">
        <span class="jobs-type-icon">${JOBS_ICON_WRENCH}</span>
        <span class="jobs-type-txt"><span class="jobs-type-name">Repairs</span><span class="jobs-type-count">${c.repairs || 0} jobs</span></span>
        <span class="jobs-type-chev">${JOBS_ICON_CHEV}</span>
      </button>
      <button class="jobs-ghost-btn" onclick="jobsNav('mine')">← My Jobs</button>
    </div>
  </div>`;
}

// ── Pool Profile ──────────────────────────────────────────────────────────────
let _poolProfileCache = {};
let _jobsPoolOrigin = ''; // which jobs list ('maintenance'|'repairs'|...) the pool profile's back button returns to

function renderPoolProfile(poolId, origin) {
  const root = document.getElementById('jobs-root');
  if (!poolId) { jobsNav(''); return; }
  _jobsPoolOrigin = origin || '';

  const cached = _poolProfileCache[poolId];
  if (cached) _renderPoolProfileBody(poolId, cached);
  else root.innerHTML = `<div class="jobs-wrap jobs-wrap-flush">${_jobsHeader('Pool Profile', '', _jobsPoolOrigin)}<div class="route-loading"><div class="spinner"></div></div></div>`;

  api({ action: 'get_pool_profile', token: currentSessionToken_(), pool_id: poolId })
    .then(res => {
      if (!res || !res.ok) { if (!cached) _renderPoolProfileError(poolId); return; }
      _poolProfileCache[poolId] = res;
      const hash = location.hash.replace('#', '');
      const expectedHash = 'jobs/pool/' + encodeURIComponent(poolId) + (_jobsPoolOrigin ? '/' + _jobsPoolOrigin : '');
      if (hash === expectedHash) _renderPoolProfileBody(poolId, res);
    })
    .catch(() => { if (!cached) _renderPoolProfileError(poolId); });

  _fetchPoolPhoto_(poolId);
}

function _renderPoolProfileError(poolId) {
  const root = document.getElementById('jobs-root');
  root.innerHTML = `<div class="jobs-wrap jobs-wrap-flush">
    ${_jobsHeader('Pool Profile', '', _jobsPoolOrigin)}
    <div class="route-empty" style="padding:3rem 1rem">
      <div class="route-empty-icon">⚠️</div>
      <div class="route-empty-text">Could not load this pool. Please try again.</div>
      <button class="jobs-retry-btn" onclick="renderPoolProfile('${escHtml(poolId)}','${escHtml(_jobsPoolOrigin)}')">Retry</button>
    </div></div>`;
}

function _renderPoolProfileBody(poolId, p) {
  const root = document.getElementById('jobs-root');
  const info = p.info || {};
  const equipment = p.equipment || [];
  const lastSvc = p.last_service || null;
  const startupHist = p.startup_history || [];
  const repairHist = p.repair_history || [];
  const pidEnc = encodeURIComponent(poolId);
  const statusRaw = String(info.status || '').toLowerCase();
  const statusBadge = statusRaw.includes('active') ? '<span class="jobs-badge jb-done">Active</span>'
    : statusRaw.includes('startup') ? '<span class="jobs-badge jb-day">Startup</span>'
    : statusRaw ? `<span class="jobs-badge jb-waiting">${escHtml(info.status)}</span>` : '';

  root.innerHTML = `<div class="jobs-wrap jobs-wrap-flush">
    ${_jobsHeader('Pool Profile', '', _jobsPoolOrigin)}
    <div class="jobs-list-body">
      <div class="jobs-profile-head">
        ${_jobsPoolPhotoSlotHtml_(poolId)}
        <div class="jobs-profile-head-mid">
          <div class="jobs-item-title" style="font-size:1.05rem">${escHtml(info.customer_name || '—')}</div>
          <div class="jobs-item-addr">${escHtml(info.address || '')}${info.city ? ', ' + escHtml(info.city) : ''}</div>
        </div>
        <div class="jobs-profile-head-side">
          ${statusBadge}
          <div class="jobs-muted" style="text-align:right">Pool ID<br><b>${escHtml(poolId)}</b></div>
        </div>
      </div>

      <div class="jobs-detail-card">
        <div class="jobs-checklist-hdr"><span>Equipment</span>${isAdmin() ? `<button class="jobs-mini-btn" onclick="jobsAddEquipment('${pidEnc}')">+ Add</button>` : ''}</div>
        ${equipment.length
          ? equipment.map(e => `<div class="jobs-part-row"><span>⚙️ ${escHtml(e.item)}</span>${e.source === 'repair' ? '<span class="jobs-muted">from repair</span>' : ''}</div>`).join('')
          : '<div class="jobs-muted">No equipment recorded yet.</div>'}
      </div>

      <div class="jobs-profile-grid">
        <div class="jobs-detail-card">
          <div class="jobs-detail-lbl">Last Service</div>
          ${lastSvc ? `<div>${_jobsFmtDate(lastSvc.date)}</div><div class="jobs-muted">${escHtml(lastSvc.technician || '')}</div>` : '<div class="jobs-muted">No visits logged.</div>'}
        </div>
        <div class="jobs-detail-card">
          <div class="jobs-detail-lbl">Startup History</div>
          ${startupHist.length ? startupHist.map(v => `<div class="jobs-muted">${_jobsFmtDate(v.date)} · Day ${escHtml(String(v.day || ''))}</div>`).join('') : '<div class="jobs-muted">No startup visits.</div>'}
        </div>
        <div class="jobs-detail-card">
          <div class="jobs-detail-lbl">Repair History</div>
          ${repairHist.length
            ? `<div>${repairHist.length} repair${repairHist.length !== 1 ? 's' : ''}</div>` +
              repairHist.slice(0, 3).map(r => `<div class="jobs-muted">${escHtml(r.job_name || 'Repair')} · ${REPAIR_STATUS_LABELS[String(r.status || '').toLowerCase()] || escHtml(r.status || '')}</div>`).join('')
            : '<div class="jobs-muted">No repairs.</div>'}
        </div>
        <div class="jobs-detail-card">
          <div class="jobs-detail-lbl">Notes</div>
          ${info.gate_code ? `<div>🔑 Gate code: <b>${escHtml(info.gate_code)}</b></div>` : ''}
          ${info.notes ? `<div class="jobs-detail-txt">${escHtml(info.notes)}</div>` : (!info.gate_code ? '<div class="jobs-muted">No notes.</div>' : '')}
        </div>
      </div>

      <button class="jobs-cta" onclick="goToSvcLog('${escHtml(poolId)}','${escHtml(info.customer_name || '')}','','')">📝 Log Service Visit</button>
      ${(p.visit_history || []).length ? `
      <div class="jobs-detail-card">
        <div class="jobs-checklist-hdr"><span>Recent Visits</span></div>
        ${(p.visit_history || []).slice(0, 6).map(v => `<div class="jobs-part-row"><span>${_jobsFmtDate(v.date)}</span><span class="jobs-muted">${escHtml(v.technician || '')}</span></div>`).join('')}
      </div>` : ''}
    </div>
  </div>`;
}

function jobsAddEquipment(pidEnc) {
  _jobsShowSheet(`
    <div class="jobs-sheet-title">Add Equipment</div>
    <label class="jobs-sheet-label">Item</label>
    <input class="si" id="jobs-eq-item" placeholder="e.g. Pentair IntelliFlo VSF Pump">
    <label class="jobs-sheet-label">Category</label>
    <select class="si" id="jobs-eq-cat">
      <option>Pump</option><option>Filter</option><option>Heater</option>
      <option>Chlorinator</option><option>Automation</option><option>Cleaner</option><option>Other</option>
    </select>
    <button class="jobs-cta" id="jobs-eq-go" onclick="jobsAddEquipmentGo('${pidEnc}')">Add Equipment</button>
    <div class="jobs-sheet-msg" id="jobs-sheet-msg"></div>
  `);
}

function jobsAddEquipmentGo(pidEnc) {
  const poolId = decodeURIComponent(pidEnc);
  const item = ((document.getElementById('jobs-eq-item') || {}).value || '').trim();
  const cat = (document.getElementById('jobs-eq-cat') || {}).value;
  const btn = document.getElementById('jobs-eq-go');
  const msg = document.getElementById('jobs-sheet-msg');
  if (!item) { if (msg) msg.textContent = 'Enter the equipment name.'; return; }
  if (btn) btn.disabled = true;
  api({ action: 'add_pool_equipment', token: currentSessionToken_(), pool_id: poolId, item: item, category: cat })
    .then(res => {
      if (!res || !res.ok) throw new Error(res && res.error || 'Add failed');
      _jobsCloseSheet();
      delete _poolProfileCache[poolId];
      renderPoolProfile(poolId, _jobsPoolOrigin);
    })
    .catch(err => {
      if (btn) btn.disabled = false;
      if (msg) msg.textContent = String(err.message || err);
    });
}

// ── Bottom sheet (mobile) / modal (desktop) ──────────────────────────────────
function _jobsShowSheet(innerHtml) {
  _jobsCloseSheet();
  const wrap = document.createElement('div');
  wrap.id = 'jobs-sheet-wrap';
  wrap.innerHTML = `
    <div class="jobs-sheet-overlay" onclick="_jobsCloseSheet()"></div>
    <div class="jobs-sheet" role="dialog" aria-modal="true">
      <div class="jobs-sheet-grab"></div>
      ${innerHtml}
      <button class="jobs-ghost-btn" onclick="_jobsCloseSheet()">Cancel</button>
    </div>`;
  document.body.appendChild(wrap);
}

function _jobsCloseSheet() {
  const el = document.getElementById('jobs-sheet-wrap');
  if (el) el.remove();
}
