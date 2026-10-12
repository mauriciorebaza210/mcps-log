// ══════════════════════════════════════════════════════════════════════════════
// OneTimeJobs.gs — one-off jobs on the schedule (Scheduled_Visits, visit_type=job)
//
// A job is one or more Scheduled_Visits rows sharing a job_group_id. Jobs never
// notify the customer: nothing in this file calls Comms, MailApp, GmailApp, SMS
// or sendVisitReportEmail. Rescheduling a job is always silent.
//
// Write safety (see the spec in the plan for the full reasoning):
//   * Every mutation runs under the script lock.
//   * Single-visit changes write the WHOLE row with one setValues, including the
//     op receipt (op_receipts), so a change can never land without its receipt.
//   * Creates use the browser-generated scheduled_visit_id as the receipt.
//   * Group cancels record a durable intent in Job_Ops (frozen targets) BEFORE
//     touching any visit, then write per-visit receipts op_id:visit_id. A retry
//     resumes from the frozen targets and rechecks each target's status.
//   * Ops older than the 7-day retry window are rejected; receipts live 8 days.
//
// Responses are always filtered per viewer (otjForViewer_). Cached schedule
// payloads stay viewer-neutral; redaction happens at the response edge and
// never mutates the cached objects.
// ══════════════════════════════════════════════════════════════════════════════

var OTJ_ROUTES_SS_ID = '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM';
var OTJ_CRM_SS_ID    = '1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E';
var OTJ_TZ           = 'America/Chicago';

var OTJ_JOB_COLS = [
  'job_group_id', 'job_title', 'client_name', 'phone', 'address', 'city', 'gate_code',
  'quote_id', 'assigned_username', 'est_minutes', 'materials', 'materials_checked',
  'lead_status', 'lead_attempts', 'lead_claim_id', 'lead_claimed_at', 'reopened_at',
  'op_receipts', 'rev', 'updated_at', 'updated_by'
];
var OTJ_OPS_HEADERS = [
  'op_id', 'action', 'group_id', 'target_visit_ids', 'actor',
  'client_created_at', 'intent_at', 'status', 'finished_at'
];

var OTJ_RETRY_WINDOW_MS = 7 * 24 * 3600 * 1000;
var OTJ_RECEIPT_TTL_MS  = 8 * 24 * 3600 * 1000;
var OTJ_CLAIM_STALE_MS  = 10 * 60 * 1000;
var OTJ_LEAD_MAX_ATTEMPTS = 5;
var OTJ_LEAD_RANK = { '': 0, pending: 1, failed: 2, processing: 3, done: 4 };

// ── Small helpers ─────────────────────────────────────────────────────────────

function otjKey_(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); }
function otjStr_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function otjLower_(v) { return otjStr_(v).toLowerCase(); }
function otjNowIso_() { return new Date().toISOString(); }

function otjDateStr_(v) {
  if (!v) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, OTJ_TZ, 'yyyy-MM-dd');
  var m = String(v).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function otjIso_(v) {
  if (!v) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  return String(v).trim();
}

// Free text written to the sheet: force text so "0123" or "+1 210…" survive and
// nothing can be interpreted as a formula.
function otjText_(v) {
  var s = otjStr_(v);
  return /^[=+\-@\d]/.test(s) ? "'" + s : s;
}

function otjJson_(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch (e) { return fallback; }
}

function otjWeekOf_(dateStr) {
  return dateStr && typeof getWeekStartForDate_ === 'function' ? getWeekStartForDate_(dateStr) : '';
}

function otjTodayStr_() { return Utilities.formatDate(new Date(), OTJ_TZ, 'yyyy-MM-dd'); }

function otjErr_(code, error, extra) {
  var out = { ok: false, code: code, error: error };
  if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
  return out;
}

function otjWithLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function otjViewer_(auth) {
  return {
    username: otjLower_(auth && auth.username),
    isAdmin: !!(auth && typeof jobsIsManagerOrAdmin_ === 'function' && jobsIsManagerOrAdmin_(auth))
  };
}

function otjTestFlag_(name, clientName) {
  try {
    if (String(clientName || '').indexOf('ZZTEST') !== 0) return '';
    return String(PropertiesService.getScriptProperties().getProperty(name) || '');
  } catch (e) { return ''; }
}

// ── Sheet access ──────────────────────────────────────────────────────────────

// Scheduled_Visits with every job column present. Returns { sheet, headers }.
function otjSheet_() {
  var sheet = ensureScheduledVisitsSheet_();
  var lastCol = Math.max(1, sheet.getLastColumn());
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(otjKey_);
  var missing = OTJ_JOB_COLS.filter(function (c) { return headers.indexOf(c) === -1; });
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers = headers.concat(missing);
  }
  return { sheet: sheet, headers: headers };
}

function otjOpsSheet_() {
  var ss = SpreadsheetApp.openById(OTJ_ROUTES_SS_ID);
  var sheet = ss.getSheetByName('Job_Ops');
  if (!sheet) {
    sheet = ss.insertSheet('Job_Ops');
    sheet.getRange(1, 1, 1, OTJ_OPS_HEADERS.length).setValues([OTJ_OPS_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Reads every Scheduled_Visits row as an object keyed by header.
function otjLoad_() {
  var s = otjSheet_();
  var last = s.sheet.getLastRow();
  var rows = [];
  if (last >= 2) {
    var values = s.sheet.getRange(2, 1, last - 1, s.headers.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var o = {};
      for (var c = 0; c < s.headers.length; c++) o[s.headers[c]] = values[i][c];
      rows.push({ rowNum: i + 2, o: o });
    }
  }
  var byId = {};
  rows.forEach(function (r) { var id = otjStr_(r.o.scheduled_visit_id); if (id) byId[id] = r; });
  return { sheet: s.sheet, headers: s.headers, rows: rows, byId: byId };
}

// One setValues for the whole row: the change and its receipt land together.
function otjWriteRow_(ctx, rowNum, o) {
  var arr = ctx.headers.map(function (h) { return o[h] === undefined || o[h] === null ? '' : o[h]; });
  ctx.sheet.getRange(rowNum, 1, 1, ctx.headers.length).setValues([arr]);
}

function otjAppendRow_(ctx, o) {
  var rowNum = ctx.sheet.getLastRow() + 1;
  otjWriteRow_(ctx, rowNum, o);
  var r = { rowNum: rowNum, o: o };
  ctx.rows.push(r);
  ctx.byId[otjStr_(o.scheduled_visit_id)] = r;
  return r;
}

function otjIsJob_(o) { return otjLower_(o && o.visit_type) === 'job'; }

function otjGroupRows_(ctx, groupId) {
  return ctx.rows.filter(function (r) { return otjIsJob_(r.o) && otjStr_(r.o.job_group_id) === groupId; });
}

// ── Receipts ──────────────────────────────────────────────────────────────────

function otjReceipts_(o) { return otjJson_(o.op_receipts, {}) || {}; }

function otjHasReceipt_(o, key) { return Object.prototype.hasOwnProperty.call(otjReceipts_(o), key); }

function otjAddReceipt_(o, key) {
  var rec = otjReceipts_(o);
  var cutoff = Date.now() - OTJ_RECEIPT_TTL_MS;
  Object.keys(rec).forEach(function (k) {
    var t = Date.parse(rec[k]);
    if (isFinite(t) && t < cutoff) delete rec[k];
  });
  rec[key] = otjNowIso_();
  o.op_receipts = JSON.stringify(rec);
}

function otjTouch_(o, auth) {
  o.rev = (Number(o.rev) || 0) + 1;
  o.updated_at = otjNowIso_();
  o.updated_by = otjStr_(auth && auth.username);
}

function otjCheckOp_(payload) {
  var opId = otjStr_(payload.op_id);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(opId)) return otjErr_('invalid', 'op_id required');
  var ts = Number(payload.op_created_at);
  if (!isFinite(ts) || ts <= 0) return otjErr_('invalid', 'op_created_at required');
  var now = Date.now();
  if (now - ts > OTJ_RETRY_WINDOW_MS || ts - now > 24 * 3600 * 1000) {
    return otjErr_('op_expired', 'This change is too old to apply. Refresh and try again.');
  }
  return null;
}

// ── Users / technicians ───────────────────────────────────────────────────────

function otjUsers_() {
  var sh = SpreadsheetApp.openById(AUTH_SHEET_ID).getSheetByName(USERS_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getDataRange().getValues();
  var h = data[0].map(otjKey_);
  var ui = h.indexOf('username'), ni = h.indexOf('name'), ri = h.indexOf('roles'), ai = h.indexOf('active');
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var username = otjStr_(ui !== -1 ? data[i][ui] : data[i][0]);
    if (!username) continue;
    out.push({
      username: username,
      name: otjStr_(ni !== -1 ? data[i][ni] : '') || username,
      roles: otjLower_(ri !== -1 ? data[i][ri] : ''),
      active: ai === -1 ? true : ['FALSE', 'NO', '0'].indexOf(otjStr_(data[i][ai]).toUpperCase()) === -1
    });
  }
  return out;
}

// Resolves a display name (or username) to exactly one active tech.
function otjResolveTech_(input, users) {
  var want = otjLower_(input);
  if (!want) return { ok: true, username: '', name: '' };
  var matches = (users || otjUsers_()).filter(function (u) {
    if (!u.active) return false;
    if (!/technician|lead|admin/.test(u.roles)) return false;
    return otjLower_(u.name) === want || otjLower_(u.username) === want;
  });
  if (matches.length === 1) return { ok: true, username: matches[0].username, name: matches[0].name };
  return { ok: false, error: matches.length ? 'Ambiguous technician: ' + input : 'Unknown technician: ' + input };
}

function otjUserIsAdmin_(username) {
  try {
    var u = getUserByUsername_(otjLower_(username));
    if (!u) return false;
    var roles = typeof parseRoles_ === 'function' ? parseRoles_(u.roles || u.role || '') : String(u.roles || '').split(/[,\s]+/);
    return roles.indexOf('admin') !== -1 || roles.indexOf('manager') !== -1;
  } catch (e) { return false; }
}

// ── Validation (shared by create, add-visit and update) ──────────────────────

function otjValidDate_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'Date must be yyyy-MM-dd';
  var p = s.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
  if (d.getUTCFullYear() !== p[0] || d.getUTCMonth() !== p[1] - 1 || d.getUTCDate() !== p[2]) return 'Not a real date';
  if (d.getUTCDay() === 0) return 'Jobs can\'t be scheduled on Sunday';
  var t = otjTodayStr_().split('-').map(Number);
  var today = Date.UTC(t[0], t[1] - 1, t[2], 12);
  var diff = Math.round((d.getTime() - today) / 86400000);
  if (diff < -60 || diff > 400) return 'Date is out of range';
  return '';
}

function otjNormMaterials_(list) {
  if (!Array.isArray(list)) return null;
  var out = [], seen = {};
  for (var i = 0; i < list.length; i++) {
    var it = list[i] || {};
    var id = otjStr_(it.id), text = otjStr_(it.text);
    if (!text) continue;
    if (!/^m_[A-Za-z0-9]{4,12}$/.test(id) || seen[id]) return null;
    seen[id] = true;
    out.push({ id: id, text: text });
  }
  return out;
}

// fields: subset of { title, date, est_minutes, materials, notes, gate_code }.
// Returns { ok, error, clean }.
function validateJobFields_(fields, opts) {
  var partial = !!(opts && opts.partial);
  var clean = {};
  var has = function (k) { return Object.prototype.hasOwnProperty.call(fields, k); };

  if (has('title') || !partial) {
    var title = otjStr_(fields.title);
    if (title.length < 1 || title.length > 120) return { ok: false, error: 'Title must be 1–120 characters' };
    clean.title = title;
  }
  if (has('date') || !partial) {
    var date = otjStr_(fields.date);
    var de = otjValidDate_(date);
    if (de) return { ok: false, error: de };
    clean.date = date;
  }
  if (has('est_minutes')) {
    var em = fields.est_minutes;
    if (em === '' || em === null || em === undefined) clean.est_minutes = '';
    else {
      var n = Number(em);
      if (!isFinite(n) || n < 15 || n > 720 || n % 15 !== 0) return { ok: false, error: 'Estimated time must be 15–720 minutes in 15-minute steps' };
      clean.est_minutes = n;
    }
  }
  if (has('materials')) {
    var mats = otjNormMaterials_(fields.materials);
    if (!mats) return { ok: false, error: 'Materials list is malformed' };
    if (mats.length > 30) return { ok: false, error: 'At most 30 materials' };
    for (var i = 0; i < mats.length; i++) if (mats[i].text.length > 120) return { ok: false, error: 'Each material must be 120 characters or less' };
    clean.materials = mats;
  }
  if (has('notes')) {
    var notes = otjStr_(fields.notes);
    if (notes.length > 2000) return { ok: false, error: 'Notes must be 2000 characters or less' };
    clean.notes = notes;
  }
  if (has('gate_code')) {
    var gc = otjStr_(fields.gate_code);
    if (gc.length > 120) return { ok: false, error: 'Gate code must be 120 characters or less' };
    clean.gate_code = gc;
  }
  return { ok: true, clean: clean };
}

// ── Client lookups (Routes + Quotes) ──────────────────────────────────────────

function otjQuoteName_(o) {
  return otjStr_(o.client_name) || [otjStr_(o.first_name), otjStr_(o.last_name)].filter(Boolean).join(' ').trim() || otjStr_(o.customer_name);
}

// routesValues / quotesValues: 2D arrays including the header row (or null).
function otjBuildLookups_(routesValues, quotesValues) {
  var L = { routesByPool: {}, quotesByPool: {}, quotesById: {} };
  if (routesValues && routesValues.length > 1) {
    var rh = routesValues[0].map(otjKey_);
    var rc = function (row, n) { var i = rh.indexOf(n); return i === -1 ? '' : otjStr_(row[i]); };
    for (var i = 1; i < routesValues.length; i++) {
      var pid = rc(routesValues[i], 'pool_id');
      if (!pid) continue;
      L.routesByPool[pid] = {
        name: rc(routesValues[i], 'customer_name'), address: rc(routesValues[i], 'address'),
        city: rc(routesValues[i], 'city'), gate_code: rc(routesValues[i], 'gate_code'), phone: rc(routesValues[i], 'phone')
      };
    }
  }
  if (quotesValues && quotesValues.length > 1) {
    var qh = quotesValues[0].map(otjKey_);
    for (var j = 1; j < quotesValues.length; j++) {
      var o = {};
      for (var c = 0; c < qh.length; c++) o[qh[c]] = quotesValues[j][c];
      var info = {
        name: otjQuoteName_(o), phone: otjStr_(o.phone), address: otjStr_(o.address || o.service_address),
        city: otjStr_(o.city), gate_code: otjStr_(o.gate_code), job_group_id: otjStr_(o.job_group_id),
        quote_id: otjStr_(o.quote_id), pool_id: otjStr_(o.pool_id)
      };
      if (info.pool_id && !L.quotesByPool[info.pool_id]) L.quotesByPool[info.pool_id] = info;
      if (info.quote_id) L.quotesById[info.quote_id] = info;
    }
  }
  return L;
}

function otjLoadLookups_(needed) {
  if (!needed) return otjBuildLookups_(null, null);
  var routes = null, quotes = null;
  try {
    var rs = SpreadsheetApp.openById(OTJ_ROUTES_SS_ID).getSheetByName('Routes');
    if (rs && rs.getLastRow() > 1) routes = rs.getDataRange().getValues();
  } catch (e) { Logger.log('otjLoadLookups_ Routes: ' + e); }
  try {
    var qs = SpreadsheetApp.openById(OTJ_CRM_SS_ID).getSheetByName('Quotes');
    if (qs && qs.getLastRow() > 1) quotes = qs.getDataRange().getValues();
  } catch (e2) { Logger.log('otjLoadLookups_ Quotes: ' + e2); }
  return otjBuildLookups_(routes, quotes);
}

// ── Shape ─────────────────────────────────────────────────────────────────────

// Group numbering across ALL rows of each group; cancelled visits don't count.
function otjGroupStats_(rowObjs) {
  var groups = {};
  rowObjs.forEach(function (o) {
    if (!otjIsJob_(o)) return;
    var g = otjStr_(o.job_group_id);
    if (!g || otjLower_(o.status) === 'cancelled') return;
    (groups[g] = groups[g] || []).push(o);
  });
  var stats = {};
  Object.keys(groups).forEach(function (g) {
    var list = groups[g].slice().sort(otjVisitOrder_);
    list.forEach(function (o, i) { stats[otjStr_(o.scheduled_visit_id)] = { index: i + 1, count: list.length }; });
  });
  return stats;
}

function otjVisitOrder_(a, b) {
  var da = otjDateStr_(a.scheduled_date), db = otjDateStr_(b.scheduled_date);
  if (da !== db) return da < db ? -1 : 1;
  var ca = otjIso_(a.created_at), cb = otjIso_(b.created_at);
  if (ca !== cb) return ca < cb ? -1 : 1;
  var ia = otjStr_(a.scheduled_visit_id), ib = otjStr_(b.scheduled_visit_id);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

function jobShape_(o, lookups, stats) {
  lookups = lookups || otjBuildLookups_(null, null);
  var id = otjStr_(o.scheduled_visit_id);
  var poolId = otjStr_(o.pool_id), quoteId = otjStr_(o.quote_id);
  var srcs = [
    { name: otjStr_(o.client_name) || otjStr_(o.customer_name), phone: otjStr_(o.phone), address: otjStr_(o.address), city: otjStr_(o.city), gate_code: otjStr_(o.gate_code) },
    poolId ? lookups.routesByPool[poolId] : null,
    poolId ? lookups.quotesByPool[poolId] : null,
    quoteId ? lookups.quotesById[quoteId] : null
  ];
  var pick = function (f) {
    for (var i = 0; i < srcs.length; i++) if (srcs[i] && srcs[i][f]) return srcs[i][f];
    return '';
  };
  var st = (stats && stats[id]) || { index: 1, count: 1 };
  var est = otjStr_(o.est_minutes);
  return {
    scheduled_visit_id: id,
    job_group_id: otjStr_(o.job_group_id) || id,
    visit_index: st.index,
    visit_count: st.count,
    title: otjStr_(o.job_title) || 'Job',
    scheduled_date: otjDateStr_(o.scheduled_date),
    assigned_technician: otjStr_(o.assigned_technician),
    assigned_username: otjStr_(o.assigned_username),
    est_minutes: est ? Number(est) : '',
    materials: otjNormMaterials_(otjJson_(o.materials, [])) || [],
    materials_checked: otjJson_(o.materials_checked, {}) || {},
    notes: otjStr_(o.notes),
    status: otjLower_(o.status) || 'scheduled',
    completed_at: otjIso_(o.completed_at),
    completed_by: otjStr_(o.completed_by),
    rev: Number(o.rev) || 0,
    created_by: otjStr_(o.created_by),
    created_at: otjIso_(o.created_at),
    lead_status: otjLower_(o.lead_status),
    client: {
      pool_id: poolId, quote_id: quoteId,
      name: pick('name'), phone: pick('phone'), address: pick('address'),
      city: pick('city'), gate_code: pick('gate_code')
    }
  };
}

// ── Viewer filtering (never mutates its input) ────────────────────────────────

function otjCanSeeFull_(job, viewer) {
  if (!viewer) return false;
  if (viewer.isAdmin) return true;
  return !!viewer.username && otjLower_(job && job.assigned_username) === viewer.username;
}

function otjForViewer_(job, viewer) {
  if (!job || otjCanSeeFull_(job, viewer)) return job;
  return {
    scheduled_visit_id: job.scheduled_visit_id, job_group_id: job.job_group_id,
    visit_index: job.visit_index, visit_count: job.visit_count, title: job.title,
    scheduled_date: job.scheduled_date, assigned_technician: job.assigned_technician,
    status: job.status, restricted: true
  };
}

// A route/visit stop object (or calendar visit entry) carrying `_job` or `job`.
function otjRedactStop_(stop, viewer) {
  var job = stop && (stop._job || stop.job);
  if (!job || otjCanSeeFull_(job, viewer)) return stop;
  var r = otjForViewer_(job, viewer);
  var out = {
    pool_id: '', customer_name: 'Job', address: '', city: '', service: 'One-time job',
    service_type: 'One-time job', maps_url: '', lat: '', lng: '', gate_code: '', notes: '',
    phone: '', operator: stop.operator || stop.assigned_technician || '',
    assigned_technician: stop.assigned_technician || stop.operator || '', pinned: false,
    visit_type: 'job', scheduled_date: stop.scheduled_date || '', status: stop.status || '',
    _visit_type: 'job', _is_scheduled_visit: true,
    _scheduled_visit_id: stop._scheduled_visit_id || stop.scheduled_visit_id || '',
    scheduled_visit_id: stop.scheduled_visit_id || stop._scheduled_visit_id || '',
    _scheduled_visit_status: stop._scheduled_visit_status || stop.status || ''
  };
  if (stop._job) out._job = r; else out.job = r;
  return out;
}

// Route payload { days: [{ pools }] } → redacted COPY for non-admin viewers.
function otjRedactRoutePayload_(payload, viewer) {
  if (!payload || !payload.days || (viewer && viewer.isAdmin)) return payload;
  var out = {};
  Object.keys(payload).forEach(function (k) { out[k] = payload[k]; });
  out.days = payload.days.map(function (d) {
    var pools = (d.pools || []).map(function (p) { return otjRedactStop_(p, viewer); });
    var changed = pools.some(function (p, i) { return p !== d.pools[i]; });
    if (!changed) return d;
    var nd = {};
    Object.keys(d).forEach(function (k) { nd[k] = d[k]; });
    nd.pools = pools;
    if (typeof buildMapsUrl_ === 'function') nd.maps_url = buildMapsUrl_(pools.filter(function (p) { return p.address; }));
    return nd;
  });
  return out;
}

// ── Group response ────────────────────────────────────────────────────────────

function otjGroupJobs_(ctx, groupId, viewer, lookups) {
  var rows = otjGroupRows_(ctx, groupId).map(function (r) { return r.o; });
  var stats = otjGroupStats_(rows);
  if (!lookups) {
    var needs = rows.some(function (o) { return otjStr_(o.pool_id) || otjStr_(o.quote_id); });
    lookups = otjLoadLookups_(needs);
  }
  return rows.slice().sort(otjVisitOrder_).map(function (o) {
    return otjForViewer_(jobShape_(o, lookups, stats), viewer);
  });
}

function otjBustGroup_(ctx, groupId, extraDates, usernames) {
  try {
    var cache = CacheService.getScriptCache();
    var weeks = {};
    otjGroupRows_(ctx, groupId).forEach(function (r) {
      var w = otjWeekOf_(otjDateStr_(r.o.scheduled_date));
      if (w) weeks[w] = true;
      if (r.o.assigned_username) (usernames = usernames || []).push(r.o.assigned_username);
    });
    (extraDates || []).forEach(function (d) { var w = otjWeekOf_(d); if (w) weeks[w] = true; });
    var keys = Object.keys(weeks).map(function (w) { return 'rd:' + w; });
    if (keys.length) cache.removeAll(keys);
  } catch (e) { Logger.log('otjBustGroup_: ' + e); }
  try { if (typeof jobsBustCache_ === 'function') jobsBustCache_(usernames || []); } catch (e2) {}
}

function otjGroupState_(rows) {
  var best = '';
  rows.forEach(function (r) {
    var s = otjLower_(r.o.lead_status);
    if ((OTJ_LEAD_RANK[s] || 0) > (OTJ_LEAD_RANK[best] || 0)) best = s;
  });
  return best;
}

function otjLeadSource_(rows) {
  var best = null;
  rows.forEach(function (r) {
    if (!best || (OTJ_LEAD_RANK[otjLower_(r.o.lead_status)] || 0) > (OTJ_LEAD_RANK[otjLower_(best.o.lead_status)] || 0)) best = r;
  });
  return best;
}

// ── Actions ───────────────────────────────────────────────────────────────────

function handleCreateJob_(payload, auth) {
  var viewer = otjViewer_(auth);
  if (!viewer.isAdmin) return otjErr_('forbidden', 'Only admins can create jobs.');
  var opErr = otjCheckOp_(payload);
  if (opErr) return opErr;
  var id = otjStr_(payload.scheduled_visit_id);
  if (!/^[A-Za-z0-9-]{16,64}$/.test(id)) return otjErr_('invalid', 'scheduled_visit_id required');

  var v = validateJobFields_({
    title: payload.title, date: payload.scheduled_date, est_minutes: payload.est_minutes,
    materials: payload.materials || [], notes: payload.notes || ''
  }, { partial: false });
  if (!v.ok) return otjErr_('invalid', v.error);

  var tech = otjResolveTech_(payload.assigned_technician);
  if (!tech.ok) return otjErr_('invalid', tech.error);

  var client = payload.client || {};
  var poolId = otjStr_(client.pool_id), quoteId = otjStr_(client.quote_id);
  var isNew = !poolId && !quoteId;
  var lookups = otjLoadLookups_(!isNew);
  var row = {
    scheduled_visit_id: id, pool_id: poolId, service_type: 'One-time job', visit_type: 'job',
    scheduled_date: v.clean.date, assigned_technician: tech.name, assigned_username: tech.username,
    status: 'scheduled', notes: otjText_(v.clean.notes), created_at: otjNowIso_(),
    created_by: otjStr_(auth.username), job_group_id: id, job_title: otjText_(v.clean.title),
    quote_id: quoteId, est_minutes: v.clean.est_minutes === undefined ? '' : v.clean.est_minutes,
    materials: JSON.stringify(v.clean.materials || []), materials_checked: '{}',
    lead_status: '', lead_attempts: 0, rev: 1, updated_at: otjNowIso_(), updated_by: otjStr_(auth.username)
  };

  if (isNew) {
    var name = otjStr_(client.name), address = otjStr_(client.address), phone = otjStr_(client.phone);
    if (name.length < 1 || name.length > 80) return otjErr_('invalid', 'Client name is required');
    if (address.length < 1 || address.length > 200) return otjErr_('invalid', 'Client address is required');
    if (phone && phone.replace(/\D/g, '').length < 10) return otjErr_('invalid', 'Phone needs at least 10 digits');
    var gc = otjStr_(client.gate_code);
    if (gc.length > 120) return otjErr_('invalid', 'Gate code must be 120 characters or less');
    row.client_name = otjText_(name); row.customer_name = otjText_(name);
    row.address = otjText_(address); row.city = otjText_(client.city);
    row.phone = otjText_(phone); row.gate_code = otjText_(gc);
    row.lead_status = 'pending';
  } else {
    var known = (poolId && (lookups.routesByPool[poolId] || lookups.quotesByPool[poolId])) ||
                (quoteId && lookups.quotesById[quoteId]);
    if (!known) return otjErr_('invalid', 'Client not found. Search again or add them as a new client.');
    if (!quoteId && poolId && lookups.quotesByPool[poolId]) row.quote_id = lookups.quotesByPool[poolId].quote_id || '';
    row.client_name = otjText_(known.name); row.customer_name = otjText_(known.name);
  }

  var result = otjWithLock_(function () {
    var ctx = otjLoad_();
    var existing = ctx.byId[id];
    if (existing) {
      if (!otjIsJob_(existing.o)) return { res: otjErr_('invalid', 'Visit id already used') };
      return { ctx: ctx, gid: otjStr_(existing.o.job_group_id), dup: true };
    }
    otjAppendRow_(ctx, row);
    return { ctx: ctx, gid: id };
  });
  if (result.res) return result.res;

  otjBustGroup_(result.ctx, result.gid, [], [tech.username]);
  if (isNew && !result.dup) kickJobLeadSweep_(row.client_name);
  return { ok: true, duplicate: !!result.dup, jobs: otjGroupJobs_(result.ctx, result.gid, viewer, lookups) };
}

function handleAddJobVisit_(payload, auth) {
  var viewer = otjViewer_(auth);
  if (!viewer.isAdmin) return otjErr_('forbidden', 'Only admins can add visits.');
  var opErr = otjCheckOp_(payload);
  if (opErr) return opErr;
  var id = otjStr_(payload.scheduled_visit_id), srcId = otjStr_(payload.source_visit_id);
  if (!/^[A-Za-z0-9-]{16,64}$/.test(id) || !srcId) return otjErr_('invalid', 'scheduled_visit_id and source_visit_id required');
  var v = validateJobFields_({ date: payload.scheduled_date }, { partial: true });
  if (!v.ok) return otjErr_('invalid', v.error);
  if (!v.clean.date) return otjErr_('invalid', 'Date required');
  var tech = otjResolveTech_(payload.assigned_technician);
  if (!tech.ok) return otjErr_('invalid', tech.error);

  var result = otjWithLock_(function () {
    var ctx = otjLoad_();
    var src = ctx.byId[srcId];
    if (!src || !otjIsJob_(src.o)) return { res: otjErr_('not_found', 'Job not found') };
    var gid = otjStr_(src.o.job_group_id) || srcId;
    var existing = ctx.byId[id];
    if (existing) {
      if (!otjIsJob_(existing.o) || otjStr_(existing.o.job_group_id) !== gid) return { res: otjErr_('invalid', 'Visit id already used') };
      return { ctx: ctx, gid: gid, dup: true };
    }
    var group = otjGroupRows_(ctx, gid);
    var lead = otjLeadSource_(group) || src;
    var s = src.o;
    var row = {
      scheduled_visit_id: id, pool_id: s.pool_id, customer_name: s.customer_name, service_type: 'One-time job',
      visit_type: 'job', scheduled_date: v.clean.date, assigned_technician: tech.name, assigned_username: tech.username,
      status: 'scheduled', notes: '', created_at: otjNowIso_(), created_by: otjStr_(auth.username),
      job_group_id: gid, job_title: s.job_title, client_name: s.client_name, phone: s.phone, address: s.address,
      city: s.city, gate_code: s.gate_code, quote_id: lead.o.quote_id || s.quote_id, est_minutes: s.est_minutes,
      materials: s.materials, materials_checked: '{}',
      // Copy the group's lead state exactly so a new row never re-opens claim eligibility.
      lead_status: lead.o.lead_status, lead_attempts: lead.o.lead_attempts, lead_claim_id: lead.o.lead_claim_id,
      lead_claimed_at: lead.o.lead_claimed_at, rev: 1, updated_at: otjNowIso_(), updated_by: otjStr_(auth.username)
    };
    ['customer_name', 'job_title', 'client_name', 'phone', 'address', 'city', 'gate_code'].forEach(function (k) {
      row[k] = otjText_(row[k]);
    });
    otjAppendRow_(ctx, row);
    return { ctx: ctx, gid: gid };
  });
  if (result.res) return result.res;
  otjBustGroup_(result.ctx, result.gid, [], [tech.username]);
  return { ok: true, duplicate: !!result.dup, jobs: otjGroupJobs_(result.ctx, result.gid, viewer) };
}

function handleGetJobGroup_(payload, auth) {
  var viewer = otjViewer_(auth);
  var id = otjStr_(payload.scheduled_visit_id);
  var ctx = otjLoad_();
  var r = ctx.byId[id];
  if (!r || !otjIsJob_(r.o)) return otjErr_('not_found', 'Job not found');
  var gid = otjStr_(r.o.job_group_id) || id;
  var group = otjGroupRows_(ctx, gid);
  if (!viewer.isAdmin) {
    var mine = group.some(function (g) { return otjLower_(g.o.assigned_username) === viewer.username && viewer.username; });
    if (!mine) return otjErr_('forbidden', 'Not your job');
  }
  var cancelled = group.filter(function (g) { return otjLower_(g.o.status) === 'cancelled'; }).length;
  return { ok: true, jobs: otjGroupJobs_(ctx, gid, viewer), cancelled_count: cancelled };
}

// Current client-facing value of an editable field, for from/to comparison.
function otjFieldValue_(o, field, lookups) {
  switch (field) {
    case 'scheduled_date': return otjDateStr_(o.scheduled_date);
    case 'assigned_technician': return otjStr_(o.assigned_technician);
    case 'notes': return otjStr_(o.notes);
    case 'job_title': return otjStr_(o.job_title);
    case 'est_minutes': return otjStr_(o.est_minutes);
    case 'materials': return JSON.stringify(otjNormMaterials_(otjJson_(o.materials, [])) || []);
    case 'gate_code': return jobShape_(o, lookups, null).client.gate_code;
  }
  return null;
}

function otjClientValue_(field, v) {
  if (field === 'materials') return JSON.stringify(otjNormMaterials_(Array.isArray(v) ? v : otjJson_(v, [])) || []);
  if (field === 'est_minutes') return v === null || v === undefined ? '' : String(v);
  return otjStr_(v);
}

var OTJ_EDITABLE = ['scheduled_date', 'assigned_technician', 'notes', 'job_title', 'est_minutes', 'materials', 'gate_code'];

function handleUpdateJob_(payload, auth) {
  var viewer = otjViewer_(auth);
  if (!viewer.isAdmin) return otjErr_('forbidden', 'Only admins can edit jobs.');
  var opErr = otjCheckOp_(payload);
  if (opErr) return opErr;
  var id = otjStr_(payload.scheduled_visit_id);
  var changes = payload.changes || {};
  var fields = Object.keys(changes);
  if (!fields.length) return otjErr_('invalid', 'No changes');
  for (var i = 0; i < fields.length; i++) {
    if (OTJ_EDITABLE.indexOf(fields[i]) === -1) return otjErr_('invalid', 'Field not editable: ' + fields[i]);
    var ch = changes[fields[i]];
    if (!ch || typeof ch !== 'object' || !('from' in ch) || !('to' in ch)) return otjErr_('invalid', 'Each change needs from and to');
  }

  // Validate the target values (same rules as create).
  var vf = {};
  if (changes.scheduled_date) vf.date = changes.scheduled_date.to;
  if (changes.job_title) vf.title = changes.job_title.to;
  if (changes.est_minutes) vf.est_minutes = changes.est_minutes.to;
  if (changes.materials) vf.materials = changes.materials.to;
  if (changes.notes) vf.notes = changes.notes.to;
  if (changes.gate_code) vf.gate_code = changes.gate_code.to;
  var v = validateJobFields_(vf, { partial: true });
  if (!v.ok) return otjErr_('invalid', v.error);
  var tech = null;
  if (changes.assigned_technician) {
    tech = otjResolveTech_(changes.assigned_technician.to);
    if (!tech.ok) return otjErr_('invalid', tech.error);
  }

  var oldDate = '';
  var result = otjWithLock_(function () {
    var ctx = otjLoad_();
    var r = ctx.byId[id];
    if (!r || !otjIsJob_(r.o)) return { res: otjErr_('not_found', 'Job not found') };
    var gid = otjStr_(r.o.job_group_id) || id;
    var o = r.o;
    if (otjHasReceipt_(o, payload.op_id)) return { ctx: ctx, gid: gid, dup: true };

    var lookups = otjLoadLookups_(!!changes.gate_code && (otjStr_(o.pool_id) || otjStr_(o.quote_id)));
    var status = otjLower_(o.status) || 'scheduled';
    if (status !== 'scheduled' && fields.some(function (f) { return f !== 'notes'; })) {
      return { ctx: ctx, gid: gid, conflict: 'Only notes can change on a ' + status + ' visit' };
    }
    for (var j = 0; j < fields.length; j++) {
      var f = fields[j];
      if (otjFieldValue_(o, f, lookups) !== otjClientValue_(f, changes[f].from)) {
        return { ctx: ctx, gid: gid, conflict: 'Someone else changed this job. Showing the latest.' };
      }
    }

    oldDate = otjDateStr_(o.scheduled_date);
    if (changes.scheduled_date) o.scheduled_date = v.clean.date;
    if (changes.job_title) o.job_title = otjText_(v.clean.title);
    if (changes.notes) o.notes = otjText_(v.clean.notes);
    if (changes.est_minutes) o.est_minutes = v.clean.est_minutes;
    if (changes.gate_code) o.gate_code = otjText_(v.clean.gate_code);
    if (changes.materials) {
      o.materials = JSON.stringify(v.clean.materials);
      var checked = otjJson_(o.materials_checked, {}) || {};
      var keep = {};
      v.clean.materials.forEach(function (m) { if (checked[m.id]) keep[m.id] = checked[m.id]; });
      o.materials_checked = JSON.stringify(keep);
    }
    if (tech) { o.assigned_technician = tech.name; o.assigned_username = tech.username; }
    otjAddReceipt_(o, payload.op_id);
    otjTouch_(o, auth);
    otjWriteRow_(ctx, r.rowNum, o);
    return { ctx: ctx, gid: gid, poolId: otjStr_(o.pool_id) };
  });
  if (result.res) return result.res;
  if (result.conflict) {
    return otjErr_('conflict', result.conflict, { jobs: otjGroupJobs_(result.ctx, result.gid, viewer) });
  }
  // "Save once": a gate code edited on a pool job also updates the client record.
  if (!result.dup && changes.gate_code && result.poolId && typeof saveGateCode_ === 'function') {
    try { saveGateCode_(result.poolId, v.clean.gate_code); } catch (e) { Logger.log('update_job gate sync: ' + e); }
  }
  otjBustGroup_(result.ctx, result.gid, oldDate ? [oldDate] : [], tech ? [tech.username] : []);
  return { ok: true, duplicate: !!result.dup, jobs: otjGroupJobs_(result.ctx, result.gid, viewer) };
}

function handleSetJobStatus_(payload, auth) {
  var viewer = otjViewer_(auth);
  var opErr = otjCheckOp_(payload);
  if (opErr) return opErr;
  var id = otjStr_(payload.scheduled_visit_id);
  var to = otjLower_(payload.to), from = otjLower_(payload.from);
  var scope = otjLower_(payload.scope) || 'visit';

  if (scope === 'group') {
    if (!viewer.isAdmin) return otjErr_('forbidden', 'Only admins can cancel jobs.');
    if (to !== 'cancelled') return otjErr_('invalid', 'Group scope only supports cancel');
    return otjCancelGroup_(payload, auth, viewer, id);
  }
  if (['completed', 'scheduled', 'cancelled'].indexOf(to) === -1) return otjErr_('invalid', 'Bad status');

  var result = otjWithLock_(function () {
    var ctx = otjLoad_();
    var r = ctx.byId[id];
    if (!r || !otjIsJob_(r.o)) return { res: otjErr_('not_found', 'Job not found') };
    var o = r.o, gid = otjStr_(o.job_group_id) || id;
    var assigned = !!viewer.username && otjLower_(o.assigned_username) === viewer.username;
    // Authorization before any dedupe return.
    if (to === 'completed' && !viewer.isAdmin && !assigned) return { res: otjErr_('forbidden', 'Not your job') };
    if (to !== 'completed' && !viewer.isAdmin) return { res: otjErr_('forbidden', 'Only admins can do that') };
    if (otjHasReceipt_(o, payload.op_id)) return { ctx: ctx, gid: gid, dup: true };

    var cur = otjLower_(o.status) || 'scheduled';
    if (cur !== from) return { ctx: ctx, gid: gid, conflict: 'This visit changed. Showing the latest.' };
    var okMove = (cur === 'scheduled' && (to === 'completed' || to === 'cancelled')) || (cur === 'completed' && to === 'scheduled');
    if (!okMove) return { ctx: ctx, gid: gid, conflict: 'Can\'t change a ' + cur + ' visit to ' + to };

    o.status = to;
    if (to === 'completed') { o.completed_at = otjNowIso_(); o.completed_by = otjStr_(auth.username); }
    if (cur === 'completed' && to === 'scheduled') { o.completed_at = ''; o.completed_by = ''; o.reopened_at = otjNowIso_(); }
    otjAddReceipt_(o, payload.op_id);
    otjTouch_(o, auth);
    otjWriteRow_(ctx, r.rowNum, o);
    return { ctx: ctx, gid: gid };
  });
  if (result.res) return result.res;
  if (result.conflict) return otjErr_('conflict', result.conflict, { jobs: otjGroupJobs_(result.ctx, result.gid, viewer) });
  otjBustGroup_(result.ctx, result.gid, [], []);
  return { ok: true, duplicate: !!result.dup, jobs: otjGroupJobs_(result.ctx, result.gid, viewer) };
}

// Cancel every scheduled visit of the group. Durable intent with frozen targets,
// then per-visit receipts; a retry resumes and rechecks each target's status.
function otjCancelGroup_(payload, auth, viewer, anchorId) {
  var opId = otjStr_(payload.op_id);
  var result = otjWithLock_(function () {
    var ctx = otjLoad_();
    var anchor = ctx.byId[anchorId];
    if (!anchor || !otjIsJob_(anchor.o)) return { res: otjErr_('not_found', 'Job not found') };
    var gid = otjStr_(anchor.o.job_group_id) || anchorId;

    var ops = otjOpsSheet_();
    var opsVals = ops.getLastRow() > 1 ? ops.getRange(2, 1, ops.getLastRow() - 1, OTJ_OPS_HEADERS.length).getValues() : [];
    var intentRow = -1, targets = null, intentStatus = '';
    for (var i = 0; i < opsVals.length; i++) {
      if (otjStr_(opsVals[i][0]) === opId) {
        if (otjStr_(opsVals[i][2]) !== gid) return { res: otjErr_('invalid', 'op_id belongs to another job') };
        intentRow = i + 2;
        targets = otjJson_(opsVals[i][3], []);
        intentStatus = otjStr_(opsVals[i][7]);
        break;
      }
    }
    if (intentStatus === 'done') return { ctx: ctx, gid: gid, dup: true };
    if (intentRow === -1) {
      targets = otjGroupRows_(ctx, gid)
        .filter(function (r) { return (otjLower_(r.o.status) || 'scheduled') === 'scheduled'; })
        .map(function (r) { return otjStr_(r.o.scheduled_visit_id); });
      intentRow = ops.getLastRow() + 1;
      ops.getRange(intentRow, 1, 1, OTJ_OPS_HEADERS.length).setValues([[
        opId, 'cancel_group', gid, JSON.stringify(targets), otjStr_(auth.username),
        String(payload.op_created_at || ''), otjNowIso_(), 'pending', ''
      ]]);
    }

    var abort = otjTestFlag_('JOB_OPS_TEST_ABORT', anchor.o.client_name);
    var written = 0;
    for (var t = 0; t < targets.length; t++) {
      var r = ctx.byId[targets[t]];
      if (!r) continue;
      var key = opId + ':' + targets[t];
      if (otjHasReceipt_(r.o, key)) continue;
      // Recheck status: a target completed since the interruption stays completed;
      // it only gets the receipt so it counts as resolved.
      if ((otjLower_(r.o.status) || 'scheduled') === 'scheduled') {
        r.o.status = 'cancelled';
        otjTouch_(r.o, auth);
      }
      otjAddReceipt_(r.o, key);
      otjWriteRow_(ctx, r.rowNum, r.o);
      written++;
      if (abort === 'after_row' && written === 1) throw new Error('JOB_OPS_TEST_ABORT after_row');
    }
    ops.getRange(intentRow, 8, 1, 2).setValues([['done', otjNowIso_()]]);
    return { ctx: ctx, gid: gid };
  });
  if (result.res) return result.res;
  otjBustGroup_(result.ctx, result.gid, [], []);
  return { ok: true, duplicate: !!result.dup, jobs: otjGroupJobs_(result.ctx, result.gid, viewer) };
}

function handleToggleJobMaterial_(payload, auth) {
  var viewer = otjViewer_(auth);
  var opErr = otjCheckOp_(payload);
  if (opErr) return opErr;
  var id = otjStr_(payload.scheduled_visit_id), itemId = otjStr_(payload.item_id);
  var checked = payload.checked === true || payload.checked === 'true';
  var from = payload.from === true || payload.from === 'true';

  var result = otjWithLock_(function () {
    var ctx = otjLoad_();
    var r = ctx.byId[id];
    if (!r || !otjIsJob_(r.o)) return { res: otjErr_('not_found', 'Job not found') };
    var o = r.o, gid = otjStr_(o.job_group_id) || id;
    var assigned = !!viewer.username && otjLower_(o.assigned_username) === viewer.username;
    if (!viewer.isAdmin && !assigned) return { res: otjErr_('forbidden', 'Not your job') };
    if (otjHasReceipt_(o, payload.op_id)) return { ctx: ctx, gid: gid, dup: true };

    var mats = otjNormMaterials_(otjJson_(o.materials, [])) || [];
    if (!mats.some(function (m) { return m.id === itemId; })) return { ctx: ctx, gid: gid, invalid: 'That material is no longer on the list' };
    if ((otjLower_(o.status) || 'scheduled') !== 'scheduled') return { ctx: ctx, gid: gid, invalid: 'Materials are locked once a visit is done' };
    var map = otjJson_(o.materials_checked, {}) || {};
    if (!!map[itemId] !== from) return { ctx: ctx, gid: gid, conflict: 'This checklist changed. Showing the latest.' };
    if (checked) { if (!map[itemId]) map[itemId] = { by: otjStr_(auth.username), at: otjNowIso_() }; }
    else delete map[itemId];
    o.materials_checked = JSON.stringify(map);
    otjAddReceipt_(o, payload.op_id);
    otjTouch_(o, auth);
    otjWriteRow_(ctx, r.rowNum, o);
    return { ctx: ctx, gid: gid };
  });
  if (result.res) return result.res;
  if (result.invalid) return otjErr_('invalid', result.invalid, { jobs: otjGroupJobs_(result.ctx, result.gid, viewer) });
  if (result.conflict) return otjErr_('conflict', result.conflict, { jobs: otjGroupJobs_(result.ctx, result.gid, viewer) });
  otjBustGroup_(result.ctx, result.gid, [], []);
  return { ok: true, duplicate: !!result.dup, jobs: otjGroupJobs_(result.ctx, result.gid, viewer) };
}

function handleRetryJobLead_(payload, auth) {
  var viewer = otjViewer_(auth);
  if (!viewer.isAdmin) return otjErr_('forbidden', 'Only admins can retry.');
  var id = otjStr_(payload.scheduled_visit_id);
  var result = otjWithLock_(function () {
    var ctx = otjLoad_();
    var r = ctx.byId[id];
    if (!r || !otjIsJob_(r.o)) return { res: otjErr_('not_found', 'Job not found') };
    var gid = otjStr_(r.o.job_group_id) || id;
    var group = otjGroupRows_(ctx, gid);
    var state = otjGroupState_(group);
    if (!state) return { res: otjErr_('invalid', 'This job has no lead to create') };
    if (state === 'done') return { ctx: ctx, gid: gid };
    var claimedAt = Date.parse(otjIso_(otjLeadSource_(group).o.lead_claimed_at));
    if (state === 'processing' && isFinite(claimedAt) && Date.now() - claimedAt < OTJ_CLAIM_STALE_MS) return { ctx: ctx, gid: gid };
    group.forEach(function (g) {
      g.o.lead_status = 'pending'; g.o.lead_attempts = 0; g.o.lead_claim_id = ''; g.o.lead_claimed_at = '';
      otjWriteRow_(ctx, g.rowNum, g.o);
    });
    return { ctx: ctx, gid: gid, kick: true, name: r.o.client_name };
  });
  if (result.res) return result.res;
  if (result.kick) kickJobLeadSweep_(result.name);
  return { ok: true, jobs: otjGroupJobs_(result.ctx, result.gid, viewer) };
}

// ── Background lead creation ──────────────────────────────────────────────────

function kickJobLeadSweep_(clientName) {
  try {
    if (otjTestFlag_('JOB_LEAD_TEST_FAIL', clientName) === 'trigger') throw new Error('JOB_LEAD_TEST_FAIL trigger');
    ensureJobLeadGuard_();
    var queued = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'processPendingJobLeads_'; });
    if (!queued) ScriptApp.newTrigger('processPendingJobLeads_').timeBased().after(5000).create();
  } catch (e) {
    // Never fails the save: the hourly guard (or a manual Retry) recovers.
    Logger.log('kickJobLeadSweep_ failed (recoverable): ' + e);
  }
}

function ensureJobLeadGuard_() {
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'jobLeadSweepGuard_'; });
  if (!has) ScriptApp.newTrigger('jobLeadSweepGuard_').timeBased().everyHours(1).create();
}

function jobLeadSweepGuard_() {
  try { otjPruneOps_(); } catch (e) { Logger.log('otjPruneOps_: ' + e); }
  processPendingJobLeads_();
}

function otjPruneOps_() {
  otjWithLock_(function () {
    var ops = otjOpsSheet_();
    var last = ops.getLastRow();
    if (last < 2) return;
    var vals = ops.getRange(2, 1, last - 1, OTJ_OPS_HEADERS.length).getValues();
    var cutoff = Date.now() - OTJ_RECEIPT_TTL_MS;
    var keep = vals.filter(function (r) { var t = Date.parse(otjIso_(r[6])); return !isFinite(t) || t >= cutoff; });
    if (keep.length === vals.length) return;
    ops.getRange(2, 1, last - 1, OTJ_OPS_HEADERS.length).clearContent();
    if (keep.length) ops.getRange(2, 1, keep.length, OTJ_OPS_HEADERS.length).setValues(keep);
  });
}

function otjQuotesIndex_() {
  var sheet = getCrmSheet_();
  var last = sheet.getLastRow();
  var idx = {};
  if (last < 2) return idx;
  var vals = sheet.getRange(1, 1, last, sheet.getLastColumn()).getValues();
  var h = vals[0].map(otjKey_);
  var qi = h.indexOf('quote_id'), gi = h.indexOf('job_group_id');
  if (qi === -1) return idx;
  for (var i = 1; i < vals.length; i++) {
    var q = otjStr_(vals[i][qi]);
    if (q) idx[q] = gi === -1 ? '' : otjStr_(vals[i][gi]);
  }
  return idx;
}

function otjLeadQuoteId_(gid) { return 'Q-J-' + gid; }

// Stamps quote_id + done on every row of the group that lacks it.
function otjStampGroup_(ctx, gid, quoteId, hook) {
  var stamped = 0;
  otjGroupRows_(ctx, gid).forEach(function (g) {
    if (otjLower_(g.o.lead_status) === 'done' && otjStr_(g.o.quote_id) === quoteId) return;
    g.o.quote_id = quoteId; g.o.lead_status = 'done'; g.o.lead_claim_id = ''; g.o.lead_claimed_at = '';
    otjWriteRow_(ctx, g.rowNum, g.o);
    stamped++;
    if (hook === 'stamp_partial' && stamped === 1) throw new Error('JOB_LEAD_TEST_FAIL stamp_partial');
  });
}

function processPendingJobLeads_() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'processPendingJobLeads_'; })
    .forEach(function (t) { try { ScriptApp.deleteTrigger(t); } catch (e) {} });

  var started = Date.now();
  var more = false, retryable = false;

  // 1. Reconcile verified links, then claim up to 10 groups — all under the lock.
  var claims = otjWithLock_(function () {
    var ctx = otjLoad_();
    var groups = {};
    ctx.rows.forEach(function (r) {
      if (!otjIsJob_(r.o) || !otjLower_(r.o.lead_status)) return;
      var g = otjStr_(r.o.job_group_id);
      if (g) (groups[g] = groups[g] || []).push(r);
    });
    var gids = Object.keys(groups);
    if (!gids.length) return [];
    var qIdx = otjQuotesIndex_();
    var out = [];
    gids.forEach(function (gid) {
      var rows = groups[gid];
      var allDone = rows.every(function (r) { return otjLower_(r.o.lead_status) === 'done' && otjStr_(r.o.quote_id); });
      if (allDone) return;
      var qid = otjLeadQuoteId_(gid);
      if (Object.prototype.hasOwnProperty.call(qIdx, qid) && qIdx[qid] === gid) {
        otjStampGroup_(ctx, gid, qid, '');         // verified link → reconcile, no import
        otjBustGroup_(ctx, gid, [], []);
        return;
      }
      var state = otjGroupState_(rows);
      var src = otjLeadSource_(rows).o;
      var attempts = Number(src.lead_attempts) || 0;
      var claimedAt = Date.parse(otjIso_(src.lead_claimed_at));
      var eligible = state === 'pending' ||
        (state === 'failed' && attempts < OTJ_LEAD_MAX_ATTEMPTS) ||
        (state === 'processing' && (!isFinite(claimedAt) || Date.now() - claimedAt > OTJ_CLAIM_STALE_MS));
      if (!eligible) return;
      if (out.length >= 10) { more = true; return; }
      var claimId = Utilities.getUuid();
      rows.forEach(function (r) {
        r.o.lead_status = 'processing'; r.o.lead_claim_id = claimId; r.o.lead_claimed_at = otjNowIso_();
        r.o.lead_attempts = attempts;
        otjWriteRow_(ctx, r.rowNum, r.o);
      });
      out.push({ gid: gid, claimId: claimId, attempts: attempts, src: src });
    });
    return out;
  });

  // 2. Process each claim. The lock is held only around the Quotes lookup-and-insert
  //    and the final stamp, never during the whole run.
  claims.forEach(function (c) {
    if (Date.now() - started > 4.5 * 60 * 1000) { more = true; return; }
    var hook = otjTestFlag_('JOB_LEAD_TEST_FAIL', c.src.client_name);
    var qid = otjLeadQuoteId_(c.gid);
    try {
      if (hook === 'import') throw new Error('JOB_LEAD_TEST_FAIL import');
      otjWithLock_(function () {
        var qIdx = otjQuotesIndex_();
        if (Object.prototype.hasOwnProperty.call(qIdx, qid)) {
          if (qIdx[qid] !== c.gid) throw new Error('Quote id collision for ' + qid);
          return; // already created (e.g. an earlier stamp failed)
        }
        createJobLead_(c.src, qid, c.gid);
      });
      if (hook === 'stamp') throw new Error('JOB_LEAD_TEST_FAIL stamp');
      otjWithLock_(function () {
        var ctx = otjLoad_();
        var rows = otjGroupRows_(ctx, c.gid);
        // Write only if this worker still owns every row's claim.
        if (!rows.every(function (r) { return otjStr_(r.o.lead_claim_id) === c.claimId; })) return;
        otjStampGroup_(ctx, c.gid, qid, hook);
        otjBustGroup_(ctx, c.gid, [], []);
      });
      try {
        var cache = CacheService.getScriptCache();
        cache.removeAll(['crm_data', 'unassigned_pools']);
      } catch (ce) {}
    } catch (e) {
      Logger.log('processPendingJobLeads_ ' + c.gid + ': ' + e);
      otjWithLock_(function () {
        var ctx = otjLoad_();
        var rows = otjGroupRows_(ctx, c.gid);
        if (!rows.every(function (r) { return otjStr_(r.o.lead_claim_id) === c.claimId; })) return;
        rows.forEach(function (r) {
          r.o.lead_status = 'failed'; r.o.lead_attempts = c.attempts + 1; r.o.lead_claim_id = ''; r.o.lead_claimed_at = '';
          otjWriteRow_(ctx, r.rowNum, r.o);
        });
      });
      if (c.attempts + 1 < OTJ_LEAD_MAX_ATTEMPTS) retryable = true;
    }
  });

  if (more || retryable) {
    try {
      ScriptApp.newTrigger('processPendingJobLeads_').timeBased().after(more ? 60000 : 5 * 60000).create();
    } catch (te) { Logger.log('processPendingJobLeads_ continuation: ' + te); }
  }
}

// Trusted, internal-only: creates the Sales Hub lead for a job's new client with
// a deterministic quote_id. The public import_leads action can never supply ids.
function createJobLead_(src, quoteId, groupId) {
  var sheet = getCrmSheet_();
  ['timestamp', 'imported_at', 'lead_source', 'pool_info', 'contact_log', 'job_group_id', 'gate_code'].forEach(function (c) {
    ensureColumn_(sheet, c);
  });
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var name = otjStr_(src.client_name);
  var parts = name.split(/\s+/);
  var lead = {
    first_name: parts.shift() || '', last_name: parts.join(' '),
    phone: otjStr_(src.phone), address: otjStr_(src.address), city: otjStr_(src.city),
    lead_source: 'one_time_job'
  };
  var row = buildLeadRow_(headers, lead, otjNowIso_(), quoteId);
  row[getColIdx_(headers, 'job_group_id')] = groupId;
  row[getColIdx_(headers, 'gate_code')] = otjText_(src.gate_code);
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, headers.length).setValues([row]);
}

// ── Service-log completion of a job (called from markScheduledVisitCompleted_) ─

// opts: { eventId: logUid, actorUsername (server-recorded), eventAt: ms }.
// Returns true when the job is (or already was, for this event) completed.
function otjCompleteFromServiceLog_(scheduledVisitId, completedAt, opts) {
  opts = opts || {};
  var eventId = otjStr_(opts.eventId), actor = otjLower_(opts.actorUsername);
  if (!eventId || !actor) {
    Logger.log('otjCompleteFromServiceLog_: no authenticated service-log event for job ' + scheduledVisitId);
    return false;
  }
  var eventAt = Number(opts.eventAt);
  var now = Date.now();
  if (!isFinite(eventAt) || eventAt < now - OTJ_RECEIPT_TTL_MS || eventAt > now + 5 * 60 * 1000) {
    Logger.log('otjCompleteFromServiceLog_: bad event time for ' + scheduledVisitId);
    return false;
  }
  var actorIsAdmin = otjUserIsAdmin_(actor);
  var result = otjWithLock_(function () {
    var ctx = otjLoad_();
    var r = ctx.byId[otjStr_(scheduledVisitId)];
    if (!r || !otjIsJob_(r.o)) return null;
    var o = r.o, key = 'svc:' + eventId;
    if (otjHasReceipt_(o, key)) return { ok: true };
    if ((otjLower_(o.status) || 'scheduled') !== 'scheduled') return { ok: false, why: 'status ' + o.status };
    var reopened = Date.parse(otjIso_(o.reopened_at));
    if (isFinite(reopened) && !(eventAt > reopened)) return { ok: false, why: 'log predates reopen' };
    if (!actorIsAdmin && otjLower_(o.assigned_username) !== actor) return { ok: false, why: 'actor not assigned' };
    o.status = 'completed';
    o.completed_at = (completedAt instanceof Date && !isNaN(completedAt.getTime()) ? completedAt : new Date()).toISOString();
    o.completed_by = actor;
    otjAddReceipt_(o, key);
    o.rev = (Number(o.rev) || 0) + 1; o.updated_at = otjNowIso_(); o.updated_by = actor;
    otjWriteRow_(ctx, r.rowNum, o);
    return { ok: true, ctx: ctx, gid: otjStr_(o.job_group_id) };
  });
  if (!result) return false;
  if (!result.ok) { Logger.log('otjCompleteFromServiceLog_ skipped ' + scheduledVisitId + ': ' + result.why); return false; }
  if (result.ctx) otjBustGroup_(result.ctx, result.gid, [], [actor]);
  return true;
}
