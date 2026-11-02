// Planner + day runner, end to end: the real rules (lifecycle-rules.js), the
// real safety core (EngineCore.js) and a fake Gmail, run day after day.
//
//   npm run test:ee
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { fakeWorld, assertReplayable, T0 } = require('./helpers/ee-fake-env.js');
const { EE_planDay, EE_runDay } = require('../email-engine/src/Planner.js');
const L = require('../js/lib/lifecycle-rules.js');
const BC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'email-engine', 'seed', 'ruleset-bc.json'), 'utf8'));
const DAY = 24 * 60 * 60 * 1000;
const ALL_APPROVED = Object.fromEntries(BC.steps.map(s => [s.step_id, 'rev_' + s.step_id + '_1']));

function snapshotOf(w, extra) {
  return Object.assign({ today: L.localDate(new Date(w.now), 'America/Chicago'), engineMode: 'test', ruleRev: 'bc-1',
    rulesets: { 'bc-1': BC }, contacts: w.tables.Contacts, enrollments: w.tables.Enrollments, deliveries: w.tables.Deliveries,
    holds: w.tables.Holds, inbox: w.tables.Inbox, suppressions: [], commsSentToday: [], paused: {},
    publishedRevision: ALL_APPROVED }, extra || {});
}
function contact(id, bucket, extra) {
  return Object.assign({ contact_id: id, email_norm: id + '@example.com', first_name: id, bucket,
    sub_bucket: bucket === 'B' ? 'B1' : '', review_status: 'confirmed', is_test: 'Y' }, extra || {});
}
// Runs the engine once per local day at 9 am Central for `days` days.
function runDays(w, days, extraFor) {
  const out = [];
  for (let d = 0; d < days; d++) {
    w.now = T0 + d * DAY;
    out.push(EE_runDay(w.core, w.env, () => snapshotOf(w, extraFor ? extraFor(d) : null)));
  }
  return out;
}
const sentDays = (w, email) => w.outbox.filter(m => m.to === email)
  .map(m => L.localDay(w.tables.Deliveries.find(r => r.message_id === m.message_id).sent_at, 'America/Chicago'));

test('Test mode: a test B contact gets Intro, Follow Up and Check-In on days 1, 5 and 14; real contacts are untouched', () => {
  const w = fakeWorld();
  w.tables.Contacts.push(contact('mau', 'B', { email_norm: 'mauricio@mcpoolsolutions.org' }));
  w.tables.Contacts.push(contact('real', 'B', { is_test: '' }));
  runDays(w, 20);
  assert.deepEqual(sentDays(w, 'mauricio@mcpoolsolutions.org'), ['2026-11-02', '2026-11-06', '2026-11-15']);
  assert.equal(w.outbox.filter(m => m.to === 'real@example.com').length, 0, 'production contacts are never touched in test mode');
  const en = w.tables.Enrollments.find(e => e.contact_id === 'mau');
  assert.equal(en.mode, 'test'); assert.equal(en.status, 'completed');
  assert.equal(w.tables.Contacts.find(c => c.contact_id === 'mau').sub_bucket, 'B2', 'moved to B2 after the Intro');
  assertReplayable(w);
});

test('Nothing goes out for a step without an approved revision', () => {
  const w = fakeWorld();
  w.tables.Contacts.push(contact('mau', 'B'));
  const [s] = runDays(w, 1, () => ({ publishedRevision: {} }));
  assert.equal(s.sent, 0); assert.equal(s.plan.not_approved, 1);
  assert.equal(w.outbox.length, 0);
});

test('A held delivery counts one hold per day, however many runs that day', () => {
  // The Comms same-day hold applies to real contacts only (Comms_Log records real mail), so this runs in production mode.
  const w = fakeWorld();
  w.tables.Contacts.push(contact('ana', 'B', { is_test: '' }));
  const prod = extra => () => snapshotOf(w, Object.assign({ engineMode: 'production' }, extra || {}));
  w.now = T0;
  for (let i = 0; i < 3; i++) EE_runDay(w.core, w.env, prod({ commsSentToday: ['ana@example.com'] }));
  assert.equal(w.outbox.length, 0);
  assert.equal(w.tables.Holds.find(h => h.key.endsWith(':b_intro:1')).held_days, 1);
  w.now = T0 + DAY;
  EE_runDay(w.core, w.env, prod());
  assert.equal(w.outbox.length, 1, 'sent the next day');
});

test('A returning B contact is flagged for review instead of getting a second Intro', () => {
  const w = fakeWorld();
  w.tables.Contacts.push(contact('mau', 'B'));
  w.tables.Enrollments.push({ enrollment_id: 'en_old', contact_id: 'mau', sequence_id: 'B', rule_rev: 'bc-1', mode: 'test',
    status: 'completed', enrolled_on: '2026-03-01', stopped_branches: [] });
  runDays(w, 2);
  assert.equal(w.outbox.length, 0);
  assert.equal(w.tables.Contacts.find(c => c.contact_id === 'mau').review_status, 'needs_review');
});

test('A test C contact gets the Welcome 3 days before startup', () => {
  const w = fakeWorld();
  w.tables.Contacts.push(contact('rosa', 'C', { startup_date: '2026-11-05', address: '27 Agave Way', pool_school: 'Y' }));
  runDays(w, 2);
  assert.deepEqual(sentDays(w, 'rosa@example.com'), ['2026-11-02']);
  assert.equal(w.delivery('en_rosa_C_1:c_welcome:1').revision_id, 'rev_c_welcome_1');
});

test('A reply signal in the Inbox stops the B sequence the next morning', () => {
  const w = fakeWorld();
  w.tables.Contacts.push(contact('mau', 'B'));
  runDays(w, 1);                                       // Intro out on day 1
  w.core.ingest({ event_id: 'reply1', type: 'signal', signal: 'reply', email_norm: 'mau@example.com',
    enrollment_id: 'en_mau_B_1', step_id: 'b_intro' });
  for (let d = 1; d < 20; d++) { w.now = T0 + d * DAY; EE_runDay(w.core, w.env, () => snapshotOf(w)); }
  assert.equal(w.outbox.length, 1, 'no Follow Up after the reply');
  const en = w.tables.Enrollments.find(e => e.enrollment_id === 'en_mau_B_1');
  assert.equal(en.status, 'stopped'); assert.equal(en.stop_reason, 'replied');
});

test('Production mode leaves test contacts alone', () => {
  const plan = EE_planDay(snapshotOf(fakeWorld(), { engineMode: 'production', contacts: [contact('mau', 'B')] }));
  assert.equal(plan.enrollmentWrites.length, 0);
});
