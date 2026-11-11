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
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite };
  vm.createContext(ctx);
  vm.runInContext(['js/lib/lifecycle-rules.js', 'js/lib/batches.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n') +
    '\nvar EE_TZ = "America/Chicago";\n' + fs.readFileSync(path.join(__dirname, '..', 'email-engine', 'src', 'Admin.js'), 'utf8'), ctx);
  // Config lives in the store here, like the real env.
  w.env.config.pausedBuckets = () => { const r = w.tables.Config.find(c => c.key === 'paused_buckets'); return r && r.value ? r.value.split(',') : []; };
  w.runs = 0;
  w.ctx_ = ctx;
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

test('Ping answers without changing anything or writing the change log (speed check)', () => {
  const w = world();
  assert.equal(w.admin('ping', {}).ok, true);
  assert.equal(w.tables.ChangeLog.length, 0);
  assert.equal(w.tables.Config.length, 0);
});

test('Maintenance runs only allow-listed setup tasks, and logs them', () => {
  const w = world();
  const ran = [];
  const run = (task) => w.ctx_.EE_adminRun_(w.env, w.core, { action: 'maintenance', params: { task }, actor: 'claude' },
    { scheduleRun: () => 'queued', runTask: fn => { ran.push(fn); return 'done'; } });
  assert.equal(run('setup_marketing_kit').ok, true);
  assert.equal(run('eeDemoSetup').ok, false, 'not on the allow-list');
  assert.equal(run('deleteEverything').ok, false);
  assert.deepEqual(ran, ['eeSetupMarketingKit']);
  assert.deepEqual(w.log().map(r => [r[0], r[1], r[2]]), [['claude', 'maintenance', 'ok'], ['claude', 'maintenance', 'unknown task'], ['claude', 'maintenance', 'unknown task']]);
});

test('Import saves new contacts into Needs review, never twice; do-not-contact goes to the real opt-out list', () => {
  const w = world();
  w.env.sha256 = s => require('crypto').createHash('sha256').update(s).digest('hex');
  const imp = (contacts, extra) => w.ctx_.EE_adminRun_(w.env, w.core, { action: 'import_contacts', actor: 'mau',
    params: Object.assign({ group: 'B', source: 'MCP 2019-2024', contacts }, extra || {}) }, { scheduleRun: () => 'queued' });
  const r = imp([{ email_norm: 'Maria@Example.com', first_name: 'Maria', last_name: 'Lopez', city: 'Boerne', tags: 'vip,spa' },
    { email_norm: 'james@example.com', first_name: 'James' }, { email_norm: 'not-an-email' }], { do_not_contact: ['dnc@example.com'] });
  assert.equal(JSON.stringify([r.ok, r.added, r.skipped.map(s => s.reason), r.do_not_contact_recorded]), JSON.stringify([true, 2, ['bad_email'], 1]));
  const maria = w.tables.Contacts.find(c => c.email_norm === 'maria@example.com');
  assert.deepEqual([maria.bucket, maria.sub_bucket, maria.review_status, maria.is_test, maria.source, maria.tags, maria.imported_by],
    ['B', 'B1', 'needs_review', 'N', 'MCP 2019-2024', 'vip,spa', 'mau']);
  assert.match(maria.contact_id, /^ct_[0-9a-f]{16}$/);
  assert.equal(w.optouts.length, 1, 'do-not-contact reaches the shared Comms_Optouts');
  const again = imp([{ email_norm: 'maria@example.com', first_name: 'Maria' }]);
  assert.deepEqual([again.added, again.skipped[0].reason], [0, 'existing'], 'a retried chunk adds nobody twice');
  assert.equal(w.tables.Contacts.length, 2);
  assert.equal(imp([], { group: 'Z' }).ok, false);
});

test('Saving an import mapping stores it in Config under its key', () => {
  const w = world();
  w.ctx_.EE_adminRun_(w.env, w.core, { action: 'save_import_mapping', actor: 'mau', params: { key: 'email|name', mapping: { 0: 'full_name', 1: 'email' }, source: 'MCP' } }, {});
  const row = w.tables.Config.find(c => c.key === 'import_mapping:email|name');
  assert.deepEqual(JSON.parse(row.value).mapping, { 0: 'full_name', 1: 'email' });
});

// ── Batches ──────────────────────────────────────────────────────────────────
function waiting(w, n, extra) {
  for (let i = 1; i <= n; i++) w.tables.Contacts.push(Object.assign({ contact_id: 'p' + i, email_norm: 'p' + i + '@example.com', bucket: 'B',
    review_status: 'needs_review', is_test: 'N', area: i % 2 ? 'Boerne' : 'Helotes', tags: i <= 3 ? 'vip' : '', source: 'MCP list',
    created_at: '2026-11-0' + (i % 9 + 1) + 'T00:00:00Z' }, (extra || {})[i] || {}));
}
const batch = (w, p) => w.ctx_.EE_adminRun_(w.env, w.core, { action: 'create_batch', params: p, actor: 'mau' }, {});
const status = (w, id) => w.tables.Contacts.find(c => c.contact_id === id).review_status;
const day = (w, d) => new Date(w.env.now() + d * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

test('Batch picked now, dated today: those exact people are confirmed right away', () => {
  const w = world(); waiting(w, 5);
  const r = batch(w, { group: 'B', pick: 'now', contact_ids: ['p1', 'p3'], start_on: day(w, 0) });
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(r.started), JSON.stringify({ started: 2, skipped: 0 }));
  assert.deepEqual(['p1', 'p2', 'p3'].map(id => status(w, id)), ['confirmed', 'needs_review', 'confirmed']);
  assert.equal(w.tables.Batches[0].status, 'started');
});

test('Batches lined up for later wait for their date, then the run starts them; cancelled ones never start', () => {
  const w = world(); waiting(w, 10);
  const a = batch(w, { group: 'B', pick: 'at_start', count: 3, order: 'oldest', start_on: day(w, 7), filters: { area: ['Boerne'] } });
  const b = batch(w, { group: 'B', pick: 'at_start', count: 2, start_on: day(w, 14) });
  assert.equal(a.start_on, day(w, 7));
  assert.equal(w.tables.Contacts.filter(c => c.review_status === 'confirmed').length, 0, 'nothing starts before its date');
  assert.equal(w.ctx_.EE_adminRun_(w.env, w.core, { action: 'cancel_batch', params: { batch_id: b.batch_id }, actor: 'mau' }, {}).ok, true);
  w.now += 7 * 86400000;
  const started = w.ctx_.EE_startDueBatches_(w.env, w.core);
  assert.equal(started.length, 1);
  const confirmed = w.tables.Contacts.filter(c => c.review_status === 'confirmed');
  assert.equal(confirmed.length, 3);
  assert.ok(confirmed.every(c => c.area === 'Boerne'), 'the filter applied on the start date');
  w.now += 7 * 86400000;
  assert.equal(w.ctx_.EE_startDueBatches_(w.env, w.core).length, 0, 'the cancelled batch never starts');
});

test('A batch skips people who are no longer waiting; bad input is refused', () => {
  const w = world(); waiting(w, 3, { 2: { review_status: 'confirmed' } });
  const r = batch(w, { group: 'B', pick: 'now', contact_ids: ['p1', 'p2', 'ghost'] });
  assert.equal(JSON.stringify(r.started), JSON.stringify({ started: 1, skipped: 2 }));
  assert.equal(batch(w, { group: 'B', pick: 'now', contact_ids: [] }).ok, false);
  assert.equal(batch(w, { group: 'B', pick: 'at_start', count: 2, start_on: '2020-01-01' }).ok, false, 'no start dates in the past');
  assert.equal(w.ctx_.EE_adminRun_(w.env, w.core, { action: 'cancel_batch', params: { batch_id: w.tables.Batches[0].batch_id }, actor: 'mau' }, {}).ok, false, 'a started batch can’t be cancelled');
});
