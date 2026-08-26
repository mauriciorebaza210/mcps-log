// Reschedule notification preview + test send regression suite.
//
//   node tests/reschedule-notifications.test.js
//
// Loads appscript/Reschedule.js AND appscript/Comms.js into one context so the
// preview runs through the REAL commsDedupeAndFlag_ the sender uses — a preview
// count that drifts from the send count is the whole failure mode here.
//
// The other invariant under test: a test send reaches the admin and nothing
// else. It must not stamp campaign_id, notify_status, or schedule_notified_at.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RS_SRC = path.join(__dirname, '..', 'appscript', 'Reschedule.js');
const COMMS_SRC = path.join(__dirname, '..', 'appscript', 'Comms.js');
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

const BATCH_HEADERS = ['batch_id','status','scope','effective_week','end_week','reason_code',
  'message_subject','message_body','created_by','created_at','applied_at','reverted_at',
  'item_count','applied_count','failed_count','notify_enabled','campaign_id','notified_count',
  'cursor','error','request_hash'];

const ITEM_HEADERS = ['batch_id','item_id','pool_id','week_start','customer_name','prev_day',
  'prev_operator','prev_pinned','prev_override_day','prev_override_operator','prev_had_override',
  'prev_override_batch_id','prev_override_created_at','prev_visit_json','new_day','new_operator',
  'status','skip_reason','notify_status','notified_at','error'];

// batch_id, item_id, pool_id, week, customer, prev_day, prev_op → new_day, new_op, status
function itemRow(poolId, customer, prevDay, prevOp, newDay, newOp, status) {
  const o = {
    batch_id: 'B-APPLIED', item_id: 'I-' + poolId, pool_id: poolId, week_start: '2026-09-07',
    customer_name: customer, prev_day: prevDay, prev_operator: prevOp, prev_pinned: 'FALSE',
    prev_override_day: '', prev_override_operator: '', prev_had_override: 'FALSE',
    prev_override_batch_id: '', prev_override_created_at: '', prev_visit_json: '',
    new_day: newDay, new_operator: newOp, status: status, skip_reason: '',
    notify_status: '', notified_at: '', error: ''
  };
  return ITEM_HEADERS.map(h => o[h] ?? '');
}

function buildContext() {
  const routes = new Spreadsheet({
    Routes: new Sheet('Routes',
      ['day_of_week','operator','pool_id','customer_name','address','city','service','maps_link','lat','lng','pinned','route_status','monthly_week'],
      []
    )
  });

  // P1 and P5 deliberately share ana@example.com (dedupe), P2 has no email
  // (invalid), P3 is opted out. P4 is a failed item and must never surface.
  const crm = new Spreadsheet({
    Quotes: new Sheet('Quotes',
      ['pool_id','first_name','last_name','customer_name','email','quote_id','area','address','city','schedule_notified_at'],
      [
        ['P1','Ana','Rivera','Ana Rivera','ana@example.com','Q1','NW','1 A','San Antonio','2026-09-04T09:00:00.000Z'],
        ['P2','Beto','Lopez','Beto Lopez','','Q2','NE','2 B','San Antonio',''],
        ['P3','Cruz','Diaz','Cruz Diaz','opt@example.com','Q3','SW','3 C','San Antonio',''],
        ['P4','Dee','Ortiz','Dee Ortiz','dee@example.com','Q4','SE','4 D','San Antonio',''],
        ['P5','Ana','Rivera','Ana Rivera','ana@example.com','Q5','NW','5 E','San Antonio','2026-09-04T09:00:00.000Z']
      ]
    )
  });

  const settings = new Spreadsheet({
    Reschedule_Batches: new Sheet('Reschedule_Batches', BATCH_HEADERS, [
      BATCH_HEADERS.map(h => ({
        batch_id: 'B-APPLIED', status: 'applied', scope: 'week', effective_week: '2026-09-07',
        end_week: '2026-09-07', created_by: 'Admin', created_at: '2026-09-07T08:00:00.000Z',
        applied_at: '2026-09-07T08:00:00.000Z', item_count: 5, applied_count: 4, failed_count: 1,
        notify_enabled: '', campaign_id: '', notified_count: ''
      }[h] ?? ''))
    ]),
    Reschedule_Items: new Sheet('Reschedule_Items', ITEM_HEADERS, [
      itemRow('P1', 'Ana Rivera', 'Monday', 'Tony', 'Wednesday', 'Mia', 'applied'),
      itemRow('P2', 'Beto Lopez', 'Thursday', 'Tony', 'Friday', 'Tony', 'applied'),
      itemRow('P3', 'Cruz Diaz', 'Tuesday', 'Mia', 'Monday', 'Mia', 'applied'),
      itemRow('P4', 'Dee Ortiz', 'Monday', 'Tony', 'Saturday', 'Tony', 'failed'),
      itemRow('P5', 'Ana Rivera', 'Monday', 'Tony', 'Saturday', 'Mia', 'applied')
    ]),
    Comms_Optouts: new Sheet('Comms_Optouts',
      ['email','scope','opted_out_at','source','recipient_id'],
      [['opt@example.com','all','2026-08-01T00:00:00.000Z','manual','']]
    )
  });

  let uuid = 0;
  const notified = [];
  const campaigns = [];
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
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ removeAll: () => {}, remove: () => {} }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => {} }) }), everyHours: () => ({ create: () => {} }) }) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => '' }) },
    // Header normalizer Comms.js borrows from HubUtils.
    huHeader_: h => String(h == null ? '' : h).trim().toLowerCase().replace(/ /g, '_'),
    validateToken: () => ({ ok: true, username: 'admin', name: 'Admin', roles: ['admin'], email: 'boss@mcpoolsolutions.org' }),
    hasRole: (auth, role) => (auth.roles || []).includes(role),
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
    getTechnicianOperators_: () => [],
    monthlyMatchesWeek_: () => true,
    isPoolVisibleForWeek_: () => true,
    recordScheduleNotified_: (poolId, day, operator) => notified.push({ poolId, day, operator }),
    computeRouteData_: () => ({ ok: true })
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(COMMS_SRC, 'utf8'), ctx, { filename: 'Comms.js' });
  vm.runInContext(fs.readFileSync(RS_SRC, 'utf8'), ctx, { filename: 'Reschedule.js' });

  // Stub only the transport. Audience resolution, dedupe, opt-out filtering and
  // placeholder rendering all run for real.
  ctx.handleCommsSendCampaign_ = (auth, payload) => {
    campaigns.push(payload);
    return { ok: true, campaign_id: 'CAMP-' + campaigns.length, total: 1, sendable: 1, skipped: 0 };
  };

  return { ctx, settings, notified, campaigns };
}

function snapshot(settings) {
  return JSON.stringify({
    batches: settings.getSheetByName('Reschedule_Batches').rows,
    items: settings.getSheetByName('Reschedule_Items').rows
  });
}

// ─── Recipient preview ───────────────────────────────────────────────────────
console.log('\nRecipient preview');
{
  const { ctx, settings } = buildContext();
  const before = snapshot(settings);
  const res = ctx.rsNotifyPreview_({ batch_id: 'B-APPLIED' });
  const after = snapshot(settings);

  t('preview succeeds', res.ok === true, JSON.stringify(res.error || ''));
  t('preview writes nothing to the batch or item sheets', before === after);

  const tt = res.totals || {};
  t('three deduped recipients from four applied items', tt.total === 3, JSON.stringify(tt));
  t('only one recipient is sendable', tt.sendable === 1, JSON.stringify(tt));
  t('missing email is counted and skipped', tt.missing_email === 1, JSON.stringify(tt));
  t('opted-out customer is counted and skipped', tt.opted_out === 1, JSON.stringify(tt));
  t('pool count spans every applied item', tt.pools === 4, JSON.stringify(tt));

  const ana = (res.recipients || []).find(r => r.email === 'ana@example.com');
  t('duplicate email collapses to one recipient', !!ana && ana.week_count === 2, JSON.stringify(ana));
  t('collapsed recipient lists both pools',
    !!ana && ana.pool_ids.indexOf('P1') !== -1 && ana.pool_ids.indexOf('P5') !== -1,
    JSON.stringify(ana && ana.pool_ids));
  t('collapsed recipient is sendable', !!ana && ana.sendable === true);
  t('recent notification is flagged', !!ana && ana.notified_recently === true);

  const beto = (res.recipients || []).find(r => (r.pool_ids || []).indexOf('P2') !== -1);
  t('missing-email recipient carries a skip reason',
    !!beto && beto.sendable === false && /email/.test(beto.skip_reason), JSON.stringify(beto));

  const cruz = (res.recipients || []).find(r => r.email === 'opt@example.com');
  t('opted-out recipient carries a skip reason',
    !!cruz && cruz.sendable === false && cruz.skip_reason === 'opted out', JSON.stringify(cruz));

  const failedLeak = (res.recipients || []).some(r => (r.pool_ids || []).indexOf('P4') !== -1);
  t('failed item is never notified', failedLeak === false);

  const sample = res.sample || {};
  t('sample renders against a real moved pool',
    /Ana/.test(sample.body_html || '') &&
    /Monday/.test(sample.body_html || '') &&
    /Wednesday/.test(sample.body_html || ''),
    JSON.stringify(sample.body_html));
  t('sample leaves no unresolved placeholders',
    !/\{\{/.test(String(sample.subject || '') + String(sample.body_html || '')),
    JSON.stringify(sample));
}

{
  // A preview that finds nobody must still succeed with zeroes so the UI can
  // disable the queue button rather than showing an error.
  const { ctx } = buildContext();
  const items = ctx.rsBatchItems_('B-APPLIED');
  const sheet = ctx.rsItemSheet_();
  items.forEach(it => ctx.rsPatchRow_(sheet, it._row, { status: 'failed' }));
  const res = ctx.rsNotifyPreview_({ batch_id: 'B-APPLIED' });
  t('empty audience still returns ok with zero sendable',
    res.ok === true && res.totals.total === 0 && res.totals.sendable === 0, JSON.stringify(res.totals));
}

{
  const { ctx } = buildContext();
  t('preview requires a batch_id', ctx.rsNotifyPreview_({}).ok === false);
  t('preview rejects an unknown batch', ctx.rsNotifyPreview_({ batch_id: 'nope' }).ok === false);
}

// ─── Test send ───────────────────────────────────────────────────────────────
console.log('\nTest send');
{
  const { ctx, settings, campaigns, notified } = buildContext();
  const before = snapshot(settings);
  const res = ctx.rsNotifyTest_({ ok: true, username: 'admin', email: 'boss@mcpoolsolutions.org' },
                                { batch_id: 'B-APPLIED' });
  const after = snapshot(settings);

  t('test send succeeds', res.ok === true, JSON.stringify(res.error || ''));
  t('test send defaults to the requesting admin', res.test_email === 'boss@mcpoolsolutions.org');
  t('test send touches neither the batch row nor any item', before === after);
  t('test send marks nobody notified', notified.length === 0);

  const camp = campaigns[0] || {};
  t('test campaign is labelled as a test', /^TEST /.test(String(camp.name || '')), camp.name);
  t('test audience carries test_email',
    camp.audience && camp.audience.test_email === 'boss@mcpoolsolutions.org', JSON.stringify(camp.audience));
  t('test send runs inline', camp.run_inline === true);
}

{
  const { ctx } = buildContext();
  const res = ctx.rsNotifyTest_({ ok: true, username: 'admin', email: '' }, { batch_id: 'B-APPLIED' });
  t('test send without an address is refused', res.ok === false && /test address/i.test(res.error));
}

{
  const { ctx } = buildContext();
  const audience = ctx.rsResolveCommsAudience_({ batch_id: 'B-APPLIED', test_email: 'boss@mcpoolsolutions.org' });
  t('test audience resolves to exactly one recipient', audience.length === 1, JSON.stringify(audience.length));
  t('test audience swaps only the address',
    audience[0].email === 'boss@mcpoolsolutions.org' &&
    audience[0].old_day === 'Monday' && audience[0].new_day === 'Wednesday' &&
    audience[0].pool_id === 'P1',
    JSON.stringify(audience[0]));
}

// ─── Post-send hook guard ────────────────────────────────────────────────────
console.log('\nPost-send hook');
{
  const { ctx, settings, notified } = buildContext();
  const recipient = { email: 'boss@mcpoolsolutions.org', properties: [{ pool_id: 'P1', new_day: 'Wednesday', operator: 'Mia' }] };
  const before = snapshot(settings);
  ctx.rsAfterCommsRecipientSent_(
    { audience_json: JSON.stringify({ type: 'reschedule_batch', batch_id: 'B-APPLIED', test_email: 'boss@mcpoolsolutions.org' }) },
    {}, recipient, '2026-09-07T09:00:00.000Z'
  );
  t('test-send hook marks no item notified', snapshot(settings) === before);
  t('test-send hook never stamps schedule_notified_at', notified.length === 0);
}

{
  // Control: without test_email the same call MUST mark the item, proving the
  // assertions above are the guard working and not a dead fixture.
  const { ctx, notified } = buildContext();
  const recipient = { email: 'ana@example.com', properties: [{ pool_id: 'P1', new_day: 'Wednesday', operator: 'Mia' }] };
  ctx.rsAfterCommsRecipientSent_(
    { audience_json: JSON.stringify({ type: 'reschedule_batch', batch_id: 'B-APPLIED' }) },
    {}, recipient, '2026-09-07T09:00:00.000Z'
  );
  const item = ctx.rsBatchItems_('B-APPLIED').find(it => String(it.pool_id) === 'P1');
  t('real send marks the item sent', item && String(item.notify_status) === 'sent', JSON.stringify(item && item.notify_status));
  t('real send stamps schedule_notified_at', notified.length === 1, JSON.stringify(notified));

  const batch = ctx.rsFindBatch_('B-APPLIED');
  t('real send updates the batch notified count', Number(batch.notified_count) === 1, JSON.stringify(batch.notified_count));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
