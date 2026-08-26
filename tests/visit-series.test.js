// Temporary visit series: list, cancel, extend.
//
//   node tests/visit-series.test.js
//
// Series are DERIVED from Scheduled_Visits rows rather than stored in a ledger,
// so the grouping rules are the contract. The dangerous invariants:
//   - history is never rewritten (completed/skipped/past rows survive)
//   - extend never double-books a date
//   - startups and one-offs are not swept up as series
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'appscript', 'VisitSeries.js');
const NOW = Date.parse('2026-09-16T14:00:00Z'); // Wednesday 2026-09-16, 9am Central

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
  getValue() { return this.getValues()[0][0]; }
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
  clearContent() { return this.setValue(''); }
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
}

const SV_HEADERS = ['scheduled_visit_id','pool_id','customer_name','service_type','visit_type',
  'scheduled_date','assigned_technician','status','completed_at','completed_by','chem_log_ref',
  'notes','created_at','created_by'];

function visit(o) {
  return SV_HEADERS.map(h => (o[h] === undefined ? '' : o[h]));
}

// A 6-week temporary series on P1 starting 2026-09-07 (Wednesdays).
// Today is 2026-09-16, so weeks 1–2 are past and weeks 3–6 are ahead.
function temporarySeries() {
  const token = 'temporary_weekly:2026-09-07:6';
  const dates = ['2026-09-09','2026-09-16','2026-09-23','2026-09-30','2026-10-07','2026-10-14'];
  const statuses = ['completed','scheduled','scheduled','scheduled','scheduled','scheduled'];
  return dates.map((d, i) => visit({
    scheduled_visit_id: 'SV-T' + (i + 1), pool_id: 'P1', customer_name: 'Rivera',
    service_type: 'Weekly Full Service', visit_type: 'temporary_week_' + (i + 1),
    scheduled_date: d, assigned_technician: 'Mia', status: statuses[i],
    notes: token + ' temporary_weekly'
  }));
}

function buildContext(extraRows) {
  const sheet = new Sheet('Scheduled_Visits', SV_HEADERS,
    temporarySeries().concat(extraRows || []));
  const routes = { getSheetByName: () => sheet, insertSheet: () => sheet };

  const busted = [];
  let lockHeld = false;
  let uuid = 0;

  const ctx = {
    console,
    String, Number, Math, JSON, Array, Object, RegExp, Set, Date: FrozenDate,
    isNaN, encodeURIComponent,
    Logger: { log: () => {} },
    Utilities: {
      getUuid: () => 'new-uuid-' + (++uuid),
      formatDate: (date, tz, fmt) => {
        const d = date instanceof Date ? date : new Date(date);
        if (fmt === 'yyyy-MM-dd') return ymd(d);
        if (fmt === 'EEEE') return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
        return d.toISOString();
      }
    },
    SpreadsheetApp: { openById: () => routes, getActiveSpreadsheet: () => routes },
    LockService: { getScriptLock: () => ({
      tryLock: () => { if (lockHeld) return false; lockHeld = true; return true; },
      releaseLock: () => { lockHeld = false; }
    })},
    CacheService: { getScriptCache: () => ({ remove: () => {}, removeAll: () => {} }) },
    hasRole: (auth, role) => (auth.roles || []).includes(role),
    ensureScheduledVisitsSheet_: () => sheet,
    bustScheduledVisitRouteCache_: d => busted.push(d),
    getWeekStartForDate_: value => {
      const d = new Date(String(value).slice(0, 10) + 'T12:00:00');
      d.setDate(d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1));
      return ymd(d);
    },
    getDayDate_: (day, week) => {
      const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const d = new Date(week + 'T12:00:00');
      d.setDate(d.getDate() + days.indexOf(day));
      return ymd(d);
    },
    addDaysToDate_: (base, days) => {
      const d = new Date(String(base).slice(0, 10) + 'T12:00:00');
      d.setDate(d.getDate() + days);
      return ymd(d);
    },
    createScheduledVisit_: o => {
      sheet.appendRow(visit(Object.assign({ scheduled_visit_id: 'SV-NEW-' + (++uuid) }, o)));
      return { ok: true };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'VisitSeries.js' });
  return { ctx, sheet, busted };
}

function rowsOf(sheet) {
  const h = sheet.rows[0].map(x => String(x).trim().toLowerCase());
  return sheet.rows.slice(1).map(r => {
    const o = {};
    h.forEach((k, i) => { o[k] = r[i]; });
    return o;
  });
}

const AUTH = { ok: true, username: 'admin', name: 'Admin', roles: ['admin'] };

// ─── Listing ─────────────────────────────────────────────────────────────────
console.log('\nSeries listing');
{
  const { ctx } = buildContext();
  const res = ctx.vsListSeries_({});
  t('list succeeds', res.ok === true);
  t('one series is derived from six rows', res.series.length === 1, JSON.stringify(res.series.length));

  const s = res.series[0];
  t('series identity comes from the notes token',
    s.derived_from_notes === true && /temporary_weekly:2026-09-07:6/.test(s.series_key), s.series_key);
  t('series reports its pool and customer', s.pool_id === 'P1' && s.customer_name === 'Rivera');
  t('series knows its day and technician', s.day_of_week === 'Wednesday' && s.technician === 'Mia',
    JSON.stringify({ day: s.day_of_week, tech: s.technician }));
  t('total counts every row', s.total === 6, String(s.total));
  // Today's visit still counts as ahead: 5 of 6 remain (week 1 completed).
  t('remaining counts only visits still ahead', s.remaining === 5, String(s.remaining));
  t('next date is the soonest future visit', s.next_date === '2026-09-16', s.next_date);
  t('completed visits are counted separately', s.counts.completed === 1, JSON.stringify(s.counts));
  t('start and end span the whole series',
    s.start_date === '2026-09-09' && s.end_date === '2026-10-14',
    JSON.stringify({ start: s.start_date, end: s.end_date }));
  t('series is actionable', s.can_cancel === true && s.can_extend === true);
}

{
  // Startups, weekly overrides and one-offs are not weekly series.
  const { ctx } = buildContext([
    visit({ scheduled_visit_id: 'SV-S1', pool_id: 'P9', visit_type: 'startup_day_1',
            scheduled_date: '2026-09-23', status: 'scheduled' }),
    visit({ scheduled_visit_id: 'SV-O1', pool_id: 'P8', visit_type: 'one_time',
            scheduled_date: '2026-09-24', status: 'scheduled' }),
    visit({ scheduled_visit_id: 'SV-W1', pool_id: 'P7', visit_type: 'weekly_override',
            scheduled_date: '2026-09-25', status: 'scheduled' })
  ]);
  const res = ctx.vsListSeries_({});
  t('startups, one-offs and overrides are not treated as series',
    res.series.length === 1 && res.series[0].pool_id === 'P1',
    JSON.stringify(res.series.map(s => s.pool_id)));
}

{
  // Rows written before the notes token existed must still group, by family.
  const { ctx } = buildContext([
    visit({ scheduled_visit_id: 'SV-L1', pool_id: 'P5', customer_name: 'Legacy',
            visit_type: 'first_month_week_1', scheduled_date: '2026-09-23',
            assigned_technician: 'Tony', status: 'scheduled', notes: 'first_month_sponsored' }),
    visit({ scheduled_visit_id: 'SV-L2', pool_id: 'P5', customer_name: 'Legacy',
            visit_type: 'first_month_week_2', scheduled_date: '2026-09-30',
            assigned_technician: 'Tony', status: 'scheduled', notes: 'first_month_sponsored' })
  ]);
  const res = ctx.vsListSeries_({});
  const legacy = res.series.find(s => s.pool_id === 'P5');
  t('token-less rows still form a series', !!legacy && legacy.total === 2, JSON.stringify(legacy));
  t('token-less series is flagged as derived by family',
    !!legacy && legacy.derived_from_notes === false);
  t('family is reported', !!legacy && legacy.series_type === 'first_month', legacy && legacy.series_type);
}

{
  const { ctx } = buildContext();
  t('pool filter narrows the list', ctx.vsListSeries_({ pool_id: 'P1' }).series.length === 1);
  t('pool filter excludes other pools', ctx.vsListSeries_({ pool_id: 'P404' }).series.length === 0);
}

{
  // A fully finished series is hidden by default but still retrievable.
  const { ctx, sheet } = buildContext();
  rowsOf(sheet).forEach((r, i) => {
    if (String(r.pool_id) === 'P1') sheet.getRange(i + 2, SV_HEADERS.indexOf('status') + 1).setValue('completed');
  });
  t('finished series are hidden by default', ctx.vsListSeries_({}).series.length === 0);
  t('finished series are available on request',
    ctx.vsListSeries_({ include_finished: true }).series.length === 1);
}

// ─── Cancel ──────────────────────────────────────────────────────────────────
console.log('\nSeries cancel');
{
  const { ctx, sheet, busted } = buildContext();
  const key = ctx.vsListSeries_({}).series[0].series_key;
  const res = ctx.vsCancelSeries_(AUTH, { series_key: key });

  t('cancel succeeds', res.ok === true, JSON.stringify(res.error || ''));
  t('cancel removes every future visit', res.cancelled_count === 5, String(res.cancelled_count));

  const rows = rowsOf(sheet).filter(r => r.pool_id === 'P1');
  t('the completed visit is untouched',
    rows.find(r => r.scheduled_date === '2026-09-09').status === 'completed');
  t('future visits are cancelled',
    rows.filter(r => ['2026-09-16','2026-09-23','2026-09-30','2026-10-07','2026-10-14'].includes(r.scheduled_date))
        .every(r => r.status === 'cancelled'));
  t('cancelling stamps who and when',
    /cancelled by Admin 2026-09-16/.test(String(rows.find(r => r.scheduled_date === '2026-09-23').notes)),
    String(rows.find(r => r.scheduled_date === '2026-09-23').notes));
  t('the route cache is busted for each cancelled date', busted.length === 5, String(busted.length));

  const after = ctx.vsListSeries_({});
  t('a cancelled series drops out of the active list', after.series.length === 0);
}

{
  // A past visit that was never completed is still history — do not rewrite it.
  const { ctx, sheet } = buildContext([
    visit({ scheduled_visit_id: 'SV-P0', pool_id: 'P1', customer_name: 'Rivera',
            visit_type: 'temporary_week_0', scheduled_date: '2026-09-02',
            assigned_technician: 'Mia', status: 'scheduled',
            notes: 'temporary_weekly:2026-09-07:6 temporary_weekly' })
  ]);
  const key = ctx.vsListSeries_({}).series[0].series_key;
  ctx.vsCancelSeries_(AUTH, { series_key: key });
  const past = rowsOf(sheet).find(r => r.scheduled_date === '2026-09-02');
  t('a past uncompleted visit is left alone', past.status === 'scheduled', String(past.status));
}

{
  // keep_through shortens rather than cancelling outright.
  const { ctx, sheet } = buildContext();
  const key = ctx.vsListSeries_({}).series[0].series_key;
  const res = ctx.vsCancelSeries_(AUTH, { series_key: key, keep_through: '2026-09-30' });
  t('shortening reports its mode', res.ok === true && res.mode === 'shortened', JSON.stringify(res));
  t('shortening cancels only past the cutoff', res.cancelled_count === 2, String(res.cancelled_count));

  const rows = rowsOf(sheet).filter(r => r.pool_id === 'P1');
  t('visits up to the cutoff survive',
    rows.find(r => r.scheduled_date === '2026-09-30').status === 'scheduled');
  t('visits after the cutoff are gone',
    rows.find(r => r.scheduled_date === '2026-10-07').status === 'cancelled' &&
    rows.find(r => r.scheduled_date === '2026-10-14').status === 'cancelled');
}

{
  const { ctx } = buildContext();
  t('cancel requires a series_key', ctx.vsCancelSeries_(AUTH, {}).ok === false);
  t('cancel rejects an unknown series',
    ctx.vsCancelSeries_(AUTH, { series_key: 'P404||nope' }).ok === false);
}

// ─── Extend ──────────────────────────────────────────────────────────────────
console.log('\nSeries extend');
{
  const { ctx, sheet } = buildContext();
  const key = ctx.vsListSeries_({}).series[0].series_key;
  const res = ctx.vsExtendSeries_(AUTH, { series_key: key, weeks: 3 });

  t('extend succeeds', res.ok === true, JSON.stringify(res.error || ''));
  t('extend creates the requested weeks', res.created_count === 3, String(res.created_count));
  t('extension continues the same weekday',
    res.created.every(c => c.date && ['2026-10-21','2026-10-28','2026-11-04'].includes(c.date)),
    JSON.stringify(res.created.map(c => c.date)));
  t('extension keeps the technician', res.technician === 'Mia', res.technician);
  t('extension continues the visit_type numbering',
    res.created.map(c => c.visit_type).join(',') === 'temporary_week_7,temporary_week_8,temporary_week_9',
    JSON.stringify(res.created.map(c => c.visit_type)));

  const listed = ctx.vsListSeries_({}).series[0];
  t('extended visits join the same series', listed.total === 9, String(listed.total));
  t('remaining grows by the extension', listed.remaining === 8, String(listed.remaining));
  t('new rows carry the series token',
    rowsOf(sheet).filter(r => r.scheduled_date === '2026-10-21')
      .every(r => /temporary_weekly:2026-09-07:6/.test(String(r.notes))));
}

{
  // Extending twice must not double-book: the second call sees the first's rows.
  const { ctx, sheet } = buildContext();
  const key = ctx.vsListSeries_({}).series[0].series_key;
  ctx.vsExtendSeries_(AUTH, { series_key: key, weeks: 2 });
  const before = rowsOf(sheet).length;
  const second = ctx.vsExtendSeries_(AUTH, { series_key: key, weeks: 2 });
  t('a second extend adds new weeks, not duplicates',
    second.created_count === 2 && rowsOf(sheet).length === before + 2,
    JSON.stringify({ created: second.created_count, rows: rowsOf(sheet).length, before }));
  const dates = rowsOf(sheet).filter(r => r.pool_id === 'P1' && r.status !== 'cancelled')
    .map(r => r.scheduled_date);
  t('no date is scheduled twice', new Set(dates).size === dates.length, JSON.stringify(dates));
}

{
  // A date already taken by an unrelated live visit must be skipped, not doubled.
  const { ctx } = buildContext([
    visit({ scheduled_visit_id: 'SV-X1', pool_id: 'P1', customer_name: 'Rivera',
            visit_type: 'one_time', scheduled_date: '2026-10-21',
            assigned_technician: 'Tony', status: 'scheduled', notes: 'ad hoc' })
  ]);
  const key = ctx.vsListSeries_({}).series.find(s => s.pool_id === 'P1').series_key;
  const res = ctx.vsExtendSeries_(AUTH, { series_key: key, weeks: 2 });
  t('an occupied date is skipped',
    res.skipped_dates.indexOf('2026-10-21') !== -1, JSON.stringify(res.skipped_dates));
  t('the remaining week is still created',
    res.created_count === 1 && res.created[0].date === '2026-10-28', JSON.stringify(res.created));
}

{
  const { ctx } = buildContext();
  const key = ctx.vsListSeries_({}).series[0].series_key;
  t('extend requires a positive week count',
    ctx.vsExtendSeries_(AUTH, { series_key: key, weeks: 0 }).ok === false);
  t('extend refuses to exceed the 26-visit ceiling',
    ctx.vsExtendSeries_(AUTH, { series_key: key, weeks: 25 }).ok === false,
    JSON.stringify(ctx.vsExtendSeries_(AUTH, { series_key: key, weeks: 25 })));
  t('extend can retarget the technician',
    ctx.vsExtendSeries_(AUTH, { series_key: key, weeks: 1, technician: 'Tony' }).technician === 'Tony');
}

// ─── Auth wiring ─────────────────────────────────────────────────────────────
console.log('\nAction wiring');
{
  const { ctx } = buildContext();
  const routed = ctx.handleVisitSeriesAction_('visit_series_list', AUTH, {});
  t('visit_series_list is routed', routed.ok === true && Array.isArray(routed.series));
  t('technicians cannot manage series',
    ctx.handleVisitSeriesAction_('visit_series_list', { ok: true, roles: ['technician'] }, {}).ok === false);
  t('an unauthenticated caller is refused',
    ctx.handleVisitSeriesAction_('visit_series_list', { ok: false }, {}).ok === false);
  t('an unknown series action is refused',
    ctx.handleVisitSeriesAction_('visit_series_nope', AUTH, {}).ok === false);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
