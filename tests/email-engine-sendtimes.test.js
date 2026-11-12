// Send times (PLAN.md → Scheduling semantics → Send times; failure rows 58–61).
// decide() still plans days; its optional `time` gates today's sends by each
// delivery's send time (the enrollment's, else the campaign default).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../js/lib/lifecycle-rules.js');
const BC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'email-engine', 'seed', 'ruleset-bc.json'), 'utf8'));

const world = (en, extra) => Object.assign({ today: '2026-11-23', rulesets: { 'bc-1': BC },
  contacts: [{ contact_id: 'c1', email_norm: 'c1@example.com', bucket: 'B', sub_bucket: 'B1', review_status: 'confirmed' }],
  enrollments: [Object.assign({ enrollment_id: 'e1', contact_id: 'c1', sequence_id: 'B', rule_rev: 'bc-1', mode: 'production',
    status: 'active', enrolled_on: '2026-11-23', stopped_branches: [] }, en || {})],
  deliveries: [], holds: {}, signals: [], suppressions: [], paused: {} }, extra || {});
const intro = r => r.deliveries.find(d => d.step_id === 'b_intro');

test('Times are normalised to HH:MM, anything else is empty', () => {
  assert.equal(L.normTime('9:05'), '09:05');
  assert.equal(L.normTime('10:30'), '10:30');
  for (const bad of ['', '24:00', '9:7', '10:60', 'noon', null]) assert.equal(L.normTime(bad), '');
  assert.equal(L.localTime(new Date('2026-11-23T16:30:00Z'), 'America/Chicago'), '10:30');   // CST
  assert.equal(L.localTime(new Date('2026-07-01T15:30:00Z'), 'America/Chicago'), '10:30');   // CDT
});

test('No time given (simulation): no gate, and every delivery carries the default 09:00', () => {
  const r = L.decide(world());
  assert.equal(intro(r).outcome, 'due');
  assert.equal(intro(r).send_time, '09:00');
});

test('Row 59 (a later run that day): campaign default gates the day: before it upcoming (later_today), at or after it due', () => {
  const before = L.decide(world(null, { time: '08:59', sendTimes: { B: '09:00' } }));
  assert.equal(intro(before).outcome, 'upcoming');
  assert.equal(intro(before).reason, 'later_today');
  assert.equal(before.due.length, 0);
  assert.equal(intro(L.decide(world(null, { time: '09:00', sendTimes: { B: '09:00' } }))).outcome, 'due');
});

test('The enrollment\'s own time (from its batch) wins over the campaign default', () => {
  const w = { time: '09:30', sendTimes: { B: '09:00' } };
  const r = L.decide(world({ send_time: '10:30' }, w));
  assert.equal(intro(r).send_time, '10:30');
  assert.equal(intro(r).outcome, 'upcoming');
  assert.equal(intro(L.decide(world({ send_time: '10:30' }, Object.assign(w, { time: '10:45' })))).outcome, 'due');
});

test('Row 59 (no run that day): a missed day waits for its time the next day; windows and dates are unchanged', () => {
  const r = L.decide(world({ send_time: '14:00' }, { today: '2026-11-24', time: '09:00' }));
  assert.equal(intro(r).due, '2026-11-23');
  assert.equal(intro(r).outcome, 'upcoming');
  assert.equal(intro(L.decide(world({ send_time: '14:00' }, { today: '2026-11-24', time: '14:00' }))).outcome, 'due');
});

test('Gating never changes later steps\' dates (Follow Up still +4 from the actual send day)', () => {
  const w = world({ send_time: '10:30' }, { today: '2026-11-27', time: '11:00' });
  w.deliveries = [{ key: 'e1:b_intro:1', enrollment_id: 'e1', contact_id: 'c1', mode: 'production', step_id: 'b_intro', occurrence: 1, state: 'sent', sent_at: '2026-11-23T16:31:00Z' }];
  const f = L.decide(w).deliveries.find(d => d.step_id === 'b_followup');
  assert.equal(f.due, '2026-11-27');
  assert.equal(f.outcome, 'due');
  assert.equal(f.send_time, '10:30');
});

// ── Per-send overrides and restarts (PLAN.md → Per-send overrides, Restarts; rows 62–64) ──
const ov = (key, kind, date) => ({ ['e1:' + key + ':1']: { kind, date } });
const step = (r, id) => r.deliveries.find(d => d.step_id === id);

test('Skip: never sent; the next step chains from the date it was due', () => {
  const r = L.decide(world(null, { overrides: ov('b_intro', 'skip') }));
  assert.equal(step(r, 'b_intro').outcome, 'excluded');
  assert.equal(step(r, 'b_intro').reason, 'skipped_by_operator');
  assert.equal(step(r, 'b_followup').due, '2026-11-27', 'Follow Up still +4 from Nov 23');
});

test('Move: inside the window it changes the day; outside it is ignored', () => {
  const moved = step(L.decide(world(null, { overrides: ov('b_intro', 'move', '2026-11-25') })), 'b_intro');
  assert.equal(moved.due, '2026-11-25');
  assert.equal(moved.original_due, '2026-11-23');
  assert.equal(moved.outcome, 'upcoming');
  const tooLate = step(L.decide(world(null, { overrides: ov('b_intro', 'move', '2026-12-31') })), 'b_intro');
  assert.equal(tooLate.due, '2026-11-23', 'row 63: past the last send day is refused');
});

test('Send next run: due now regardless of date and time, but never before its prerequisite', () => {
  const w = world(null, { today: '2026-11-23', time: '08:00', sendTimes: { B: '09:00' } });
  w.deliveries = [{ key: 'e1:b_intro:1', enrollment_id: 'e1', contact_id: 'c1', mode: 'production', step_id: 'b_intro', occurrence: 1, state: 'sent', sent_at: '2026-11-23T14:00:00Z' }];
  w.overrides = ov('b_followup', 'next_run');
  w.today = '2026-11-24';
  assert.equal(step(L.decide(w), 'b_followup').outcome, 'due', 'Follow Up (due Nov 27) goes on the next run');
  const early = world(null, { today: '2026-11-23', overrides: ov('b_followup', 'next_run') });
  assert.equal(step(L.decide(early), 'b_followup').outcome, 'upcoming', 'row 63: Intro not sent yet');
});

test('Row 62: an override on a sent delivery has no effect', () => {
  const w = world(null, { overrides: ov('b_intro', 'skip') });
  w.deliveries = [{ key: 'e1:b_intro:1', enrollment_id: 'e1', contact_id: 'c1', mode: 'production', step_id: 'b_intro', occurrence: 1, state: 'sent', sent_at: '2026-11-23T15:00:00Z' }];
  assert.equal(step(L.decide(w), 'b_intro').outcome, 'sent');
});

test('Restart: only with restart_ok, never while a sequence is still going', () => {
  const seq = { sequence_id: 'B', reentry: 'never' };
  const c = { contact_id: 'c1', review_status: 'confirmed' };
  const done = [{ contact_id: 'c1', sequence_id: 'B', status: 'stopped' }];
  assert.equal(L.decideEnrollment(c, seq, done, '2026-11-23').action, 'needs_review');
  assert.equal(L.decideEnrollment({ ...c, restart_ok: 'bat_1' }, seq, done, '2026-11-23').reason, 'restart_by_operator');
  assert.equal(L.decideEnrollment({ ...c, restart_ok: 'bat_1' }, seq, [{ ...done[0], status: 'active' }], '2026-11-23').reason, 'already_enrolled');
});
