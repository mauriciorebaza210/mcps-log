// Route Planner constraint-awareness suite.
//
//   node tests/planner-context.test.js
//
// Two things under test:
//   1. Only a day that has already passed is closed. Route_Lock rows are ignored
//      (autoRecalculateRoutes() is a no-op and nothing writes lock rows), and
//      today is always open — adding a stop mid-morning is normal work.
//   2. rsPlannerContext_ gathers the constraints the board needs to warn BEFORE
//      a move is staged — technicians, closed days, blackouts, load, unrouted.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'appscript', 'Reschedule.js');
const NOW = Date.parse('2026-09-07T09:00:00Z'); // 4:00 AM Central, Monday — before the 6am cutoff

let pass = 0;
let fail = 0;
function t(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log('  ok - ' + name);
  } else {
    fail += 1;
    console.log('  FAIL - ' + name + (detail ? ' ' + detail : ''));
  }
}

// The production code derives the Central hour via toLocaleString, so the stub
// has to answer that the same way the runtime would.
function makeFrozenDate(ctHour) {
  return class FrozenDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(NOW);
      else super(...args);
    }
    static now() { return NOW; }
    static parse(s) { return Date.parse(s); }
    toLocaleString() { return '9/7/2026, ' + ctHour + ':00:00'; }
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

class Range {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet; this.row = row; this.col = col;
    this.numRows = numRows || 1; this.numCols = numCols || 1;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        row.push((this.sheet.rows[this.row - 1 + r] || [])[this.col - 1 + c] ?? '');
      }
      out.push(row);
    }
    return out;
  }
  setValues(matrix) {
    for (let r = 0; r < matrix.length; r++) {
      const ri = this.row - 1 + r;
      while (this.sheet.rows.length <= ri) this.sheet.rows.push([]);
      for (let c = 0; c < matrix[r].length; c++) {
        const ci = this.col - 1 + c;
        while (this.sheet.rows[ri].length <= ci) this.sheet.rows[ri].push('');
        this.sheet.rows[ri][ci] = matrix[r][c];
      }
    }
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      const ri = this.row - 1 + r;
      while (this.sheet.rows.length <= ri) this.sheet.rows.push([]);
      for (let c = 0; c < this.numCols; c++) {
        const ci = this.col - 1 + c;
        while (this.sheet.rows[ri].length <= ci) this.sheet.rows[ri].push('');
        this.sheet.rows[ri][ci] = '';
      }
    }
    return this;
  }
}

class Sheet {
  constructor(name, headers, rows) {
    this.name = name;
    this.rows = headers ? [headers.slice(), ...(rows || []).map(r => r.slice())] : [];
  }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(row, col, numRows, numCols) { return new Range(this, row, col, numRows, numCols); }
  getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  appendRow(row) { this.rows.push(row.slice()); return this; }
  setFrozenRows() { return this; }
  deleteRow(row) { this.rows.splice(row - 1, 1); }
}

class Spreadsheet {
  constructor(sheets) { this.sheets = sheets || {}; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) {
    const sheet = new Sheet(name, null, []);
    this.sheets[name] = sheet;
    return sheet;
  }
}

const ROUTE_HEADERS = ['day_of_week','operator','pool_id','customer_name','address','city',
  'service','maps_link','lat','lng','pinned','route_status','monthly_week'];

// opts.lockRows: [[week_start, day, locked_at, locked_by]] — omit the sheet entirely with lockSheet:false
// opts.blackouts: [{start,end}] | null to omit the reader entirely
// opts.unassigned: pools array | null to omit handleGetUnassigned entirely
// opts.hour: Central hour to pretend it is (default 4, before the 6am cutoff)
function buildContext(opts) {
  opts = opts || {};
  const CT_HOUR = opts.hour === undefined ? 4 : opts.hour;
  const sheets = {
    Routes: new Sheet('Routes', ROUTE_HEADERS, [
      ['Monday','Tony','P1','Rivera','1 A','San Antonio','Weekly Full Service','',29,-98,'FALSE','',''],
      ['Monday','Tony','P2','Lopez','2 B','San Antonio','Weekly Full Service','',29,-98,'FALSE','',''],
      ['Thursday','Mia','P3','Diaz','3 C','San Antonio','Weekly Full Service','',29,-98,'FALSE','','']
    ]),
    Weekly_Overrides: new Sheet('Weekly_Overrides',
      ['week_start','pool_id','override_day','override_operator','created_at','batch_id'], []),
    Scheduled_Visits: new Sheet('Scheduled_Visits',
      ['scheduled_visit_id','pool_id','customer_name','service_type','visit_type','scheduled_date',
       'assigned_technician','status','completed_at','completed_by','chem_log_ref','notes',
       'created_at','created_by'], [])
  };
  if (opts.lockSheet !== false) {
    sheets.Route_Lock = new Sheet('Route_Lock',
      ['week_start','day','locked_at','locked_by'], opts.lockRows || []);
  }
  const routes = new Spreadsheet(sheets);
  const crm = new Spreadsheet({
    Quotes: new Sheet('Quotes',
      ['pool_id','first_name','last_name','customer_name','email','quote_id','area','address','city','schedule_notified_at'], [])
  });
  const settings = new Spreadsheet({});

  const unassignedCalls = [];
  const ctx = {
    console,
    String, Number, Math, JSON, Array, Object, RegExp, Set, Date: makeFrozenDate(CT_HOUR),
    isNaN, encodeURIComponent,
    Logger: { log: () => {} },
    Utilities: {
      getUuid: () => 'uuid',
      formatDate: (date, tz, fmt) => {
        const d = date instanceof Date ? date : new Date(date);
        if (fmt === 'yyyy-MM-dd') return ymd(d);
        if (fmt === 'EEEE') return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
        return d.toISOString();
      }
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => settings,
      openById: id => id === '1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E' ? crm : routes
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ removeAll: () => {}, remove: () => {}, get: () => null, put: () => {} }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => {} }) }), everyHours: () => ({ create: () => {} }) }) }) },
    validateToken: () => ({ ok: true, username: 'admin', roles: ['admin'] }),
    hasRole: (auth, role) => (auth.roles || []).includes(role),
    getTechnicianOperators_: () => [
      { name: 'Tony', maxPerDay: 8, days: ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY'] },
      { name: 'Mia', maxPerDay: 5, days: ['THURSDAY','FRIDAY','SATURDAY'] }
    ],
    getWeekStart_: () => '2026-09-07',
    getWeekStartForDate_: value => {
      if (!value) return '';
      const d = value instanceof Date ? new Date(value.getTime()) : new Date(String(value).slice(0, 10) + 'T12:00:00');
      if (isNaN(d.getTime())) return '';
      d.setDate(d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1));
      return ymd(d);
    },
    getDayDate_: (day, week) => {
      const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const d = new Date(week + 'T12:00:00');
      d.setDate(d.getDate() + days.indexOf(day));
      return ymd(d);
    },
    monthlyMatchesWeek_: () => true,
    isPoolVisibleForWeek_: () => true,
    ensureWeeklyOverridesSheet_: ss => ss.getSheetByName('Weekly_Overrides'),
    ensureScheduledVisitsSheet_: () => routes.getSheetByName('Scheduled_Visits'),
    computeRouteData_: () => ({ ok: true })
  };
  if (opts.blackouts) {
    ctx.savBlackoutRanges_ = () => opts.blackouts;
    ctx.savIsBlackedOut_ = (day, ranges) => ranges.some(r => day >= r.start && day <= r.end);
  }
  if (opts.blackoutsThrow) {
    ctx.savBlackoutRanges_ = () => { throw new Error('blackout sheet unreadable'); };
    ctx.savIsBlackedOut_ = () => false;
  }
  if (opts.unassigned) {
    // Must match the real name in RouteManager.js — a stub under the wrong name
    // made the wiring look correct while production silently found nothing.
    ctx.getUnassignedPools = token => {
      unassignedCalls.push(token);
      return { ok: true, pools: opts.unassigned };
    };
  }
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'Reschedule.js' });
  ctx.__unassignedCalls = unassignedCalls;
  return ctx;
}

function preflight(ctx, day, week) {
  return ctx.rsPreflight_({
    scope: 'week',
    effective_week: week || '2026-09-07',
    items: [{ pool_id: 'P1', new_day: day, new_operator: 'Tony' }]
  });
}

function blockersFor(res) {
  return ((res.verdicts || [])[0] || {}).blockers || [];
}

// ─── Days already gone ───────────────────────────────────────────────────────
console.log('\nDay closure');
{
  // NOW is Monday 2026-09-07. Nothing this week has passed yet, so all open.
  const ctx = buildContext({ lockRows: [] });
  ['Monday','Wednesday','Saturday'].forEach(day => {
    const res = preflight(ctx, day);
    t(day + ' of the current week is open',
      res.ok === true && !blockersFor(res).some(b => /passed|route already/.test(b)),
      JSON.stringify(blockersFor(res)));
  });
}

{
  const ctx = buildContext({ lockRows: [] });
  const res = preflight(ctx, 'Monday', '2026-08-31');
  t('a day that has already passed is blocked',
    blockersFor(res).some(b => /has already passed/.test(b)), JSON.stringify(blockersFor(res)));
  t('the blocker names the day and week, not "locked"',
    blockersFor(res).some(b => /Monday of 2026-08-31/.test(b)) &&
    !blockersFor(res).some(b => /locked/i.test(b)), JSON.stringify(blockersFor(res)));
}

{
  // A Route_Lock row must NOT block anything — the sheet has no writer and there
  // is no auto-recalc to guard against.
  const ctx = buildContext({ lockRows: [['2026-09-07', 'Wednesday', '2026-09-07T05:00:00Z', 'admin']] });
  const res = preflight(ctx, 'Wednesday');
  t('a Route_Lock row does not block a move',
    res.ok === true && Number(res.blockers) === 0, JSON.stringify(blockersFor(res)));
}

{
  const ctx = buildContext({ lockSheet: false });
  const res = preflight(ctx, 'Wednesday');
  t('a missing Route_Lock sheet is irrelevant', res.ok === true && Number(res.blockers) === 0);
}

{
  // Today stays open at any hour. Adding a stop to today's route mid-morning is
  // normal work — the tech's app picks it up on the next refresh.
  const ctx = buildContext({ lockRows: [], hour: 15 });
  const res = preflight(ctx, 'Monday');
  t('today is still a legal target in the afternoon',
    res.ok === true && !blockersFor(res).some(b => /passed/.test(b)), JSON.stringify(blockersFor(res)));
  const closed = ctx.rsPlannerContext_({ week_start: '2026-09-07' }).closed_days;
  t('today is not marked closed on the board', closed.length === 0, JSON.stringify(closed));
}

// ─── Planner context ─────────────────────────────────────────────────────────
console.log('\nPlanner context');
{
  const ctx = buildContext({
    lockRows: [['2026-09-07', 'Wednesday', '', 'admin']],
    blackouts: [{ start: '2026-09-10', end: '2026-09-10' }], // Thursday
    unassigned: [
      { pool_id: 'U1', customer_name: 'New One', address: '9 X', city: 'San Antonio', service: 'Weekly Full Service' },
      { pool_id: 'U2', customer_name: 'Monthly Two', service: 'Monthly Service', needs_monthly_week: true, day_of_week: 'Friday', operator: 'Mia' }
    ]
  });
  const c = ctx.rsPlannerContext_({ week_start: '2026-09-07' });

  t('context succeeds', c.ok === true);
  t('context echoes the requested week', c.week_start === '2026-09-07', c.week_start);

  t('technicians carry per-day capacity and working days',
    c.technicians.length === 2 &&
    c.technicians[0].name === 'Mia' && c.technicians[0].max_per_day === 5 &&
    c.technicians[0].days.indexOf('MONDAY') === -1 &&
    c.technicians[1].name === 'Tony' && c.technicians[1].max_per_day === 8,
    JSON.stringify(c.technicians));

  t('nothing is closed in an open week', c.closed_days.length === 0, JSON.stringify(c.closed_days));
  t('context reports no manual lock concept at all',
    c.locked_days === undefined && c.manual_locked_days === undefined,
    JSON.stringify(Object.keys(c)));

  t('blackout days are surfaced with their date',
    c.blackout_days.length === 1 &&
    c.blackout_days[0].day === 'Thursday' &&
    c.blackout_days[0].date === '2026-09-10',
    JSON.stringify(c.blackout_days));

  t('current load is counted per operator per day',
    c.load['Tony||Monday'] === 2 && c.load['Mia||Thursday'] === 1, JSON.stringify(c.load));

  t('unrouted pools are surfaced with a count',
    c.unrouted.count === 2 && c.unrouted.pools.length === 2, JSON.stringify(c.unrouted.count));
  t('a monthly pool needing a week is flagged',
    c.unrouted.pools[1].needs_monthly_week === true, JSON.stringify(c.unrouted.pools[1]));
}

{
  // Every optional source degrades to empty rather than failing the whole read —
  // the planner must still open when Service Areas or the CRM is unavailable.
  const ctx = buildContext({ lockRows: [] });
  const c = ctx.rsPlannerContext_({ week_start: '2026-09-07' });
  t('missing blackout reader degrades to none',
    c.ok === true && c.blackout_days.length === 0, JSON.stringify(c.blackout_days));
  t('missing unassigned reader degrades to zero',
    c.unrouted.count === 0 && c.unrouted.pools.length === 0, JSON.stringify(c.unrouted));
}

{
  // The reader validates its own token, so the planner has to forward it.
  const ctx = buildContext({ lockRows: [], unassigned: [{ pool_id: 'U1' }] });
  ctx.rsPlannerContext_({ week_start: '2026-09-07', token: 'tok-123' });
  t('the session token is forwarded to the unassigned reader',
    ctx.__unassignedCalls[0] === 'tok-123', JSON.stringify(ctx.__unassignedCalls));
}

{
  const ctx = buildContext({ lockRows: [], blackoutsThrow: true });
  let threw = false;
  let c = null;
  try { c = ctx.rsPlannerContext_({ week_start: '2026-09-07' }); } catch (e) { threw = true; }
  t('a throwing blackout reader does not break the planner',
    threw === false && c && c.ok === true && c.blackout_days.length === 0);
}

{
  const ctx = buildContext({ lockRows: [] });
  const c = ctx.rsPlannerContext_({});
  t('context defaults to the current week when none is given',
    c.week_start === '2026-09-07', c.week_start);
}

{
  // 50-pool display cap must announce itself rather than look like the full list.
  const many = [];
  for (let i = 0; i < 60; i++) many.push({ pool_id: 'U' + i, customer_name: 'C' + i });
  const ctx = buildContext({ lockRows: [], unassigned: many });
  const c = ctx.rsPlannerContext_({ week_start: '2026-09-07' });
  t('unrouted list is capped but reports the true count',
    c.unrouted.count === 60 && c.unrouted.pools.length === 50 && c.unrouted.truncated === true,
    JSON.stringify({ count: c.unrouted.count, shown: c.unrouted.pools.length, truncated: c.unrouted.truncated }));
}

console.log('\nAction wiring');
{
  const ctx = buildContext({ lockRows: [] });
  const auth = { ok: true, username: 'admin', roles: ['admin'] };
  const routed = ctx.handleRescheduleAction_('reschedule_planner_context', auth, { week_start: '2026-09-07' });
  t('reschedule_planner_context is routed', routed.ok === true && !!routed.technicians);
  const denied = ctx.handleRescheduleAction_('reschedule_planner_context',
    { ok: true, roles: ['technician'] }, {});
  t('technicians cannot read planner context', denied.ok === false);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
