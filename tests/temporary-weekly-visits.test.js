// Temporary weekly visit scheduling guard.
//
//   node tests/temporary-weekly-visits.test.js
//
// Locks the old "first month = always 4 visits" path into a generic, specific
// pool workflow: schedule N weeks, replace prior scheduled temporary rows, and
// preserve completed history.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCHEDULED_SRC = path.join(__dirname, '..', 'appscript', 'ScheduledVisits.js');
const ROUTE_SRC = path.join(__dirname, '..', 'appscript', 'RouteData.js');
const ROUTES_ID = '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM';

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
  setFontWeight() { return this; }
}

class Sheet {
  constructor(name, headers, rows) {
    this.name = name;
    this.rows = [headers.slice(), ...(rows || []).map(r => r.slice())];
  }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(row, col, numRows, numCols) { return new Range(this, row, col, numRows, numCols); }
  getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  appendRow(row) { this.rows.push(row.slice()); return this; }
  setFrozenRows() { return this; }
  setColumnWidth() { return this; }
}

class Spreadsheet {
  constructor(sheets) {
    this.sheets = sheets || {};
  }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) {
    const sh = new Sheet(name, [], []);
    this.sheets[name] = sh;
    return sh;
  }
}

function rowsAsObjects(sheet) {
  const h = sheet.rows[0].map(x => String(x || '').trim().toLowerCase().replace(/ /g, '_'));
  return sheet.rows.slice(1).filter(r => r.some(v => v !== '')).map(row => {
    const o = {};
    h.forEach((k, i) => { o[k] = row[i]; });
    return o;
  });
}

function buildContext() {
  const routes = new Spreadsheet({
    Routes: new Sheet('Routes',
      ['day_of_week','operator','pool_id','customer_name','address','city','service','maps_link','lat','lng','pinned','route_status'],
      [['Monday','Tony','P1','Rivera','1 A','San Antonio','Weekly Full Service','',29,-98,'FALSE','']]
    ),
    Scheduled_Visits: new Sheet('Scheduled_Visits',
      ['scheduled_visit_id','pool_id','customer_name','service_type','visit_type','scheduled_date','assigned_technician','status','completed_at','completed_by','chem_log_ref','notes','created_at','created_by'],
      [
        ['OLD1','P1','Rivera','Weekly Full Service','first_month_week_1','2026-09-09','Tony','scheduled','','','','old first month','old','admin'],
        ['DONE','P1','Rivera','Weekly Full Service','first_month_week_2','2026-09-16','Tony','completed','done','','','completed history','old','admin'],
        ['START','P1','Rivera','Startup','startup_day_1','2026-09-01','Tony','scheduled','','','','startup','old','admin']
      ]
    )
  });
  let uuid = 0;
  const cacheKeys = [];
  const ctx = {
    console,
    String, Number, Math, JSON, Array, Object, RegExp, Date, Set,
    isNaN, encodeURIComponent,
    AUTH_SHEET_ID: 'auth-test',
    USERS_SHEET: 'Users',
    OFFICE_ADDR: 'Office',
    Logger: { log: () => {} },
    Session: { getScriptTimeZone: () => 'America/Chicago' },
    Utilities: {
      getUuid: () => 'uuid-' + (++uuid),
      sleep: () => {},
      formatDate: (date, tz, fmt) => {
        const d = date instanceof Date ? date : new Date(date);
        if (fmt === 'yyyy-MM-dd') return ymd(d);
        if (fmt === 'EEEE') return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
        if (fmt === 'yyyy-MM-dd HH:mm') return ymd(d) + ' 09:00';
        return d.toISOString();
      }
    },
    CacheService: { getScriptCache: () => ({ remove: k => cacheKeys.push(k), removeAll: keys => keys.forEach(k => cacheKeys.push(k)), put: () => {}, get: () => null }) },
    SpreadsheetApp: { openById: id => routes },
    validateToken: () => ({ ok: true, roles: ['admin'], user: { username: 'admin' } }),
    hasRole: (auth, role) => (auth.roles || []).includes(role)
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SCHEDULED_SRC, 'utf8'), ctx, { filename: 'ScheduledVisits.js' });
  vm.runInContext(fs.readFileSync(ROUTE_SRC, 'utf8'), ctx, { filename: 'RouteData.js' });
  return { ctx, routes, cacheKeys };
}

console.log('\nSpecific pool temporary weekly visits');
{
  const { ctx, routes } = buildContext();
  const res = ctx.scheduleTemporaryWeeklyVisits(
    'token', 'P1', '2026-09-10', 'Thursday', 'Mia', 6,
    { reason: 'temporary_weekly', replace_existing: true }
  );
  const rows = rowsAsObjects(routes.getSheetByName('Scheduled_Visits'));
  const activeTemp = rows.filter(r => r.pool_id === 'P1' && r.visit_type.indexOf('temporary_week_') === 0 && r.status === 'scheduled');

  t('custom 6-week schedule succeeds', res.ok === true && res.visit_count === 6, res.error || '');
  t('input date is normalized to the week Monday', res.start_week === '2026-09-07');
  t('creates exactly 6 active temporary visits', activeTemp.length === 6);
  t('temporary visits land on the chosen weekday each week',
    activeTemp.map(r => r.scheduled_date).join(',') === '2026-09-10,2026-09-17,2026-09-24,2026-10-01,2026-10-08,2026-10-15');
  t('scheduled old first-month rows are cancelled',
    rows.some(r => r.scheduled_visit_id === 'OLD1' && r.status === 'cancelled'));
  t('completed old first-month history is preserved',
    rows.some(r => r.scheduled_visit_id === 'DONE' && r.status === 'completed'));
  t('startup visits are not touched',
    rows.some(r => r.scheduled_visit_id === 'START' && r.status === 'scheduled'));

  const again = ctx.scheduleTemporaryWeeklyVisits(
    'token', 'P1', '2026-09-10', 'Friday', 'Tony', 2,
    { reason: 'temporary_weekly', replace_existing: true }
  );
  const rowsAgain = rowsAsObjects(routes.getSheetByName('Scheduled_Visits'));
  const activeAgain = rowsAgain.filter(r => r.pool_id === 'P1' && r.visit_type.indexOf('temporary_week_') === 0 && r.status === 'scheduled');
  t('rescheduling the same pool replaces prior active temporary rows',
    again.ok === true && activeAgain.length === 2);
  t('replacement uses the new weekday and technician',
    activeAgain.map(r => r.scheduled_date + '/' + r.assigned_technician).join(',') === '2026-09-11/Tony,2026-09-18/Tony');
}

console.log('\nBackwards-compatible first-month wrapper');
{
  const { ctx, routes } = buildContext();
  const res = ctx.scheduleFirstMonthVisits('token', 'P1', '2026-09-07', 'Monday', 'Mia', 5);
  const rows = rowsAsObjects(routes.getSheetByName('Scheduled_Visits'));
  const firstMonth = rows.filter(r => r.pool_id === 'P1' && r.visit_type.indexOf('first_month_week_') === 0 && r.status === 'scheduled');
  t('first-month wrapper accepts custom count', res.ok === true && res.visit_count === 5, res.error || '');
  t('first-month wrapper still uses first_month visit types',
    firstMonth.map(r => r.visit_type).join(',') === 'first_month_week_1,first_month_week_2,first_month_week_3,first_month_week_4,first_month_week_5');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
