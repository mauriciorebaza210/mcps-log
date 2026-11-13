// Importing a campaign already under way (Plan changes 2026-11-12): people who got the
// MCP Legacy Intro by hand start at the Follow Up and wait for a person's yes; file
// flags hold people out of batches; planned dates from the file become batches; and no
// batch starts people while the first email of their sequence is off.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const L = require('../js/lib/lifecycle-rules.js');
const { fakeWorld } = require('./helpers/ee-fake-env.js');

const BC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'email-engine', 'seed', 'ruleset-bc.json'), 'utf8'));
const plain = x => JSON.parse(JSON.stringify(x));

function engine(today) {
  const w = fakeWorld();
  if (today) w.now = Date.parse(today + 'T15:00:00Z');
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite };
  vm.createContext(ctx);
  vm.runInContext(['js/lib/lifecycle-rules.js', 'js/lib/batches.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n') +
    '\nvar EE_TZ = "America/Chicago";\n' + fs.readFileSync(path.join(__dirname, '..', 'email-engine', 'src', 'Admin.js'), 'utf8'), ctx);
  w.tables.Rulesets.push({ rule_rev: 'bc-1', json: plain(BC), published_at: '', published_by: 'seed' });
  w.tables.Config.push({ key: 'rule_rev', value: 'bc-1' });
  w.admin = (action, params) => plain(ctx.EE_adminRun_(w.env, w.core, { action, params, actor: 'mau' }, { scheduleRun: () => 'queued', planRuns: () => ({ times: [] }) }));
  w.contact = id => plain(w.tables.Contacts.find(c => c.contact_id === id));
  w.byEmail = e => plain(w.tables.Contacts.find(c => c.email_norm === e));
  w.startDue = () => plain(ctx.EE_startDueBatches_(w.env, w.core));
  w.introOff = () => assert.equal(w.admin('publish_rules', { edits: [{ step_id: 'b_intro', status: 'off' }], scope: 'new' }).ok, true);
  w.introOn = () => assert.equal(w.admin('publish_rules', { edits: [{ step_id: 'b_intro', status: 'active' }], scope: 'new' }).ok, true);
  return w;
}
const row = (email, extra) => Object.assign({ email_norm: email, first_name: 'A', last_name: 'B' }, extra || {});

test('Rules: a contact who started at the Follow Up never gets the Intro; the Follow Up is due the day they are enrolled', () => {
  const contact = { contact_id: 'c1', bucket: 'B', sub_bucket: 'B2', review_status: 'confirmed', start_step: 'b_followup', email_norm: 'a@x.com' };
  const en = { enrollment_id: 'e1', contact_id: 'c1', sequence_id: 'B', rule_rev: 'bc-1', mode: 'production', status: 'active', enrolled_on: '2026-11-20', stopped_branches: [] };
  const d = L.decide({ today: '2026-11-20', rulesets: { 'bc-1': BC }, contacts: [contact], enrollments: [en], deliveries: [], holds: {}, signals: [], suppressions: [], paused: {} }).deliveries;
  const by = id => d.find(x => x.step_id === id);
  assert.equal(by('b_intro').outcome, 'excluded');
  assert.equal(by('b_intro').reason, 'sent_before_import');
  assert.equal(by('b_followup').due, '2026-11-20');
  assert.equal(by('b_followup').outcome, 'due');
  assert.equal(by('b_checkin').outcome, 'upcoming');
  assert.equal(by('b_checkin').due, '2026-11-29', 'Check-In 9 days after the Follow Up');
  // Without start_step the same contact (B2) would never be reached: that's why import sets it.
  const plainB2 = Object.assign({}, contact, { start_step: '' });
  const d2 = L.decide({ today: '2026-11-20', rulesets: { 'bc-1': BC }, contacts: [plainB2], enrollments: [en], deliveries: [], holds: {}, signals: [], suppressions: [], paused: {} }).deliveries;
  assert.notEqual(d2.find(x => x.step_id === 'b_followup').outcome, 'due');
});

test('Import: intro sent by hand → waiting for approval at the Follow Up; a file flag → flagged with its reason; planned date kept', () => {
  const w = engine('2026-11-13');
  const r = w.admin('import_contacts', { group: 'B', contacts: [
    row('done@x.com', { intro_sent_on: '2026-10-26', planned_start: '2026-10-26' }),
    row('flag@x.com', { flag_reason: 'Possible non-residential', planned_start: '2026-11-23' }),
    row('new@x.com', { planned_start: '2026-11-23' }),
    row('bad@x.com', { planned_start: 'next week', intro_sent_on: 'oct 26' })] });
  assert.equal(r.ok, true, r.error);
  const done = w.byEmail('done@x.com');
  assert.equal(done.review_status, 'awaiting_approval');
  assert.equal(done.sub_bucket, 'B2');
  assert.equal(done.start_step, 'b_followup');
  assert.match(done.review_reason, /2026-10-26/);
  const flag = w.byEmail('flag@x.com');
  assert.equal(flag.review_status, 'flagged');
  assert.equal(flag.review_reason, 'Possible non-residential');
  assert.equal(w.byEmail('new@x.com').review_status, 'needs_review');
  assert.equal(w.byEmail('new@x.com').planned_start, '2026-11-23');
  const bad = w.byEmail('bad@x.com');
  assert.equal(bad.planned_start, '');
  assert.equal(bad.intro_sent_on, '');
  assert.equal(bad.review_status, 'needs_review');
});

test('Nobody waiting or flagged is ever enrolled by the planner', () => {
  const contacts = ['awaiting_approval', 'flagged', 'needs_review'].map((s, i) => ({ contact_id: 'c' + i, bucket: 'B', review_status: s }));
  const seq = (BC.sequences || []).find(s => s.bucket === 'B') || { sequence_id: 'B', bucket: 'B' };
  contacts.forEach(c => assert.equal(L.decideEnrollment(c, seq, [], '2026-11-13').action, 'none'));
});

test('Approve: the hand-introduced start at the Follow Up even with the Intro off; a late planned start needs the Intro on', () => {
  const w = engine('2026-11-13');
  w.admin('import_contacts', { group: 'B', contacts: [row('done@x.com', { intro_sent_on: '2026-11-02' }), row('late@x.com', { planned_start: '2026-11-09' }),
    row('soon@x.com', { planned_start: '2026-11-23' })] });
  const done0 = w.byEmail('done@x.com').contact_id;
  assert.equal(w.admin('publish_rules', { edits: [{ step_id: 'b_followup', status: 'off' }], scope: 'new' }).ok, true);
  const noFollow = w.admin('approve_waiting', { contact_ids: [done0] });
  assert.equal(noFollow.ok, false, 'the Follow Up must be on: otherwise the Check-In goes out with nothing before it');
  assert.match(noFollow.error, /Turn on/);
  assert.equal(w.admin('publish_rules', { edits: [{ step_id: 'b_followup', status: 'active' }], scope: 'new' }).ok, true);
  w.introOff();
  const done = w.byEmail('done@x.com').contact_id, late = w.byEmail('late@x.com').contact_id, soon = w.byEmail('soon@x.com').contact_id;
  assert.equal(w.admin('approve_waiting', { contact_ids: [done] }).approved, 1);
  assert.equal(w.contact(done).review_status, 'confirmed');
  const refused = w.admin('approve_waiting', { contact_ids: [late] });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Turn on/);
  assert.equal(w.contact(late).review_status, 'needs_review');
  assert.equal(w.admin('approve_waiting', { contact_ids: [soon] }).ok, false, 'a future planned start is not "waiting"');
  w.introOn();
  assert.equal(w.admin('approve_waiting', { contact_ids: [late] }).approved, 1);
  assert.equal(w.contact(late).review_status, 'confirmed');
  assert.ok(w.tables.ChangeLog.some(c => c.action === 'approve_waiting'));
});

test('Planned batches from the file: one per future date, none for past dates, never twice', () => {
  const w = engine('2026-11-13');
  w.admin('import_contacts', { group: 'B', contacts: [
    row('a@x.com', { planned_start: '2026-11-16' }), row('b@x.com', { planned_start: '2026-11-16' }), row('c@x.com', { planned_start: '2026-11-23' }),
    row('late@x.com', { planned_start: '2026-11-09' }), row('flag@x.com', { planned_start: '2026-11-16', flag_reason: 'Bounced' }),
    row('done@x.com', { planned_start: '2026-11-16', intro_sent_on: '2026-11-02' })] });
  const r = w.admin('plan_import_batches', { group: 'B', name_prefix: 'MCP week' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.batches.map(b => [b.start_on, b.count, b.ok]), [['2026-11-16', 2, true], ['2026-11-23', 1, true]]);
  assert.equal(w.tables.Batches.length, 2);
  assert.equal(w.admin('plan_import_batches', { group: 'B' }).batches.length, 0, 're-running adds nothing');
});

test('A batch never starts people while the first email is off; it starts at the first run after it is turned on', () => {
  const w = engine('2026-11-13');
  w.admin('import_contacts', { group: 'B', contacts: [row('a@x.com', { planned_start: '2026-11-16' })] });
  w.admin('plan_import_batches', { group: 'B' });
  w.introOff();
  w.now = Date.parse('2026-11-16T15:00:00Z');
  const first = w.startDue();
  assert.equal(first[0].result.started, 0);
  assert.ok(first[0].result.waiting, 'reports which first email is off');
  assert.equal(w.tables.Batches[0].status, 'planned');
  assert.ok(String(w.tables.Batches[0].waiting).startsWith('first_email_off'));
  assert.equal(w.byEmail('a@x.com').review_status, 'needs_review');
  w.introOn();
  const second = w.startDue();
  assert.equal(second[0].result.started, 1);
  assert.equal(w.tables.Batches[0].status, 'started');
  assert.equal(w.byEmail('a@x.com').review_status, 'confirmed');
});

test('Clearing a flag puts the person back in line (Needs review, or waiting for approval if introduced by hand)', () => {
  const w = engine('2026-11-13');
  w.admin('import_contacts', { group: 'B', contacts: [row('f@x.com', { flag_reason: 'Duplicate' }), row('g@x.com', { flag_reason: 'Check', intro_sent_on: '2026-10-26' })] });
  const f = w.byEmail('f@x.com').contact_id, g = w.byEmail('g@x.com').contact_id;
  assert.equal(w.admin('clear_flag', { contact_ids: [f, g] }).cleared, 2);
  assert.equal(w.contact(f).review_status, 'needs_review');
  assert.equal(w.contact(g).review_status, 'awaiting_approval');
  assert.equal(w.contact(f).flag_reason, '');
  assert.equal(w.admin('clear_flag', { contact_ids: [f] }).ok, false);
});
