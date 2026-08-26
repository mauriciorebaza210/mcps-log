// Bulk reschedule engine regression suite.
//
//   node tests/reschedule.test.js
//
// Runs appscript/Reschedule.js against in-memory spreadsheet stubs. The goal is
// to lock the dangerous invariants: no per-pool notifier, rollback restores the
// previous override, and future permanent batches do not mutate Routes early.
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
  setValue(value) {
    return this.setValues([[value]]);
  }
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
  constructor(sheets) {
    this.sheets = sheets || {};
  }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) {
    const sheet = new Sheet(name, null, []);
    this.sheets[name] = sheet;
    return sheet;
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
  const routeHeaders = ['day_of_week','operator','pool_id','customer_name','address','city','service','maps_link','lat','lng','pinned','route_status','monthly_week'];
  const routes = new Spreadsheet({
    Routes: new Sheet('Routes', routeHeaders, [
      ['Monday','Tony','P1','Rivera','1 A','San Antonio','Weekly Full Service','',29,-98,'FALSE','',''],
      ['Thursday','Tony','P2','Lopez','2 B','San Antonio','Weekly Full Service','',29,-98,'FALSE','',''],
      ['Tuesday','Mia','P3','Pinned','3 C','San Antonio','Weekly Full Service','',29,-98,'TRUE','',''],
      ['Wednesday','Tony','P4','Inactive','4 D','San Antonio','Weekly Full Service','',29,-98,'FALSE','inactive','']
    ]),
    Weekly_Overrides: new Sheet('Weekly_Overrides',
      ['week_start','pool_id','override_day','override_operator','created_at','batch_id'],
      [['2026-09-07','P1','Wednesday','Mia','old-created','']]
    ),
    Scheduled_Visits: new Sheet('Scheduled_Visits',
      ['scheduled_visit_id','pool_id','customer_name','service_type','visit_type','scheduled_date','assigned_technician','status','completed_at','completed_by','chem_log_ref','notes','created_at','created_by'],
      [['SV-OLD','P1','Rivera','Weekly Full Service','weekly_override','2026-09-09','Mia','scheduled','','','','weekly_override:2026-09-07 moved_to:Wednesday','old-created','admin']]
    )
  });
  const crm = new Spreadsheet({
    Quotes: new Sheet('Quotes',
      ['pool_id','first_name','last_name','customer_name','email','quote_id','area','address','city','schedule_notified_at'],
      [['P1','Ana','Rivera','Ana Rivera','ana@example.com','Q1','NW','1 A','San Antonio','']]
    )
  });
  const settings = new Spreadsheet({});

  let lockHeld = false;
  let uuid = 0;
  const notified = [];
  const warmedWeeks = [];
  const ctx = {
    console,
    String, Number, Math, JSON, Array, Object, RegExp, Set, Date: FrozenDate,
    isNaN, encodeURIComponent,
    Logger: { log: () => {} },
    Utilities: {
      getUuid: () => 'uuid-' + (++uuid),
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
    LockService: { getScriptLock: () => ({
      tryLock: () => { if (lockHeld) return false; lockHeld = true; return true; },
      releaseLock: () => { lockHeld = false; }
    })},
    CacheService: { getScriptCache: () => ({ removeAll: () => {}, remove: () => {} }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => {} }) }), everyHours: () => ({ create: () => {} }) }) }) },
    validateToken: () => ({ ok: true, username: 'admin', name: 'Admin', roles: ['admin'], user: { username: 'admin' } }),
    hasRole: (auth, role) => (auth.roles || []).includes(role),
    getTechnicianOperators_: () => [
      { name: 'Tony', maxPerDay: 3, days: ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY'] },
      { name: 'Mia', maxPerDay: 1, days: ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY'] }
    ],
    getWeekStart_: () => '2026-09-07',
    getWeekStartForDate_: value => {
      const d = value instanceof Date ? new Date(value.getTime()) : new Date(String(value).slice(0, 10) + 'T12:00:00');
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
    notifyScheduleChangeIfNeeded_: () => { throw new Error('bulk apply must not call the single-pool notifier'); },
    recordScheduleNotified_: (poolId, day, operator) => notified.push({ poolId, day, operator }),
    computeRouteData_: week => { warmedWeeks.push(week); return { ok: true }; }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'Reschedule.js' });
  return { ctx, routes, crm, settings, notified, warmedWeeks };
}

console.log('\nReschedule preflight');
{
  const { ctx } = buildContext();
  const res = ctx.handleRescheduleAction_('reschedule_preflight', ctx.validateToken(), {
    scope: 'week',
    effective_week: '2026-09-07',
    items: [{ pool_id: 'P4', new_day: 'Friday', new_operator: 'Tony' }]
  });
  t('inactive Routes row is blocked', res.ok && res.blockers > 0 && /inactive/.test(res.verdicts[0].blockers.join(' ')));
}

console.log('\nValidation, warnings, and capacity');
{
  const { ctx, routes } = buildContext();
  const range = ctx.handleRescheduleAction_('reschedule_preflight', ctx.validateToken(), {
    scope: 'multi_week',
    effective_week: '2026-09-07',
    duration_weeks: 4,
    items: [{ pool_id: 'P2', new_day: 'Monday' }]
  });
  t('multi_week + duration_weeks normalizes to a 4-week range',
    range.ok && range.scope === 'range' && range.week_count === 4 && range.end_week === '2026-09-28');

  const dup = ctx.handleRescheduleAction_('reschedule_preflight', ctx.validateToken(), {
    scope: 'week',
    effective_week: '2026-09-07',
    items: [
      { pool_id: 'P2', new_day: 'Monday' },
      { pool_id: 'P2', new_day: 'Tuesday' }
    ]
  });
  t('duplicate pool ids are rejected before apply', dup.ok === false && /Duplicate pool_id/.test(dup.error));

  const badTech = ctx.handleRescheduleAction_('reschedule_preflight', ctx.validateToken(), {
    scope: 'week',
    effective_week: '2026-09-07',
    items: [{ pool_id: 'P2', new_day: 'Friday', new_operator: 'Ghost' }]
  });
  t('unknown target technician is blocked',
    badTech.ok && badTech.blockers > 0 && /not an active technician/.test(badTech.verdicts[0].blockers.join(' ')));

  const unavailable = ctx.handleRescheduleAction_('reschedule_preflight', ctx.validateToken(), {
    scope: 'week',
    effective_week: '2026-09-07',
    items: [{ pool_id: 'P2', new_day: 'Saturday', new_operator: 'Tony' }]
  });
  t('technician unavailable day is blocked',
    unavailable.ok && unavailable.blockers > 0 && /outside operator available_days/.test(unavailable.verdicts[0].blockers.join(' ')));

  const locked = ctx.handleRescheduleAction_('reschedule_preflight', ctx.validateToken(), {
    scope: 'week',
    effective_week: '2026-08-31',
    items: [{ pool_id: 'P2', new_day: 'Friday', new_operator: 'Tony' }]
  });
  t('past target date is blocked',
    locked.ok && locked.blockers > 0 && /has already passed/.test(locked.verdicts[0].blockers.join(' ')));
  t('the past-date blocker names the day, not a "lock"',
    // There is no admin lock mechanism in this app — saying "locked" sent people
    // hunting for a lock they could not have set.
    /Friday of 2026-08-31/.test(locked.verdicts[0].blockers.join(' ')) &&
    !/locked/i.test(locked.verdicts[0].blockers.join(' ')),
    JSON.stringify(locked.verdicts[0].blockers));

  const pinnedApply = ctx.handleRescheduleAction_('reschedule_apply', ctx.validateToken(), {
    batch_id: 'B-PINNED-NOACK',
    scope: 'week',
    effective_week: '2026-09-07',
    items: [{ pool_id: 'P3', new_day: 'Wednesday', new_operator: 'Mia' }]
  });
  t('apply refuses warnings until acknowledged',
    pinnedApply.ok === false && /Warnings require acknowledgement/.test(pinnedApply.error));

  const routeSheet = routes.getSheetByName('Routes');
  routeSheet.appendRow(['Friday','Tony','P5','Extra 1','5 E','San Antonio','Weekly Full Service','',29,-98,'FALSE','','']);
  routeSheet.appendRow(['Friday','Tony','P6','Extra 2','6 F','San Antonio','Weekly Full Service','',29,-98,'FALSE','','']);
  routeSheet.appendRow(['Friday','Tony','P7','Extra 3','7 G','San Antonio','Weekly Full Service','',29,-98,'FALSE','','']);
  const cap = ctx.handleRescheduleAction_('reschedule_preflight', ctx.validateToken(), {
    scope: 'week',
    effective_week: '2026-09-07',
    items: [{ pool_id: 'P2', new_day: 'Friday' }]
  });
  t('over-capacity warning attaches when technician is kept',
    cap.ok && cap.warnings > 0 && /max_per_day/.test(cap.verdicts[0].warnings.join(' ')));
}

console.log('\nMulti-week temporary apply/revert');
{
  const { ctx, routes } = buildContext();
  const apply = ctx.handleRescheduleAction_('reschedule_apply', ctx.validateToken(), {
    batch_id: 'B-4W',
    scope: 'weeks',
    effective_week: '2026-09-07',
    duration_weeks: 4,
    items: [{ pool_id: 'P2', new_day: 'Monday' }],
    acknowledge_warnings: true
  });
  const overridesAfterApply = rowsAsObjects(routes.getSheetByName('Weekly_Overrides'));
  const p2Overrides = overridesAfterApply.filter(r => r.pool_id === 'P2' && r.batch_id === 'B-4W');
  const visitsAfterApply = rowsAsObjects(routes.getSheetByName('Scheduled_Visits'));
  const warmupsAfterApply = rowsAsObjects(ctx.rsWarmupSheet_());

  t('4-week temporary apply succeeds', apply.ok === true, apply.error || '');
  t('4-week temporary apply writes one override per week',
    p2Overrides.length === 4 &&
    p2Overrides.map(r => r.week_start).join(',') === '2026-09-07,2026-09-14,2026-09-21,2026-09-28');
  t('4-week temporary apply writes one dated visit per week',
    visitsAfterApply.filter(v => /reschedule_batch:B-4W/.test(v.notes)).length === 4);
  t('4-week temporary apply queues each affected week for distance warming',
    warmupsAfterApply.filter(r => r.source_batch_id === 'B-4W' && r.status === 'pending').length === 4);

  const revert = ctx.handleRescheduleAction_('reschedule_revert', ctx.validateToken(), { batch_id: 'B-4W' });
  const overridesAfterRevert = rowsAsObjects(routes.getSheetByName('Weekly_Overrides'));
  const visitsAfterRevert = rowsAsObjects(routes.getSheetByName('Scheduled_Visits'));
  t('4-week temporary revert succeeds', revert.ok === true, revert.error || '');
  t('4-week temporary revert removes batch overrides',
    overridesAfterRevert.filter(r => r.pool_id === 'P2' && r.batch_id === 'B-4W').length === 0);
  t('4-week temporary revert cancels batch visits',
    visitsAfterRevert.filter(v => /reschedule_batch:B-4W/.test(v.notes) && v.status === 'cancelled').length === 4);
}

console.log('\nDistance warmup worker');
{
  const { ctx, warmedWeeks } = buildContext();
  ctx.handleRescheduleAction_('reschedule_apply', ctx.validateToken(), {
    batch_id: 'B-WARM',
    scope: 'range',
    effective_week: '2026-09-07',
    duration_weeks: 2,
    items: [{ pool_id: 'P2', new_day: 'Monday' }],
    acknowledge_warnings: true
  });
  const processed = ctx.handleRescheduleAction_('reschedule_warm_distances', ctx.validateToken(), { limit: 5 });
  const warmups = rowsAsObjects(ctx.rsWarmupSheet_()).filter(r => r.source_batch_id === 'B-WARM');
  t('distance warmup worker processes queued weeks',
    processed.ok === true && processed.processed === 2 && warmedWeeks.join(',') === '2026-09-07,2026-09-14');
  t('distance warmup ledger marks weeks done',
    warmups.length === 2 && warmups.every(r => r.status === 'done'));
}

console.log('\nWeek apply/revert restores previous override and visit audit');
{
  const { ctx, routes } = buildContext();
  const apply = ctx.handleRescheduleAction_('reschedule_apply', ctx.validateToken(), {
    batch_id: 'B-WEEK',
    scope: 'week',
    effective_week: '2026-09-07',
    items: [{ pool_id: 'P1', new_day: 'Friday', new_operator: 'Tony' }],
    acknowledge_warnings: true
  });
  const overridesAfterApply = rowsAsObjects(routes.getSheetByName('Weekly_Overrides'));
  const visitsAfterApply = rowsAsObjects(routes.getSheetByName('Scheduled_Visits'));
  const itemsAfterApply = rowsAsObjects(ctx.rsItemSheet_());

  t('week apply succeeds', apply.ok === true, apply.error || '');
  t('batch override row carries batch_id',
    overridesAfterApply.length === 1 &&
    overridesAfterApply[0].override_day === 'Friday' &&
    overridesAfterApply[0].batch_id === 'B-WEEK');
  t('previous override is captured per item-week',
    itemsAfterApply[0].prev_had_override === 'TRUE' &&
    itemsAfterApply[0].prev_override_day === 'Wednesday');
  t('old weekly_override Scheduled_Visits row is cancelled during apply',
    visitsAfterApply.some(v => v.scheduled_visit_id === 'SV-OLD' && v.status === 'cancelled'));
  t('batch Scheduled_Visits row is created for the new day',
    visitsAfterApply.some(v => /reschedule_batch:B-WEEK/.test(v.notes) && v.scheduled_date === '2026-09-11'));

  const revert = ctx.handleRescheduleAction_('reschedule_revert', ctx.validateToken(), { batch_id: 'B-WEEK' });
  const overridesAfterRevert = rowsAsObjects(routes.getSheetByName('Weekly_Overrides'));
  const visitsAfterRevert = rowsAsObjects(routes.getSheetByName('Scheduled_Visits'));

  t('week revert succeeds', revert.ok === true, revert.error || '');
  t('previous override is restored, not erased',
    overridesAfterRevert.length === 1 &&
    overridesAfterRevert[0].override_day === 'Wednesday' &&
    String(overridesAfterRevert[0].batch_id || '') === '');
  t('previous Scheduled_Visits audit row is restored',
    visitsAfterRevert.some(v => v.scheduled_visit_id === 'SV-OLD' && v.status === 'scheduled'));
  t('batch Scheduled_Visits audit row is cancelled on revert',
    visitsAfterRevert.some(v => /reschedule_batch:B-WEEK/.test(v.notes) && v.status === 'cancelled'));
}

console.log('\nPermanent apply/revert');
{
  const { ctx, routes, notified } = buildContext();
  const apply = ctx.handleRescheduleAction_('reschedule_apply', ctx.validateToken(), {
    batch_id: 'B-PERM',
    scope: 'permanent',
    effective_week: '2026-09-07',
    items: [{ pool_id: 'P2', new_day: 'Friday', new_operator: 'Mia' }],
    acknowledge_warnings: true
  });
  const routeRows = rowsAsObjects(routes.getSheetByName('Routes'));
  const p2 = routeRows.find(r => r.pool_id === 'P2');
  t('permanent apply succeeds', apply.ok === true, apply.error || '');
  t('permanent apply mutates Routes in one batch path',
    p2.day_of_week === 'Friday' && p2.operator === 'Mia' && p2.pinned === 'TRUE');
  t('permanent apply did not notify customers directly', notified.length === 0);

  ctx.rsAfterCommsRecipientSent_(
    { audience_json: JSON.stringify({ type: 'reschedule_batch', batch_id: 'B-PERM' }) },
    {},
    { properties: [{ pool_id: 'P2', new_day: 'Friday', operator: 'Mia' }] },
    '2026-09-07T14:00:00.000Z'
  );
  t('post-send hook records schedule notification only after Comms sent',
    notified.length === 1 && notified[0].poolId === 'P2' && notified[0].day === 'Friday');

  const revert = ctx.handleRescheduleAction_('reschedule_revert', ctx.validateToken(), { batch_id: 'B-PERM' });
  const p2After = rowsAsObjects(routes.getSheetByName('Routes')).find(r => r.pool_id === 'P2');
  t('permanent revert succeeds', revert.ok === true, revert.error || '');
  t('permanent revert restores day/operator/pinned',
    p2After.day_of_week === 'Thursday' && p2After.operator === 'Tony' && p2After.pinned === 'FALSE');
}

console.log('\nPermanent day-only move and conflict-safe revert');
{
  const { ctx, routes } = buildContext();
  const apply = ctx.handleRescheduleAction_('reschedule_apply', ctx.validateToken(), {
    batch_id: 'B-PERM-DAY',
    scope: 'permanent',
    effective_week: '2026-09-07',
    items: [{ pool_id: 'P2', new_day: 'Friday' }],
    acknowledge_warnings: true
  });
  const p2 = rowsAsObjects(routes.getSheetByName('Routes')).find(r => r.pool_id === 'P2');
  t('permanent day-only move keeps original technician',
    apply.ok === true && p2.day_of_week === 'Friday' && p2.operator === 'Tony');

  const routeSheet = routes.getSheetByName('Routes');
  routeSheet.rows[2][0] = 'Monday';
  routeSheet.rows[2][1] = 'Mia';
  const revert = ctx.handleRescheduleAction_('reschedule_revert', ctx.validateToken(), { batch_id: 'B-PERM-DAY' });
  const p2After = rowsAsObjects(routeSheet).find(r => r.pool_id === 'P2');
  t('permanent revert refuses to overwrite a newer manual route change',
    revert.ok === false && p2After.day_of_week === 'Monday' && p2After.operator === 'Mia');
}

console.log('\nTemporary revert conflict safety');
{
  const { ctx, routes } = buildContext();
  const apply = ctx.handleRescheduleAction_('reschedule_apply', ctx.validateToken(), {
    batch_id: 'B-CONFLICT',
    scope: 'week',
    effective_week: '2026-09-07',
    items: [{ pool_id: 'P2', new_day: 'Friday', new_operator: 'Tony' }],
    acknowledge_warnings: true
  });
  const ovSheet = routes.getSheetByName('Weekly_Overrides');
  ovSheet.appendRow(['2026-09-07','P2','Tuesday','Mia','later-created','B-LATER']);
  const revert = ctx.handleRescheduleAction_('reschedule_revert', ctx.validateToken(), { batch_id: 'B-CONFLICT' });
  const overrides = rowsAsObjects(ovSheet).filter(r => r.pool_id === 'P2');
  const visits = rowsAsObjects(routes.getSheetByName('Scheduled_Visits'));
  t('temporary conflict fixture applied first', apply.ok === true, apply.error || '');
  t('temporary revert reports conflict instead of clobbering newer override',
    revert.ok === false && overrides.some(r => r.batch_id === 'B-LATER' && r.override_day === 'Tuesday'));
  t('temporary conflict revert removes this batch override rows',
    !overrides.some(r => r.batch_id === 'B-CONFLICT'));
  t('temporary conflict revert cancels this batch visit rows',
    visits.some(v => /reschedule_batch:B-CONFLICT/.test(v.notes) && v.status === 'cancelled'));
}

console.log('\nFuture permanent batches');
{
  const { ctx, routes } = buildContext();
  const apply = ctx.handleRescheduleAction_('reschedule_apply', ctx.validateToken(), {
    batch_id: 'B-FUTURE',
    scope: 'permanent',
    effective_week: '2026-09-14',
    items: [{ pool_id: 'P2', new_day: 'Friday', new_operator: 'Mia' }],
    acknowledge_warnings: true
  });
  const p2 = rowsAsObjects(routes.getSheetByName('Routes')).find(r => r.pool_id === 'P2');
  const batch = rowsAsObjects(ctx.rsBatchSheet_()).find(r => r.batch_id === 'B-FUTURE');
  const item = rowsAsObjects(ctx.rsItemSheet_()).find(r => r.batch_id === 'B-FUTURE');
  t('future permanent batch is pending', apply.ok === true && batch.status === 'pending');
  t('future permanent batch does not mutate Routes early',
    p2.day_of_week === 'Thursday' && p2.operator === 'Tony');
  t('future permanent pending item does not capture stale rollback yet',
    item.status === 'pending' && !item.prev_day);

  ctx.getWeekStart_ = () => '2026-09-14';
  ctx.rsPromotePendingBatches_();
  const promotedP2 = rowsAsObjects(routes.getSheetByName('Routes')).find(r => r.pool_id === 'P2');
  const promotedBatch = rowsAsObjects(ctx.rsBatchSheet_()).find(r => r.batch_id === 'B-FUTURE');
  const promotedItem = rowsAsObjects(ctx.rsItemSheet_()).find(r => r.batch_id === 'B-FUTURE');
  t('future permanent batch promotes when its effective week arrives',
    promotedBatch.status === 'applied' && promotedP2.day_of_week === 'Friday' && promotedP2.operator === 'Mia');
  t('future permanent promotion captures rollback at promotion time',
    promotedItem.status === 'applied' && promotedItem.prev_day === 'Thursday' && promotedItem.prev_operator === 'Tony');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
