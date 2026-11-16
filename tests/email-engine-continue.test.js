// A whole batch goes out on one click (Plan changes 2026-11-16).
// Nov 16: the first batch (14) took one run ~5 min to confirm + enroll (one write per
// person), then sent 5 before the time budget; the other 9 waited for the next run.
// Now: batch start and the plan's writes are one fenced bulk write, the budget counts
// from the execution start, and a run that ran out of time queues the next right away.
//
//   npm run test:ee
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { fakeWorld, assertReplayable, T0 } = require('./helpers/ee-fake-env.js');
const { EE_runDay } = require('../email-engine/src/Planner.js');
const L = require('../js/lib/lifecycle-rules.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BC = JSON.parse(read('email-engine/seed/ruleset-bc.json'));
const ALL_APPROVED = Object.fromEntries(BC.steps.map(s => [s.step_id, 'rev_' + s.step_id + '_1']));

const sched = (() => {
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite };
  vm.createContext(ctx);
  vm.runInContext(read('email-engine/src/Schedule.js'), ctx);
  return ctx;
})();

function snapshotOf(w) {
  return { today: L.localDate(new Date(w.now), 'America/Chicago'), engineMode: 'test', ruleRev: 'bc-1',
    rulesets: { 'bc-1': BC }, contacts: w.tables.Contacts, enrollments: w.tables.Enrollments, deliveries: w.tables.Deliveries,
    holds: w.tables.Holds, inbox: w.tables.Inbox, suppressions: [], commsSentToday: [], paused: {}, publishedRevision: ALL_APPROVED };
}
function batchOf(w, n) {
  for (let i = 1; i <= n; i++) {
    w.tables.Contacts.push({ contact_id: 'p' + i, email_norm: 'p' + i + '@example.com', first_name: 'P' + i, bucket: 'B',
      sub_bucket: 'B1', review_status: 'confirmed', is_test: 'Y' });
  }
}

test('Run budget counts from the execution start and always leaves room for the send in flight', () => {
  assert.equal(sched.EE_runBudgetMs_(0, 0), 285000, 'a fresh run: 6 min minus the margin');
  assert.equal(sched.EE_runBudgetMs_(0, 120000), 165000, 'two minutes of batch start and reply scan come off');
  assert.equal(sched.EE_runBudgetMs_(0, 330000), 15000, 'never below the minimum');
});

test('Carry on only when a run ran out of time after making progress', () => {
  assert.equal(sched.EE_shouldContinue_({ stopped_reason: 'time_budget', sent: 5 }), true);
  assert.equal(sched.EE_shouldContinue_({ stopped_reason: 'time_budget', sent: 0, skipped: 1 }), true);
  assert.equal(sched.EE_shouldContinue_({ stopped_reason: 'time_budget', sent: 0 }), false, 'no progress: no loop');
  for (const r of ['done', 'daily_cap', 'quota_reserve', 'lease_lost', 'already_running', 'safety_pause', 'kill_switch'])
    assert.equal(sched.EE_shouldContinue_({ stopped_reason: r, sent: 3 }), false, r);
  assert.equal(sched.EE_shouldContinue_(null), false);
});

test('Nov 16 replay: 14 people at ~30 s a send finish over chained runs, each sent once, nobody twice', () => {
  const w = fakeWorld();
  w.now = T0;
  batchOf(w, 14);
  w.hooks.beforeSend = () => { w.now += 30000; };     // ~30 s per email, as measured live
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const s = EE_runDay(w.core, w.env, () => snapshotOf(w), { trigger: 'portal', budgetMs: sched.EE_runBudgetMs_(w.now, w.now) });
    runs.push(s);
    if (!sched.EE_shouldContinue_(s)) break;
  }
  assert.equal(runs[0].stopped_reason, 'time_budget');
  assert.equal(runs[runs.length - 1].stopped_reason, 'done');
  assert.equal(runs.reduce((n, s) => n + s.sent, 0), 14);
  const to = w.outbox.map(m => m.to);
  assert.equal(new Set(to).size, 14, 'each person once');
  assert.equal(to.length, 14, 'nobody twice');
  assertReplayable(w);
});

test('The plan enrolls everyone in one fenced write, not one write per person', () => {
  const w = fakeWorld();
  batchOf(w, 14);
  let single = 0, bulk = 0;
  const core = Object.assign({}, w.core, {
    commitEntity: (...a) => { single++; return w.core.commitEntity(...a); },
    commitEntities: (...a) => { bulk++; return w.core.commitEntities(...a); }
  });
  const s = EE_runDay(core, w.env, () => snapshotOf(w));
  assert.equal(single, 0);
  assert.equal(bulk, 1);
  assert.equal(w.tables.Enrollments.length, 14);
  assert.equal(s.sent, 14);
  assertReplayable(w);
});

test('A bulk write under a lost lease writes nothing', () => {
  const w = fakeWorld();
  batchOf(w, 2);
  const before = w.journal.length;
  assert.throws(() => w.core.commitEntities([{ type: 'contact', data: { contact_id: 'p1', review_status: 'needs_review' }, opId: 'x:1' }],
    { run_id: 'run_gone', gen: 999 }));
  assert.equal(w.journal.length, before);
  assert.equal(w.tables.Contacts.find(c => c.contact_id === 'p1').review_status, 'confirmed');
});

test('Batch start confirms everyone in one bulk write', () => {
  const w = fakeWorld();
  w.now = Date.parse('2026-11-16T12:30:00-06:00');
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite };
  vm.createContext(ctx);
  vm.runInContext([read('js/lib/lifecycle-rules.js'), read('js/lib/batches.js'), 'var EE_TZ = "America/Chicago";',
    'function EE_config_(store) { var c = {}; store.rows("Config").forEach(function (r) { c[r.key] = r.value; }); return c; }',
    read('email-engine/src/Admin.js'), read('email-engine/src/Schedule.js')].join('\n'), ctx);
  w.env.config.pausedBuckets = () => [];
  const ids = [];
  for (let i = 1; i <= 14; i++) {
    ids.push('p' + i);
    w.tables.Contacts.push({ contact_id: 'p' + i, email_norm: 'p' + i + '@x.com', bucket: 'B', review_status: 'needs_review', is_test: 'N' });
  }
  let single = 0, bulk = 0;
  const core = Object.assign({}, w.core, {
    commitEntity: (...a) => { single++; return w.core.commitEntity(...a); },
    commitEntities: (...a) => { bulk++; return w.core.commitEntities(...a); }
  });
  const r = ctx.EE_adminRun_(w.env, core, { action: 'create_batch', params: { group: 'B', pick: 'now', contact_ids: ids, start_on: '2026-11-16' }, actor: 'mau' },
    { scheduleRun: () => 'queued', planRuns: () => ({}) });
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(r.started), JSON.stringify({ started: 14, skipped: 0 }));
  assert.equal(single, 0); assert.equal(bulk, 1);
  assert.equal(w.tables.Contacts.filter(c => c.review_status === 'confirmed').length, 14);
  assertReplayable(w);
});
