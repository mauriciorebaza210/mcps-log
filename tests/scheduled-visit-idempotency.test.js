// B7 — the promised first visit is created exactly once.
//
//   node tests/scheduled-visit-idempotency.test.js
//
// Signing is retried on network failure, and createScheduledVisit_ has no dedupe
// guard of its own. Without ensureWeeklyServiceVisit_, a customer who tapped
// "Accept & Sign" twice — or whose phone dropped mid-request — would get two
// "first visits" on the route board and consume two slots of their zone's
// capacity.
//
// THE LAYERING THIS SUITE PINS DOWN:
//
//   The SHEET is the durable record. claimDedupAction_ is only a race guard.
//
// Script properties expire and cap at 50 entries, so a claim cannot be the
// permanent record — the "claim cleared, sheet still has the row" case below is
// exactly the retry-after-collection scenario that makes properties unsafe here.
//
// And the key must stay COLLECTABLE: claimDedupAction_'s cleanup only deletes
// keys ending in 'yyyy-MM-dd HH:mm'. A key without that suffix accumulates until
// the 50-property store is exhausted, at which point every caller of
// claimDedupAction_ starts failing — including chemical-usage dedup, which has
// nothing to do with this feature.
//
// THE WRITE IS GATED ON BOTH LAYERS. Losing the claim is not a licence to append
// after one empty read: the loser re-reading a few milliseconds early sees the
// same empty sheet the winner did, and both append. A lost claim yields
// pending:true and an exception row instead — visible, and singular.
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'appscript/ScheduledVisits.js');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

const SV_H = ['scheduled_visit_id','pool_id','customer_name','service_type','visit_type',
              'scheduled_date','assigned_technician','status','completed_at','completed_by',
              'chem_log_ref','notes','created_at','created_by'];

function build(o) {
  o = o || {};
  const rows = (o.rows || []).map(r => {
    const row = new Array(SV_H.length).fill('');
    Object.keys(r).forEach(k => { const i = SV_H.indexOf(k); if (i !== -1) row[i] = r[k]; });
    if (!row[0]) row[0] = 'uuid-' + Math.random().toString(36).slice(2, 8);
    return row;
  });

  const claims = [], exceptions = [];
  let claimResult = o.claimResult === undefined ? true : o.claimResult;

  const sheet = {
    getLastRow: () => rows.length + 1,
    getDataRange: () => ({ getValues: () => [SV_H, ...rows] }),
    appendRow: (r) => rows.push(r),
    setFrozenRows: () => {}, setColumnWidth: () => {}
  };

  // The sleep between rechecks is exactly the window the other execution's
  // append lands in, so the harness models it there: `landsOnSleep` writes the
  // winning row the first time this execution waits.
  let slept = 0;
  const sleep = () => {
    slept++;
    if (o.landsOnSleep && slept === 1) {
      const row = new Array(SV_H.length).fill('');
      Object.keys(o.landsOnSleep).forEach(k => {
        const i = SV_H.indexOf(k); if (i !== -1) row[i] = o.landsOnSleep[k];
      });
      if (!row[0]) row[0] = 'uuid-winner';
      rows.push(row);
    }
  };

  const ctx = {
    console, Date, String, Number, Math, JSON, Array, Object, isNaN, RegExp,
    Logger: { log: () => {} },
    Session: { getScriptTimeZone: () => 'America/Chicago' },
    Utilities: {
      getUuid: () => 'uuid-' + (rows.length + 1),
      sleep,
      formatDate: (d, tz, fmt) => {
        const p = n => String(n).padStart(2, '0');
        const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        return fmt === 'yyyy-MM-dd HH:mm' ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base;
      }
    },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }) },
    SV_ROUTES_SS_ID: 'x',
    CacheService: { getScriptCache: () => ({ remove: () => {} }) },
    claimDedupAction_: (action, key) => { claims.push({ action, key }); return claimResult; },
    recordAssignmentException_: (d) => { exceptions.push(d); return { ok: true }; }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'ScheduledVisits.js' });
  ctx._rows = rows; ctx._claims = claims; ctx._exceptions = exceptions;
  // Normalizes Date-typed cells the same way the code does — Sheets returns real
  // Dates for date-formatted cells, and a counter that only matched strings
  // would under-report exactly the rows this suite cares about.
  const cellIso = (v) => {
    if (v instanceof Date && !isNaN(v.getTime())) {
      const p = n => String(n).padStart(2, '0');
      return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    }
    return String(v || '').trim();
  };
  ctx._count = (pool, date) => rows.filter(r =>
    r[SV_H.indexOf('pool_id')] === pool &&
    cellIso(r[SV_H.indexOf('scheduled_date')]) === date &&
    r[SV_H.indexOf('visit_type')] === 'weekly_service').length;
  return ctx;
}

// ── The core property ───────────────────────────────────────────────────────
console.log('\n⚠️  Calling twice creates ONE visit');
{
  const ctx = build({});
  const a = ctx.ensureWeeklyServiceVisit_('P-1', '2026-08-25');
  const b = ctx.ensureWeeklyServiceVisit_('P-1', '2026-08-25');
  t('first call creates', a.ok === true && a.created === true);
  t('second call does NOT create', b.ok === true && b.created === false, '(created=' + b.created + ')');
  t('exactly one row exists', ctx._count('P-1', '2026-08-25') === 1,
    '(got ' + ctx._count('P-1', '2026-08-25') + ')');
}

console.log('Different dates create separate visits');
{
  const ctx = build({});
  ctx.ensureWeeklyServiceVisit_('P-1', '2026-08-25');
  ctx.ensureWeeklyServiceVisit_('P-1', '2026-09-01');
  t('two rows', ctx._rows.length === 2);
  t('one per date', ctx._count('P-1', '2026-08-25') === 1 && ctx._count('P-1', '2026-09-01') === 1);
}

console.log('Different pools on the same date do not collide');
{
  const ctx = build({});
  ctx.ensureWeeklyServiceVisit_('P-1', '2026-08-25');
  ctx.ensureWeeklyServiceVisit_('P-2', '2026-08-25');
  t('both created', ctx._count('P-1', '2026-08-25') === 1 && ctx._count('P-2', '2026-08-25') === 1);
}

// ── The reason properties can't be the record ───────────────────────────────
console.log('\n⚠️  The SHEET is authoritative — a cleared claim must not create a duplicate');
{
  // A row already exists, and the dedup claim has since expired and been
  // garbage-collected (claimDedupAction_ would happily grant it again). This is
  // the retry-after-collection case. The sheet scan has to catch it.
  const ctx = build({
    rows: [{ pool_id: 'P-1', scheduled_date: '2026-08-25', visit_type: 'weekly_service', status: 'scheduled' }],
    claimResult: true   // claim granted, i.e. no memory of the earlier write
  });
  const res = ctx.ensureWeeklyServiceVisit_('P-1', '2026-08-25');
  t('the existing row is found', res.ok === true && res.created === false);
  t('still exactly one row', ctx._count('P-1', '2026-08-25') === 1);
  t('the claim was not even needed', ctx._claims.length === 0,
    'the sheet is checked BEFORE the claim');
}

console.log('A lost race waits, then finds the winner\'s row');
{
  // claimDedupAction_ returns false: another execution holds the claim and is
  // mid-write. Its append lands while we wait. We adopt its row.
  const ctx = build({
    claimResult: false,
    landsOnSleep: { pool_id: 'P-1', scheduled_date: '2026-08-25',
                    visit_type: 'weekly_service', status: 'scheduled' }
  });
  const res = ctx.ensureWeeklyServiceVisit_('P-1', '2026-08-25');
  t('a claim was attempted', ctx._claims.length === 1);
  t('the winner\'s row is returned', res.ok === true && res.created === false);
  t('exactly one row exists', ctx._count('P-1', '2026-08-25') === 1,
    '(got ' + ctx._count('P-1', '2026-08-25') + ')');
  t('no exception was needed — the row arrived', ctx._exceptions.length === 0);
}

console.log('\n⚠️  A LOST claim never appends, even when the sheet still looks empty');
{
  // This is the case that makes the guard a guard. Two executions both read an
  // empty sheet; the loser re-reading a few milliseconds early sees exactly the
  // same empty sheet the winner did. Appending "just once, after re-checking"
  // is the double-write, not a fix for it.
  const ctx = build({ claimResult: false });
  const res = ctx.ensureWeeklyServiceVisit_('P-1', '2026-08-25');
  t('NOTHING was appended', ctx._rows.length === 0, '(got ' + ctx._rows.length + ' rows)');
  t('and it says so rather than claiming success',
    res.ok === true && res.created === false && res.pending === true,
    '(created=' + res.created + ', pending=' + res.pending + ')');
  t('the gap is recorded for ops', ctx._exceptions.length === 1);
  t('typed missing_first_visit', ctx._exceptions.length === 1 &&
    ctx._exceptions[0].type === 'missing_first_visit');
  t('it names the pool', ctx._exceptions.length === 1 && ctx._exceptions[0].pool_id === 'P-1');
  t('and the date', ctx._exceptions.length === 1 && /2026-08-25/.test(ctx._exceptions[0].detail));
}

console.log('The recheck is bounded — signing cannot hang on it');
{
  const ctx = build({ claimResult: false });
  ctx.ensureWeeklyServiceVisit_('P-1', '2026-08-25');
  t('it waits, but only a beat', ctx.SV_CLAIM_RECHECK_TRIES * ctx.SV_CLAIM_RECHECK_MS <= 2000,
    '(' + (ctx.SV_CLAIM_RECHECK_TRIES * ctx.SV_CLAIM_RECHECK_MS) + 'ms)');
  t('a missing Utilities.sleep does not break signing', (() => {
    const c = build({ claimResult: false });
    c.Utilities.sleep = () => { throw new Error('not available'); };
    return c.ensureWeeklyServiceVisit_('P-1', '2026-08-25').ok === true;
  })());
}

// ── The key must stay collectable ───────────────────────────────────────────
console.log('\n⚠️  The dedup key ends in a minute stamp, so cleanup can collect it');
{
  const ctx = build({});
  ctx.ensureWeeklyServiceVisit_('P-1', '2026-08-25');
  t('a claim was made', ctx._claims.length === 1);
  t('it is namespaced weekly_service', ctx._claims[0].action === 'weekly_service');
  // This is the EXACT regex from claimDedupAction_'s cleanup in DedupHelpers.js.
  // If the key does not match it, the property is never deleted.
  t('the key matches the cleanup regex /(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2})$/',
    /(\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/.test(ctx._claims[0].key),
    '(key: "' + ctx._claims[0].key + '")');
  t('the key still identifies the pool', /P-1/.test(ctx._claims[0].key));
  t('and the date', /2026-08-25/.test(ctx._claims[0].key));
}

// ── Status handling ─────────────────────────────────────────────────────────
console.log('\nA CANCELLED visit does not block rescheduling');
{
  const ctx = build({
    rows: [{ pool_id: 'P-1', scheduled_date: '2026-08-25', visit_type: 'weekly_service', status: 'cancelled' }]
  });
  const res = ctx.ensureWeeklyServiceVisit_('P-1', '2026-08-25');
  t('a new visit is created', res.created === true);
  t('the cancelled row is left alone', ctx._rows.length === 2);
}

console.log('A visit of a DIFFERENT type on the same date does not count');
{
  const ctx = build({
    rows: [{ pool_id: 'P-1', scheduled_date: '2026-08-25', visit_type: 'startup_day_1', status: 'scheduled' }]
  });
  t('the weekly visit is still created',
    ctx.ensureWeeklyServiceVisit_('P-1', '2026-08-25').created === true);
}

console.log('A Date object in the sheet is matched, not just an ISO string');
{
  // Sheets hands back real Dates for date-formatted cells. Comparing those to a
  // string would never match, and every retry would create another row.
  const ctx = build({
    rows: [{ pool_id: 'P-1', scheduled_date: new Date(2026, 7, 25),
             visit_type: 'weekly_service', status: 'scheduled' }]
  });
  const res = ctx.ensureWeeklyServiceVisit_('P-1', '2026-08-25');
  t('the Date-typed cell is recognised', res.created === false,
    '(created=' + res.created + ' — a string/Date mismatch would duplicate on every retry)');
  t('no duplicate row', ctx._count('P-1', '2026-08-25') === 1);
}

// ── Validation ──────────────────────────────────────────────────────────────
console.log('\nValidation and failure handling');
{
  const ctx = build({});
  t('missing pool_id is refused', ctx.ensureWeeklyServiceVisit_('', '2026-08-25').ok === false);
  t('missing date is refused', ctx.ensureWeeklyServiceVisit_('P-1', '').ok === false);
  t('a malformed date is refused', ctx.ensureWeeklyServiceVisit_('P-1', 'next tuesday').ok === false);
  t('nothing was written by the refusals', ctx._rows.length === 0);

  t('extra fields are carried onto the row', (() => {
    const c = build({});
    c.ensureWeeklyServiceVisit_('P-1', '2026-08-25', { customer_name: 'Rivera', assigned_technician: 'Ana' });
    const r = c._rows[0];
    return r[SV_H.indexOf('customer_name')] === 'Rivera' &&
           r[SV_H.indexOf('assigned_technician')] === 'Ana';
  })());

  t('visit_type is always weekly_service', (() => {
    const c = build({});
    c.ensureWeeklyServiceVisit_('P-1', '2026-08-25');
    return c._rows[0][SV_H.indexOf('visit_type')] === 'weekly_service';
  })());

  t('status is scheduled', (() => {
    const c = build({});
    c.ensureWeeklyServiceVisit_('P-1', '2026-08-25');
    return c._rows[0][SV_H.indexOf('status')] === 'scheduled';
  })());

  t('a thrown sheet never breaks signing', (() => {
    const c = build({});
    c.SpreadsheetApp.openById = () => { throw new Error('boom'); };
    const res = c.ensureWeeklyServiceVisit_('P-1', '2026-08-25');
    return res.ok === false;   // reported, not thrown
  })());
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
