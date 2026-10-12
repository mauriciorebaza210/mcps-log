// ══════════════════════════════════════════════════════════════════════════════
// ONE-TIME JOBS — "+ New Job" on the schedule, job cards and the job sheet
// Depends on: api.js (api, apiLocalGet), auth.js (isAdmin), crm.js
// (_getCrmListFast_), routes.js (renderRoutePage, _clearRouteCache, loadCalendarData)
// Uses globals: _s, _routeData, _activeOp, _activeDay, _currentMapView, _calMonth, _calYear
//
// Model: _jobStore holds the server-canonical job objects. Every change is an
// operation in a per-user localStorage queue, FIFO per job group, applied
// optimistically on top of the canonical data (the "view"). Server responses
// replace the canonical jobs; still-queued ops are re-applied on top, so later
// optimistic edits never flicker away. Every op carries an op_id the server
// dedupes on, so retrying after a lost response is always safe.
//
// Jobs never notify the customer — rescheduling is silent.
// ══════════════════════════════════════════════════════════════════════════════

const JOB_TZ = 'America/Chicago';
const JOB_RETRY_WINDOW_MS = 7 * 24 * 3600 * 1000;
const JOB_REQUEST_TIMEOUT_MS = 30000;
const JOB_EST_CHIPS = [['', '—'], [30, '30m'], [60, '1h'], [120, '2h'], [180, '3h'], [240, 'Half day'], [480, 'Full day']];
const JOB_DEFINITIVE_CODES = ['conflict', 'invalid', 'forbidden', 'not_found', 'op_expired'];

let _jobStore = {};            // visit id → server-canonical job
let _jobTouched = {};          // visit id → ms of last mutation response (guards stale fetches)
let _jobRunning = {};          // group id → request in flight
let _jobHalted = {};           // group id → network failure, waiting for Retry
let _jobSheetId = null;        // visit id open in the sheet
let _jobSheetDeferred = false; // re-render postponed while the user is typing
let _jobGroupLists = {};       // group id → { jobs, cancelled, loading, error }
let _jobLeadPoll = null;
let _jobCalDate = '';          // month view: the day cell last opened
let _jobModal = null;          // create-modal state

// ── Small helpers ─────────────────────────────────────────────────────────────

function _jobUuid_() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function _jobMatId_() {
  const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = 'm_';
  for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

function _jobLower_(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function _jobClone_(o) { return o ? JSON.parse(JSON.stringify(o)) : o; }

// Dates are yyyy-MM-dd strings in America/Chicago — never toISOString().
function _jobToday_() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: JOB_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function _jobAddDays_(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n, 12));
  return dt.toISOString().slice(0, 10);
}
function _jobDow_(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}
function _jobSkipSunday_(iso) { return _jobDow_(iso) === 0 ? _jobAddDays_(iso, 1) : iso; }
function _jobFmtDate_(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}
function _jobFmtEst_(min) {
  const n = Number(min);
  if (!n) return '';
  const hit = JOB_EST_CHIPS.find(c => Number(c[0]) === n);
  if (hit) return hit[1];
  return n % 60 === 0 ? `${n / 60}h` : `${Math.floor(n / 60) ? Math.floor(n / 60) + 'h ' : ''}${n % 60}m`;
}
function _jobDateChips_() {
  const today = _jobToday_();
  return { tomorrow: _jobSkipSunday_(_jobAddDays_(today, 1)) };
}

function _jobToast_(msg, kind) {
  let el = document.getElementById('job-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'job-toast';
    el.className = 'job-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'job-toast show' + (kind ? ' ' + kind : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'job-toast'; }, 4200);
}

function _jobIsAssigned_(job) {
  if (!job || !_s) return false;
  const me = _jobLower_(_s.username);
  if (me && _jobLower_(job.assigned_username) === me) return true;
  // Optimistic jobs don't know the username yet — fall back to the display name.
  return !job.assigned_username && !!_s.name && _jobLower_(job.assigned_technician) === _jobLower_(_s.name);
}

function _jobOperators_() {
  const list = (_routeData && _routeData.all_operators) || window._calOperatorList || [];
  return list.map(op => (op && op.name) || op).filter(n => n && n !== 'UNASSIGNED');
}

// ── Queue ─────────────────────────────────────────────────────────────────────

function _jobQueueKey_() { return 'mcps_job_ops:' + _jobLower_(_s && _s.username); }
function _jobQueue_() {
  try { return JSON.parse(localStorage.getItem(_jobQueueKey_()) || '[]'); } catch (e) { return []; }
}
function _jobSaveQueue_(q) {
  try { localStorage.setItem(_jobQueueKey_(), JSON.stringify(q)); } catch (e) {}
}

// Applies queued ops on top of the canonical store. Returns the full view.
function _jobViewAll_() {
  const jobs = {};
  Object.keys(_jobStore).forEach(id => { jobs[id] = _jobClone_(_jobStore[id]); });
  const pending = new Set();
  const failed = new Set();
  _jobQueue_().forEach(op => {
    const p = op.patch || {};
    if (op.state === 'failed' || _jobHalted[op.group_id]) failed.add(op.group_id);
    if (p.kind === 'create') {
      if (!jobs[p.job.scheduled_visit_id]) jobs[p.job.scheduled_visit_id] = _jobClone_(p.job);
      pending.add(p.job.scheduled_visit_id);
      return;
    }
    if (p.kind === 'group_cancel') {
      Object.values(jobs).forEach(j => {
        if (j.job_group_id === op.group_id && j.status === 'scheduled') { j.status = 'cancelled'; pending.add(j.scheduled_visit_id); }
      });
      return;
    }
    const j = jobs[p.id];
    if (!j) return;
    pending.add(p.id);
    if (p.kind === 'fields') {
      Object.keys(p.fields).forEach(f => {
        if (f === 'gate_code') j.client = Object.assign({}, j.client, { gate_code: p.fields[f] });
        else if (f === 'job_title') j.title = p.fields[f];
        else j[f] = p.fields[f];
      });
    } else if (p.kind === 'status') {
      j.status = p.status;
      if (p.status === 'completed') j.completed_by = j.completed_by || (_s && _s.username) || '';
    } else if (p.kind === 'toggle') {
      j.materials_checked = Object.assign({}, j.materials_checked);
      if (p.checked) j.materials_checked[p.item_id] = j.materials_checked[p.item_id] || { by: _s.username, at: new Date().toISOString() };
      else delete j.materials_checked[p.item_id];
    }
  });
  // Visit numbering for optimistic groups (server numbers win once confirmed).
  const groups = {};
  Object.values(jobs).forEach(j => {
    if (j.status === 'cancelled' || j.restricted) return;
    (groups[j.job_group_id] = groups[j.job_group_id] || []).push(j);
  });
  Object.values(groups).forEach(list => {
    if (!list.some(j => pending.has(j.scheduled_visit_id))) return;
    list.sort((a, b) => (a.scheduled_date + a.created_at).localeCompare(b.scheduled_date + b.created_at));
    list.forEach((j, i) => { j.visit_index = i + 1; j.visit_count = list.length; });
  });
  return { jobs, pending, failed };
}

function _jobView_(id) { return _jobViewAll_().jobs[id] || null; }

// Earlier queued ops in the same group that this op builds on.
function _jobDependsOn_(groupId, visitId, touches) {
  return _jobQueue_().filter(op => {
    if (op.group_id !== groupId) return false;
    const p = op.patch || {};
    if (p.kind === 'create' && p.job.scheduled_visit_id === visitId) return true;
    if (p.kind === 'group_cancel') return true;
    if (p.id !== visitId) return false;
    if (touches.status && p.kind === 'status') return true;
    if (touches.item && p.kind === 'toggle' && p.item_id === touches.item) return true;
    if (touches.fields && p.kind === 'fields' && Object.keys(p.fields).some(f => touches.fields.includes(f))) return true;
    if (touches.fields && touches.fields.includes('materials') && p.kind === 'toggle') return true;
    return false;
  }).map(op => op.op_id);
}

function _jobEnqueue_(op) {
  op.op_id = _jobUuid_();
  op.created_at = Date.now();
  op.state = 'queued';
  const q = _jobQueue_();
  q.push(op);
  _jobSaveQueue_(q);
  _jobRefreshUi_();
  _jobPump_(op.group_id);
}

function _jobRemoveOps_(ids) {
  const set = new Set(ids);
  _jobSaveQueue_(_jobQueue_().filter(o => !set.has(o.op_id)));
}

function _jobMergeServer_(jobs) {
  (jobs || []).forEach(j => {
    if (!j || !j.scheduled_visit_id) return;
    const prev = _jobStore[j.scheduled_visit_id];
    _jobStore[j.scheduled_visit_id] = j;
    _jobTouched[j.scheduled_visit_id] = Date.now();
    _jobNoteLeadFlip_(prev, j);
  });
  const any = (jobs || [])[0];
  if (any && _jobGroupLists[any.job_group_id]) {
    const gl = _jobGroupLists[any.job_group_id];
    gl.jobs = jobs.filter(j => j.status !== 'cancelled');
    gl.cancelled = jobs.filter(j => j.status === 'cancelled').length;
  }
}

function _jobNoteLeadFlip_(prev, next) {
  if (!prev || !next) return;
  if (['pending', 'processing'].includes(prev.lead_status) && next.lead_status === 'done') {
    // A background lead just landed: drop every client-list layer so the new
    // client is searchable immediately.
    if (typeof _crmCache !== 'undefined') _crmCache = [];
    try { localStorage.removeItem('mcps_crm_data'); } catch (e) {}
    window._jobCrmForceRefresh = true;
  }
}

function _jobSend_(op) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), JOB_REQUEST_TIMEOUT_MS);
  const body = Object.assign({}, op.payload, {
    action: op.action, token: _s.token, op_id: op.op_id, op_created_at: op.created_at
  });
  return api(body, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function _jobPump_(groupId) {
  if (_jobRunning[groupId] || _jobHalted[groupId]) return;
  const op = _jobQueue_().find(o => o.group_id === groupId);
  if (!op) return;

  if (Date.now() - op.created_at > JOB_RETRY_WINDOW_MS) {
    _jobRemoveOps_([op.op_id]);
    _jobToast_('A change was too old to save — showing the latest.', 'warn');
    _jobRefreshUi_();
    return _jobPump_(groupId);
  }

  _jobRunning[groupId] = true;
  let res = null;
  try { res = await _jobSend_(op); } catch (e) { res = null; }
  _jobRunning[groupId] = false;

  // Unknown outcome (network, timeout, server error): halt this group; the
  // retry resends the SAME op_id, which the server dedupes.
  if (!res || (!res.ok && !JOB_DEFINITIVE_CODES.includes(res.code) && res.code !== 'unauthorized')) {
    _jobHalted[groupId] = true;
    _jobSaveQueue_(_jobQueue_().map(o => o.op_id === op.op_id ? Object.assign(o, { state: 'failed' }) : o));
    _jobRefreshUi_();
    return;
  }
  if (res.code === 'unauthorized') {
    _jobHalted[groupId] = true;
    _jobToast_('Your session expired — log in again to save changes.', 'error');
    _jobRefreshUi_();
    return;
  }

  if (res.ok) {
    _jobMergeServer_(res.jobs);
    _jobRemoveOps_([op.op_id]);
    if (typeof _clearRouteCache === 'function') _clearRouteCache();
  } else {
    if (res.jobs) _jobMergeServer_(res.jobs);
    _jobRemoveOps_([op.op_id]);
    _jobToast_(res.error || 'That change couldn\'t be saved.', res.code === 'conflict' ? 'warn' : 'error');
    _jobDropDependents_(op);
  }
  _jobRefreshUi_();
  _jobPump_(groupId);
}

// After a rejection: later ops that depended on the rejected one are dropped as
// conflicts, unless they can still apply without overwriting anything (their
// expected prior values equal the current canonical values).
function _jobDropDependents_(rejected) {
  const dropped = new Set([rejected.op_id]);
  const q = _jobQueue_();
  const remove = [];
  q.forEach(op => {
    if (op.group_id !== rejected.group_id) return;
    if (!(op.depends_on || []).some(id => dropped.has(id))) return;
    if (_jobOpStillApplies_(op)) return;
    dropped.add(op.op_id);
    remove.push(op.op_id);
  });
  if (remove.length) {
    _jobRemoveOps_(remove);
    _jobToast_(`${remove.length} later change${remove.length === 1 ? '' : 's'} discarded — someone else changed this job.`, 'warn');
  }
}

function _jobOpStillApplies_(op) {
  const p = op.patch || {};
  const visitId = p.id || (p.job && p.job.scheduled_visit_id);
  const cur = visitId ? _jobStore[visitId] : null;
  if (op.action === 'create_job') return false;
  if (op.action === 'add_job_visit') return !!_jobStore[op.payload.source_visit_id];
  if (op.action === 'set_job_status' && op.payload.scope === 'group') return true;
  if (!cur) return false;
  if (op.action === 'set_job_status') return cur.status === op.payload.from;
  if (op.action === 'toggle_job_material') return !!(cur.materials_checked || {})[op.payload.item_id] === op.payload.from;
  if (op.action === 'update_job') {
    return Object.keys(op.payload.changes).every(f => _jobFieldStr_(f, _jobFieldOf_(cur, f)) === _jobFieldStr_(f, op.payload.changes[f].from));
  }
  return false;
}

function _jobFieldOf_(job, f) {
  if (f === 'gate_code') return (job.client || {}).gate_code || '';
  if (f === 'job_title') return job.title;
  return job[f];
}
function _jobFieldStr_(f, v) {
  if (f === 'materials') return JSON.stringify((v || []).map(m => ({ id: m.id, text: m.text })));
  return v == null ? '' : String(v);
}

function jobRetryGroup(groupId) {
  _jobHalted[groupId] = false;
  _jobSaveQueue_(_jobQueue_().map(o => o.group_id === groupId ? Object.assign(o, { state: 'queued' }) : o));
  _jobRefreshUi_();
  _jobPump_(groupId);
}

function _jobPumpAll_() {
  const groups = new Set(_jobQueue_().map(o => o.group_id));
  groups.forEach(g => { _jobHalted[g] = false; _jobPump_(g); });
}
window.addEventListener('online', () => { if (_s && _s.token) _jobPumpAll_(); });

// ── Server payload ingestion ──────────────────────────────────────────────────

// Called with every fresh week payload (authoritative) and on renders (not).
function _jobsIngestPayload_(payload, authoritative) {
  if (!payload || !Array.isArray(payload.days)) return;
  const seen = new Set();
  payload.days.forEach(d => (d.pools || []).forEach(p => {
    if (!p || p._visit_type !== 'job') return;
    const j = p._jobView ? p._jobServer : p._job;
    if (!j || !j.scheduled_visit_id) return;
    seen.add(j.scheduled_visit_id);
    const cur = _jobStore[j.scheduled_visit_id];
    const newer = !cur || (Number(j.rev) || 0) >= (Number(cur.rev) || 0);
    const fresh = authoritative && !p._jobView && !(cur && Date.now() - (_jobTouched[j.scheduled_visit_id] || 0) < 30000 && (Number(j.rev) || 0) < (Number(cur.rev) || 0));
    if (fresh || newer) {
      _jobNoteLeadFlip_(cur, j);
      _jobStore[j.scheduled_visit_id] = j;
    }
  }));
  if (authoritative && payload.week_start) {
    const ws = payload.week_start, we = _jobAddDays_(payload.week_start, 5);
    const filter = (payload.operator && payload.operator !== 'all') ? _jobLower_(payload.operator)
      : (_activeOp && _activeOp !== 'all' ? _jobLower_(_activeOp) : null);
    Object.keys(_jobStore).forEach(id => {
      const j = _jobStore[id];
      if (seen.has(id) || !j.scheduled_date || j.scheduled_date < ws || j.scheduled_date > we) return;
      if (filter && _jobLower_(j.assigned_technician) !== filter) return;
      if (Date.now() - (_jobTouched[id] || 0) < 30000) return; // a newer mutation response wins
      delete _jobStore[id]; // cancelled or moved by someone else
    });
  }
  // Keep polling while a lead is still being created.
  Object.values(_jobStore).some(j => ['pending', 'processing'].includes(j.lead_status)) && _jobStartLeadPoll_();
}

// Jobs from a non-week payload (month view). Never overwrites newer data.
function _jobsIngestJobs_(list) {
  (list || []).forEach(j => {
    if (!j || !j.scheduled_visit_id) return;
    const cur = _jobStore[j.scheduled_visit_id];
    if (!cur || (Number(j.rev) || 0) >= (Number(cur.rev) || 0)) _jobStore[j.scheduled_visit_id] = j;
  });
}

// Rewrites the job stops of _routeData from the view, keeping server order.
function _jobsApplyToRouteData_() {
  if (!_routeData || !Array.isArray(_routeData.days)) return;
  _jobsIngestPayload_(_routeData, false);
  const { jobs, pending, failed } = _jobViewAll_();
  const filter = (_activeOp && _activeOp !== 'all') ? _jobLower_(_activeOp) : null;
  const visible = (j, date) => j.status !== 'cancelled' && j.scheduled_date === date &&
    (!filter || _jobLower_(j.assigned_technician) === filter);
  const placed = new Set();
  _routeData.days.forEach(day => {
    const out = [];
    (day.pools || []).forEach(p => {
      if (!p || p._visit_type !== 'job') { out.push(p); return; }
      const id = p._scheduled_visit_id || (p._job && p._job.scheduled_visit_id);
      const j = jobs[id];
      if (!j || placed.has(id) || !visible(j, day.date)) return;
      out.push(_jobStop_(j, pending.has(id), failed.has(j.job_group_id)));
      placed.add(id);
    });
    Object.values(jobs).forEach(j => {
      if (placed.has(j.scheduled_visit_id) || !visible(j, day.date)) return;
      out.push(_jobStop_(j, pending.has(j.scheduled_visit_id), failed.has(j.job_group_id)));
      placed.add(j.scheduled_visit_id);
    });
    day.pools = out;
  });
}

function _jobStop_(j, isPending, isFailed) {
  const c = j.client || {};
  return {
    pool_id: c.pool_id || '', customer_name: c.name || j.title, address: c.address || '', city: c.city || '',
    service: 'One-time job', maps_url: '', lat: '', lng: '', operator: j.assigned_technician || '',
    pinned: false, gate_code: c.gate_code || '', notes: j.notes || '',
    _is_scheduled_visit: true, _visit_type: 'job', _scheduled_visit_id: j.scheduled_visit_id,
    _scheduled_visit_status: j.status, _job: j, _jobView: true,
    _jobServer: _jobStore[j.scheduled_visit_id] || null, _jobPending: isPending, _jobFailed: isFailed
  };
}

function _jobRefreshUi_() {
  if (_routeData && typeof renderRoutePage === 'function' && document.getElementById('route-day-card')) {
    try { renderRoutePage(); } catch (e) { console.warn('job refresh', e); }
  }
  if (_jobSheetId) _jobRenderSheet_();
  if (typeof _currentMapView !== 'undefined' && _currentMapView === 'month') _jobScheduleMonthReload_();
}

let _jobMonthTimer = null;
function _jobScheduleMonthReload_() {
  // Month data is server-rendered; reload once the queue for it has drained.
  clearTimeout(_jobMonthTimer);
  _jobMonthTimer = setTimeout(() => {
    if (_jobQueue_().length) return _jobScheduleMonthReload_();
    if (typeof loadCalendarData === 'function') loadCalendarData(_calMonth, _calYear);
  }, 600);
}

// ── Job card on the schedule ──────────────────────────────────────────────────

function _jobStopCardHtml_(pool, idx) {
  const j = pool._job || {};
  const id = j.scheduled_visit_id || pool._scheduled_visit_id;
  const opLabel = isAdmin() && pool.operator ? `<span class="ps-label svc-other">${escHtml(pool.operator)}</span>` : '';
  if (j.restricted) {
    return `<div class="pool-stop job-stop">
      <div class="ps-num-col"><div class="ps-num">${idx + 1}</div></div>
      <div class="ps-main-col">
        <div class="ps-title">${escHtml(j.title || 'Job')}</div>
        <div class="ps-label-row"><span class="ps-label job-badge">One-time job</span>${opLabel}</div>
      </div>
    </div>`;
  }
  const c = j.client || {};
  const done = j.status === 'completed';
  const canAct = isAdmin() || _jobIsAssigned_(j);
  const mats = j.materials || [];
  const checked = mats.filter(m => (j.materials_checked || {})[m.id]).length;
  const addr = [c.address, c.city].filter(Boolean).join(', ');
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const enc = encodeURIComponent(addr + (addr ? ', TX' : ''));
  const nav = isIOS ? 'https://maps.apple.com/?daddr=' + enc + '&dirflg=d' : 'https://www.google.com/maps/dir/?api=1&destination=' + enc;
  const notesPreview = j.notes ? escHtml(j.notes.length > 90 ? j.notes.slice(0, 90) + '…' : j.notes) : '';
  const status = pool._jobFailed
    ? `<button class="job-pill failed" onclick="event.stopPropagation();jobRetryGroup(${jsArg(j.job_group_id)})">Not saved — Retry</button>`
    : pool._jobPending ? '<span class="job-pill saving">Saving…</span>' : '';

  return `<div class="pool-stop job-stop${done ? ' ps-done' : ''}" id="stop-${idx}" style="cursor:pointer" onclick="openJobSheet(${jsArg(id)})">
    <div class="ps-num-col"><div class="ps-num">${idx + 1}</div></div>
    <div class="ps-main-col">
      <div class="ps-title">${escHtml(j.title || 'Job')}</div>
      <div class="ps-meta"><span>👤 ${escHtml(c.name || '—')}</span></div>
      ${addr ? `<div class="ps-meta"><span>📍 ${escHtml(addr)}</span></div>` : ''}
      <div class="ps-label-row">
        <span class="ps-label job-badge">One-time job</span>
        ${j.visit_count > 1 ? `<span class="ps-label job-visit-badge">Visit ${j.visit_index} of ${j.visit_count}</span>` : ''}
        ${j.est_minutes ? `<span class="ps-label job-est">⏱ ${escHtml(_jobFmtEst_(j.est_minutes))}</span>` : ''}
        ${opLabel}
        ${done ? '<span class="ps-label svc-done">Done</span>' : ''}
        ${status}
      </div>
      ${c.gate_code ? `<div class="stop-gate-code" style="font-size:.75rem;color:var(--teal);margin-top:.25rem;font-weight:600">🔑 ${escHtml(c.gate_code)}</div>` : ''}
      ${notesPreview ? `<div class="job-notes-preview">${notesPreview}</div>` : ''}
      ${mats.length ? `<div class="job-mats-count">🧰 ${checked}/${mats.length} materials</div>` : ''}
      <div class="ps-btns" onclick="event.stopPropagation()">
        ${canAct && !done ? `<button class="ps-btn job-done-btn" onclick="jobMarkDone(${jsArg(id)})">✓ Done</button>` : ''}
        ${canAct && !done && c.pool_id ? `<button class="ps-btn ps-log" onclick="goToSvcLog(${jsArg(c.pool_id)},${jsArg(c.name || '')},${jsArg(id)},'job')">📝 Log Service</button>` : ''}
        ${c.phone ? `<a class="ps-btn job-call-btn" href="tel:${escHtml(c.phone.replace(/[^\d+]/g, ''))}">📞 Call</a>` : ''}
        ${addr ? `<a class="ps-btn ps-nav" href="${nav}" target="_blank" rel="noopener" title="Navigate"></a>` : ''}
      </div>
    </div>
    <div class="ps-action-col ps-server-check" title="${done ? 'Done' : 'Not done yet'}">
      <div class="ps-check">${done ? '✓' : ''}</div>
    </div>
  </div>`;
}

// ── Actions (all go through the queue) ────────────────────────────────────────

function jobMarkDone(id) {
  const j = _jobView_(id);
  if (!j || j.status !== 'scheduled') return;
  _jobEnqueue_({
    action: 'set_job_status', group_id: j.job_group_id,
    depends_on: _jobDependsOn_(j.job_group_id, id, { status: true }),
    payload: { scheduled_visit_id: id, from: 'scheduled', to: 'completed' },
    patch: { kind: 'status', id, status: 'completed' }
  });
}

function jobReopen(id) {
  const j = _jobView_(id);
  if (!j || j.status !== 'completed') return;
  _jobEnqueue_({
    action: 'set_job_status', group_id: j.job_group_id,
    depends_on: _jobDependsOn_(j.job_group_id, id, { status: true }),
    payload: { scheduled_visit_id: id, from: 'completed', to: 'scheduled' },
    patch: { kind: 'status', id, status: 'scheduled' }
  });
}

function jobCancelVisit(id) {
  const j = _jobView_(id);
  if (!j || j.status !== 'scheduled') return;
  if (!confirm(`Cancel this visit on ${_jobFmtDate_(j.scheduled_date)}? The customer isn't notified.`)) return;
  _jobEnqueue_({
    action: 'set_job_status', group_id: j.job_group_id,
    depends_on: _jobDependsOn_(j.job_group_id, id, { status: true }),
    payload: { scheduled_visit_id: id, from: 'scheduled', to: 'cancelled' },
    patch: { kind: 'status', id, status: 'cancelled' }
  });
  closeJobSheet();
}

function jobCancelGroup(id) {
  const j = _jobView_(id);
  if (!j) return;
  if (!confirm('Cancel every remaining visit of this job? Completed visits stay as they are. The customer isn\'t notified.')) return;
  _jobEnqueue_({
    action: 'set_job_status', group_id: j.job_group_id,
    depends_on: _jobQueue_().filter(o => o.group_id === j.job_group_id).map(o => o.op_id),
    payload: { scheduled_visit_id: id, to: 'cancelled', scope: 'group' },
    patch: { kind: 'group_cancel' }
  });
  closeJobSheet();
}

// changes: { field: newValue } — from-values come from the current view.
function _jobUpdate_(id, changes) {
  const j = _jobView_(id);
  if (!j) return;
  const payload = {};
  const fields = {};
  Object.keys(changes).forEach(f => {
    const from = _jobFieldOf_(j, f);
    if (_jobFieldStr_(f, from) === _jobFieldStr_(f, changes[f])) return;
    payload[f] = { from: from == null ? '' : from, to: changes[f] };
    fields[f] = changes[f];
  });
  if (!Object.keys(payload).length) return;
  _jobEnqueue_({
    action: 'update_job', group_id: j.job_group_id,
    depends_on: _jobDependsOn_(j.job_group_id, id, { fields: Object.keys(payload) }),
    payload: { scheduled_visit_id: id, changes: payload },
    patch: { kind: 'fields', id, fields }
  });
}

function jobReschedule(id, date) {
  if (!date) return;
  if (_jobDow_(date) === 0) { _jobToast_('Jobs can\'t be scheduled on Sunday.', 'warn'); return; }
  _jobUpdate_(id, { scheduled_date: date });
}

function jobRescheduleChip(id, which) {
  const j = _jobView_(id);
  if (!j) return;
  const base = j.scheduled_date || _jobToday_();
  const date = which === 'tomorrow' ? _jobDateChips_().tomorrow
    : which === 'next' ? _jobSkipSunday_(_jobAddDays_(base, 1))
    : _jobAddDays_(base, 7);
  jobReschedule(id, date);
}

function jobToggleMaterial(id, itemId, checked) {
  const j = _jobView_(id);
  if (!j) return;
  const from = !!(j.materials_checked || {})[itemId];
  if (from === checked) return;
  _jobEnqueue_({
    action: 'toggle_job_material', group_id: j.job_group_id,
    depends_on: _jobDependsOn_(j.job_group_id, id, { item: itemId }),
    payload: { scheduled_visit_id: id, item_id: itemId, checked, from },
    patch: { kind: 'toggle', id, item_id: itemId, checked }
  });
}

// One material per line. Lines whose text matches an existing item keep its id,
// so editing or reordering never moves a checkmark to a different item.
function _jobParseMaterials_(text, existing) {
  const pool = (existing || []).slice();
  return String(text || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 30).map(line => {
    const k = pool.findIndex(m => m.text === line);
    if (k !== -1) return pool.splice(k, 1)[0];
    return { id: _jobMatId_(), text: line.slice(0, 120) };
  });
}

function jobAddVisit(sourceId, date, tech) {
  const src = _jobView_(sourceId);
  if (!src || !date) return;
  if (_jobDow_(date) === 0) { _jobToast_('Jobs can\'t be scheduled on Sunday.', 'warn'); return; }
  const id = _jobUuid_();
  const job = Object.assign(_jobClone_(src), {
    scheduled_visit_id: id, scheduled_date: date, assigned_technician: tech || '', assigned_username: '',
    status: 'scheduled', notes: '', materials_checked: {}, completed_at: '', completed_by: '',
    rev: 0, created_at: new Date().toISOString()
  });
  _jobEnqueue_({
    action: 'add_job_visit', group_id: src.job_group_id,
    depends_on: _jobDependsOn_(src.job_group_id, sourceId, {}),
    payload: { scheduled_visit_id: id, source_visit_id: sourceId, scheduled_date: date, assigned_technician: tech || '' },
    patch: { kind: 'create', job }
  });
  _jobToast_(`Visit added for ${_jobFmtDate_(date)}.`);
}

function jobRetryLead(id) {
  api({ action: 'retry_job_lead', token: _s.token, scheduled_visit_id: id }).then(res => {
    if (res && res.jobs) _jobMergeServer_(res.jobs);
    if (!res || !res.ok) _jobToast_((res && res.error) || 'Couldn\'t retry right now.', 'error');
    else _jobToast_('Retrying — adding them to the Sales Hub.');
    _jobStartLeadPoll_();
    _jobRefreshUi_();
  }).catch(() => _jobToast_('Network error — try again.', 'error'));
}

// ── Lead polling (only while a lead is being created) ─────────────────────────

function _jobStartLeadPoll_() {
  if (_jobLeadPoll) return;
  const started = Date.now();
  _jobLeadPoll = setInterval(() => {
    const id = _jobSheetId;
    const j = id ? _jobView_(id) : null;
    if (!j || !['pending', 'processing'].includes(j.lead_status) || Date.now() - started > 3 * 60 * 1000) {
      clearInterval(_jobLeadPoll); _jobLeadPoll = null; return;
    }
    _jobLoadGroup_(id, true);
  }, 8000);
}

// ── Job sheet ─────────────────────────────────────────────────────────────────

function openJobSheet(id) {
  _jobSheetId = id;
  document.getElementById('job-sheet-backdrop').classList.add('open');
  document.getElementById('job-sheet').classList.add('open');
  _jobRenderSheet_(true);
  const j = _jobView_(id);
  if (j && !j.restricted && !_jobQueue_().some(o => o.patch && o.patch.kind === 'create' && o.patch.job.scheduled_visit_id === id)) {
    _jobLoadGroup_(id, false);
  }
  if (j && ['pending', 'processing'].includes(j.lead_status)) _jobStartLeadPoll_();
}

function closeJobSheet() {
  _jobSheetId = null;
  document.getElementById('job-sheet-backdrop').classList.remove('open');
  document.getElementById('job-sheet').classList.remove('open');
}

function _jobLoadGroup_(id, silent) {
  const j = _jobView_(id);
  if (!j) return;
  const gid = j.job_group_id;
  const gl = _jobGroupLists[gid] = _jobGroupLists[gid] || { jobs: null, cancelled: 0 };
  if (!silent) { gl.loading = true; gl.error = ''; _jobRenderSheet_(); }
  api({ action: 'get_job_group', token: _s.token, scheduled_visit_id: id }).then(res => {
    gl.loading = false;
    if (!res || !res.ok) { gl.error = (res && res.error) || 'Couldn\'t load visits'; _jobRenderSheet_(); return; }
    _jobMergeServer_(res.jobs);
    gl.jobs = (res.jobs || []).filter(x => x.status !== 'cancelled');
    gl.cancelled = res.cancelled_count || 0;
    _jobRefreshUi_();
  }).catch(() => { gl.loading = false; gl.error = 'Network error'; _jobRenderSheet_(); });
}

function _jobRenderSheet_(force) {
  const el = document.getElementById('job-sheet');
  if (!el || !_jobSheetId) return;
  // Never clobber a field the user is typing in; re-render after they leave it.
  const active = document.activeElement;
  if (!force && active && el.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
    _jobSheetDeferred = true;
    return;
  }
  _jobSheetDeferred = false;
  const view = _jobViewAll_();
  const j = view.jobs[_jobSheetId];
  if (!j) {
    el.innerHTML = '<div class="pas-handle"></div><div class="job-empty">This job is no longer on the schedule.</div>';
    return;
  }
  const id = j.scheduled_visit_id;
  const admin = isAdmin();
  const canAct = admin || _jobIsAssigned_(j);
  if (j.restricted) {
    el.innerHTML = `<div class="pas-handle"></div>
      <div class="pas-title">${escHtml(j.title)}</div>
      <div class="pas-sub">${escHtml(_jobFmtDate_(j.scheduled_date))} · Assigned to ${escHtml(j.assigned_technician || 'nobody yet')}</div>`;
    return;
  }
  const c = j.client || {};
  const isNewJob = view.pending.has(id) && _jobQueue_().some(o => o.patch && o.patch.kind === 'create' && o.patch.job.scheduled_visit_id === id);
  const failed = view.failed.has(j.job_group_id);
  const done = j.status === 'completed', scheduled = j.status === 'scheduled';
  const addr = [c.address, c.city].filter(Boolean).join(', ');
  const enc = encodeURIComponent(addr + ', TX');
  const nav = /iPad|iPhone|iPod/.test(navigator.userAgent)
    ? 'https://maps.apple.com/?daddr=' + enc + '&dirflg=d'
    : 'https://www.google.com/maps/dir/?api=1&destination=' + enc;
  const phone = (c.phone || '').replace(/[^\d+]/g, '');
  const mats = j.materials || [];
  const ops = _jobOperators_();
  const gl = _jobGroupLists[j.job_group_id] || {};

  const leadAgeMin = j.created_at ? (Date.now() - Date.parse(j.created_at)) / 60000 : 0;
  let leadLine = '';
  if (j.lead_status === 'pending' || j.lead_status === 'processing') {
    leadLine = leadAgeMin < 10 || !admin
      ? '<div class="job-lead-line"><span class="job-spinner"></span> Adding to Sales Hub…</div>'
      : `<div class="job-lead-line warn">Lead still pending <button class="job-link-btn" onclick="jobRetryLead(${jsArg(id)})">Retry</button></div>`;
  } else if (j.lead_status === 'failed') {
    leadLine = `<div class="job-lead-line warn">Lead not created${admin ? ` <button class="job-link-btn" onclick="jobRetryLead(${jsArg(id)})">Retry</button>` : ''}</div>`;
  }

  const statusPill = failed
    ? `<button class="job-pill failed" onclick="jobRetryGroup(${jsArg(j.job_group_id)})">Not saved — Retry</button>`
    : view.pending.has(id) ? '<span class="job-pill saving">Saving…</span>' : '';

  let html = `<div class="pas-handle"></div>
    <div class="job-sheet-hdr">
      ${admin && scheduled
        ? `<input class="job-title-input" value="${escHtml(j.title)}" maxlength="120" aria-label="Job title"
             onblur="_jobUpdate_(${jsArg(id)},{job_title:this.value.trim()||this.defaultValue});_jobAfterBlur_()">`
        : `<div class="pas-title">${escHtml(j.title)}</div>`}
      <button class="drawer-close" onclick="closeJobSheet()" aria-label="Close">✕</button>
    </div>
    <div class="job-sheet-sub">
      <span class="ps-label job-badge">One-time job</span>
      ${j.visit_count > 1 ? `<span class="ps-label job-visit-badge">Visit ${j.visit_index} of ${j.visit_count}</span>` : ''}
      <span>${escHtml(_jobFmtDate_(j.scheduled_date))}</span>
      ${j.est_minutes ? `<span>· ⏱ ${escHtml(_jobFmtEst_(j.est_minutes))}</span>` : ''}
      ${done ? '<span class="ps-label svc-done">Done</span>' : ''}
      ${statusPill}
    </div>

    <div class="job-client">
      <div class="job-client-name">${escHtml(c.name || '—')}</div>
      ${addr ? `<div class="job-client-addr">${escHtml(addr)}</div>` : ''}
      <div class="job-quick">
        ${addr ? `<a class="job-quick-btn" href="${nav}" target="_blank" rel="noopener">🧭 Navigate</a>` : ''}
        ${phone ? `<a class="job-quick-btn" href="tel:${escHtml(phone)}">📞 Call</a><a class="job-quick-btn" href="sms:${escHtml(phone)}">💬 Text</a>` : ''}
      </div>
      ${c.gate_code || admin ? `<div class="job-gate">
        <span class="job-gate-label">🔑 Gate code</span>
        ${admin && scheduled
          ? `<input class="job-gate-input" value="${escHtml(c.gate_code || '')}" placeholder="Add gate code" maxlength="120"
               onblur="_jobUpdate_(${jsArg(id)},{gate_code:this.value.trim()});_jobAfterBlur_()">`
          : `<span class="job-gate-code">${escHtml(c.gate_code || '—')}</span>`}
      </div>` : ''}
      ${leadLine}
    </div>`;

  // Materials checklist
  if (mats.length || (admin && scheduled)) {
    html += `<div class="pas-section"><div class="pas-section-label">🧰 Materials needed</div>`;
    if (mats.length) {
      html += '<div class="job-mats">' + mats.map(m => {
        const on = !!(j.materials_checked || {})[m.id];
        const dis = !canAct || !scheduled ? 'disabled' : '';
        return `<label class="job-mat${on ? ' on' : ''}"><input type="checkbox" ${on ? 'checked' : ''} ${dis}
          onchange="jobToggleMaterial(${jsArg(id)},${jsArg(m.id)},this.checked)"><span>${escHtml(m.text)}</span></label>`;
      }).join('') + '</div>';
      if (done) html += '<div class="job-hint">Locked — this visit is done.</div>';
    }
    if (admin && scheduled) {
      html += `<details class="job-edit-mats"><summary>Edit list</summary>
        <textarea class="q-inp" rows="4" placeholder="One per line" onblur="_jobUpdate_(${jsArg(id)},{materials:_jobParseMaterials_(this.value,(_jobView_(${jsArg(id)})||{}).materials)});_jobAfterBlur_()">${escHtml(mats.map(m => m.text).join('\n'))}</textarea>
      </details>`;
    }
    html += '</div>';
  }

  // Notes
  if (admin) {
    html += `<div class="pas-section"><div class="pas-section-label">📝 Notes</div>
      <textarea class="q-inp" rows="3" maxlength="2000" placeholder="Anything the tech should know"
        onblur="_jobUpdate_(${jsArg(id)},{notes:this.value.trim()});_jobAfterBlur_()">${escHtml(j.notes || '')}</textarea></div>`;
  } else if (j.notes) {
    html += `<div class="pas-section"><div class="pas-section-label">📝 Notes</div><div class="job-notes">${escHtml(j.notes)}</div></div>`;
  }

  // Estimated time (admin)
  if (admin && scheduled) {
    html += `<div class="pas-section"><div class="pas-section-label">⏱ Estimated time</div><div class="pas-day-grid">` +
      JOB_EST_CHIPS.map(([v, label]) => `<button class="pas-day-btn${String(j.est_minutes || '') === String(v) ? ' active' : ''}"
        onclick="_jobUpdate_(${jsArg(id)},{est_minutes:${v === '' ? "''" : v}})">${label}</button>`).join('') + '</div></div>';
  }

  // Reschedule (admin) — this visit only, silent
  if (admin && scheduled) {
    html += `<div class="pas-section"><div class="pas-section-label">📅 Reschedule this visit</div>
      <div class="pas-day-grid">
        <button class="pas-day-btn" onclick="jobRescheduleChip(${jsArg(id)},'tomorrow')">Tomorrow</button>
        <button class="pas-day-btn" onclick="jobRescheduleChip(${jsArg(id)},'next')">Next weekday</button>
        <button class="pas-day-btn" onclick="jobRescheduleChip(${jsArg(id)},'week')">+1 week</button>
        <input type="date" class="job-date-input" value="${escHtml(j.scheduled_date)}" aria-label="Pick date"
          onchange="jobReschedule(${jsArg(id)},this.value)">
      </div>
      <select class="pas-op-select" style="margin-top:.5rem" onchange="_jobUpdate_(${jsArg(id)},{assigned_technician:this.value})">
        <option value="">Unassigned</option>
        ${ops.map(o => `<option value="${escHtml(o)}"${_jobLower_(o) === _jobLower_(j.assigned_technician) ? ' selected' : ''}>${escHtml(o)}</option>`).join('')}
      </select>
      <div class="job-hint">The customer isn't notified.</div>
    </div>`;
  }

  // Visits in this job
  if (!isNewJob) {
    html += `<div class="pas-section"><div class="pas-section-label">🗓 Visits in this job</div>`;
    if (gl.loading && !gl.jobs) html += '<div class="job-loading"><span class="job-spinner"></span> Loading visits…</div>';
    else if (gl.error && !gl.jobs) html += `<div class="job-hint">${escHtml(gl.error)} <button class="job-link-btn" onclick="_jobLoadGroup_(${jsArg(id)},false)">Retry</button></div>`;
    else if (gl.jobs) {
      const list = Object.values(view.jobs).filter(x => x.job_group_id === j.job_group_id && x.status !== 'cancelled')
        .sort((a, b) => (a.scheduled_date + a.created_at).localeCompare(b.scheduled_date + b.created_at));
      html += '<div class="job-visits">' + list.map(v => `<button class="job-visit-row${v.scheduled_visit_id === id ? ' current' : ''}"
          onclick="jobJumpToVisit(${jsArg(v.scheduled_visit_id)})">
          <span>${escHtml(_jobFmtDate_(v.scheduled_date))}</span>
          <span class="job-visit-tech">${escHtml(v.assigned_technician || 'Unassigned')}</span>
          <span class="job-visit-status ${escHtml(v.status)}">${v.status === 'completed' ? 'Done' : 'Scheduled'}</span>
        </button>`).join('') + '</div>';
      if (gl.cancelled) html += `<div class="job-hint">${gl.cancelled} cancelled visit${gl.cancelled === 1 ? '' : 's'} hidden.</div>`;
    }
    if (admin) {
      html += `<details class="job-add-visit"><summary>+ Add visit</summary>
        <div class="pas-day-grid" style="margin-top:.5rem">
          <button class="pas-day-btn" onclick="jobAddVisit(${jsArg(id)},_jobDateChips_().tomorrow,document.getElementById('job-addvisit-tech').value)">Tomorrow</button>
          <button class="pas-day-btn" onclick="jobAddVisit(${jsArg(id)},_jobSkipSunday_(_jobAddDays_(${jsArg(j.scheduled_date)},1)),document.getElementById('job-addvisit-tech').value)">Next weekday</button>
          <button class="pas-day-btn" onclick="jobAddVisit(${jsArg(id)},_jobAddDays_(${jsArg(j.scheduled_date)},7),document.getElementById('job-addvisit-tech').value)">+1 week</button>
          <input type="date" class="job-date-input" id="job-addvisit-date" aria-label="Pick date"
            onchange="jobAddVisit(${jsArg(id)},this.value,document.getElementById('job-addvisit-tech').value)">
        </div>
        <select class="pas-op-select" id="job-addvisit-tech" style="margin-top:.5rem">
          <option value="">Unassigned</option>
          ${ops.map(o => `<option value="${escHtml(o)}"${_jobLower_(o) === _jobLower_(j.assigned_technician) ? ' selected' : ''}>${escHtml(o)}</option>`).join('')}
        </select>
      </details>`;
    }
    html += '</div>';
  }

  // Actions
  html += '<div class="job-actions">';
  if (canAct && scheduled) html += `<button class="pas-apply-btn" onclick="jobMarkDone(${jsArg(id)})">✓ Mark done</button>`;
  if (canAct && scheduled && c.pool_id) {
    html += `<button class="job-secondary-btn" onclick="closeJobSheet();goToSvcLog(${jsArg(c.pool_id)},${jsArg(c.name || '')},${jsArg(id)},'job')">📝 Log Service</button>`;
  }
  if (admin && done) html += `<button class="job-secondary-btn" onclick="jobReopen(${jsArg(id)})">↺ Reopen</button>`;
  if (admin && scheduled) {
    html += `<button class="job-danger-btn" onclick="jobCancelVisit(${jsArg(id)})">Cancel this visit</button>`;
    const scheduledCount = gl.jobs ? gl.jobs.filter(v => v.status === 'scheduled').length : j.visit_count;
    if (scheduledCount > 1) html += `<button class="job-danger-btn" onclick="jobCancelGroup(${jsArg(id)})">Cancel all remaining visits</button>`;
  }
  html += '</div>';

  el.innerHTML = html;
}

function _jobAfterBlur_() {
  // Let the focus move first, then catch up on any deferred re-render.
  setTimeout(() => { if (_jobSheetDeferred) _jobRenderSheet_(); }, 0);
}

function jobJumpToVisit(id) {
  const j = _jobView_(id);
  if (!j) return;
  if (id === _jobSheetId) return;
  const ws = _jobWeekStartOf_(j.scheduled_date);
  const cur = typeof _weekStartForOffset_ === 'function' ? _weekStartForOffset_(_weekOffset) : '';
  if (ws && cur && ws !== cur && isAdmin() && typeof navWeek === 'function') {
    const diff = Math.round((Date.parse(ws + 'T12:00:00Z') - Date.parse(cur + 'T12:00:00Z')) / (7 * 86400000));
    navWeek(diff);
  }
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][_jobDow_(j.scheduled_date)];
  if (typeof selectDay === 'function' && ws === cur) selectDay(dayName);
  else _activeDay = dayName;
  openJobSheet(id);
}

function _jobWeekStartOf_(iso) {
  const dow = _jobDow_(iso);
  return _jobAddDays_(iso, dow === 0 ? -6 : 1 - dow);
}

// ── Create modal ──────────────────────────────────────────────────────────────

function _jobDefaultDate_() {
  const today = _jobToday_();
  if (typeof _currentMapView !== 'undefined' && _currentMapView === 'month') {
    if (_jobCalDate && _jobDow_(_jobCalDate) !== 0) return _jobCalDate;
    const first = `${_calYear}-${String(_calMonth).padStart(2, '0')}-01`;
    if (today.slice(0, 7) === first.slice(0, 7)) return _jobSkipSunday_(today);
    return _jobSkipSunday_(first);
  }
  const days = (_routeData && _routeData.days) || [];
  const sel = days.find(d => d.day === _activeDay);
  if (sel && sel.date) return sel.date;
  const ws = typeof _weekStartForOffset_ === 'function' ? _weekStartForOffset_(_weekOffset) : '';
  if (ws) {
    const t = _jobSkipSunday_(today);
    return t >= ws && t <= _jobAddDays_(ws, 5) ? t : ws;
  }
  return _jobSkipSunday_(today);
}

function openNewJob() {
  if (!isAdmin()) return;
  _jobModal = { client: null, isNew: false, est: '', date: _jobDefaultDate_() };
  const m = document.getElementById('job-modal');
  document.getElementById('job-title').value = '';
  document.getElementById('job-client-q').value = '';
  document.getElementById('job-materials').value = '';
  document.getElementById('job-notes').value = '';
  ['job-nc-name', 'job-nc-address', 'job-nc-city', 'job-nc-phone', 'job-nc-gate'].forEach(i => { document.getElementById(i).value = ''; });
  document.getElementById('job-err').textContent = '';
  const tech = document.getElementById('job-tech');
  tech.innerHTML = '<option value="">Unassigned</option>' + _jobOperators_().map(o => `<option value="${escHtml(o)}">${escHtml(o)}</option>`).join('');
  _jobRenderClientPicker_();
  _jobRenderDateChips_();
  _jobRenderEstChips_();
  m.classList.add('open');
  setTimeout(() => document.getElementById('job-client-q').focus(), 50);
  _jobLoadClients_(false);
}

function closeNewJob() {
  document.getElementById('job-modal').classList.remove('open');
  _jobModal = null;
}

let _jobClients = null, _jobClientsState = 'idle', _jobClientsErr = '';
function _jobLoadClients_(force) {
  if (typeof _getCrmListFast_ !== 'function') return;
  if (window._jobCrmForceRefresh) { force = true; window._jobCrmForceRefresh = false; }
  if (_jobClients && !force) { _jobRenderClientResults_(); return; }
  _jobClientsState = 'loading';
  _jobRenderClientResults_();
  _getCrmListFast_(force).then(list => {
    _jobClients = list;
    _jobClientsState = 'ready';
    _jobRenderClientResults_();
  }).catch(e => {
    _jobClientsState = 'error';
    _jobClientsErr = e.message || 'Couldn\'t load clients';
    _jobRenderClientResults_();
  });
}

// Idle prefetch so the picker is instant when an admin opens it.
function _jobPrefetchClients_() {
  if (!isAdmin() || _jobClients) return;
  const run = () => _getCrmListFast_(false).then(l => { _jobClients = l; _jobClientsState = 'ready'; }).catch(() => {});
  if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 4000 }); else setTimeout(run, 1500);
}

function _jobClientName_(c) {
  return c.client_name || [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || '(no name)';
}

function _jobSearchClients_(q) {
  const list = _jobClients || [];
  const needle = _jobLower_(q);
  const digits = q.replace(/\D/g, '');
  if (needle.length < 2 && digits.length < 3) return [];
  const scored = [];
  for (const c of list) {
    const name = _jobLower_(_jobClientName_(c));
    const addr = _jobLower_([c.address, c.city].join(' '));
    const phone = String(c.phone || '').replace(/\D/g, '');
    const pid = _jobLower_(c.pool_id);
    let score = 0;
    if (name.startsWith(needle)) score = 4;
    else if (name.includes(needle)) score = 3;
    else if (addr.includes(needle)) score = 2;
    else if (pid && pid.includes(needle)) score = 2;
    else if (digits.length >= 3 && phone.includes(digits)) score = 2;
    if (!score) continue;
    if (c.pool_id) score += 2;
    if (String(c.status || '').toUpperCase() === 'ACTIVE_CUSTOMER') score += 1;
    scored.push([score, c]);
  }
  // One row per client: prefer the row with a pool / most recent.
  const seen = new Set();
  return scored.sort((a, b) => b[0] - a[0]).map(s => s[1]).filter(c => {
    const k = c.pool_id || (_jobLower_(_jobClientName_(c)) + '|' + _jobLower_(c.address));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 8);
}

function jobClientInput() { _jobRenderClientResults_(); }

function _jobRenderClientResults_() {
  const box = document.getElementById('job-client-results');
  if (!box || !_jobModal) return;
  if (_jobModal.client || _jobModal.isNew) { box.innerHTML = ''; return; }
  const q = document.getElementById('job-client-q').value.trim();
  if (_jobClientsState === 'loading' && !_jobClients) {
    box.innerHTML = '<div class="job-result-status"><span class="job-spinner"></span> Loading clients…</div>';
    return;
  }
  if (_jobClientsState === 'error' && !_jobClients) {
    box.innerHTML = `<div class="job-result-status err">${escHtml(_jobClientsErr)} <button class="job-link-btn" onclick="_jobLoadClients_(true)">Retry</button></div>`;
    return;
  }
  if (!q) {
    box.innerHTML = `<div class="job-result-status">Type a name, address, phone or pool #</div>
      <button class="job-result new" onclick="jobPickNewClient()">+ New client</button>`;
    return;
  }
  const hits = _jobSearchClients_(q);
  box.innerHTML = hits.map((c, i) => {
    const st = String(c.status || '').toUpperCase();
    const chip = c.pool_id ? '<span class="job-chip cust">Customer</span>' : st === 'LEAD' ? '<span class="job-chip lead">Lead</span>' : `<span class="job-chip">${escHtml(st.replace(/_/g, ' ').toLowerCase() || 'client')}</span>`;
    return `<button class="job-result" onclick="jobPickClient(${i})">
      <span class="job-result-name">${escHtml(_jobClientName_(c))} ${chip}</span>
      <span class="job-result-sub">${escHtml([c.address, c.city].filter(Boolean).join(', ') || c.phone || '')}${c.pool_id ? ' · ' + escHtml(c.pool_id) : ''}</span>
    </button>`;
  }).join('') + (hits.length ? '' : '<div class="job-result-status">No match.</div>') +
    `<button class="job-result new" onclick="jobPickNewClient()">+ New client${q ? ` "${escHtml(q)}"` : ''}</button>`;
  _jobModal.hits = hits;
}

function jobPickClient(i) {
  const c = (_jobModal.hits || [])[i];
  if (!c) return;
  _jobModal.client = c;
  _jobModal.isNew = false;
  _jobRenderClientPicker_();
}

function jobPickNewClient() {
  _jobModal.client = null;
  _jobModal.isNew = true;
  const q = document.getElementById('job-client-q').value.trim();
  if (q && !/\d/.test(q)) document.getElementById('job-nc-name').value = q;
  _jobRenderClientPicker_();
  setTimeout(() => document.getElementById(q && !/\d/.test(q) ? 'job-nc-address' : 'job-nc-name').focus(), 30);
}

function jobClearClient() {
  _jobModal.client = null;
  _jobModal.isNew = false;
  _jobRenderClientPicker_();
  setTimeout(() => document.getElementById('job-client-q').focus(), 30);
}

function _jobRenderClientPicker_() {
  const chip = document.getElementById('job-client-chip');
  const search = document.getElementById('job-client-search');
  const nc = document.getElementById('job-new-client');
  const c = _jobModal && _jobModal.client;
  search.style.display = c || (_jobModal && _jobModal.isNew) ? 'none' : '';
  nc.style.display = _jobModal && _jobModal.isNew ? '' : 'none';
  if (c) {
    chip.style.display = '';
    chip.innerHTML = `<div><div class="job-result-name">${escHtml(_jobClientName_(c))}</div>
      <div class="job-result-sub">${escHtml([c.address, c.city].filter(Boolean).join(', '))}${c.pool_id ? ' · ' + escHtml(c.pool_id) : ''}</div></div>
      <button class="job-link-btn" onclick="jobClearClient()">Change</button>`;
  } else if (_jobModal && _jobModal.isNew) {
    chip.style.display = '';
    chip.innerHTML = '<div class="job-result-name">New client</div><button class="job-link-btn" onclick="jobClearClient()">Search instead</button>';
  } else {
    chip.style.display = 'none';
  }
  _jobRenderClientResults_();
}

function _jobRenderDateChips_() {
  const wrap = document.getElementById('job-date-chips');
  const today = _jobToday_();
  const t = _jobSkipSunday_(today);
  const tm = _jobDateChips_().tomorrow;
  const d = _jobModal.date;
  const chip = (val, label) => `<button type="button" class="pas-day-btn${d === val ? ' active' : ''}" onclick="jobSetDate('${val}')">${label}</button>`;
  wrap.innerHTML = chip(t, t === today ? 'Today' : 'Monday') + chip(tm, 'Tomorrow') + chip(_jobAddDays_(t, 7), '+1 week') +
    `<input type="date" class="job-date-input" value="${escHtml(d)}" onchange="jobSetDate(this.value)" aria-label="Pick date">
     <span class="job-date-label">${escHtml(_jobFmtDate_(d))}</span>`;
}

function jobSetDate(v) {
  if (!v) return;
  if (_jobDow_(v) === 0) { document.getElementById('job-err').textContent = 'Jobs can\'t be scheduled on Sunday.'; _jobRenderDateChips_(); return; }
  document.getElementById('job-err').textContent = '';
  _jobModal.date = v;
  _jobRenderDateChips_();
}

function _jobRenderEstChips_() {
  document.getElementById('job-est-chips').innerHTML = JOB_EST_CHIPS.map(([v, label]) =>
    `<button type="button" class="pas-day-btn${String(_jobModal.est) === String(v) ? ' active' : ''}" onclick="jobSetEst('${v}')">${label}</button>`).join('');
}

function jobSetEst(v) { _jobModal.est = v === '' ? '' : Number(v); _jobRenderEstChips_(); }

function saveNewJob() {
  const m = _jobModal;
  if (!m) return;
  const err = document.getElementById('job-err');
  const title = document.getElementById('job-title').value.trim();
  const tech = document.getElementById('job-tech').value;
  const notes = document.getElementById('job-notes').value.trim();
  const materials = _jobParseMaterials_(document.getElementById('job-materials').value, []);
  if (!title) { err.textContent = 'Give the job a title.'; document.getElementById('job-title').focus(); return; }
  if (!m.client && !m.isNew) { err.textContent = 'Pick a client or add a new one.'; document.getElementById('job-client-q').focus(); return; }
  if (!m.date || _jobDow_(m.date) === 0) { err.textContent = 'Pick a date (Mon–Sat).'; return; }

  let client, view;
  if (m.isNew) {
    const name = document.getElementById('job-nc-name').value.trim();
    const address = document.getElementById('job-nc-address').value.trim();
    const phone = document.getElementById('job-nc-phone').value.trim();
    if (!name) { err.textContent = 'New client needs a name.'; document.getElementById('job-nc-name').focus(); return; }
    if (!address) { err.textContent = 'New client needs an address.'; document.getElementById('job-nc-address').focus(); return; }
    if (phone && phone.replace(/\D/g, '').length < 10) { err.textContent = 'Phone needs at least 10 digits.'; return; }
    client = { name, address, city: document.getElementById('job-nc-city').value.trim(), phone, gate_code: document.getElementById('job-nc-gate').value.trim() };
    view = Object.assign({ pool_id: '', quote_id: '' }, client);
  } else {
    const c = m.client;
    client = { pool_id: c.pool_id || '', quote_id: c.pool_id ? '' : (c.quote_id || '') };
    view = { pool_id: c.pool_id || '', quote_id: c.quote_id || '', name: _jobClientName_(c), phone: c.phone || '', address: c.address || '', city: c.city || '', gate_code: '' };
  }

  const id = _jobUuid_();
  const job = {
    scheduled_visit_id: id, job_group_id: id, visit_index: 1, visit_count: 1, title,
    scheduled_date: m.date, assigned_technician: tech, assigned_username: '',
    est_minutes: m.est === '' ? '' : Number(m.est), materials, materials_checked: {}, notes,
    status: 'scheduled', completed_at: '', completed_by: '', rev: 0,
    created_by: _s.username, created_at: new Date().toISOString(),
    lead_status: m.isNew ? 'pending' : '', client: view
  };
  closeNewJob();
  _jobEnqueue_({
    action: 'create_job', group_id: id, depends_on: [],
    payload: { scheduled_visit_id: id, title, scheduled_date: m.date, assigned_technician: tech, est_minutes: job.est_minutes, materials, notes, client },
    patch: { kind: 'create', job }
  });
  if (m.isNew) { try { localStorage.removeItem('mcps_crm_data'); } catch (e) {} }

  // Land on the job: same week → select its day; otherwise say where it went.
  const ws = _jobWeekStartOf_(m.date);
  const cur = typeof _weekStartForOffset_ === 'function' ? _weekStartForOffset_(_weekOffset) : '';
  if (_currentMapView === 'week' && ws === cur && typeof selectDay === 'function') {
    selectDay(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][_jobDow_(m.date)]);
  } else {
    _jobToast_(`Job added for ${_jobFmtDate_(m.date)}.`);
  }
}

// Boot: resume any queued changes from a previous visit (scoped to this user).
function _jobsBoot_() {
  if (!_s || !_s.token) return;
  _jobPumpAll_();
}
