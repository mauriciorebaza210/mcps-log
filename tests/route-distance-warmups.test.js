// Distance warmup queue regression suite.
//
//   node tests/route-distance-warmups.test.js
//
// The queue exists so route ordering catches up after a bulk move. Two things
// must hold: the status a manager sees matches the sheet, and a warmup failure
// stays contained — it can never take down the reschedule that queued it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'appscript', 'Reschedule.js');
const NOW = Date.parse('2026-09-07T09:00:00Z'); // 4:00 AM Central, Monday

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

class FrozenDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(NOW);
    else super(...args);
  }
  static now() { return NOW; }
  static parse(s) { return Date.parse(s); }
}

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

class Range {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows || 1;
    this.numCols = numCols || 1;
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
  setValue(value) { return this.setValues([[value]]); }
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

const WARMUP_HEADERS = ['week_start','source_batch_id','status','created_at','processed_at','error'];

// Builds a context whose warmup queue starts with the given rows.
// Each row: [week_start, source_batch_id, status, created_at, processed_at, error]
function buildContext(warmupRows, opts) {
  opts = opts || {};
  const settings = new Spreadsheet({
    Reschedule_Distance_Warmups: new Sheet('Reschedule_Distance_Warmups', WARMUP_HEADERS, warmupRows || [])
  });
  const routes = new Spreadsheet({
    Routes: new Sheet('Routes', ['day_of_week','operator','pool_id'], [])
  });

  const warmed = [];
  const evicted = [];
  let lockHeld = !!opts.lockHeld;

  const ctx = {
    console,
    String, Number, Math, JSON, Array, Object, RegExp, Set, Date: FrozenDate,
    isNaN, encodeURIComponent,
    Logger: { log: () => {} },
    Utilities: {
      getUuid: () => 'uuid',
      formatDate: (date, tz, fmt) => {
        const d = date instanceof Date ? date : new Date(date);
        if (fmt === 'yyyy-MM-dd') return ymd(d);
        return d.toISOString();
      }
    },
    SpreadsheetApp: { getActiveSpreadsheet: () => settings, openById: () => routes },
    LockService: { getScriptLock: () => ({
      tryLock: () => { if (lockHeld) return false; lockHeld = true; return true; },
      releaseLock: () => { lockHeld = false; }
    })},
    CacheService: { getScriptCache: () => ({ removeAll: () => {}, remove: k => evicted.push(k) }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => {} }) }), everyHours: () => ({ create: () => {} }) }) }) },
    validateToken: () => ({ ok: true, username: 'admin', roles: ['admin'] }),
    hasRole: (auth, role) => (auth.roles || []).includes(role),
    getWeekStart_: () => '2026-09-07',
    getWeekStartForDate_: value => {
      if (!value) return '';
      const d = value instanceof Date ? new Date(value.getTime()) : new Date(String(value).slice(0, 10) + 'T12:00:00');
      if (isNaN(d.getTime())) return '';
      d.setDate(d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1));
      return ymd(d);
    },
    getDayDate_: () => '',
    getTechnicianOperators_: () => [],
    monthlyMatchesWeek_: () => true,
    isPoolVisibleForWeek_: () => true,
    computeRouteData_: week => {
      if (opts.failWeeks && opts.failWeeks.indexOf(week) !== -1) throw new Error('maps quota exceeded');
      warmed.push(week);
      return { ok: true };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'Reschedule.js' });
  return { ctx, settings, warmed, evicted };
}

function queueRows(ctx) {
  return ctx.rsRows_(ctx.rsWarmupSheet_());
}

// ─── Status reporting ────────────────────────────────────────────────────────
console.log('\nWarmup status');
{
  const { ctx } = buildContext([
    ['2026-09-07','B1','done','2026-09-01T00:00:00.000Z','2026-09-01T01:00:00.000Z',''],
    ['2026-09-14','B1','pending','2026-09-02T00:00:00.000Z','',''],
    ['2026-09-21','B2','processing','2026-09-03T00:00:00.000Z','',''],
    ['2026-09-28','B2','failed','2026-09-04T00:00:00.000Z','2026-09-04T02:00:00.000Z','maps quota exceeded'],
    ['2026-10-05','B3','failed','2026-09-05T00:00:00.000Z','2026-09-05T02:00:00.000Z','timeout']
  ]);
  const s = ctx.rsWarmupStatus_();

  t('status succeeds', s.ok === true);
  t('counts every bucket',
    s.pending === 1 && s.processing === 1 && s.done === 1 && s.failed === 2, JSON.stringify(s));
  t('last_processed_at is the newest processed row',
    s.last_processed_at === '2026-09-05T02:00:00.000Z', s.last_processed_at);
  t('pending_weeks covers pending and processing, sorted',
    JSON.stringify(s.pending_weeks) === JSON.stringify(['2026-09-14','2026-09-21']),
    JSON.stringify(s.pending_weeks));
  t('recent failures are newest first',
    s.recent_failures.length === 2 &&
    s.recent_failures[0].week_start === '2026-10-05' &&
    /timeout/.test(s.recent_failures[0].error),
    JSON.stringify(s.recent_failures));
}

{
  const { ctx } = buildContext([]);
  const s = ctx.rsWarmupStatus_();
  t('empty queue reports a clean ready state',
    s.ok === true && s.pending === 0 && s.processing === 0 && s.failed === 0 &&
    s.pending_weeks.length === 0 && s.last_processed_at === '', JSON.stringify(s));
}

{
  // Rows written by an older schema version, or garbage, must not be counted.
  const { ctx } = buildContext([
    ['2026-09-14','B1','PENDING','2026-09-02T00:00:00.000Z','',''],
    ['2026-09-21','B1','queued','2026-09-02T00:00:00.000Z','','']
  ]);
  const s = ctx.rsWarmupStatus_();
  t('status matching is case-insensitive', s.pending === 1, JSON.stringify(s));
  t('unknown statuses are ignored, not miscounted',
    s.pending + s.processing + s.done + s.failed === 1, JSON.stringify(s));
}

// ─── Enqueue ─────────────────────────────────────────────────────────────────
console.log('\nWarmup enqueue');
{
  const { ctx } = buildContext([
    ['2026-09-14','B1','pending','2026-09-02T00:00:00.000Z','','']
  ]);
  const res = ctx.rsEnqueueDistanceWarmups_(['2026-09-14','2026-09-21'], 'B2');
  t('already-pending week is not queued twice', res.queued === 1, JSON.stringify(res));
  t('new week is appended', queueRows(ctx).length === 2);
  t('appended row starts pending',
    queueRows(ctx).filter(r => r.week_start === '2026-09-21' && r.status === 'pending').length === 1);
}

{
  const { ctx } = buildContext([
    ['2026-09-14','B1','done','2026-09-02T00:00:00.000Z','2026-09-02T01:00:00.000Z','']
  ]);
  const res = ctx.rsEnqueueDistanceWarmups_(['2026-09-14'], 'B2');
  t('a completed week can be re-queued', res.queued === 1, JSON.stringify(res));
}

{
  const { ctx } = buildContext([]);
  const res = ctx.rsEnqueueDistanceWarmups_(['', null], 'B2');
  t('blank weeks queue nothing', res.queued === 0 && queueRows(ctx).length === 0, JSON.stringify(res));
}

// ─── Processing ──────────────────────────────────────────────────────────────
console.log('\nWarmup processing');
{
  const { ctx, warmed, evicted } = buildContext([
    ['2026-09-14','B1','pending','2026-09-02T00:00:00.000Z','',''],
    ['2026-09-21','B1','pending','2026-09-02T00:00:00.000Z','','']
  ]);
  const res = ctx.rsProcessDistanceWarmups_();

  t('processing reports success', res.ok === true && res.processed === 2, JSON.stringify(res));
  t('every pending row lands on done',
    queueRows(ctx).every(r => r.status === 'done'), JSON.stringify(queueRows(ctx).map(r => r.status)));
  t('processed rows are stamped', queueRows(ctx).every(r => !!r.processed_at));
  t('route data is recomputed for each week',
    JSON.stringify(warmed) === JSON.stringify(['2026-09-14','2026-09-21']), JSON.stringify(warmed));
  t('the stale route cache is evicted first',
    evicted.indexOf('rd:2026-09-14') !== -1 && evicted.indexOf('rd:2026-09-21') !== -1,
    JSON.stringify(evicted));

  const after = ctx.rsWarmupStatus_();
  t('status reflects the drained queue',
    after.pending === 0 && after.done === 2 && after.pending_weeks.length === 0, JSON.stringify(after));
}

{
  // A Maps failure must be recorded on its own row and must not throw — the
  // reschedule that queued this work has already been applied.
  const { ctx } = buildContext([
    ['2026-09-14','B1','pending','2026-09-02T00:00:00.000Z','',''],
    ['2026-09-21','B1','pending','2026-09-02T00:00:00.000Z','','']
  ], { failWeeks: ['2026-09-14'] });

  let threw = false;
  let res = null;
  try { res = ctx.rsProcessDistanceWarmups_(); } catch (e) { threw = true; }

  t('a warmup failure does not throw', threw === false);
  t('failure is reported, not swallowed', res && res.ok === false && res.failed === 1, JSON.stringify(res));
  t('the healthy week still completes', res && res.processed === 1, JSON.stringify(res));

  const rows = queueRows(ctx);
  const failedRow = rows.find(r => r.week_start === '2026-09-14');
  t('failed row records the reason',
    failedRow && failedRow.status === 'failed' && /maps quota/.test(failedRow.error),
    JSON.stringify(failedRow));
  t('failed row does not block the other week',
    rows.find(r => r.week_start === '2026-09-21').status === 'done');

  const after = ctx.rsWarmupStatus_();
  t('status surfaces the failure to the UI',
    after.failed === 1 && after.recent_failures.length === 1 &&
    /maps quota/.test(after.recent_failures[0].error), JSON.stringify(after));
}

{
  const { ctx, warmed } = buildContext([
    ['2026-09-07','B1','pending','2026-09-02T00:00:00.000Z','',''],
    ['2026-09-14','B1','pending','2026-09-02T00:00:00.000Z','',''],
    ['2026-09-21','B1','pending','2026-09-02T00:00:00.000Z','','']
  ]);
  ctx.rsProcessDistanceWarmups_(1);
  t('limit caps how many weeks a run touches', warmed.length === 1, JSON.stringify(warmed));
  t('the rest stay pending for the next run',
    queueRows(ctx).filter(r => r.status === 'pending').length === 2);
}

{
  const { ctx } = buildContext([
    ['2026-09-14','B1','pending','2026-09-02T00:00:00.000Z','','']
  ], { lockHeld: true });
  const res = ctx.rsProcessDistanceWarmups_();
  t('a held lock defers instead of racing the route job',
    res.ok === false && /already running/.test(res.error), JSON.stringify(res));
  t('deferred run leaves the queue untouched',
    queueRows(ctx)[0].status === 'pending');
}

// ─── Action wiring ───────────────────────────────────────────────────────────
console.log('\nAction wiring');
{
  const { ctx } = buildContext([
    ['2026-09-14','B1','pending','2026-09-02T00:00:00.000Z','','']
  ]);
  const auth = { ok: true, username: 'admin', roles: ['admin'] };

  const status = ctx.handleRescheduleAction_('reschedule_warmup_status', auth, {});
  t('reschedule_warmup_status is routed', status.ok === true && status.pending === 1, JSON.stringify(status));

  const warm = ctx.handleRescheduleAction_('reschedule_warm_distances', auth, { limit: 3 });
  t('reschedule_warm_distances is routed', warm.ok === true && warm.processed === 1, JSON.stringify(warm));

  const denied = ctx.handleRescheduleAction_('reschedule_warmup_status',
    { ok: true, username: 'tech', roles: ['technician'] }, {});
  t('technicians cannot read the warmup queue', denied.ok === false, JSON.stringify(denied));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
