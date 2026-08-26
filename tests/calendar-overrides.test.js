// Month calendar override guard.
//
//   node tests/calendar-overrides.test.js
//
// The calendar must show the same effective schedule as the weekly route board:
// base recurring rows plus Weekly_Overrides for the week being rendered.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'appscript', 'RouteData.js');
const ROUTES_ID = '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM';
const AUTH_ID = 'auth-test';

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
}

class Sheet {
  constructor(headers, rows) {
    this.rows = [headers.slice(), ...(rows || []).map(r => r.slice())];
  }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(row, col, numRows, numCols) { return new Range(this, row, col, numRows, numCols); }
  getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  appendRow(row) { this.rows.push(row.slice()); return this; }
  setFrozenRows() { return this; }
}

class Spreadsheet {
  constructor(sheets) {
    this.sheets = sheets || {};
  }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) {
    const sh = new Sheet([], []);
    this.sheets[name] = sh;
    return sh;
  }
}

const auth = new Spreadsheet({
  Users: new Sheet(['name', 'roles', 'active'], [
    ['Tony', 'technician', 'TRUE'],
    ['Mia', 'technician', 'TRUE']
  ])
});

const routes = new Spreadsheet({
  Routes: new Sheet(
    ['day_of_week','operator','pool_id','customer_name','address','city','service','maps_link','lat','lng','pinned','route_status','monthly_week'],
    [
      ['Monday','Tony','P1','Rivera','1 A','San Antonio','Weekly Full Service','',29,-98,'FALSE','',''],
      ['Thursday','Mia','P2','Lopez','2 B','San Antonio','Weekly Full Service','',29,-98,'FALSE','',''],
      ['Monday','Tony','P3','Inactive','3 C','San Antonio','Weekly Full Service','',29,-98,'FALSE','inactive','']
    ]
  ),
  Weekly_Overrides: new Sheet(
    ['week_start','pool_id','override_day','override_operator','created_at','batch_id'],
    [
      ['2026-09-07','P1','Friday','Mia','created-1','B-1'],
      ['2026-09-14','P2','Monday','Tony','created-2','B-2']
    ]
  ),
  AdHoc_Services: new Sheet(
    ['Event_ID','Date_Scheduled','Type','Customer_Name','Location_Address','Assigned_Operator','Notes','Status'],
    []
  ),
  Scheduled_Visits: new Sheet(
    ['scheduled_visit_id','pool_id','customer_name','service_type','visit_type','scheduled_date',
     'assigned_technician','status','completed_at','completed_by','chem_log_ref','notes','created_at','created_by'],
    [
      ['SV1','P9','Nguyen','Pool Startup','startup_day_1','2026-09-08','Tony','scheduled','','','','','',''],
      ['SV2','P9','Nguyen','Pool Startup','startup_day_2','2026-09-09','Tony','','','','','','',''],
      ['SV3','P8','Reyes','Weekly Full Service','temporary_week_1','2026-09-10','Mia','scheduled','','','','','',''],
      ['SV4','P7','Cancelled One','Weekly Full Service','one_time','2026-09-11','Tony','cancelled','','','','','',''],
      ['SV5','P6','Done One','Weekly Full Service','one_time','2026-09-12','Tony','completed','2026-09-12','','','','','']
    ]
  )
});

const ctx = {
  console,
  String, Number, Math, JSON, Array, Object, RegExp, Date, Set,
  isNaN, encodeURIComponent,
  AUTH_SHEET_ID: AUTH_ID,
  USERS_SHEET: 'Users',
  Logger: { log: () => {} },
  Utilities: {
    formatDate: (date, tz, fmt) => {
      const d = date instanceof Date ? date : new Date(date);
      if (fmt === 'yyyy-MM-dd') return ymd(d);
      return d.toISOString();
    },
    getUuid: () => 'uuid'
  },
  SpreadsheetApp: {
    openById: id => id === AUTH_ID ? auth : (id === ROUTES_ID ? routes : routes)
  },
  validateToken: () => ({ ok: true, role: 'admin' })
};
ctx.globalThis = ctx;

vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'RouteData.js' });

console.log('\nMonth calendar weekly override behavior');
const all = ctx.getCalendarData('token', 9, 2026, 'all');
const byDate = date => all.days.find(d => d.date === date);

t('calendar call succeeds', all.ok === true, all.error || '');
t('weekly override removes pool from original day',
  !byDate('2026-09-07').weeklies.some(p => p.pool_id === 'P1'));
t('weekly override shows pool on moved day with moved technician',
  byDate('2026-09-11').weeklies.some(p => p.pool_id === 'P1' && p.operator === 'Mia' && p.week_override === true));
t('next week override is applied independently',
  byDate('2026-09-14').weeklies.some(p => p.pool_id === 'P2' && p.operator === 'Tony'));
t('inactive recurring rows stay hidden from calendar',
  !all.days.some(d => d.weeklies.some(p => p.pool_id === 'P3')));

const tony = ctx.getCalendarData('token', 9, 2026, 'Tony');
const tonySep11 = tony.days.find(d => d.date === '2026-09-11');
const tonySep14 = tony.days.find(d => d.date === '2026-09-14');
t('operator filter uses effective override technician',
  !tonySep11.weeklies.some(p => p.pool_id === 'P1') &&
  tonySep14.weeklies.some(p => p.pool_id === 'P2'));

// The week board merges Scheduled_Visits; the month view read none of them, so
// startups, temporary series and G2C one-offs were invisible on the month while
// the same week showed them. These lock the two views to the same schedule.
console.log('\nMonth calendar scheduled visits');

t('startup visits appear on their date',
  byDate('2026-09-08').visits.some(v => v.pool_id === 'P9' && v.visit_type === 'startup_day_1'),
  JSON.stringify(byDate('2026-09-08').visits));

t('a blank status counts as scheduled',
  byDate('2026-09-09').visits.some(v => v.visit_type === 'startup_day_2'),
  JSON.stringify(byDate('2026-09-09').visits));

t('temporary series visits appear on their date',
  byDate('2026-09-10').visits.some(v => v.pool_id === 'P8' && v.visit_type === 'temporary_week_1'));

t('cancelled visits stay hidden',
  !all.days.some(d => (d.visits || []).some(v => v.pool_id === 'P7')));

t('completed visits stay hidden',
  !all.days.some(d => (d.visits || []).some(v => v.pool_id === 'P6')));

t('visits carry the technician and service for display',
  (() => {
    const v = byDate('2026-09-10').visits[0];
    return v && v.operator === 'Mia' && v.service === 'Weekly Full Service' && !!v.customer_name;
  })());

t('every day exposes a visits array',
  all.days.every(d => Array.isArray(d.visits)));

t('operator filter applies to visits too',
  (() => {
    const mia = ctx.getCalendarData('token', 9, 2026, 'Mia');
    const sep8 = mia.days.find(d => d.date === '2026-09-08');   // Tony's startup
    const sep10 = mia.days.find(d => d.date === '2026-09-10');  // Mia's temporary
    return sep8.visits.length === 0 && sep10.visits.some(v => v.pool_id === 'P8');
  })());

t('week_override marks a pool moved off its normal day',
  // The flag was computed but nothing rendered it; the month view now badges it.
  byDate('2026-09-11').weeklies.find(p => p.pool_id === 'P1').week_override === true &&
  byDate('2026-09-04').weeklies.every(p => p.week_override === false));

// The payload above is only useful if the month view renders it. These guard the
// consuming half so the two can't drift apart again.
console.log('\nMonth calendar rendering');
const routesJs = fs.readFileSync(path.join(__dirname, '..', 'js/features/routes.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

t('month cells render a visits pill',
  /day\.visits && day\.visits\.length > 0/.test(routesJs) &&
  /cal-pill visit/.test(routesJs) &&
  /\.cal-pill\.visit/.test(cssSrc));

t('month detail lists scheduled visits',
  /Scheduled Visits \(\$\{day\.visits\.length\}\)/.test(routesJs) &&
  /function _visitTypeLabel_/.test(routesJs));

t('visit types read as English, unknown values included',
  /Startup day /.test(routesJs) &&
  /First month wk /.test(routesJs) &&
  /Temporary wk /.test(routesJs) &&
  /replace\(\/_\/g, ' '\)/.test(routesJs));

t('an empty day accounts for visits before saying nothing is scheduled',
  /!day\.visits \|\| !day\.visits\.length/.test(routesJs));

t('month cells count how many pools were moved',
  /const moved = day\.weeklies\.filter\(w => w\.week_override\)\.length/.test(routesJs) &&
  /\$\{moved\} moved/.test(routesJs));

t('month detail badges each moved pool',
  /w\.week_override \? ' <span class="cal-pill moved"/.test(routesJs) &&
  /\.cal-pill\.moved/.test(cssSrc));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
