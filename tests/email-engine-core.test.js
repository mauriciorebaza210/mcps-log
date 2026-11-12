// Engine core: Journal, fenced lease, delivery stages, reconcile, Resend.
// Runs email-engine/src/EngineCore.js against a fake Gmail and in-memory sheets
// with fault injection. Row numbers refer to PLAN.md → Failure acceptance matrix
// (the FG rows; SB rows run in the sandbox mailbox at CP4).
//
//   npm run test:ee
//
// Two properties are checked everywhere, not just in named tests:
//   - Gmail is never called while the script lock is held (the fake throws).
//   - The Journal alone rebuilds the main sheet exactly (assertReplayable).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fakeWorld, enroll, item, assertReplayable, MIN, T0 } = require('./helpers/ee-fake-env.js');
const runPlan = (w, plan, opts) => w.core.run(Object.assign({ plan: () => plan }, opts || {}));

// ── Happy path ───────────────────────────────────────────────────────────────

test('Sends each due delivery once; a second run sends nothing (same external count)', () => {
  const w = fakeWorld(); enroll(w, 'e1'); enroll(w, 'e2');
  const plan = [item('e1:b_intro:1'), item('e2:b_intro:1', { enrollment_id: 'e2', contact_id: 'c2', email_norm: 'james@example.com' })];
  const s1 = runPlan(w, plan);
  assert.equal(s1.sent, 2); assert.equal(s1.stopped_reason, 'done');
  assert.equal(w.outbox.length, 2);
  assert.equal(w.delivery('e1:b_intro:1').state, 'sent');
  assert.match(w.delivery('e1:b_intro:1').token, /^dlv_[0-9a-f]{32}$/);
  const s2 = runPlan(w, plan);
  assert.equal(s2.sent, 0); assert.equal(w.outbox.length, 2);
  assert.equal(Object.keys(w.drafts).length, 0);
  assertReplayable(w);
});

// ── Interrupted sends (rows 1–6, 41) ─────────────────────────────────────────

test('Row 1: Gmail accepts, then the process dies before "sent" is written: one email', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.faults['send.kill'] = { times: 1 };
  assert.throws(() => runPlan(w, [item('e1:b_intro:1')]), e => e.killed);
  assert.equal(w.delivery('e1:b_intro:1').state, 'sending');
  w.revive(); w.now += 8 * MIN;                         // the dead run's lease has expired
  const s = runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(s.sent, 0);
  assert.equal(w.delivery('e1:b_intro:1').state, 'sent');
  assert.equal(w.delivery('e1:b_intro:1').resolved_by, 'sent_search');
  assert.equal(w.outbox.length, 1, 'external send count');
  assertReplayable(w);
});

test('Row 2: the process dies after the draft is recorded, before authorization: one email', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  const lease = w.core.acquireLease('run_A');
  const c = w.core.claim(lease, item('e1:b_intro:1'));
  w.core.prepare(lease, c.row);
  w.dead = true;                                        // dies here; the lease is never released
  w.revive(); w.now += 8 * MIN;
  const s = runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(s.adopted, 1); assert.equal(s.sent, 1);
  assert.equal(w.outbox.length, 1);
  assertReplayable(w);
});

test('Row 3: dies after Gmail created the draft but before its id was saved: orphan removed, one email', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.faults['createDraft.kill'] = { times: 1 };
  assert.throws(() => runPlan(w, [item('e1:b_intro:1')]), e => e.killed);
  assert.equal(w.delivery('e1:b_intro:1').state, 'claimed');
  assert.equal(Object.keys(w.drafts).length, 1, 'orphan draft exists');
  w.revive(); w.now += 8 * MIN;
  const s = runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(s.sent, 1);
  assert.equal(w.delivery('e1:b_intro:1').attempt, 2);
  assert.equal(Object.keys(w.drafts).length, 0, 'orphan deleted');
  assert.equal(w.outbox.length, 1);
  assertReplayable(w);
});

test('Row 4: send() throws (nothing was sent): reconcile, then unknown; never resent', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.faults['send.timeout'] = { times: 1 };
  const s1 = runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(s1.reconcile, 1);
  assert.equal(w.delivery('e1:b_intro:1').state, 'reconcile');
  for (const mins of [1, 5, 16]) {                     // before G, between G and G2, past G2
    w.now = T0 + mins * MIN;
    runPlan(w, [item('e1:b_intro:1')]);
  }
  assert.equal(w.delivery('e1:b_intro:1').state, 'unknown');
  assert.ok(w.alerts.some(a => a.startsWith('delivery_unknown')));
  assert.equal(w.outbox.length, 0, 'never sent automatically');
});

test('Row 5: a delayed send shows up in Sent later: resolved to sent, no duplicate', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.faults['send.ackLost'] = { times: 1 };
  w.faults['send.delayed'] = { times: 1, ms: 10 * MIN };
  runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(w.delivery('e1:b_intro:1').state, 'reconcile');
  w.now = T0 + 4 * MIN; runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(w.delivery('e1:b_intro:1').state, 'reconcile', 'not visible yet');
  w.now = T0 + 11 * MIN; runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(w.delivery('e1:b_intro:1').state, 'sent');
  assert.equal(w.outbox.length, 1);
});

test('Rows 6 and 41: no copy in Sent after G2: unknown + alert, and it is never eligible again', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.faults['send.killBefore'] = { times: 1 };
  assert.throws(() => runPlan(w, [item('e1:b_intro:1')]), e => e.killed);
  w.revive(); w.now += 16 * MIN;
  runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(w.delivery('e1:b_intro:1').state, 'unknown');
  w.now += 24 * 60 * MIN;
  const s = runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(s.sent, 0); assert.equal(w.outbox.length, 0);
});

// ── Overlapping and stale workers (rows 7, 8, 35a, 35b) ──────────────────────

test('Row 7: a second run while one holds the lease refuses ("already running")', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.core.acquireLease('run_trigger');
  assert.equal(runPlan(w, [item('e1:b_intro:1')]).stopped_reason, 'already_running');
  assert.equal(w.outbox.length, 0);
});

test('Row 8: a resume trigger firing twice in a row sends nothing extra', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  runPlan(w, [item('e1:b_intro:1')]); runPlan(w, [item('e1:b_intro:1')]); runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(w.outbox.length, 1);
});

test('Row 35a: a stale worker cannot authorize after another worker took over', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  const leaseA = w.core.acquireLease('run_A');
  const c = w.core.claim(leaseA, item('e1:b_intro:1'));
  const drafted = w.core.prepare(leaseA, c.row);
  w.now += 8 * MIN;                                     // A stalls; its lease expires
  const sB = runPlan(w, [item('e1:b_intro:1')]);       // B adopts and sends
  assert.equal(sB.sent, 1);
  const journalLen = w.journal.length;
  assert.throws(() => w.core.authorize(leaseA, drafted), e => e.name === 'StaleLease');
  assert.equal(w.journal.length, journalLen, 'A wrote nothing');
  assert.equal(w.outbox.length, 1);
});

test('Row 35b: stale after authorization: its send may complete, but never twice', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  const leaseA = w.core.acquireLease('run_A');
  const c = w.core.claim(leaseA, item('e1:b_intro:1'));
  const a = w.core.authorize(leaseA, w.core.prepare(leaseA, c.row));
  assert.equal(a.row.state, 'sending');
  w.now += 8 * MIN;                                     // A paused right before calling Gmail
  runPlan(w, [item('e1:b_intro:1')]);                   // B: sees `sending`, nothing in Sent yet
  assert.equal(w.delivery('e1:b_intro:1').state, 'reconcile');
  assert.equal(w.outbox.length, 0);
  w.core.sendAuthorized(leaseA, a.row);                 // A resumes: the authorized send completes
  assert.equal(w.outbox.length, 1);
  assert.equal(w.delivery('e1:b_intro:1').state, 'reconcile', "A's stale 'sent' write was refused");
  runPlan(w, [item('e1:b_intro:1')]);                   // the current worker finishes the bookkeeping
  assert.equal(w.delivery('e1:b_intro:1').state, 'sent');
  assert.equal(w.outbox.length, 1);
  assert.equal(w.core.resend('e1:b_intro:1', 'mau').reason, 'not_unknown');
  assertReplayable(w);
});

// ── Unsubscribe ordering (rows 36–38, 10) ────────────────────────────────────

test('Row 36: unsubscribe recorded before authorization: that delivery is cancelled and its draft deleted', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  const lease = w.core.acquireLease('run_A');
  const drafted = w.core.prepare(lease, w.core.claim(lease, item('e1:b_intro:1')).row);
  assert.ok(w.core.ingest({ event_id: 'u1', type: 'unsubscribe', email_norm: 'Maria@Example.com', scope: 'all' }).ok);
  const a = w.core.authorize(lease, drafted);
  assert.equal(a.ok, false); assert.equal(a.reason, 'suppressed');
  assert.equal(w.delivery('e1:b_intro:1').state, 'cancelled');
  assert.equal(Object.keys(w.drafts).length, 0);
  assert.equal(w.outbox.length, 0);
});

test('Rows 37 and 10: unsubscribe just after authorization: that send completes; later ones are blocked', () => {
  const w = fakeWorld(); enroll(w, 'e1'); enroll(w, 'e1b');
  const lease = w.core.acquireLease('run_A');
  const a = w.core.authorize(lease, w.core.prepare(lease, w.core.claim(lease, item('e1:b_intro:1')).row));
  w.core.ingest({ event_id: 'u1', type: 'unsubscribe', email_norm: 'maria@example.com', scope: 'all' });
  w.core.sendAuthorized(lease, a.row);
  assert.equal(w.outbox.length, 1);
  const next = w.core.claim(lease, item('e1b:b_followup:1', { enrollment_id: 'e1b', step_id: 'b_followup' }));
  assert.equal(next.skipped, 'suppressed');
  assert.equal(w.outbox.length, 1);
});

test('Row 38: unsubscribe arriving during the Gmail call: that send completes, logged; nothing after it', () => {
  const w = fakeWorld(); enroll(w, 'e1'); enroll(w, 'e1b');
  w.hooks.beforeSend = () => { w.hooks.beforeSend = null; w.core.ingest({ event_id: 'u1', type: 'unsubscribe', email_norm: 'maria@example.com', scope: 'all' }); };
  const s = runPlan(w, [item('e1:b_intro:1'), item('e1b:b_followup:1', { enrollment_id: 'e1b', step_id: 'b_followup' })]);
  assert.equal(s.sent, 1); assert.equal(s.skipped, 1);
  assert.equal(w.sentTo('maria@example.com'), 1);
  assertReplayable(w);
});

// ── Gates (rows 11, 15, 26, 27, 29) ──────────────────────────────────────────

test('Row 11: shared opt-out list unreadable: nothing sends, run stops, alert', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.faults['optouts.scope'] = {};
  const s = runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(s.stopped_reason, 'suppression_unavailable');
  assert.equal(w.outbox.length, 0);
  assert.ok(w.alerts.some(a => a.startsWith('run_stopped:suppression_unavailable')));
});

test('Row 15: a recovered draft re-passes the full gate (retire, bucket pause, revoke, stop, opt-out)', () => {
  const cases = {
    'step retired': w => { w.steps.b_intro = 'retired'; },
    'bucket paused': w => { w.paused = ['B']; },
    'revision revoked': w => { w.revisions['rev-1'] = 'revoked'; },
    'enrollment stopped (bucket change)': w => { w.tables.Enrollments[0].status = 'stopped'; },
    'opted out': w => { w.optouts.push({ email: 'maria@example.com', scope: 'all', source: 'x' }); }
  };
  for (const [name, change] of Object.entries(cases)) {
    const w = fakeWorld(); enroll(w, 'e1');
    const lease = w.core.acquireLease('run_A');
    w.core.prepare(lease, w.core.claim(lease, item('e1:b_intro:1', { revision_id: 'rev-1' })).row);
    change(w); w.now += 8 * MIN;
    runPlan(w, []);
    assert.equal(w.delivery('e1:b_intro:1').state, 'cancelled', name);
    assert.equal(Object.keys(w.drafts).length, 0, name + ': draft deleted');
    assert.equal(w.outbox.length, 0, name);
  }
});

test('Row 26: quota reserve and daily cap stop cleanly; the next run continues', () => {
  const w = fakeWorld(); ['e1', 'e2', 'e3'].forEach(e => enroll(w, e));
  const plan = ['e1', 'e2', 'e3'].map((e, i) => item(e + ':b_intro:1', { enrollment_id: e, contact_id: 'c' + i, email_norm: e + '@example.com' }));
  w.quota = 20;                                         // at the default reserve
  const q = runPlan(w, plan);
  assert.equal(q.stopped_reason, 'quota_reserve');
  assert.deepEqual([q.quota_remaining, q.quota_reserve], [20, 20], 'the stop reports the numbers');
  assert.equal(w.outbox.length, 0);
  w.quota = 1500;
  const s = runPlan(w, plan, { dailyCap: 2 });
  assert.equal(s.sent, 2); assert.equal(s.stopped_reason, 'daily_cap');
  assert.equal(runPlan(w, plan, { dailyCap: 5, sentToday: 2 }).sent, 1);
  assert.equal(w.outbox.length, 3);
});

test('Row 27: running as anyone but the engine owner sends nothing', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.user = 'mauricio@mcpoolsolutions.org';
  assert.equal(runPlan(w, [item('e1:b_intro:1')]).stopped_reason, 'owner_guard');
  assert.equal(w.outbox.length, 0);
});

test('Row 29: kill switch: zero sends', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.enabled = false;
  assert.equal(runPlan(w, [item('e1:b_intro:1')]).stopped_reason, 'kill_switch');
  assert.equal(w.outbox.length, 0);
});

// ── Test-mode isolation (rows 28, 40) ────────────────────────────────────────

test('Rows 28 and 40: a test-mode unsubscribe never touches production suppression', () => {
  const w = fakeWorld(); enroll(w, 'e1'); enroll(w, 'et', { mode: 'test' });
  w.core.ingest({ event_id: 'ut', type: 'unsubscribe', mode: 'test', email_norm: 'maria@example.com', scope: 'all' });
  assert.equal(w.optouts.length, 0, 'Comms_Optouts untouched');
  assert.equal(w.cache['sup:production:maria@example.com'], undefined);
  assert.equal(w.cache['sup:test:maria@example.com'], 'all');
  const s = runPlan(w, [item('e1:b_intro:1'), item('et:b_intro:1', { enrollment_id: 'et', mode: 'test' })]);
  assert.equal(s.sent, 1, 'production delivery sends');
  assert.equal(w.delivery('e1:b_intro:1').state, 'sent');
  assert.equal(w.delivery('et:b_intro:1'), undefined, 'test delivery blocked by the test suppression');
});

// ── Journal faults (rows 42–45) ──────────────────────────────────────────────

for (const state of ['claimed', 'drafted', 'sending', 'sent']) {
  test('Row 42: fault between Journal append and main-sheet write at "' + state + '": replay restores it; never a second email', () => {
    const w = fakeWorld(); enroll(w, 'e1');
    w.faults['store.upsert:Deliveries'] = { times: 1, state };
    if (state === 'sent') runPlan(w, [item('e1:b_intro:1')]);   // after Gmail accepted: bookkeeping only, no crash
    else assert.throws(() => runPlan(w, [item('e1:b_intro:1')]), /main sheet write failed/);
    if (state !== 'sent') assert.notEqual(w.delivery('e1:b_intro:1') && w.delivery('e1:b_intro:1').state, state, 'main sheet missed the write');
    const journaled = w.journal.filter(r => r.data.state === state);
    assert.equal(journaled.length, 1, 'the Journal has the ' + state + ' record');
    w.now += 8 * MIN;
    runPlan(w, [item('e1:b_intro:1')]);                // catch-up replays before any claim
    w.now += 20 * MIN;
    runPlan(w, [item('e1:b_intro:1')]);
    const final = w.delivery('e1:b_intro:1').state;
    assert.ok(w.outbox.length <= 1, 'never two emails');
    if (state === 'sending') {
      assert.equal(w.outbox.length, 0, 'Gmail is not called when the "sending" write failed');
      assert.equal(final, 'unknown', 'an authorized delivery is never eligible again');
    } else {
      assert.equal(w.outbox.length, 1); assert.equal(final, 'sent');
    }
    assertReplayable(w);
  });
}

test('Row 42: fault applying an unsubscribe: replay restores it, and it still blocks the next send', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.faults['store.upsert:Inbox'] = { times: 1 };
  const r = w.core.ingest({ event_id: 'u1', type: 'unsubscribe', email_norm: 'maria@example.com', scope: 'all' });
  assert.equal(r.journaled, false);                     // the commit failed; the fallback kept the opt-out
  assert.equal(w.journal.filter(x => x.type === 'inbox').length, 1);
  delete w.props.EE_SAFETY_PAUSE;                       // an operator clears the pause after checking
  const s = runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(s.sent, 0);
  assert.ok(w.tables.Inbox.some(x => x.inbox_id === 'u1'), 'catch-up materialized the unsubscribe');
});

test('Row 43: Journal append succeeded but its acknowledgement was lost: no duplicate record', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.faults['journal.append'] = { times: 1, mode: 'ack_lost' };
  const s = runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(s.sent, 1);
  const ids = w.journal.map(r => r.op_id);
  assert.equal(new Set(ids).size, ids.length, 'every op_id appears once');
  assertReplayable(w);
});

test('Row 44: Journal unreadable: the engine pauses itself, alerts, and still records the unsubscribe', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.faults['journal.unavailable'] = {};
  assert.equal(runPlan(w, [item('e1:b_intro:1')]).stopped_reason, 'safety_pause');
  assert.ok(w.alerts.some(a => a.startsWith('journal_integrity:journal_unavailable')));
  const r = w.core.ingest({ event_id: 'u9', type: 'unsubscribe', email_norm: 'maria@example.com', scope: 'all' });
  assert.deepEqual([r.ok, r.journaled], [true, false]);
  assert.ok(w.optouts.some(o => o.source === 'fallback:inbox:u9'));
  delete w.faults['journal.unavailable'];
  assert.equal(runPlan(w, [item('e1:b_intro:1')]).stopped_reason, 'safety_pause', 'stays closed until a person clears it');
  assert.equal(w.outbox.length, 0);
});

test('Row 44: a broken hash chain or a sequence gap pauses the engine', () => {
  for (const tamper of ['hash', 'gap']) {
    const w = fakeWorld(); enroll(w, 'e1'); enroll(w, 'e2');
    runPlan(w, [item('e1:b_intro:1')]);
    w.meta.applied_seq = 1;                              // pretend this worker had only applied record 1
    if (tamper === 'hash') w.journal[2].data.state = 'sent_EDITED';
    else w.journal.splice(1, 1);
    const s = runPlan(w, [item('e2:b_intro:1', { enrollment_id: 'e2', email_norm: 'b@example.com' })]);
    assert.equal(s.stopped_reason, 'safety_pause', tamper);
    assert.ok(w.props.EE_SAFETY_PAUSE, tamper);
    assert.equal(w.outbox.length, 1, tamper + ': nothing more sent');
  }
});

test('Row 45: interrupted Comms_Optouts write is applied exactly once on replay', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.faults['optouts.append'] = { times: 1 };
  assert.ok(w.core.ingest({ event_id: 'u1', type: 'unsubscribe', email_norm: 'maria@example.com', scope: 'all' }).journaled);
  assert.equal(w.optouts.length, 0, 'secondary write failed');
  runPlan(w, []); runPlan(w, []);
  assert.equal(w.optouts.filter(o => o.source === 'inbox:u1').length, 1);
  assert.equal(w.tables.Secondaries[0].status, 'done');
});

// ── Resend (row 46) and operator actions ─────────────────────────────────────

test('Row 46: Resend is refused until quiescence, then sends once through the normal path', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.faults['send.killBefore'] = { times: 1 };
  assert.throws(() => runPlan(w, [item('e1:b_intro:1')]), e => e.killed);
  w.revive(); w.now = T0 + 16 * MIN; runPlan(w, []);
  assert.equal(w.delivery('e1:b_intro:1').state, 'unknown');
  const early = w.core.resend('e1:b_intro:1', 'mau');
  assert.equal(early.reason, 'quiescence');
  assert.equal(early.unlock_at, new Date(T0 + 36 * MIN).toISOString());
  w.now = T0 + 37 * MIN;
  assert.equal(w.core.resend('e1:b_intro:1', 'mau').ok, true);
  assert.equal(w.delivery('e1:b_intro:1').state, 'released');
  assert.equal(runPlan(w, [item('e1:b_intro:1')]).sent, 1);
  assert.equal(w.delivery('e1:b_intro:1').attempt, 2);
  assert.equal(w.outbox.length, 1);
});

test('Resend finds the earlier copy in Sent at the last moment: marks it sent instead', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.faults['send.ackLost'] = { times: 1 };
  w.faults['send.delayed'] = { times: 1, ms: 30 * MIN };
  runPlan(w, [item('e1:b_intro:1')]);
  w.now = T0 + 16 * MIN; runPlan(w, []);
  assert.equal(w.delivery('e1:b_intro:1').state, 'unknown');
  w.now = T0 + 37 * MIN;
  assert.equal(w.core.resend('e1:b_intro:1', 'mau').reason, 'found_in_sent');
  assert.equal(w.delivery('e1:b_intro:1').state, 'sent');
  assert.equal(w.outbox.length, 1);
});

test('"It was sent" and "Don\'t send" resolve an unknown delivery for good', () => {
  for (const [action, end] of [['markSent', 'sent'], ['abandon', 'abandoned']]) {
    const w = fakeWorld(); enroll(w, 'e1');
    w.faults['send.killBefore'] = { times: 1 };
    assert.throws(() => runPlan(w, [item('e1:b_intro:1')]), e => e.killed);
    w.revive(); w.now = T0 + 16 * MIN; runPlan(w, []);
    assert.equal(w.core[action]('e1:b_intro:1', 'mau').ok, true);
    assert.equal(w.delivery('e1:b_intro:1').state, end);
    assert.equal(w.delivery('e1:b_intro:1').resolved_by, 'operator:mau');
    assert.equal(runPlan(w, [item('e1:b_intro:1')]).sent, 0, action);
  }
});

test('A template that fails at render time fails the delivery for a person; the run continues', () => {
  const w = fakeWorld(); enroll(w, 'e1'); enroll(w, 'e2');
  const real = w.env.render;
  w.env.render = row => { if (row.enrollment_id === 'e1') throw new Error('missing required Address (address)'); return real(row); };
  const s = runPlan(w, [item('e1:b_intro:1'), item('e2:b_intro:1', { enrollment_id: 'e2', email_norm: 'b@example.com' })]);
  assert.equal(s.failed, 1); assert.equal(s.sent, 1); assert.equal(s.stopped_reason, 'done');
  assert.equal(w.delivery('e1:b_intro:1').state, 'failed');
  assert.match(w.delivery('e1:b_intro:1').error, /missing required Address/);
  assert.ok(w.alerts.some(a => a.startsWith('delivery_failed:e1:b_intro:1')));
  assert.equal(runPlan(w, [item('e1:b_intro:1')]).sent, 0, 'not retried automatically');
  assertReplayable(w);
});

test('Contacts and enrollments are journaled: replay rebuilds them (row 39 groundwork)', () => {
  const w = fakeWorld();
  w.core.commitEntity('contact', { contact_id: 'c9', email_norm: 'new@example.com', bucket: 'B' }, 'contact:c9:create');
  w.core.commitEntity('enrollment', { enrollment_id: 'e9', contact_id: 'c9', status: 'active' }, 'enrollment:e9:create');
  w.core.commitEntity('enrollment', { enrollment_id: 'e9', status: 'stopped', stop_reason: 'form_submitted' }, 'enrollment:e9:stop');
  const fresh = fakeWorld(); fresh.journal = JSON.parse(JSON.stringify(w.journal)); fresh.core.catchUp();
  assert.equal(fresh.tables.Enrollments.find(e => e.enrollment_id === 'e9').status, 'stopped');
  assert.equal(fresh.tables.Enrollments.find(e => e.enrollment_id === 'e9').contact_id, 'c9', 'merged, not replaced');
  assert.ok(fresh.tables.Contacts && fresh.tables.Contacts.some(c => c.contact_id === 'c9'));
});

test('Gmail refusing to create a draft stops the run cleanly; the next run recovers the delivery', () => {
  const w = fakeWorld(); enroll(w, 'e1'); enroll(w, 'e2');
  const real = w.env.gmail.createDraft;
  w.env.gmail.createDraft = () => { throw new Error('The script does not have permission to perform that action'); };
  const s = runPlan(w, [item('e1:b_intro:1'), item('e2:b_intro:1', { enrollment_id: 'e2', email_norm: 'b@example.com' })]);
  assert.match(s.stopped_reason, /^gmail_error: The script does not have permission/);
  assert.ok(w.alerts.some(a => a.startsWith('run_stopped:gmail_error')));
  assert.equal(w.delivery('e1:b_intro:1').state, 'claimed'); assert.equal(w.delivery('e2:b_intro:1'), undefined, 'stopped before the next one');
  w.env.gmail.createDraft = real; w.now += 8 * MIN;
  assert.equal(runPlan(w, [item('e1:b_intro:1'), item('e2:b_intro:1', { enrollment_id: 'e2', email_norm: 'b@example.com' })]).sent, 2);
  assert.equal(w.delivery('e1:b_intro:1').attempt, 2, 'recovered like the real sandbox run');
  assert.equal(w.outbox.length, 2);
});

test('Row 34 / RUNBOOK §4 restore: catchUp replays the Journal into an older main sheet, with sending off and nothing sent', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(w.outbox.length, 1);
  const head = w.journal[w.journal.length - 1].seq;
  // The "backup": before the send was recorded.
  w.tables.Deliveries = []; w.meta.applied_seq = 0;
  w.tables.Config.push({ key: 'engine_enabled', value: 'false' });
  w.env.config.engineEnabled = () => false;
  assert.equal(runPlan(w, []).stopped_reason, 'kill_switch', 'Run now with sending off touches nothing');
  assert.equal(w.tables.Deliveries.length, 0);
  assert.equal(w.core.catchUp().applied_seq, head);
  assert.equal(w.delivery('e1:b_intro:1').state, 'sent', 'the sent delivery is back');
  assert.equal(w.outbox.length, 1, 'nothing sent again');
});

// ── Content binding and integrity (rows 12, 14) ──────────────────────────────

test('Row 12: content published mid-run: this run sends the version it planned with; only a revoked one is refused', () => {
  const w = fakeWorld(); enroll(w, 'e1'); enroll(w, 'e2');
  const plan = [item('e1:b_intro:1', { revision_id: 'rev_b_intro_1' }),
    item('e2:b_intro:1', { enrollment_id: 'e2', contact_id: 'c2', email_norm: 'james@example.com', revision_id: 'rev_b_intro_1' })];
  // Version 2 is approved while the first email is going out.
  w.hooks.beforeSend = () => { w.revisions.rev_b_intro_1 = 'superseded'; w.revisions.rev_b_intro_2 = 'published'; };
  const s = runPlan(w, plan);
  assert.equal(s.sent, 2);
  assert.deepEqual([w.delivery('e1:b_intro:1').revision_id, w.delivery('e2:b_intro:1').revision_id], ['rev_b_intro_1', 'rev_b_intro_1']);
  // A revoked version is different: it never goes out.
  const w2 = fakeWorld(); enroll(w2, 'e1');
  w2.revisions.rev_b_intro_1 = 'revoked';
  assert.equal(runPlan(w2, [item('e1:b_intro:1', { revision_id: 'rev_b_intro_1' })]).sent, 0);
  assert.equal(w2.outbox.length, 0);
});

test('Row 14: an approved file altered in Drive fails the delivery (no draft, no send) and alerts; it is not retried daily', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.env.render = () => { throw new Error('integrity: file f1 changed after approval'); };
  const s = runPlan(w, [item('e1:b_intro:1')]);
  assert.equal(s.sent, 0);
  const d = w.delivery('e1:b_intro:1');
  assert.equal(d.state, 'failed'); assert.match(d.error, /^integrity:/);
  assert.equal(Object.keys(w.drafts).length, 0); assert.equal(w.outbox.length, 0);
  assert.ok(w.alerts.some(a => /^delivery_failed:e1:b_intro:1: integrity/.test(a)));
  w.env.render = row => ({ to: row.email_norm, subject: 'Hello', html: '<p>Hi</p>', text: 'Hi' });
  assert.equal(runPlan(w, [item('e1:b_intro:1')]).sent, 0, 'failed stays failed until a person acts');
});

// ── Security audit and schema compatibility (rows 33, 32) ────────────────────

test('Row 33: a changed security property is logged to SecurityAudit (names only) and alerts; the first run is the quiet baseline', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.props.EE_LINK_SECRET = 'secret-one'; w.props.EE_OWNER_EMAIL = 'antonio@mcpoolsolutions.org';
  runPlan(w, []);
  assert.equal(w.tables.SecurityAudit.length, 0); assert.ok(!w.alerts.some(a => /^security_property_changed/.test(a)));
  runPlan(w, []);
  assert.equal(w.tables.SecurityAudit.length, 0, 'nothing changed');
  w.props.EE_LINK_SECRET = 'secret-two'; w.props.EE_REQUIRE_SECOND_APPROVER = 'true';
  runPlan(w, []);
  assert.equal(w.tables.SecurityAudit.length, 1);
  assert.equal(w.tables.SecurityAudit[0].changed, 'EE_LINK_SECRET,EE_REQUIRE_SECOND_APPROVER');
  assert.ok(w.alerts.some(a => a === 'security_property_changed:EE_LINK_SECRET, EE_REQUIRE_SECOND_APPROVER'));
  assert.ok(!JSON.stringify(w.tables.SecurityAudit).includes('secret-two') && !JSON.stringify(w.meta).includes('secret-two'), 'values are never stored');
  // Noticed even while sending is off.
  w.enabled = false; w.props.EE_RELAY_SECRET = 'x';
  assert.equal(runPlan(w, []).stopped_reason, 'kill_switch');
  assert.equal(w.tables.SecurityAudit.length, 2);
});

test('Row 32: data from a newer schema stops the run (rollback below the floor can’t corrupt it); additive columns are fine', () => {
  const w = fakeWorld(); enroll(w, 'e1');
  w.env.schema = { read_min: 1, read_max: 1, writes: 1 };
  // An additive migration rolled back: rows carry a column this code doesn't know. A full run passes.
  w.tables.Enrollments[0].column_from_a_newer_release = 'x';
  assert.equal(runPlan(w, [item('e1:b_intro:1')]).sent, 1);
  assert.equal(w.meta.data_schema, 1, 'the run records the schema it writes');
  // A semantic migration's contract step (schema 2) then a rollback to this code: it refuses to run.
  w.meta.data_schema = 2; enroll(w, 'e2');
  const s = runPlan(w, [item('e2:b_intro:1', { enrollment_id: 'e2', contact_id: 'c2', email_norm: 'james@example.com' })]);
  assert.equal(s.stopped_reason, 'schema_incompatible'); assert.equal(w.outbox.length, 1, 'nothing more sent');
  assert.ok(w.alerts.some(a => /^schema_incompatible:data schema 2, this code reads 1\.\.1/.test(a)));
  // The expand release reads both forms: 1..2 runs on schema-2 data.
  w.env.schema = { read_min: 1, read_max: 2, writes: 2 };
  assert.equal(runPlan(w, [item('e2:b_intro:1', { enrollment_id: 'e2', contact_id: 'c2', email_norm: 'james@example.com' })]).sent, 1);
});
