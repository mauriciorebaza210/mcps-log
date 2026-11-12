// Single emails (email-engine/src/Singles.js): one email, one day, a picked list,
// through the same rules and planner as the B/C sequences.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeWorld } = require('./helpers/ee-fake-env.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BC = JSON.parse(read('email-engine/seed/ruleset-bc.json'));
const plain = x => JSON.parse(JSON.stringify(x));

function world(mode) {
  const w = fakeWorld();
  w.now = Date.parse('2026-11-23T15:00:00Z');       // Mon Nov 23, 9:00 AM CST
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(['js/lib/lifecycle-rules.js', 'js/lib/batches.js'].map(read).join('\n') +
    '\nvar EE_TZ = "America/Chicago";\nfunction EE_config_(store) { var c = {}; store.rows("Config").forEach(function (r) { c[r.key] = r.value; }); return c; }\n' +
    ['email-engine/src/Admin.js', 'email-engine/src/Schedule.js', 'email-engine/src/Singles.js', 'email-engine/src/Planner.js'].map(read).join('\n'), ctx);
  w.env.config.pausedBuckets = () => { const r = w.tables.Config.find(c => c.key === 'paused_buckets'); return r && r.value ? r.value.split(',') : []; };
  w.tables.Rulesets.push({ rule_rev: 'bc-1', json: plain(BC), published_by: 'seed' });
  w.tables.Config.push({ key: 'rule_rev', value: 'bc-1' }, { key: 'engine_mode', value: mode || 'test' }, { key: 'daily_cap', value: '80' });
  const person = (id, extra) => Object.assign({ contact_id: id, email_norm: id + '@example.com', first_name: id, bucket: 'B', sub_bucket: 'B2', review_status: 'confirmed', is_test: 'Y' }, extra || {});
  w.tables.Contacts.push(person('ana'), person('bo'), person('cy', { review_status: 'needs_review' }), person('real', { is_test: 'N' }), person('dee', { bucket: 'C' }));
  w.ctx_ = ctx;
  w.planned = 0;
  w.admin = (action, params) => ctx.EE_adminRun_(w.env, w.core, { action, params, actor: 'mau' }, { scheduleRun: () => 'queued', planRuns: () => { w.planned++; return { times: [] }; } });
  w.cfg = k => (w.tables.Config.find(c => c.key === k) || {}).value;
  w.rules = () => { const rev = w.cfg('rule_rev'); return plain(w.tables.Rulesets.find(r => r.rule_rev === rev).json); };
  w.en = id => w.tables.Enrollments.find(e => e.enrollment_id === id);
  // The engine's day plan, as Main.js builds it (only what these tests need).
  w.plan = (today, time, extra) => {
    const rulesets = {}; w.tables.Rulesets.forEach(r => { rulesets[r.rule_rev] = r.json; });
    const published = {}; w.rules().steps.forEach(s => { published[s.step_id] = 'rev_' + s.step_id; });
    return plain(ctx.EE_planDay(Object.assign({ today, engineMode: w.cfg('engine_mode'), ruleRev: w.cfg('rule_rev'), rulesets, contacts: w.tables.Contacts,
      enrollments: w.tables.Enrollments, deliveries: w.tables.Deliveries, holds: [], inbox: [], suppressions: [], commsSentToday: [],
      paused: { all: false, buckets: w.env.config.pausedBuckets() }, publishedRevision: published, time: time || '23:59', sendTimes: {}, overrides: {} }, extra || {})));
  };
  return w;
}

test('create_single: a new rules revision with the email, and one enrollment per eligible person', () => {
  const w = world();
  const r = w.admin('create_single', { name: 'Holiday hours', date: '2026-12-01', send_time: '10:30', contact_ids: ['ana', 'bo', 'cy', 'real', 'dee', 'ana', 'nobody'] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.count, 3, 'ana, bo, dee (test mode: test contacts only; cy is not confirmed)');
  assert.deepEqual(plain(r.skipped.map(s => s.reason).sort()), ['not_confirmed', 'not_found', 'test_mode_real_contact']);
  assert.equal(w.cfg('rule_rev'), 'bc-2');
  const rs = w.rules(), seq = rs.sequences.find(s => s.sequence_id === r.sequence_id), st = rs.steps.find(s => s.step_id === r.step_id);
  assert.equal(seq.kind, 'single'); assert.equal(seq.name, 'Holiday hours');
  assert.deepEqual([st.anchor, st.date, st.category, st.status], ['date', '2026-12-01', 'marketing', 'active']);
  const e = w.en('en_ana_' + r.sequence_id + '_1');
  assert.deepEqual([e.rule_rev, e.send_time, e.status, e.mode], ['bc-2', '10:30', 'active', 'test']);
  assert.equal(w.planned, 1, 'today’s runs are re-planned for its send time');
  // The B/C sequences are untouched in the new revision.
  assert.deepEqual(rs.steps.filter(s => s.sequence_id === 'B').map(s => s.offset), [0, 4, 9]);
});

test('It sends on its day at its time, once per person, alongside the person’s other sequence', () => {
  const w = world();
  const r = w.admin('create_single', { name: 'Holiday hours', date: '2026-12-01', send_time: '10:30', contact_ids: ['ana', 'bo'] });
  assert.equal(w.plan('2026-11-30').due.filter(d => d.step_id === r.step_id).length, 0, 'not before its day');
  assert.equal(w.plan('2026-12-01', '09:00').due.filter(d => d.step_id === r.step_id).length, 0, 'not before its time');
  const due = w.plan('2026-12-01', '10:30').due.filter(d => d.step_id === r.step_id);
  assert.deepEqual(due.map(d => d.contact_id).sort(), ['ana', 'bo']);
  assert.equal(due[0].bucket, r.sequence_id, 'the gate pauses by the email’s own sequence');
  // The planner never auto-enrolls anyone into a single email.
  assert.equal(w.plan('2026-12-01').enrollmentWrites.filter(x => x.data.sequence_id === r.sequence_id && /create/.test(x.op_id)).length, 0);
  // Sent once → never again.
  due.forEach(d => w.tables.Deliveries.push({ delivery_id: d.key, key: d.key, enrollment_id: d.enrollment_id, contact_id: d.contact_id, step_id: d.step_id, occurrence: 1, mode: 'test', state: 'sent', sent_at: '2026-12-01T16:30:00Z' }));
  assert.equal(w.plan('2026-12-02').due.filter(d => d.step_id === r.step_id).length, 0);
});

test('Pausing MCP Legacy doesn’t hold a single email to the same people; pausing the single email does', () => {
  const w = world();
  const r = w.admin('create_single', { name: 'Holiday hours', date: '2026-12-01', send_time: '09:00', contact_ids: ['ana'] });
  w.tables.Config.push({ key: 'paused_buckets', value: 'B' });
  assert.equal(w.plan('2026-12-01').due.filter(d => d.step_id === r.step_id).length, 1);
  assert.equal(w.admin('set_bucket_paused', { bucket: r.sequence_id, paused: true }).ok, true);
  assert.equal(w.plan('2026-12-01').due.filter(d => d.step_id === r.step_id).length, 0);
});

test('A large list is spread over the daily cap instead of expiring', () => {
  const w = world();
  for (let i = 0; i < 300; i++) w.tables.Contacts.push({ contact_id: 'p' + i, email_norm: 'p' + i + '@x.com', bucket: 'B', review_status: 'confirmed', is_test: 'Y' });
  const r = w.admin('create_single', { name: 'Big', date: '2026-12-01', send_time: '09:00', contact_ids: w.tables.Contacts.filter(c => /^p\d/.test(c.contact_id)).map(c => c.contact_id) });
  assert.equal(r.window_days, 6, '300 people / 80 a day → 4 days, plus 2 of slack');
  assert.equal(w.rules().steps.find(s => s.step_id === r.step_id).window_days, 6);
});

test('update_single: name, day and time before it sends; the day is locked once sending starts', () => {
  const w = world();
  const r = w.admin('create_single', { name: 'Holiday hours', date: '2026-12-01', send_time: '09:00', contact_ids: ['ana', 'bo'] });
  const u = w.admin('update_single', { sequence_id: r.sequence_id, name: 'Holiday hours 2026', date: '2026-12-03', send_time: '14:15' });
  assert.equal(u.ok, true, u.error);
  const st = w.rules().steps.find(s => s.step_id === r.step_id);
  assert.deepEqual([st.name, st.date], ['Holiday hours 2026', '2026-12-03']);
  assert.deepEqual([w.en('en_ana_' + r.sequence_id + '_1').send_time, w.en('en_ana_' + r.sequence_id + '_1').rule_rev], ['14:15', u.rule_rev]);
  // Back to 9:00 works too (the journal op for each change is unique).
  w.now += 1000;
  w.admin('update_single', { sequence_id: r.sequence_id, send_time: '09:00' });
  assert.equal(w.en('en_ana_' + r.sequence_id + '_1').send_time, '09:00');
  w.tables.Deliveries.push({ delivery_id: 'x', step_id: r.step_id, state: 'sent' });
  assert.match(w.admin('update_single', { sequence_id: r.sequence_id, date: '2026-12-05' }).error, /already started/);
  assert.match(w.admin('update_single', { sequence_id: r.sequence_id, date: '2026-11-01' }).error, /later day/);
});

test('cancel_single: turned off and everyone still waiting is stopped; nothing more sends', () => {
  const w = world();
  const r = w.admin('create_single', { name: 'Holiday hours', date: '2026-12-01', send_time: '09:00', contact_ids: ['ana', 'bo'] });
  const c = w.admin('cancel_single', { sequence_id: r.sequence_id });
  assert.equal(c.ok, true); assert.equal(c.stopped, 2);
  assert.equal(w.en('en_bo_' + r.sequence_id + '_1').status, 'stopped');
  assert.equal(w.rules().steps.find(s => s.step_id === r.step_id).status, 'off');
  assert.equal(w.plan('2026-12-01').due.filter(d => d.step_id === r.step_id).length, 0);
  assert.equal(w.admin('cancel_single', { sequence_id: r.sequence_id }).already, true);
  assert.match(w.admin('update_single', { sequence_id: r.sequence_id, name: 'x' }).error, /cancelled/);
});

test('Bad input is refused and publishes nothing', () => {
  const w = world();
  const base = { name: 'X', date: '2026-12-01', send_time: '09:00', contact_ids: ['ana'] };
  [[{ name: ' ' }, /name/], [{ date: '2026-11-01' }, /later day/], [{ send_time: '03:00' }, /send time/], [{ contact_ids: [] }, /at least one/],
    [{ contact_ids: ['real'] }, /test mode/]].forEach(([d, re]) => assert.match(w.admin('create_single', Object.assign({}, base, d)).error, re));
  assert.equal(w.tables.Rulesets.length, 1);
  assert.equal(w.admin('update_single', { sequence_id: 'B', name: 'x' }).error, 'single email not found');
});
