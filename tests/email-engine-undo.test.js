// Stopping emails before they go (Plan changes 2026-11-16): Undo approval, Sent by hand,
// Cancel Send now (engine Admin.js → unapprove_waiting, mark_hand_sent, cancel_run_now).
// Nov 16: 12 people were approved at the Follow Up that Tony had already sent by hand.
//
//   npm run test:ee
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeWorld } = require('./helpers/ee-fake-env.js');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
function world() {
  const w = fakeWorld();
  w.now = Date.parse('2026-11-16T13:30:00-06:00');
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite };
  vm.createContext(ctx);
  vm.runInContext([read('js/lib/lifecycle-rules.js'), read('js/lib/batches.js'), 'var EE_TZ = "America/Chicago";',
    'function EE_config_(store) { var c = {}; store.rows("Config").forEach(function (r) { c[r.key] = r.value; }); return c; }',
    read('email-engine/src/Admin.js'), read('email-engine/src/Schedule.js')].join('\n'), ctx);
  w.env.config.pausedBuckets = () => [];
  w.cancelled = 0;
  w.admin = (action, params, actor) => JSON.parse(JSON.stringify(ctx.EE_adminRun_(w.env, w.core, { action, params, actor: actor || 'mau' },
    { scheduleRun: () => 'queued', planRuns: () => ({}), cancelRun: () => { w.cancelled++; return { ok: true, cancelled: 1, running: false }; } })));
  w.c = id => w.tables.Contacts.find(c => c.contact_id === id);
  // The Follow Up and Check-In are on (approval refuses while the email they'd start at is off).
  w.tables.Config.push({ key: 'rule_rev', value: 'bc-1' });
  const BC = JSON.parse(read('email-engine/seed/ruleset-bc.json'));
  BC.steps.forEach(s => { s.status = 'active'; });
  w.tables.Rulesets.push({ rule_rev: 'bc-1', json: BC });
  return w;
}
const hand = (id, extra) => Object.assign({ contact_id: id, email_norm: id + '@x.com', bucket: 'B', sub_bucket: 'B2', is_test: 'N',
  review_status: 'awaiting_approval', intro_sent_on: '2026-11-10', start_step: 'b_followup', review_reason: 'Intro sent by hand on 2026-11-10' }, extra || {});

test('Undo approval: approved people who have not started go back to waiting, as they were', () => {
  const w = world();
  w.tables.Contacts.push(hand('a'), hand('b'), { contact_id: 'late', email_norm: 'l@x.com', bucket: 'B', sub_bucket: 'B1', is_test: 'N', review_status: 'needs_review', planned_start: '2026-11-09' });
  assert.equal(w.admin('approve_waiting', { contact_ids: ['a', 'b', 'late'] }, 'tony').approved, 3);
  assert.equal(w.c('a').review_status, 'confirmed');
  const r = w.admin('unapprove_waiting', { contact_ids: ['a', 'b', 'late'] });
  assert.equal(r.undone, 3);
  assert.equal(w.c('a').review_status, 'awaiting_approval'); assert.equal(w.c('a').start_step, 'b_followup');
  assert.equal(w.c('a').review_reason, 'Intro sent by hand on 2026-11-10');
  assert.equal(w.c('late').review_status, 'needs_review'); assert.equal(w.c('late').planned_start, '2026-11-09', 'shows as overdue again');
  // Approving again the same day works (not mistaken for the first approval's write).
  w.now += 60000;
  assert.equal(w.admin('approve_waiting', { contact_ids: ['a'] }).approved, 1);
  assert.equal(w.c('a').review_status, 'confirmed');
});

test('Undo approval leaves anyone already in a sequence, and anyone never approved', () => {
  const w = world();
  w.tables.Contacts.push(hand('a', { review_status: 'confirmed', review_reason: 'approved by tony on 2026-11-16' }),
    hand('batch', { review_status: 'confirmed', review_reason: 'batch bat_1' }), hand('waiting'));
  w.tables.Enrollments.push({ enrollment_id: 'e1', contact_id: 'a', sequence_id: 'B', status: 'active' });
  const r = w.admin('unapprove_waiting', { contact_ids: ['a', 'batch', 'waiting'] });
  assert.equal(r.ok, false);
  assert.match(r.skipped[0].reason, /already getting emails/);
  assert.equal(w.c('a').review_status, 'confirmed'); assert.equal(w.c('batch').review_status, 'confirmed'); assert.equal(w.c('waiting').review_status, 'awaiting_approval');
});

test('Sent by hand (Nov 16 case): the Follow Up is recorded, they wait at the Check-In and never get the Follow Up', () => {
  const w = world();
  w.tables.Contacts.push(hand('a'), hand('approved', { review_status: 'confirmed', review_reason: 'approved by tony on 2026-11-16' }));
  const r = w.admin('mark_hand_sent', { contact_ids: ['a', 'approved'], step_id: 'b_followup', date: '2026-11-16' });
  assert.equal(r.marked, 2);
  for (const id of ['a', 'approved']) {
    assert.equal(w.c(id).followup_sent_on, '2026-11-16'); assert.equal(w.c(id).start_step, 'b_checkin');
    assert.equal(w.c(id).review_status, 'awaiting_approval');
    assert.equal(w.c(id).review_reason, 'Intro sent by hand on 2026-11-10; Follow Up on 2026-11-16');
  }
});

test('Sent by hand: the Intro for someone still in line; they wait for approval at the Follow Up', () => {
  const w = world();
  w.tables.Contacts.push({ contact_id: 'n', email_norm: 'n@x.com', bucket: 'B', sub_bucket: 'B1', is_test: 'N', review_status: 'needs_review', planned_start: '2026-11-23' });
  assert.equal(w.admin('mark_hand_sent', { contact_ids: ['n'], step_id: 'b_intro', date: '2026-11-16' }).marked, 1);
  assert.equal(w.c('n').intro_sent_on, '2026-11-16'); assert.equal(w.c('n').start_step, 'b_followup');
  assert.equal(w.c('n').sub_bucket, 'B2'); assert.equal(w.c('n').review_status, 'awaiting_approval');
});

test('Sent by hand refuses: in a sequence, future date, Follow Up before any Intro, twice, other emails or campaigns', () => {
  const w = world();
  w.tables.Contacts.push(hand('in'), hand('a'), { contact_id: 'n', email_norm: 'n@x.com', bucket: 'B', is_test: 'N', review_status: 'needs_review' },
    { contact_id: 's', email_norm: 's@x.com', bucket: 'C', is_test: 'N', review_status: 'needs_review' });
  w.tables.Enrollments.push({ enrollment_id: 'e1', contact_id: 'in', sequence_id: 'B', status: 'active' });
  assert.match(w.admin('mark_hand_sent', { contact_ids: ['in'], step_id: 'b_followup', date: '2026-11-16' }).error, /already getting emails/);
  assert.equal(w.admin('mark_hand_sent', { contact_ids: ['a'], step_id: 'b_followup', date: '2026-11-17' }).ok, false);
  assert.match(w.admin('mark_hand_sent', { contact_ids: ['a'], step_id: 'b_followup', date: '2026-11-09' }).error, /before their Intro/);
  assert.match(w.admin('mark_hand_sent', { contact_ids: ['n'], step_id: 'b_followup', date: '2026-11-16' }).error, /Intro first/);
  assert.match(w.admin('mark_hand_sent', { contact_ids: ['a'], step_id: 'b_intro', date: '2026-11-16' }).error, /already recorded/);
  assert.equal(w.admin('mark_hand_sent', { contact_ids: ['a'], step_id: 'b_checkin', date: '2026-11-16' }).ok, false);
  assert.match(w.admin('mark_hand_sent', { contact_ids: ['s'], step_id: 'b_intro', date: '2026-11-16' }).error, /not MCP Legacy/);
  assert.equal(w.c('a').start_step, 'b_followup', 'nothing changed');
});

test('Approve writes everyone at once; Cancel Send now reaches the trigger remover and is logged', () => {
  const w = world();
  for (let i = 0; i < 12; i++) w.tables.Contacts.push(hand('p' + i));
  let bulk = 0, single = 0;
  const one = w.core.commitEntity, many = w.core.commitEntities;
  w.core.commitEntity = (...a) => { single++; return one(...a); };
  w.core.commitEntities = (...a) => { bulk++; return many(...a); };
  assert.equal(w.admin('approve_waiting', { contact_ids: Array.from({ length: 12 }, (_, i) => 'p' + i) }).approved, 12);
  assert.equal(bulk, 1); assert.equal(single, 0);
  const r = w.admin('cancel_run_now', {});
  assert.equal(r.ok, true); assert.equal(r.cancelled, 1); assert.equal(w.cancelled, 1);
  assert.ok(w.tables.ChangeLog.some(c => c.action === 'cancel_run_now'));
});
