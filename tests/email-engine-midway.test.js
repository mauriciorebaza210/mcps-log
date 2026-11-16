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

// ── Bulk writes and re-imports (2026-11-14) ──
const { fakeWorld: fw2 } = require('./helpers/ee-fake-env.js');
function withBulk(w) {
  // The real sheet adapters' bulk calls (Env.js), on the fake world.
  w.env.journal.opIds = () => { const s = {}; w.journal.forEach(r => { s[r.op_id] = true; }); return s; };
  w.env.journal.appendMany = recs => recs.forEach(r => w.journal.push(JSON.parse(JSON.stringify(r))));
  w.env.store.upsertMany = (name, rows) => rows.forEach(r => w.env.store.upsert(name, r));
  return w;
}
function contactsRebuiltFromJournal(w) {
  const fresh = fw2();
  fresh.journal = w.journal.map(r => JSON.parse(JSON.stringify(r)));
  fresh.core.catchUp();
  const sort = t => [...t].sort((a, b) => a.contact_id < b.contact_id ? -1 : 1).map(r => JSON.parse(JSON.stringify(r)));
  assert.deepEqual(sort(fresh.tables.Contacts), sort(w.tables.Contacts), 'Contacts rebuilt from the Journal match the sheet');
}

for (const bulk of [false, true]) {
  test('Import writes every contact through the Journal' + (bulk ? ' (bulk adapters)' : ' (one at a time)') + '; a retried import writes nothing twice', () => {
    const w = engine('2026-11-14');
    if (bulk) withBulk(w);
    const before = w.journal.length;
    const rows = Array.from({ length: 30 }, (_, i) => row('p' + i + '@x.com', { planned_start: '2026-11-30' }));
    assert.equal(w.admin('import_contacts', { group: 'B', contacts: rows }).added, 30);
    assert.equal(w.journal.length - before, 30);
    const seqs = w.journal.map(r => r.seq);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'seq has no gaps');
    w.journal.forEach((r, i) => { if (i) assert.equal(r.prev_hash, w.journal[i - 1].hash, 'hash chain unbroken'); });
    assert.equal(w.admin('import_contacts', { group: 'B', contacts: rows }).added, 0);
    assert.equal(w.journal.length - before, 30, 'nothing appended on the retry');
    contactsRebuiltFromJournal(w);
  });
}

test('Re-import of people already here (incl. removed) brings their planned date, hand-sent Intro and flag; enrolled people keep their status', () => {
  const w = withBulk(engine('2026-11-14'));
  w.admin('import_contacts', { group: 'B', contacts: [row('a@x.com'), row('b@x.com'), row('c@x.com'), row('d@x.com'), row('e@x.com')] });
  const id = e => w.byEmail(e).contact_id;
  // a, b, c were removed by the go-live cleanup; e is already in a sequence.
  w.core.commitEntities(['a@x.com', 'b@x.com', 'c@x.com'].map(e => ({ type: 'contact', data: { contact_id: id(e), review_status: 'removed' }, opId: 'test:remove:' + e })));
  w.tables.Enrollments.push({ enrollment_id: 'en_e', contact_id: id('e@x.com'), sequence_id: 'B', status: 'active' });
  const r = w.admin('apply_incoming_many', { items: [
    { contact_id: id('a@x.com'), mode: 'replace', data: { email_norm: 'a@x.com', planned_start: '2026-11-30' } },
    { contact_id: id('b@x.com'), mode: 'replace', data: { email_norm: 'b@x.com', intro_sent_on: '2026-10-26', planned_start: '2026-10-26' } },
    { contact_id: id('c@x.com'), mode: 'replace', data: { email_norm: 'c@x.com', flag_reason: 'Intro bounced', intro_sent_on: '2026-11-02' } },
    { contact_id: id('d@x.com'), mode: 'skip-me', data: {} },
    { contact_id: id('e@x.com'), mode: 'replace', data: { email_norm: 'e@x.com', intro_sent_on: '2026-10-26' } },
    { contact_id: 'ct_nobody', mode: 'replace', data: {} }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.missing, 1);
  const a = w.byEmail('a@x.com'), b = w.byEmail('b@x.com'), c = w.byEmail('c@x.com'), e = w.byEmail('e@x.com');
  assert.deepEqual([a.review_status, a.planned_start], ['needs_review', '2026-11-30']);
  assert.deepEqual([b.review_status, b.sub_bucket, b.start_step, b.intro_sent_on], ['awaiting_approval', 'B2', 'b_followup', '2026-10-26']);
  assert.deepEqual([c.review_status, c.flag_reason, c.start_step], ['flagged', 'Intro bounced', 'b_followup'], 'flag wins; clearing it later leads to awaiting approval');
  assert.notEqual(e.review_status, 'awaiting_approval', 'someone already in a sequence is never re-staged by a file');
  assert.equal(e.intro_sent_on || '', '');
  contactsRebuiltFromJournal(w);
  // Re-sending the same items changes nothing.
  assert.equal(w.admin('apply_incoming_many', { items: [{ contact_id: a.contact_id, mode: 'replace', data: { email_norm: 'a@x.com', planned_start: '2026-11-30' } }] }).changed, 0);
});

test('Planned batches: people added later join the batch already planned for their day (one batch per date)', () => {
  const w = withBulk(engine('2026-11-14'));
  w.admin('import_contacts', { group: 'B', contacts: [row('a@x.com', { planned_start: '2026-11-30' })] });
  w.admin('plan_import_batches', { group: 'B' });
  w.admin('import_contacts', { group: 'B', contacts: [row('b@x.com', { planned_start: '2026-11-30' }), row('c@x.com', { planned_start: '2026-12-07' })] });
  const r = w.admin('plan_import_batches', { group: 'B' });
  assert.deepEqual(r.batches.map(b => [b.start_on, b.count, !!b.added_to]), [['2026-11-30', 1, true], ['2026-12-07', 1, false]]);
  const nov30 = w.tables.Batches.filter(b => b.start_on === '2026-11-30');
  assert.equal(nov30.length, 1);
  assert.equal(nov30[0].count, 2);
  assert.equal(nov30[0].contact_ids.length, 2);
});

test('Move people between planned batches: later day, a new day, or out of the batches; started batches never change', () => {
  const w = withBulk(engine('2026-11-14'));
  w.admin('import_contacts', { group: 'B', contacts: [row('a@x.com', { planned_start: '2026-11-16' }), row('b@x.com', { planned_start: '2026-11-16' }), row('c@x.com', { planned_start: '2026-11-23' })] });
  w.admin('plan_import_batches', { group: 'B' });
  const id = e => w.byEmail(e).contact_id, on = d => { const b = w.tables.Batches.find(x => x.start_on === d && x.status === 'planned'); return b ? plain(b) : undefined; };
  // a → Nov 23 (joins the batch there)
  let r = w.admin('set_batch_date', { contact_ids: [id('a@x.com')], start_on: '2026-11-23' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(on('2026-11-16').contact_ids, [id('b@x.com')]);
  assert.equal(on('2026-11-23').count, 2);
  assert.equal(w.byEmail('a@x.com').planned_start, '2026-11-23');
  // b → Dec 1 (no batch that day: one is made; Nov 16 is now empty → cancelled)
  r = w.admin('set_batch_date', { contact_ids: [id('b@x.com')], start_on: '2026-12-01' });
  assert.equal(r.created, true);
  assert.equal(on('2026-11-16'), undefined);
  assert.equal(w.tables.Batches.find(b => b.start_on === '2026-11-16').status, 'cancelled');
  assert.equal(on('2026-12-01').count, 1);
  // c out of the batches → back to Needs review, no date
  r = w.admin('set_batch_date', { contact_ids: [id('c@x.com')], start_on: '' });
  assert.equal(r.ok, true);
  assert.deepEqual(on('2026-11-23').contact_ids, [id('a@x.com')]);
  assert.deepEqual([w.byEmail('c@x.com').review_status, w.byEmail('c@x.com').planned_start], ['needs_review', '']);
  // Refusals: a past day, someone not in Needs review, a started batch stays as it was
  assert.equal(w.admin('set_batch_date', { contact_ids: [id('a@x.com')], start_on: '2026-11-01' }).ok, false);
  w.admin('import_contacts', { group: 'B', contacts: [row('f@x.com', { flag_reason: 'Check' })] });
  assert.equal(w.admin('set_batch_date', { contact_ids: [id('f@x.com')], start_on: '2026-11-30' }).ok, false);
  const started = { batch_id: 'bs', group: 'B', status: 'started', pick: 'now', start_on: '2026-11-10', contact_ids: [id('a@x.com')], count: 1 };
  w.tables.Batches.push(started);
  w.admin('set_batch_date', { contact_ids: [id('a@x.com')], start_on: '2026-11-30' });
  assert.deepEqual(plain(w.tables.Batches.find(b => b.batch_id === 'bs').contact_ids), [id('a@x.com')], 'a started batch is history');
});

test('Intro and Follow Up both sent by hand → waits for approval at the Check-In; the rules never send the first two', () => {
  const w = withBulk(engine('2026-11-16'));
  w.admin('import_contacts', { group: 'B', contacts: [row('a@x.com', { intro_sent_on: '2026-10-26', followup_sent_on: '2026-11-10' }), row('b@x.com', { followup_sent_on: '2026-11-10' })] });
  const a = w.byEmail('a@x.com'), b = w.byEmail('b@x.com');
  assert.deepEqual([a.review_status, a.start_step, a.followup_sent_on], ['awaiting_approval', 'b_checkin', '2026-11-10']);
  assert.match(a.review_reason, /Follow Up on 2026-11-10/);
  assert.deepEqual([b.review_status, b.followup_sent_on], ['needs_review', ''], 'a Follow Up date without an Intro date means nothing');
  const contact = Object.assign({}, a, { review_status: 'confirmed' });
  const en = { enrollment_id: 'e1', contact_id: a.contact_id, sequence_id: 'B', rule_rev: 'bc-1', mode: 'production', status: 'active', enrolled_on: '2026-11-16', stopped_branches: [] };
  const d = L.decide({ today: '2026-11-16', rulesets: { 'bc-1': BC }, contacts: [contact], enrollments: [en], deliveries: [], holds: {}, signals: [], suppressions: [], paused: {} }).deliveries;
  const by = id => d.find(x => x.step_id === id);
  assert.deepEqual([by('b_intro').reason, by('b_followup').reason], ['sent_before_import', 'sent_before_import']);
  assert.deepEqual([by('b_checkin').due, by('b_checkin').outcome], ['2026-11-16', 'due']);
  // Approval needs the Check-In on.
  assert.equal(w.admin('publish_rules', { edits: [{ step_id: 'b_checkin', status: 'off' }], scope: 'new' }).ok, true);
  const refused = w.admin('approve_waiting', { contact_ids: [a.contact_id] });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Turn on/);
});
