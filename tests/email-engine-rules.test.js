// Lifecycle rules: the worked examples from email-engine/docs/PLAN.md, run
// against the real B/C seed (email-engine/seed/ruleset-bc.json).
//
//   npm run test:ee
//
// Most cases drive a tiny simulated engine: once per local day it calls
// decide(), "sends" whatever is due, and records holds and enrollment changes,
// exactly like the real daily run will. Asserting on the resulting send dates is
// what proves the multi-week behaviour, not just one day's answer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RULES_PATH = path.join(__dirname, '..', 'js', 'lib', 'lifecycle-rules.js');
const L = require(RULES_PATH);
const BC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'email-engine', 'seed', 'ruleset-bc.json'), 'utf8'));
const STEP = Object.fromEntries(BC.steps.map(s => [s.step_id, s]));

function contact(id, bucket, extra) {
  return Object.assign({ contact_id: id, email_norm: id + '@example.com', bucket,
    sub_bucket: bucket === 'B' ? 'B1' : '', review_status: 'confirmed' }, extra || {});
}
function enrollment(id, contactId, seq, on, extra) {
  return Object.assign({ enrollment_id: id, contact_id: contactId, sequence_id: seq, rule_rev: 'bc-1',
    mode: 'production', status: 'active', enrolled_on: on, stopped_branches: [] }, extra || {});
}
function world(contacts, enrollments, rulesets) {
  return { rulesets: rulesets || { 'bc-1': BC }, contacts, enrollments,
    deliveries: [], holds: {}, signals: [], suppressions: [], paused: {} };
}
// The engine's daily loop, in miniature.
function simulate(w, from, to, hooks) {
  hooks = hooks || {};
  const sends = [];
  for (let d = from; d <= to; d = L.addDays(d, 1)) {
    if (hooks.before) hooks.before(d, w);
    const r = L.decide(Object.assign({}, w, { today: d, commsSentToday: (hooks.comms && hooks.comms[d]) || [] }));
    r.enrollments.forEach(e => Object.assign(w.enrollments.find(x => x.enrollment_id === e.enrollment_id), {
      status: e.status, stop_reason: e.stop_reason, stopped_branches: e.stopped_branches,
      stopped_steps: e.stopped_steps, flags: e.flags }));
    r.due.forEach(x => {
      w.deliveries.push({ key: x.key, enrollment_id: x.enrollment_id, contact_id: x.contact_id, mode: x.mode,
        step_id: x.step_id, occurrence: x.occurrence, state: 'sent', sent_at: d });
      sends.push(x.step_id + (STEP[x.step_id].repeat_count > 1 ? '#' + x.occurrence : '') + ' ' + d);
      const sub = STEP[x.step_id].on_send_sub_bucket;
      if (sub) w.contacts.find(c => c.contact_id === x.contact_id).sub_bucket = sub;
    });
    r.deliveries.filter(x => x.outcome === 'held').forEach(x => { w.holds[x.key] = (w.holds[x.key] || 0) + 1; });
    if (hooks.after) hooks.after(d, w, r);
  }
  return sends;
}
const outcomeOn = (w, day, key, extra) => L.decide(Object.assign({}, w, { today: day }, extra || {}))
  .deliveries.find(d => d.key === key);

// ── Worked examples (PLAN.md → Scheduling semantics) ─────────────────────────

test('1. B confirmed Mon Oct 26: Intro day 1, Follow Up Oct 30, Check-In Nov 8', () => {
  const w = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26')]);
  assert.deepEqual(simulate(w, '2026-10-26', '2026-11-30'),
    ['b_intro 2026-10-26', 'b_followup 2026-10-30', 'b_checkin 2026-11-08']);
  assert.equal(w.enrollments[0].status, 'completed');
});

test('2. Intro sent late (Oct 28) shifts the chain: Follow Up Nov 1', () => {
  const w = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26')]);
  const sends = simulate(w, '2026-10-26', '2026-11-30', { before: (d, w) => { w.paused = { all: d < '2026-10-28' }; } });
  assert.deepEqual(sends, ['b_intro 2026-10-28', 'b_followup 2026-11-01', 'b_checkin 2026-11-10']);
});

test('3. Intro blocked 8 days (window 7): whole chain expires, enrollment stops for review', () => {
  const w = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26')]);
  const sends = simulate(w, '2026-10-26', '2026-11-20', { before: (d, w) => { w.paused = { all: d <= '2026-11-02' }; } });
  assert.deepEqual(sends, []);
  const intro = outcomeOn(w, '2026-11-03', 'e1:b_intro:1');
  assert.equal(intro.outcome, 'stopped'); // already closed out by the run on Nov 3
  const en = w.enrollments[0];
  assert.equal(en.status, 'stopped');
  assert.equal(en.stop_reason, 'prerequisite_expired');
  assert.ok(en.flags.includes('needs_review') && en.flags.includes('expired_steps'));
});

test('3b. ...and on the day it expires, the reasons are explicit', () => {
  const w = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26')]);
  const r = L.decide(Object.assign({}, w, { today: '2026-11-03' }));
  const by = Object.fromEntries(r.deliveries.map(d => [d.step_id, d]));
  assert.equal(by.b_intro.outcome, 'expired'); assert.equal(by.b_intro.reason, 'window_passed');
  assert.equal(by.b_followup.outcome, 'expired'); assert.equal(by.b_followup.reason, 'prerequisite_expired');
  assert.equal(by.b_checkin.outcome, 'expired'); assert.equal(by.b_checkin.reason, 'prerequisite_expired');
});

test('4. C startup Oct 28: Welcome due Oct 25, last send day (hard deadline) Oct 27', () => {
  const w = world([contact('c2', 'C', { startup_date: '2026-10-28' })], [enrollment('e2', 'c2', 'C', '2026-10-20')]);
  const welcome = outcomeOn(w, '2026-10-20', 'e2:c_welcome:1');
  assert.equal(welcome.due, '2026-10-25');
  assert.equal(welcome.last_send_day, '2026-10-27');
  assert.equal(welcome.outcome, 'upcoming');
  assert.equal(simulate(w, '2026-10-20', '2026-10-27')[0], 'c_welcome 2026-10-25');
});

test('5. Startup moved to Nov 4 before Welcome: everything re-plans from the new date', () => {
  const w = world([contact('c2', 'C', { startup_date: '2026-10-28' })], [enrollment('e2', 'c2', 'C', '2026-10-20')]);
  const sends = simulate(w, '2026-10-20', '2026-12-15', {
    before: (d, w) => { if (d === '2026-10-22') w.contacts[0].startup_date = '2026-11-04'; } });
  assert.deepEqual(sends, ['c_welcome 2026-11-01', 'c_progress#1 2026-11-11', 'c_progress#2 2026-11-18',
    'c_progress#3 2026-11-25', 'c_maint 2026-11-26', 'c_progress#4 2026-12-02', 'c_final 2026-12-03']);
});

test('6 (row 17). Startup moved after Welcome sent: no re-send, Progress re-plans, Activity flag', () => {
  const w = world([contact('c2', 'C', { startup_date: '2026-10-28' })],
    [enrollment('e2', 'c2', 'C', '2026-10-20', { anchor_snapshot: { startup_date: '2026-10-28' } })]);
  const sends = simulate(w, '2026-10-20', '2026-11-12', {
    before: (d, w) => { if (d === '2026-10-26') w.contacts[0].startup_date = '2026-11-04'; } });
  assert.deepEqual(sends, ['c_welcome 2026-10-25', 'c_progress#1 2026-11-11']);
  assert.ok(w.enrollments[0].flags.includes('anchor_moved_after_send'));
});

test('7. Startup Sep 28 collisions: one email a day, the later step waits a day', () => {
  const w = world([contact('c2', 'C', { startup_date: '2026-09-28' })], [enrollment('e2', 'c2', 'C', '2026-09-20')]);
  assert.deepEqual(simulate(w, '2026-09-20', '2026-11-10'), ['c_welcome 2026-09-25', 'c_progress#1 2026-10-05',
    'c_progress#2 2026-10-12', 'c_progress#3 2026-10-19', 'c_maint 2026-10-20', 'c_progress#4 2026-10-26', 'c_final 2026-10-27']);
});

test('8 (row 24). Comms emailed the contact today: lifecycle email held to tomorrow (best-effort)', () => {
  const w = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26')]);
  const sends = simulate(w, '2026-10-26', '2026-10-28', { comms: { '2026-10-26': ['C1@Example.com '] } });
  assert.deepEqual(sends, ['b_intro 2026-10-27']);
});

test('9. C without a startup date: waiting_anchor, nothing due', () => {
  const w = world([contact('c2', 'C')], [enrollment('e2', 'c2', 'C', '2026-10-20')]);
  const r = L.decide(Object.assign({}, w, { today: '2026-10-26' }));
  assert.equal(r.enrollments[0].status, 'waiting_anchor');
  assert.equal(r.due.length, 0);
  assert.ok(r.deliveries.every(d => d.outcome === 'waiting_anchor'));
});

test('11. Follow Up +4 -> +6: "active enrollments" moves it to Nov 1; "new only" keeps Oct 30', () => {
  const rev2 = JSON.parse(JSON.stringify(BC));
  rev2.rule_rev = 'bc-2'; rev2.steps.find(s => s.step_id === 'b_followup').offset = 6;
  const rulesets = { 'bc-1': BC, 'bc-2': rev2 };
  const migrated = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26', { rule_rev: 'bc-2' })], rulesets);
  assert.deepEqual(simulate(migrated, '2026-10-26', '2026-11-02').slice(0, 2), ['b_intro 2026-10-26', 'b_followup 2026-11-01']);
  const pinned = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26', { rule_rev: 'bc-1' })], rulesets);
  assert.deepEqual(simulate(pinned, '2026-10-26', '2026-11-02').slice(0, 2), ['b_intro 2026-10-26', 'b_followup 2026-10-30']);
});

test('12 (row 16). Re-entry: a returning B contact goes to Needs review, never a second Intro', () => {
  const seq = BC.sequences.find(s => s.sequence_id === 'B');
  const c = contact('c1', 'B');
  const prior = [{ contact_id: 'c1', sequence_id: 'B', status: 'completed', enrolled_on: '2026-03-01' }];
  assert.deepEqual(L.decideEnrollment(c, seq, prior, '2026-10-26'), { action: 'needs_review', reason: 'already_completed_sequence' });
  assert.equal(L.decideEnrollment(c, seq, [], '2026-10-26').action, 'enroll');
  assert.equal(L.decideEnrollment(c, seq, [{ contact_id: 'c1', sequence_id: 'B', status: 'active' }], '2026-10-26').action, 'none');
  assert.equal(L.decideEnrollment(contact('c9', 'B', { review_status: 'needs_review' }), seq, [], '2026-10-26').reason, 'not_confirmed');
  const after = { sequence_id: 'B', reentry: 'after_days:180' };
  assert.equal(L.decideEnrollment(c, after, [{ contact_id: 'c1', sequence_id: 'B', status: 'stopped', stopped_on: '2026-03-01' }], '2026-10-26').action, 'enroll');
  assert.equal(L.decideEnrollment(c, after, [{ contact_id: 'c1', sequence_id: 'B', status: 'stopped', stopped_on: '2026-09-01' }], '2026-10-26').reason, 'reentry_too_soon');
});

test('13 (row 25). Welcome held every day by Comms: expires at the hard deadline (startup - 1), flagged', () => {
  const w = world([contact('c2', 'C', { startup_date: '2026-10-28' })], [enrollment('e2', 'c2', 'C', '2026-10-20')]);
  const comms = { '2026-10-25': ['c2@example.com'], '2026-10-26': ['c2@example.com'], '2026-10-27': ['c2@example.com'] };
  const sends = simulate(w, '2026-10-20', '2026-10-28', { comms });
  assert.ok(!sends.some(s => s.startsWith('c_welcome')));
  const welcome = outcomeOn(w, '2026-10-28', 'e2:c_welcome:1');
  assert.equal(welcome.outcome, 'expired'); assert.equal(welcome.reason, 'deadline_passed');
  assert.equal(welcome.last_send_day, '2026-10-27'); // window + 1 hold = Oct 28, but the deadline wins
  assert.ok(w.enrollments[0].flags.includes('expired_steps'));
});

test('13b (row 25). Without a deadline, the hold cap still ends it: nothing stays eligible forever', () => {
  const w = world([contact('c2', 'C', { startup_date: '2026-09-28' })], [enrollment('e2', 'c2', 'C', '2026-09-20')]);
  const comms = {}; for (let d = '2026-10-19'; d <= '2026-10-30'; d = L.addDays(d, 1)) comms[d] = ['c2@example.com'];
  simulate(w, '2026-09-20', '2026-10-27', { comms });
  const maint = outcomeOn(w, '2026-10-27', 'e2:c_maint:1');
  assert.equal(maint.outcome, 'expired'); assert.equal(maint.reason, 'hold_cap_reached');
  assert.equal(maint.last_send_day, '2026-10-26'); // due Oct 19 + window 5 + max_hold 2
});

test('14 (row 18). C marketing opt-out: Maintenance suppressed; every service email still sends', () => {
  const w = world([contact('c2', 'C', { startup_date: '2026-09-28' })], [enrollment('e2', 'c2', 'C', '2026-09-20')]);
  w.suppressions = [{ email_norm: 'c2@example.com', scope: 'marketing' }];
  const sends = simulate(w, '2026-09-20', '2026-11-10');
  assert.deepEqual(sends, ['c_welcome 2026-09-25', 'c_progress#1 2026-10-05', 'c_progress#2 2026-10-12',
    'c_progress#3 2026-10-19', 'c_progress#4 2026-10-26', 'c_final 2026-10-27']);
  assert.equal(outcomeOn(world([contact('c2', 'C', { startup_date: '2026-09-28' })], [enrollment('e2', 'c2', 'C', '2026-09-20')]),
    '2026-10-19', 'e2:c_maint:1', { suppressions: w.suppressions }).outcome, 'suppressed');
});

for (const [n, signal] of [['15', 'click'], ['16', 'form']]) {
  test(n + ' (row 19). ' + signal + ' on Maintenance stops the marketing branch only; Final Transition still sends', () => {
    const w = world([contact('c2', 'C', { startup_date: '2026-09-28' })], [enrollment('e2', 'c2', 'C', '2026-09-20')]);
    const sends = simulate(w, '2026-09-20', '2026-11-10', { before: (d, w) => {
      if (d === '2026-10-21') w.signals = [{ enrollment_id: 'e2', step_id: 'c_maint', signal, confidence: 'high' }]; } });
    assert.ok(sends.includes('c_final 2026-10-27'));
    assert.ok(w.enrollments[0].stopped_branches.includes('marketing'));
    assert.notEqual(w.enrollments[0].status, 'stopped');
  });
}

// ── Stop rules and guards beyond the numbered examples ───────────────────────

test('B reply after the Intro stops the whole enrollment: no Follow Up', () => {
  const w = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26')]);
  const sends = simulate(w, '2026-10-26', '2026-11-20', { before: (d, w) => {
    if (d === '2026-10-27') w.signals = [{ enrollment_id: 'e1', step_id: 'b_intro', signal: 'reply' }]; } });
  assert.deepEqual(sends, ['b_intro 2026-10-26']);
  assert.equal(w.enrollments[0].status, 'stopped'); assert.equal(w.enrollments[0].stop_reason, 'replied');
});

test('A medium-confidence click (or an auto-reply) stops nothing', () => {
  for (const sig of [{ signal: 'click', confidence: 'medium' }, { signal: 'click', confidence: 'low' }, { signal: 'auto_reply' }]) {
    const w = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26')]);
    const sends = simulate(w, '2026-10-26', '2026-11-01', { before: (d, w) => {
      if (d === '2026-10-27') w.signals = [Object.assign({ enrollment_id: 'e1', step_id: 'b_intro' }, sig)]; } });
    assert.deepEqual(sends, ['b_intro 2026-10-26', 'b_followup 2026-10-30'], JSON.stringify(sig));
  }
});

test('Unsubscribe-all (or a bounce) stops every enrollment for that person', () => {
  const w = world([contact('c2', 'C', { startup_date: '2026-09-28' })], [enrollment('e2', 'c2', 'C', '2026-09-20')]);
  const sends = simulate(w, '2026-09-20', '2026-11-10', { before: (d, w) => {
    if (d === '2026-10-06') w.suppressions = [{ email_norm: 'c2@example.com', scope: 'all' }]; } });
  assert.deepEqual(sends, ['c_welcome 2026-09-25', 'c_progress#1 2026-10-05']);
  assert.equal(w.enrollments[0].stop_reason, 'suppressed_all');
});

test('Test-mode suppression never touches production, and vice versa', () => {
  const w = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26')]);
  w.suppressions = [{ email_norm: 'c1@example.com', scope: 'all', mode: 'test' }];
  assert.equal(outcomeOn(w, '2026-10-26', 'e1:b_intro:1').outcome, 'due');
});

test('A delivery already handed to the send path is never re-planned', () => {
  const w = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26')]);
  for (const state of ['claimed', 'drafted', 'sending', 'reconcile', 'unknown']) {
    w.deliveries = [{ key: 'e1:b_intro:1', enrollment_id: 'e1', contact_id: 'c1', state }];
    for (const day of ['2026-10-26', '2026-10-30', '2026-12-31']) {
      const d = outcomeOn(w, day, 'e1:b_intro:1');
      assert.equal(d.outcome, 'in_flight', state + ' on ' + day);
    }
  }
});

test('Paused engine, paused bucket and paused enrollment send nothing (and do not count as holds)', () => {
  const w = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26')]);
  assert.equal(outcomeOn(w, '2026-10-26', 'e1:b_intro:1', { paused: { all: true } }).outcome, 'paused');
  assert.equal(outcomeOn(w, '2026-10-26', 'e1:b_intro:1', { paused: { buckets: ['B'] } }).outcome, 'paused');
  const p = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26', { status: 'paused' })]);
  assert.equal(outcomeOn(p, '2026-10-26', 'e1:b_intro:1').outcome, 'paused');
});

test('Needs-review contacts are planned but never due', () => {
  const w = world([contact('c1', 'B', { review_status: 'needs_review' })], [enrollment('e1', 'c1', 'B', '2026-10-26')]);
  const d = outcomeOn(w, '2026-10-26', 'e1:b_intro:1');
  assert.equal(d.outcome, 'excluded'); assert.equal(d.reason, 'needs_review');
});

test('Deferred timing (business days, events) is reported, never guessed', () => {
  const rs = JSON.parse(JSON.stringify(BC));
  rs.steps.find(s => s.step_id === 'b_intro').unit = 'business';
  const w = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26')], { 'bc-1': rs });
  const d = outcomeOn(w, '2026-10-26', 'e1:b_intro:1');
  assert.equal(d.outcome, 'excluded'); assert.equal(d.reason, 'unsupported_in_this_release');
});

// ── Runtimes and clock ───────────────────────────────────────────────────────

test('Loads as a browser / Apps Script global (no module system)', () => {
  const ctx = { Intl, Date, Math, JSON, String, Object, Array };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(RULES_PATH, 'utf8'), ctx, { filename: 'lifecycle-rules.js' });
  assert.equal(typeof ctx.MCPS_LIFECYCLE.decide, 'function');
  const r = ctx.MCPS_LIFECYCLE.decide({ today: '2026-10-26', rulesets: { 'bc-1': BC },
    contacts: [contact('c1', 'B')], enrollments: [enrollment('e1', 'c1', 'B', '2026-10-26')] });
  assert.equal(r.due.length, 1);
});

test('"Today" is the America/Chicago calendar date, across the DST change', () => {
  assert.equal(L.localDate(new Date('2026-11-02T04:30:00Z'), 'America/Chicago'), '2026-11-01'); // 10:30 pm CST
  assert.equal(L.localDate(new Date('2026-11-02T06:30:00Z'), 'America/Chicago'), '2026-11-02');
  assert.equal(L.localDate(new Date('2026-03-08T07:30:00Z'), 'America/Chicago'), '2026-03-08'); // spring forward
  assert.equal(L.addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(L.addDays('2026-03-08', 1), '2026-03-09');
});

test('Ended attempts: released/cancelled re-plan; abandoned and failed never do', () => {
  const w = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26')]);
  const expect = { released: 'due', cancelled: 'due', abandoned: 'excluded', failed: 'failed' };
  for (const [state, outcome] of Object.entries(expect)) {
    w.deliveries = [{ key: 'e1:b_intro:1', enrollment_id: 'e1', contact_id: 'c1', state, error: 'attachment' }];
    assert.equal(outcomeOn(w, '2026-10-26', 'e1:b_intro:1').outcome, outcome, state);
  }
  w.deliveries = [{ key: 'e1:b_intro:1', enrollment_id: 'e1', contact_id: 'c1', state: 'failed' }];
  assert.notEqual(L.decide(Object.assign({}, w, { today: '2026-11-20' })).enrollments[0].status, 'completed');
});

test('A 7 pm send counts as that local day, not the next UTC day', () => {
  const w = world([contact('c1', 'B')], [enrollment('e1', 'c1', 'B', '2026-10-26')]);
  // 7:30 pm CDT on Oct 26 = 00:30 UTC on Oct 27
  w.deliveries = [{ key: 'e1:b_intro:1', enrollment_id: 'e1', contact_id: 'c1', mode: 'production', state: 'sent', sent_at: '2026-10-27T00:30:00Z' }];
  assert.equal(outcomeOn(w, '2026-10-26', 'e1:b_followup:1').due, '2026-10-30', 'Follow Up = local send day + 4');
  assert.equal(L.localDay('2026-10-27T00:30:00Z', 'America/Chicago'), '2026-10-26');
  assert.equal(L.localDay('2026-10-26', 'America/Chicago'), '2026-10-26');
});
