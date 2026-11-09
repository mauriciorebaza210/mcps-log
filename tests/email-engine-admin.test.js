// Page actions on the engine side (email-engine/src/Admin.js) against the fake
// env: what each action changes, the core's rules it goes through, and the
// ChangeLog row every action leaves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeWorld, item, MIN } = require('./helpers/ee-fake-env.js');

function world() {
  const w = fakeWorld();
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'email-engine', 'src', 'Admin.js'), 'utf8'), ctx);
  // Config lives in the store here, like the real env.
  w.env.config.pausedBuckets = () => { const r = w.tables.Config.find(c => c.key === 'paused_buckets'); return r && r.value ? r.value.split(',') : []; };
  w.runs = 0;
  w.admin = (action, params) => ctx.EE_adminRun_(w.env, w.core, { action, params, actor: 'mau' }, { scheduleRun: () => (w.runs++ ? 'already_queued' : 'queued') });
  w.cfg = k => (w.tables.Config.find(c => c.key === k) || {}).value;
  w.log = () => w.tables.ChangeLog.map(c => [c.actor, c.action, c.result]);
  return w;
}
// An unconfirmed send, the way the core leaves one: authorized, Gmail threw, nothing in Sent after G2.
function unknownDelivery(w) {
  w.tables.Enrollments.push({ enrollment_id: 'e1', status: 'active', stopped_branches: [] });
  w.faults['send.timeout'] = { times: 1 };
  w.core.run({ plan: () => [item('e1:b_intro:1')] });
  w.now += 16 * MIN;
  w.core.run({ plan: () => [] });
  const d = w.delivery('e1:b_intro:1');
  assert.equal(d.state, 'unknown');
  return d;
}

test('Run now queues one run; a second click while it is pending does not queue another', () => {
  const w = world();
  assert.equal(w.admin('run_now', {}).status, 'queued');
  assert.equal(w.admin('run_now', {}).status, 'already_queued');
  assert.deepEqual(w.log(), [['mau', 'run_now', 'ok'], ['mau', 'run_now', 'ok']]);
});

test('Sending on/off and per-sequence pause write Config; bad input is refused and logged', () => {
  const w = world();
  assert.equal(w.admin('set_enabled', { enabled: false }).ok, true);
  assert.equal(w.cfg('engine_enabled'), 'false');
  assert.equal(w.admin('set_enabled', { enabled: 'no' }).ok, false);
  w.admin('set_bucket_paused', { bucket: 'C', paused: true });
  w.admin('set_bucket_paused', { bucket: 'B', paused: true });
  assert.equal(w.cfg('paused_buckets'), 'B,C');
  w.admin('set_bucket_paused', { bucket: 'B', paused: false });
  assert.equal(w.cfg('paused_buckets'), 'C');
  assert.equal(w.admin('set_bucket_paused', { bucket: 'Z', paused: true }).ok, false);
  assert.equal(w.log().filter(r => r[2] !== 'ok').length, 2, 'refusals are logged too');
});

test('Mark sent and abandon resolve an unconfirmed send; abandon deletes its leftover draft', () => {
  const w = world();
  const d = unknownDelivery(w);
  assert.ok(w.drafts[d.draft_id], 'the failed send left its draft');
  assert.equal(w.admin('abandon', { delivery_id: d.delivery_id }).ok, true);
  assert.equal(w.delivery(d.delivery_id).state, 'abandoned');
  assert.equal(w.drafts[d.draft_id], undefined);
  assert.equal(w.delivery(d.delivery_id).resolved_by, 'operator:mau');
  const w2 = world();
  const d2 = unknownDelivery(w2);
  assert.equal(w2.admin('mark_sent', { delivery_id: d2.delivery_id }).ok, true);
  assert.equal(w2.delivery(d2.delivery_id).state, 'sent');
  assert.equal(w2.admin('mark_sent', { delivery_id: d2.delivery_id }).ok, false, 'only an unconfirmed send can be resolved');
});

test('Resend is refused until quiescence (with the unlock time), then releases the delivery for the next run', () => {
  const w = world();
  const d = unknownDelivery(w);
  const early = w.admin('resend', { delivery_id: d.delivery_id });
  assert.deepEqual([early.ok, early.reason], [false, 'quiescence']);
  assert.ok(early.unlock_at);
  w.now += 30 * MIN;
  assert.equal(w.admin('resend', { delivery_id: d.delivery_id }).ok, true);
  assert.equal(w.delivery(d.delivery_id).state, 'released');
  assert.equal(w.outbox.length, 0, 'the page never sends directly; the next run does, through the full gate');
  assert.deepEqual(w.log().map(r => r[2]), ['quiescence', 'ok']);
});
