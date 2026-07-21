// ══════════════════════════════════════════════════════════════════════════════
// JOBS — backend for the portal Jobs tab (Maintenance / Startups / Repairs)
//
// Actions (routed in WebhookReceiver doPost):
//   get_my_jobs                     — aggregate open jobs for the session op
//   get_startup_hub                 — per-pool day checklist + photos
//   update_startup_task             — tick a checklist item
//   convert_startup_to_maintenance  — admin: startup pool → weekly route
//   update_repair_order             — status / schedule / reassign (role-gated)
//   get_pool_profile                — aggregate pool info for the profile view
//   get_pool_photo                  — latest "after" visit photo for the profile view (lazy, cached)
//   add_pool_equipment              — admin: manual equipment entry
//
// Hooks (called from SalesHub / WebhookReceiver):
//   createRepairOrderFromQuote_     — save_quote with service=repair_job
//   markRepairOrdersApprovedForQuote_ — proposal APPROVED
//   completeRepairOrderByVisit_     — repair scheduled visit's service log submitted
// ══════════════════════════════════════════════════════════════════════════════

const JOBS_ROUTES_SS_ID = "1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM";
const JOBS_AUTH_SS_ID   = "1e2XmGuosFSzeDQYMf3TYG3ZFfENYTyne5pqOi3L5m1g";

const REPAIR_ORDERS_HEADERS = [
  'order_id', 'quote_ref', 'pool_id', 'customer_name', 'address', 'city',
  'job_name', 'description', 'equipment', 'issue', 'priority', 'parts_json',
  'photo_url', 'status', 'assignee_type', 'assigned_to', 'reported_at',
  'scheduled_date', 'scheduled_visit_id', 'completed_at', 'updated_at', 'updated_by'
];

const STARTUP_TASKS_HEADERS = [
  'pool_id', 'day', 'task', 'status', 'updated_by', 'updated_at'
];

const POOL_EQUIPMENT_HEADERS = [
  'pool_id', 'item', 'category', 'source', 'added_by', 'added_at'
];

// ─── Sheet helpers ────────────────────────────────────────────────────────────

function jobsEnsureSheet_(name, headers) {
  const ss = SpreadsheetApp.openById(JOBS_ROUTES_SS_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jobsReadRows_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return { headers: [], rows: [] };
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(function(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
  return { headers: headers, rows: data.slice(1) };
}

function jobsCol_(headers, name) { return headers.indexOf(name); }

function jobsVal_(headers, row, name) {
  const i = headers.indexOf(name);
  return i === -1 ? '' : String(row[i] === null || row[i] === undefined ? '' : row[i]).trim();
}

function jobsDateStr_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'America/Chicago', 'yyyy-MM-dd');
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, 'America/Chicago', 'yyyy-MM-dd');
  return s;
}

// username → display name map from Auth Users sheet
function jobsUserNameMap_() {
  try {
    const sh = SpreadsheetApp.openById(JOBS_AUTH_SS_ID).getSheetByName('Users');
    const read = jobsReadRows_(sh);
    const map = {};
    read.rows.forEach(function(r) {
      const u = jobsVal_(read.headers, r, 'username');
      if (u) map[u.toLowerCase()] = jobsVal_(read.headers, r, 'name') || u;
    });
    return map;
  } catch (e) { return {}; }
}

// Active users holding technician/lead/admin roles — for assignment dropdowns
function jobsOperatorList_() {
  try {
    const sh = SpreadsheetApp.openById(JOBS_AUTH_SS_ID).getSheetByName('Users');
    const read = jobsReadRows_(sh);
    const out = [];
    read.rows.forEach(function(r) {
      const u = jobsVal_(read.headers, r, 'username');
      const roles = jobsVal_(read.headers, r, 'roles').toLowerCase();
      const active = jobsVal_(read.headers, r, 'active').toUpperCase();
      if (!u || active === 'FALSE' || active === 'NO') return;
      if (roles.indexOf('technician') === -1 && roles.indexOf('lead') === -1 && roles.indexOf('admin') === -1) return;
      out.push({ username: u, name: jobsVal_(read.headers, r, 'name') || u });
    });
    return out;
  } catch (e) { return []; }
}

function jobsIsManagerOrAdmin_(auth) {
  return hasRole(auth, 'admin') || hasRole(auth, 'manager');
}

function jobsIsHiddenRouteStatus_(status) {
  const s = String(status || '').trim().toLowerCase();
  return s === 'inactive' || s === 'startup_complete';
}

function jobsIsStartupRoute_(service, status) {
  const svc = String(service || '').toLowerCase();
  const st = String(status || '').toLowerCase();
  return svc.indexOf('startup') !== -1 || st === 'startup';
}

function jobsBustCache_(ops) {
  try {
    const cache = CacheService.getScriptCache();
    const keys = ['my_jobs:v5:all'];
    (ops || []).forEach(function(o) { if (o) keys.push('my_jobs:v5:' + String(o).toLowerCase()); });
    cache.removeAll(keys);
  } catch (e) {}
}

function handleDebugJobs(payload) {
  const out = {
    ok: true,
    handler_deployed: true,
    token_received: !!payload.token
  };
  const auth = validateToken(payload.token);
  out.auth_ok = !!auth.ok;
  out.auth_error = auth.error || '';
  out.username = auth.username || '';
  out.roles = auth.roles || [];
  if (!auth.ok) return out;

  try {
    const ss = SpreadsheetApp.openById(JOBS_ROUTES_SS_ID);
    out.routes_spreadsheet_ok = true;
    ['Routes', 'Scheduled_Visits', 'Job_Completions'].forEach(function(name) {
      const sheet = ss.getSheetByName(name);
      out[name.toLowerCase() + '_exists'] = !!sheet;
      out[name.toLowerCase() + '_rows'] = sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;
    });
  } catch (e) {
    out.routes_spreadsheet_ok = false;
    out.routes_error = String(e);
  }

  try {
    const authSs = SpreadsheetApp.openById(JOBS_AUTH_SS_ID);
    const users = authSs.getSheetByName('Users');
    out.auth_spreadsheet_ok = true;
    out.users_exists = !!users;
    out.users_rows = users ? Math.max(0, users.getLastRow() - 1) : 0;
  } catch (e) {
    out.auth_spreadsheet_ok = false;
    out.auth_error_detail = String(e);
  }

  try {
    const data = handleGetMyJobs({ token: payload.token, scope: payload.scope || 'mine' });
    out.get_my_jobs_ok = !!(data && data.ok);
    out.get_my_jobs_error = data && data.error ? data.error : '';
    out.counts = data && data.counts ? data.counts : null;
  } catch (e) {
    out.get_my_jobs_ok = false;
    out.get_my_jobs_error = String(e);
  }
  return out;
}

// ─── get_my_jobs ──────────────────────────────────────────────────────────────

function handleGetMyJobs(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };

  const scopeAll = String(payload.scope || '') === 'all' && jobsIsManagerOrAdmin_(auth);
  const op = String(auth.username || '').toLowerCase();
  const opName = String(auth.name || '').toLowerCase();
  const weekStart = typeof getWeekStart_ === 'function' ? getWeekStart_() : '';
  const cacheKey = scopeAll ? 'my_jobs:v5:all' : 'my_jobs:v5:' + op;

  try {
    const cached = CacheService.getScriptCache().get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) {}

  const ss = SpreadsheetApp.openById(JOBS_ROUTES_SS_ID);
  const nameMap = jobsUserNameMap_();
  const matchOp = function(assignee) {
    const a = String(assignee || '').toLowerCase();
    return scopeAll || a === op || (!!opName && a === opName);
  };

  // ── Routes: maintenance + lookup context for scheduled startup visits ──
  const routes = jobsReadRows_(ss.getSheetByName('Routes'));
  const rh = routes.headers;
  const maintenance = [];
  const startupPools = [];
  const routesByPool = {};
  routes.rows.forEach(function(r) {
    const status = jobsVal_(rh, r, 'route_status').toLowerCase();
    const rowOp = jobsVal_(rh, r, 'operator');
    const service = jobsVal_(rh, r, 'service');
    const poolId = jobsVal_(rh, r, 'pool_id');
    routesByPool[poolId] = r;
    if (jobsIsHiddenRouteStatus_(status)) return;
    if (weekStart && typeof isPoolVisibleForWeek_ === 'function') {
      const col = function(name) { return rh.indexOf(name); };
      if (!isPoolVisibleForWeek_(r, col, weekStart)) return;
    }

    if (jobsIsStartupRoute_(service, status)) return;
    const day = jobsVal_(rh, r, 'day_of_week');
    if (!day || day.toUpperCase() === 'UNSCHEDULED') return;
    if (!matchOp(rowOp)) return;
    maintenance.push({
      pool_id: poolId,
      customer_name: jobsVal_(rh, r, 'customer_name'),
      address: jobsVal_(rh, r, 'address'),
      city: jobsVal_(rh, r, 'city'),
      service: service,
      day_of_week: day,
      gate_code: jobsVal_(rh, r, 'gate_code'),
      operator: rowOp,
      op_name: nameMap[rowOp.toLowerCase()] || rowOp
    });
  });

  // ── Scheduled_Visits: startup queue source of truth ──
  const sv = jobsReadRows_(ss.getSheetByName('Scheduled_Visits'));
  const svh = sv.headers;
  const byPool = {};
  sv.rows.forEach(function(r) {
    const vt = jobsVal_(svh, r, 'visit_type');
    const m = vt.match(/^startup_day_([123])$/);
    if (!m) return;
    const pid = jobsVal_(svh, r, 'pool_id');
    const status = jobsVal_(svh, r, 'status').toLowerCase();
    if (status === 'cancelled' || status === 'removed') return;
    let s = byPool[pid];
    if (!s) {
      const routeRow = routesByPool[pid] || [];
      const vTech = jobsVal_(svh, r, 'assigned_technician');
      const customer = jobsVal_(svh, r, 'customer_name') || jobsVal_(rh, routeRow, 'customer_name') || pid;
      s = {
        pool_id: pid,
        customer_name: customer,
        address: jobsVal_(rh, routeRow, 'address'),
        city: jobsVal_(rh, routeRow, 'city'),
        operator: vTech,
        op_name: nameMap[vTech.toLowerCase()] || vTech,
        startup_start_date: typeof startupDateFromVisit_ === 'function'
          ? startupDateFromVisit_(jobsDateStr_(jobsVal_(svh, r, 'scheduled_date')), vt)
          : '',
        photo_url: '',
        days: []
      };
      startupPools.push(s);
      byPool[pid] = s;
    }
    // If the pool has no Routes operator, fall back to the visit's tech
    if (!s.operator) {
      const vTech = jobsVal_(svh, r, 'assigned_technician');
      if (vTech) { s.operator = vTech; s.op_name = nameMap[vTech.toLowerCase()] || vTech; }
    }
    s.days.push({
      n: Number(m[1]),
      visit_id: jobsVal_(svh, r, 'scheduled_visit_id'),
      scheduled_date: jobsDateStr_(jobsVal_(svh, r, 'scheduled_date')),
      status: status || 'scheduled',
      completed_at: jobsDateStr_(jobsVal_(svh, r, 'completed_at'))
    });
  });
  const startups = startupPools.filter(function(s) { return matchOp(s.operator); });
  startups.forEach(function(s) { s.days.sort(function(a, b) { return a.n - b.n; }); });

  // ── Repair_Orders ──
  const ro = jobsReadRows_(jobsEnsureSheet_('Repair_Orders', REPAIR_ORDERS_HEADERS));
  const roh = ro.headers;
  const repairs = [];
  ro.rows.forEach(function(r) {
    const assigned = jobsVal_(roh, r, 'assigned_to');
    // Include when: company-wide scope, assigned to me, or (admin viewing
    // "mine") unassigned — so brand-new work orders are never invisible.
    const isMine = String(assigned || '').toLowerCase() === op;
    if (!scopeAll && !isMine && !(jobsIsManagerOrAdmin_(auth) && !assigned)) return;
    let parts = [];
    try { parts = JSON.parse(jobsVal_(roh, r, 'parts_json') || '[]'); } catch (e) {}
    repairs.push({
      order_id: jobsVal_(roh, r, 'order_id'),
      quote_ref: jobsVal_(roh, r, 'quote_ref'),
      pool_id: jobsVal_(roh, r, 'pool_id'),
      customer_name: jobsVal_(roh, r, 'customer_name'),
      address: jobsVal_(roh, r, 'address'),
      city: jobsVal_(roh, r, 'city'),
      job_name: jobsVal_(roh, r, 'job_name'),
      description: jobsVal_(roh, r, 'description'),
      equipment: jobsVal_(roh, r, 'equipment'),
      issue: jobsVal_(roh, r, 'issue'),
      priority: jobsVal_(roh, r, 'priority') || 'medium',
      parts: parts,
      photo_url: jobsVal_(roh, r, 'photo_url'),
      status: jobsVal_(roh, r, 'status') || 'new',
      assigned_to: assigned,
      assigned_name: nameMap[assigned.toLowerCase()] || assigned,
      reported_at: jobsDateStr_(jobsVal_(roh, r, 'reported_at')),
      scheduled_date: jobsDateStr_(jobsVal_(roh, r, 'scheduled_date'))
    });
  });

  const openRepairs = repairs.filter(function(r) { return r.status !== 'completed'; }).length;
  const openStartups = startups.filter(function(s) {
    return s.days.filter(function(d) { return d.status === 'completed'; }).length < 3;
  }).length;

  const out = {
    ok: true,
    scope: scopeAll ? 'all' : 'mine',
    operator: auth.username,
    maintenance: maintenance,
    startups: startups,
    repairs: repairs,
    operators: jobsIsManagerOrAdmin_(auth) ? jobsOperatorList_() : [],
    counts: { maintenance: maintenance.length, startups: openStartups, repairs: openRepairs }
  };

  try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(out), 300); } catch (e) {}
  return out;
}

// ─── get_startup_hub ──────────────────────────────────────────────────────────

function handleGetStartupHub(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };
  const poolId = String(payload.pool_id || '').trim();
  if (!poolId) return { ok: false, error: 'pool_id required' };

  const read = jobsReadRows_(jobsEnsureSheet_('Startup_Tasks', STARTUP_TASKS_HEADERS));
  const tasks = [];
  read.rows.forEach(function(r) {
    if (jobsVal_(read.headers, r, 'pool_id') !== poolId) return;
    tasks.push({
      day: Number(jobsVal_(read.headers, r, 'day')) || 1,
      task: jobsVal_(read.headers, r, 'task'),
      status: jobsVal_(read.headers, r, 'status') || 'pending'
    });
  });

  // Photos from the pool's Drive visit-photo folder (newest date folders first)
  const photos = [];
  try {
    const rootSearch = DriveApp.getFoldersByName('MCPS Visit Photos');
    if (rootSearch.hasNext()) {
      const root = rootSearch.next();

      // Pool-level folders aren't always named with the bare pool_id — some carry a
      // descriptive prefix (e.g. "Cid - Weekly Full Service - 8611 Kihnu Willow - MCPS-0041").
      // Match any folder whose name contains the pool_id, not just an exact match, and
      // merge all matches' date folders (see handleGetPoolPhoto for the same pattern).
      const poolFolders = [];
      const pfIt = root.getFolders();
      while (pfIt.hasNext()) {
        const f = pfIt.next();
        if (f.getName() === poolId || f.getName().indexOf(poolId) !== -1) poolFolders.push(f);
      }

      const dateFolders = [];
      poolFolders.forEach(function(pf) {
        const dIt = pf.getFolders();
        while (dIt.hasNext()) dateFolders.push(dIt.next());
      });
      dateFolders.sort(function(a, b) { return b.getName().localeCompare(a.getName()); });

      for (let f = 0; f < dateFolders.length && photos.length < 12; f++) {
        const files = dateFolders[f].getFiles();
        while (files.hasNext() && photos.length < 12) {
          photos.push('https://drive.google.com/thumbnail?id=' + files.next().getId() + '&sz=w800');
        }
      }
    }
  } catch (e) { Logger.log('handleGetStartupHub photos: ' + e); }

  return { ok: true, tasks: tasks, photos: photos };
}

// ─── update_startup_task ──────────────────────────────────────────────────────

function handleUpdateStartupTask(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };
  const poolId = String(payload.pool_id || '').trim();
  const day = Number(payload.day);
  const task = String(payload.task || '').trim();
  const status = String(payload.status || 'pending').toLowerCase();
  if (!poolId || !day || !task) return { ok: false, error: 'pool_id, day, task required' };
  if (['pending', 'in_progress', 'completed'].indexOf(status) === -1) return { ok: false, error: 'Bad status' };

  const sheet = jobsEnsureSheet_('Startup_Tasks', STARTUP_TASKS_HEADERS);
  const read = jobsReadRows_(sheet);
  const now = new Date().toISOString();
  for (let i = 0; i < read.rows.length; i++) {
    if (jobsVal_(read.headers, read.rows[i], 'pool_id') === poolId &&
        Number(jobsVal_(read.headers, read.rows[i], 'day')) === day &&
        jobsVal_(read.headers, read.rows[i], 'task') === task) {
      const rowNum = i + 2;
      sheet.getRange(rowNum, jobsCol_(read.headers, 'status') + 1).setValue(status);
      sheet.getRange(rowNum, jobsCol_(read.headers, 'updated_by') + 1).setValue(auth.username);
      sheet.getRange(rowNum, jobsCol_(read.headers, 'updated_at') + 1).setValue(now);
      return { ok: true, updated: true };
    }
  }
  sheet.appendRow([poolId, day, task, status, auth.username, now]);
  return { ok: true, created: true };
}

// ─── convert_startup_to_maintenance ──────────────────────────────────────────

function handleConvertStartupToMaintenance(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!jobsIsManagerOrAdmin_(auth)) return { ok: false, error: 'Not authorized' };

  const poolId = String(payload.pool_id || '').trim();
  const dayOfWeek = String(payload.day_of_week || '').trim();
  const operator = String(payload.operator || '').trim();
  if (!poolId || !dayOfWeek || !operator) return { ok: false, error: 'pool_id, day_of_week, operator required' };

  const ss = SpreadsheetApp.openById(JOBS_ROUTES_SS_ID);

  // Server-side gate: all 3 startup days must be completed
  const sv = jobsReadRows_(ss.getSheetByName('Scheduled_Visits'));
  let doneDays = 0;
  sv.rows.forEach(function(r) {
    if (jobsVal_(sv.headers, r, 'pool_id') !== poolId) return;
    if (!/^startup_day_[123]$/.test(jobsVal_(sv.headers, r, 'visit_type'))) return;
    if (jobsVal_(sv.headers, r, 'status').toLowerCase() === 'completed') doneDays++;
  });
  if (doneDays < 3) return { ok: false, error: 'All 3 startup days must be logged before converting (' + doneDays + '/3 done).' };

  // Grab the current operator before conversion (for cache busting)
  const routesRead = jobsReadRows_(ss.getSheetByName('Routes'));
  let oldOp = '';
  routesRead.rows.forEach(function(r) {
    if (jobsVal_(routesRead.headers, r, 'pool_id') === poolId) oldOp = jobsVal_(routesRead.headers, r, 'operator');
  });

  // Reuse the existing conversion (service → Weekly Full Service, status → active,
  // day set, Service_History audit row)
  const res = convertStartupToWeekly(payload.token, poolId, dayOfWeek, payload.service_start_date || '');
  if (!res || !res.ok) return res || { ok: false, error: 'Conversion failed' };

  // Assign the weekly operator (convertStartupToWeekly doesn't touch it)
  const routesSheet = ss.getSheetByName('Routes');
  const routes = jobsReadRows_(routesSheet);
  for (let i = 0; i < routes.rows.length; i++) {
    if (jobsVal_(routes.headers, routes.rows[i], 'pool_id') !== poolId) continue;
    const opCol = jobsCol_(routes.headers, 'operator');
    if (opCol !== -1) routesSheet.getRange(i + 2, opCol + 1).setValue(operator);
    break;
  }

  try { CacheService.getScriptCache().remove('rd:' + getWeekStart_()); } catch (e) {}
  jobsBustCache_([oldOp, operator]);
  return { ok: true, pool_id: poolId, day_of_week: dayOfWeek, operator: operator, service_start: res.service_start };
}

// ─── Repair orders ────────────────────────────────────────────────────────────

// Hook: called from handleSaveQuote_ when service === 'repair_job'
function createRepairOrderFromQuote_(payload, quoteId) {
  try {
    const sheet = jobsEnsureSheet_('Repair_Orders', REPAIR_ORDERS_HEADERS);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(function(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
    const row = new Array(headers.length).fill('');
    const set = function(col, val) {
      const i = headers.indexOf(col);
      if (i !== -1) row[i] = val !== undefined && val !== null ? val : '';
    };
    const orderId = 'RO-' + Utilities.getUuid().substring(0, 8).toUpperCase();
    let parts = payload.repair_parts;
    if (typeof parts !== 'string') parts = JSON.stringify(parts || []);

    set('order_id', orderId);
    set('quote_ref', quoteId || '');
    set('pool_id', payload.pool_id || '');
    set('customer_name', ((payload.first_name || '') + ' ' + (payload.last_name || '')).trim() || payload.repair_company_name || '');
    set('address', payload.address || payload.repair_company_address || '');
    set('city', payload.city || '');
    set('job_name', payload.repair_job_name || payload.repair_job_type || 'Repair Job');
    set('description', payload.repair_job_description || '');
    set('equipment', payload.repair_equipment || '');
    set('issue', payload.repair_issue || '');
    set('priority', String(payload.repair_priority || 'medium').toLowerCase());
    set('parts_json', parts);
    set('photo_url', payload.repair_photo_url || '');
    set('status', 'new');
    set('assignee_type', 'user');
    set('assigned_to', payload.repair_assigned_to || '');
    set('reported_at', new Date().toISOString());
    set('updated_at', new Date().toISOString());
    set('updated_by', payload.created_by || '');
    sheet.appendRow(row);
    jobsBustCache_([payload.repair_assigned_to]);
    return orderId;
  } catch (e) {
    Logger.log('createRepairOrderFromQuote_ error: ' + e);
    return null;
  }
}

function jobsFindRepairOrder_(sheet, orderId) {
  const read = jobsReadRows_(sheet);
  for (let i = 0; i < read.rows.length; i++) {
    if (jobsVal_(read.headers, read.rows[i], 'order_id') === orderId) {
      return { headers: read.headers, row: read.rows[i], rowNum: i + 2 };
    }
  }
  return null;
}

function handleUpdateRepairOrder(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };
  const orderId = String(payload.order_id || '').trim();
  if (!orderId) return { ok: false, error: 'order_id required' };

  const sheet = jobsEnsureSheet_('Repair_Orders', REPAIR_ORDERS_HEADERS);
  const hit = jobsFindRepairOrder_(sheet, orderId);
  if (!hit) return { ok: false, error: 'Work order not found: ' + orderId };

  const isAdminUser = jobsIsManagerOrAdmin_(auth);
  const assignedTo = jobsVal_(hit.headers, hit.row, 'assigned_to');
  const newStatus = payload.status ? String(payload.status).toLowerCase() : '';

  // Techs may only complete their own orders; admins can do anything
  if (!isAdminUser) {
    const isMine = assignedTo.toLowerCase() === String(auth.username || '').toLowerCase();
    if (!isMine || newStatus !== 'completed' || payload.assigned_to || payload.scheduled_date) {
      return { ok: false, error: 'Not authorized' };
    }
  }
  if (newStatus && ['new', 'approved', 'waiting', 'scheduled', 'completed'].indexOf(newStatus) === -1) {
    return { ok: false, error: 'Bad status' };
  }

  const setCell = function(col, val) {
    const i = jobsCol_(hit.headers, col);
    if (i !== -1) sheet.getRange(hit.rowNum, i + 1).setValue(val);
  };
  const now = new Date().toISOString();

  if (payload.assigned_to !== undefined && isAdminUser) setCell('assigned_to', String(payload.assigned_to || ''));

  if (newStatus === 'scheduled') {
    const date = jobsDateStr_(payload.scheduled_date);
    if (!date) return { ok: false, error: 'scheduled_date required to schedule' };
    setCell('scheduled_date', date);
    // Put the visit on the tech's schedule — completing its service log
    // auto-completes this order via completeRepairOrderByVisit_.
    const poolId = jobsVal_(hit.headers, hit.row, 'pool_id');
    const finalAssignee = (payload.assigned_to !== undefined && isAdminUser)
      ? String(payload.assigned_to || '') : assignedTo;
    if (poolId) {
      const visit = createScheduledVisit_({
        pool_id: poolId,
        customer_name: jobsVal_(hit.headers, hit.row, 'customer_name'),
        service_type: 'Repair: ' + jobsVal_(hit.headers, hit.row, 'job_name'),
        visit_type: 'repair',
        scheduled_date: date,
        assigned_technician: finalAssignee,
        notes: 'Work order ' + orderId,
        created_by: auth.username
      });
      if (visit.ok) {
        try {
          const svSheet = SpreadsheetApp.openById(JOBS_ROUTES_SS_ID).getSheetByName('Scheduled_Visits');
          const svId = svSheet.getRange(visit.row, 1).getValue();
          setCell('scheduled_visit_id', String(svId || ''));
        } catch (e) {}
      }
      try { CacheService.getScriptCache().remove('rd:' + getWeekStartForDate_(date)); } catch (e) {}
    }
  }

  if (newStatus) {
    setCell('status', newStatus);
    if (newStatus === 'completed') {
      setCell('completed_at', now);
      jobsAppendPartsToEquipment_(hit, auth.username);
    }
  }
  setCell('updated_at', now);
  setCell('updated_by', auth.username);

  jobsBustCache_([assignedTo, payload.assigned_to]);
  return { ok: true, order_id: orderId, status: newStatus || jobsVal_(hit.headers, hit.row, 'status') };
}

// Hook: proposal APPROVED for a repair quote → advance matching orders to approved
function markRepairOrdersApprovedForQuote_(quoteId) {
  try {
    if (!quoteId) return;
    const sheet = jobsEnsureSheet_('Repair_Orders', REPAIR_ORDERS_HEADERS);
    const read = jobsReadRows_(sheet);
    const now = new Date().toISOString();
    for (let i = 0; i < read.rows.length; i++) {
      if (jobsVal_(read.headers, read.rows[i], 'quote_ref') !== String(quoteId)) continue;
      if (jobsVal_(read.headers, read.rows[i], 'status').toLowerCase() !== 'new') continue;
      const rowNum = i + 2;
      sheet.getRange(rowNum, jobsCol_(read.headers, 'status') + 1).setValue('approved');
      sheet.getRange(rowNum, jobsCol_(read.headers, 'updated_at') + 1).setValue(now);
      sheet.getRange(rowNum, jobsCol_(read.headers, 'updated_by') + 1).setValue('customer_approval');
      jobsBustCache_([jobsVal_(read.headers, read.rows[i], 'assigned_to')]);
    }
  } catch (e) {
    Logger.log('markRepairOrdersApprovedForQuote_ error: ' + e);
  }
}

// Hook: a repair scheduled visit's service log was submitted
function completeRepairOrderByVisit_(scheduledVisitId, completedBy) {
  try {
    if (!scheduledVisitId) return;
    const sheet = jobsEnsureSheet_('Repair_Orders', REPAIR_ORDERS_HEADERS);
    const read = jobsReadRows_(sheet);
    const now = new Date().toISOString();
    for (let i = 0; i < read.rows.length; i++) {
      if (jobsVal_(read.headers, read.rows[i], 'scheduled_visit_id') !== String(scheduledVisitId)) continue;
      if (jobsVal_(read.headers, read.rows[i], 'status').toLowerCase() === 'completed') return;
      const rowNum = i + 2;
      sheet.getRange(rowNum, jobsCol_(read.headers, 'status') + 1).setValue('completed');
      sheet.getRange(rowNum, jobsCol_(read.headers, 'completed_at') + 1).setValue(now);
      sheet.getRange(rowNum, jobsCol_(read.headers, 'updated_at') + 1).setValue(now);
      sheet.getRange(rowNum, jobsCol_(read.headers, 'updated_by') + 1).setValue(completedBy || 'service_log');
      jobsAppendPartsToEquipment_({ headers: read.headers, row: read.rows[i] }, completedBy || 'service_log');
      jobsBustCache_([jobsVal_(read.headers, read.rows[i], 'assigned_to')]);
      return;
    }
  } catch (e) {
    Logger.log('completeRepairOrderByVisit_ error: ' + e);
  }
}

// Completed repair parts → Pool_Equipment (source=repair)
function jobsAppendPartsToEquipment_(hit, addedBy) {
  try {
    const poolId = jobsVal_(hit.headers, hit.row, 'pool_id');
    if (!poolId) return;
    let parts = [];
    try { parts = JSON.parse(jobsVal_(hit.headers, hit.row, 'parts_json') || '[]'); } catch (e) {}
    if (!parts.length) return;
    const eq = jobsEnsureSheet_('Pool_Equipment', POOL_EQUIPMENT_HEADERS);
    const existing = jobsReadRows_(eq);
    const have = {};
    existing.rows.forEach(function(r) {
      if (jobsVal_(existing.headers, r, 'pool_id') === poolId) {
        have[jobsVal_(existing.headers, r, 'item').toLowerCase()] = true;
      }
    });
    const now = new Date().toISOString();
    parts.forEach(function(p) {
      const item = String((p && p.name) || '').trim();
      if (!item || have[item.toLowerCase()]) return;
      eq.appendRow([poolId, item, 'Repair Part', 'repair', addedBy || '', now]);
    });
  } catch (e) {
    Logger.log('jobsAppendPartsToEquipment_ error: ' + e);
  }
}

// ─── Pool profile ─────────────────────────────────────────────────────────────

function handleGetPoolProfile(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };
  const poolId = String(payload.pool_id || '').trim();
  if (!poolId) return { ok: false, error: 'pool_id required' };

  const ss = SpreadsheetApp.openById(JOBS_ROUTES_SS_ID);

  // Info from Routes
  const routes = jobsReadRows_(ss.getSheetByName('Routes'));
  let info = { customer_name: '', address: '', city: '', status: '', gate_code: '', notes: '' };
  routes.rows.forEach(function(r) {
    if (jobsVal_(routes.headers, r, 'pool_id') !== poolId) return;
    info = {
      customer_name: jobsVal_(routes.headers, r, 'customer_name'),
      address: jobsVal_(routes.headers, r, 'address'),
      city: jobsVal_(routes.headers, r, 'city'),
      status: jobsVal_(routes.headers, r, 'route_status'),
      gate_code: jobsVal_(routes.headers, r, 'gate_code'),
      notes: jobsVal_(routes.headers, r, 'notes')
    };
  });

  // Equipment
  const eq = jobsReadRows_(jobsEnsureSheet_('Pool_Equipment', POOL_EQUIPMENT_HEADERS));
  const equipment = [];
  eq.rows.forEach(function(r) {
    if (jobsVal_(eq.headers, r, 'pool_id') !== poolId) return;
    equipment.push({
      item: jobsVal_(eq.headers, r, 'item'),
      category: jobsVal_(eq.headers, r, 'category'),
      source: jobsVal_(eq.headers, r, 'source')
    });
  });

  // Visit history + last service from Job_Completions
  const jc = jobsReadRows_(ss.getSheetByName('Job_Completions'));
  const nameMap = jobsUserNameMap_();
  const visits = [];
  jc.rows.forEach(function(r) {
    if (jobsVal_(jc.headers, r, 'pool_id') !== poolId) return;
    const tech = jobsVal_(jc.headers, r, 'technician');
    visits.push({
      date: jobsDateStr_(jobsVal_(jc.headers, r, 'date') || jobsVal_(jc.headers, r, 'completed_at')),
      technician: nameMap[tech.toLowerCase()] || tech
    });
  });
  visits.sort(function(a, b) { return String(b.date).localeCompare(String(a.date)); });

  // Startup history from Scheduled_Visits
  const sv = jobsReadRows_(ss.getSheetByName('Scheduled_Visits'));
  const startupHistory = [];
  sv.rows.forEach(function(r) {
    if (jobsVal_(sv.headers, r, 'pool_id') !== poolId) return;
    const m = jobsVal_(sv.headers, r, 'visit_type').match(/^startup_day_([123])$/);
    if (!m) return;
    if (jobsVal_(sv.headers, r, 'status').toLowerCase() !== 'completed') return;
    startupHistory.push({
      day: Number(m[1]),
      date: jobsDateStr_(jobsVal_(sv.headers, r, 'completed_at') || jobsVal_(sv.headers, r, 'scheduled_date'))
    });
  });
  startupHistory.sort(function(a, b) { return a.day - b.day; });

  // Repair history
  const ro = jobsReadRows_(jobsEnsureSheet_('Repair_Orders', REPAIR_ORDERS_HEADERS));
  const repairHistory = [];
  ro.rows.forEach(function(r) {
    if (jobsVal_(ro.headers, r, 'pool_id') !== poolId) return;
    repairHistory.push({
      order_id: jobsVal_(ro.headers, r, 'order_id'),
      job_name: jobsVal_(ro.headers, r, 'job_name'),
      status: jobsVal_(ro.headers, r, 'status'),
      reported_at: jobsDateStr_(jobsVal_(ro.headers, r, 'reported_at'))
    });
  });

  return {
    ok: true,
    info: info,
    equipment: equipment,
    last_service: visits.length ? visits[0] : null,
    visit_history: visits.slice(0, 10),
    startup_history: startupHistory,
    repair_history: repairHistory
  };
}

// ─── Pool "after" photo (lazy-loaded separately from get_pool_profile) ────────
const POOL_PHOTO_CACHE_TTL = 300; // seconds
const POOL_PHOTO_AFTER_FILENAME = 'after-pool.jpg'; // fixed filename for the service log's "After" slot — see SVC_PHOTO_SLOTS in service-log.js
const POOL_PHOTO_FOLDER_SCAN_CAP = 20; // most-recent date folders to search before giving up

function handleGetPoolPhoto(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };
  const poolId = String(payload.pool_id || '').trim();
  if (!poolId) return { ok: false, error: 'pool_id required' };

  const cache = CacheService.getScriptCache();
  const cacheKey = 'pool_photo:' + poolId;
  const cached = cache.get(cacheKey);
  if (cached !== null) return { ok: true, photo_url: cached };

  let url = '';
  try {
    const rootSearch = DriveApp.getFoldersByName('MCPS Visit Photos');
    if (rootSearch.hasNext()) {
      const root = rootSearch.next();

      // Pool-level folders aren't always named with the bare pool_id — some carry a
      // descriptive prefix (e.g. "Cid - Weekly Full Service - 8611 Kihnu Willow - MCPS-0041"),
      // likely left over from an older naming convention. Match any folder whose name
      // contains the pool_id, not just an exact match, and merge all matches' date folders.
      const poolFolders = [];
      const pfIt = root.getFolders();
      while (pfIt.hasNext()) {
        const f = pfIt.next();
        if (f.getName() === poolId || f.getName().indexOf(poolId) !== -1) poolFolders.push(f);
      }

      const dateFolders = [];
      poolFolders.forEach(function(pf) {
        const dIt = pf.getFolders();
        while (dIt.hasNext()) dateFolders.push(dIt.next());
      });
      dateFolders.sort(function(a, b) { return b.getName().localeCompare(a.getName()); });

      for (let f = 0; f < dateFolders.length && f < POOL_PHOTO_FOLDER_SCAN_CAP && !url; f++) {
        const files = dateFolders[f].getFilesByName(POOL_PHOTO_AFTER_FILENAME);
        let newest = null;
        while (files.hasNext()) {
          const file = files.next();
          if (!newest || file.getLastUpdated() > newest.getLastUpdated()) newest = file;
        }
        if (newest) url = 'https://drive.google.com/thumbnail?id=' + newest.getId() + '&sz=w800';
      }
    }
  } catch (e) {
    Logger.log('handleGetPoolPhoto error: ' + e);
  }

  cache.put(cacheKey, url, POOL_PHOTO_CACHE_TTL);
  return { ok: true, photo_url: url };
}

function handleAddPoolEquipment(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!jobsIsManagerOrAdmin_(auth)) return { ok: false, error: 'Not authorized' };
  const poolId = String(payload.pool_id || '').trim();
  const item = String(payload.item || '').trim();
  if (!poolId || !item) return { ok: false, error: 'pool_id and item required' };
  const eq = jobsEnsureSheet_('Pool_Equipment', POOL_EQUIPMENT_HEADERS);
  eq.appendRow([poolId, item, String(payload.category || 'Other'), 'manual', auth.username, new Date().toISOString()]);
  return { ok: true };
}
