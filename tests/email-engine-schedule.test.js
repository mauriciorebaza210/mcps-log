// Send times and the day's runs on the engine side (email-engine/src/Schedule.js,
// Admin.js set_send_time / create_batch send_time). PLAN.md → Scheduling
// semantics → Send times, Runs at send times; failure rows 58–61.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeWorld } = require('./helpers/ee-fake-env.js');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
function world(localNow) {
  const w = fakeWorld();
  // Pin the clock to a local Central time on Mon Nov 23 2026 (CST = UTC−6).
  w.now = Date.parse('2026-11-23T' + localNow + ':00-06:00');
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite };
  vm.createContext(ctx);
  vm.runInContext([read('js/lib/lifecycle-rules.js'), read('js/lib/batches.js'), 'var EE_TZ = "America/Chicago";',
    'function EE_config_(store) { var c = {}; store.rows("Config").forEach(function (r) { c[r.key] = r.value; }); return c; }',
    read('email-engine/src/Admin.js'), read('email-engine/src/Schedule.js')].join('\n'), ctx);
  w.env.config.pausedBuckets = () => [];
  w.ctx_ = ctx;
  w.installed = [];
  w.deps = { replaceTimedRuns: list => { w.installed = list; } };
  w.queued = 0;
  w.admin = (action, params) => ctx.EE_adminRun_(w.env, w.core, { action, params, actor: 'mau' },
    { scheduleRun: () => { w.queued++; return 'queued'; }, planRuns: () => ctx.EE_planRuns_(w.env, w.deps) });
  w.cfg = k => (w.tables.Config.find(c => c.key === k) || {}).value;
  return w;
}
const local = ms => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });

test('Valid send times: quarter hours from 6:00 AM to 8:00 PM', () => {
  const w = world('08:00');
  assert.equal(w.ctx_.EE_validSendTime_('9:00'), '09:00');
  assert.equal(w.ctx_.EE_validSendTime_('20:00'), '20:00');
  for (const bad of ['05:45', '20:15', '09:10', 'x']) assert.equal(w.ctx_.EE_validSendTime_(bad), '', bad);
});

test('The day\'s runs: campaign defaults, enrollment times and today\'s batches, only those still ahead, at the right instants', () => {
  const w = world('08:00');
  w.tables.Config.push({ key: 'send_time_C', value: '07:30' });           // already past at 8:00
  w.tables.Enrollments.push({ enrollment_id: 'e1', status: 'active', send_time: '10:30' }, { enrollment_id: 'e2', status: 'stopped', send_time: '11:00' });
  w.tables.Batches.push({ batch_id: 'b1', status: 'planned', start_on: '2026-11-23', send_time: '14:15' }, { batch_id: 'b2', status: 'planned', start_on: '2026-11-30', send_time: '16:00' });
  const r = w.ctx_.EE_planRuns_(w.env, w.deps);
  assert.deepEqual(Array.from(r.times), ['09:00', '10:30', '14:15'], 'B default, e1, b1; not past, stopped or later batches');
  assert.deepEqual(w.installed.map(x => local(x.at)), ['9:00 AM', '10:30 AM', '2:15 PM']);
  assert.equal(JSON.parse(w.cfg('run_plan')).date, '2026-11-23');
});

test('Run instants are right across the DST change (Mar 9 2026 is CDT)', () => {
  const w = world('08:00');
  assert.equal(new Date(w.ctx_.EE_localToMs_('2026-03-09', '09:00')).toISOString(), '2026-03-09T14:00:00.000Z');
  assert.equal(new Date(w.ctx_.EE_localToMs_('2026-11-23', '09:00')).toISOString(), '2026-11-23T15:00:00.000Z');
});

test('Row 60: more than 12 times installs the 12 earliest and alerts', () => {
  const w = world('06:00');
  for (let i = 0; i < 14; i++) w.tables.Enrollments.push({ enrollment_id: 'e' + i, status: 'active', send_time: String(7 + Math.floor(i / 4)).padStart(2, '0') + ':' + ['00', '15', '30', '45'][i % 4] });
  const r = w.ctx_.EE_planRuns_(w.env, w.deps);
  assert.equal(w.installed.length, 12);
  assert.ok(r.dropped.length >= 1);
  assert.ok(w.alerts.some(a => a.startsWith('too_many_send_times')));
});

test('Row 58: a trigger firing early gates at its slot; a late one at the real time', () => {
  const w = world('08:00'), plan = { times: ['09:00', '10:30'] };
  assert.deepEqual({ ...w.ctx_.EE_slotFor_(plan, '08:47') }, { gate: '09:00', planned_for: '09:00' });
  assert.deepEqual({ ...w.ctx_.EE_slotFor_(plan, '09:04') }, { gate: '09:04', planned_for: '09:00' });
  assert.deepEqual({ ...w.ctx_.EE_slotFor_(plan, '08:20') }, { gate: '08:20', planned_for: '' }, 'more than 20 min early is just an early run');
});

test('set_send_time saves the default, re-plans today, and refuses bad times', () => {
  const w = world('08:00');
  assert.equal(w.admin('set_send_time', { bucket: 'B', time: '7:45' }).ok, true, 'a time already past today still saves (it applies from tomorrow)');
  const ok = w.admin('set_send_time', { bucket: 'B', time: '11:15' });
  assert.equal(ok.ok, true);
  assert.equal(w.cfg('send_time_B'), '11:15');
  assert.ok(w.installed.some(x => x.time === '11:15'));
  assert.equal(w.admin('set_send_time', { bucket: 'B', time: '22:00' }).ok, false);
  assert.equal(w.tables.ChangeLog.at(-1).action, 'set_send_time');
});

test('A batch keeps its send time: stored on the batch, copied to its people, and runs are planned for it', () => {
  const w = world('08:00');
  w.tables.Contacts.push({ contact_id: 'p1', email_norm: 'p1@x.com', bucket: 'B', review_status: 'needs_review', is_test: 'N' });
  const r = w.admin('create_batch', { group: 'B', pick: 'now', contact_ids: ['p1'], start_on: '2026-11-23', send_time: '13:30' });
  assert.equal(r.ok, true);
  assert.equal(w.tables.Batches[0].send_time, '13:30');
  assert.equal(w.tables.Contacts[0].send_time, '13:30');
  assert.equal(w.queued, 0, 'its time is still ahead: no immediate run');
  assert.equal(w.admin('create_batch', { group: 'B', pick: 'at_start', count: 1, start_on: '2026-11-30', send_time: '13:10' }).ok, false, 'quarter hours only');
});

test('Row 61: a batch for today whose time has passed runs right away', () => {
  const w = world('15:00');
  w.tables.Contacts.push({ contact_id: 'p1', email_norm: 'p1@x.com', bucket: 'B', review_status: 'needs_review', is_test: 'N' });
  assert.equal(w.admin('create_batch', { group: 'B', pick: 'now', contact_ids: ['p1'], start_on: '2026-11-23', send_time: '09:00' }).ok, true);
  assert.equal(w.queued, 1);
});

test('Planner: a confirmed contact\'s batch time becomes the enrollment\'s, and the run\'s time decides what goes out', () => {
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite };
  vm.createContext(ctx);
  vm.runInContext(read('js/lib/lifecycle-rules.js') + '\n' + read('email-engine/src/Planner.js'), ctx);
  const BC = JSON.parse(read('email-engine/seed/ruleset-bc.json'));
  const snap = time => ({ today: '2026-11-23', engineMode: 'production', ruleRev: BC.rule_rev, rulesets: { [BC.rule_rev]: BC },
    contacts: [{ contact_id: 'p1', email_norm: 'p1@x.com', bucket: 'B', sub_bucket: 'B1', review_status: 'confirmed', is_test: 'N', send_time: '10:30' }],
    enrollments: [], deliveries: [], holds: [], inbox: [], suppressions: [], commsSentToday: [], paused: {},
    publishedRevision: { b_intro: 'rev1' }, time, sendTimes: { B: '09:00' } });
  const early = ctx.EE_planDay(snap('09:00'));
  assert.equal(early.enrollmentWrites[0].data.send_time, '10:30');
  assert.equal(early.due.length, 0, 'not yet its time');
  assert.equal(ctx.EE_planDay(snap('10:30')).due.length, 1);
});

test('Read model: campaign send times, today\'s run plan, each run\'s planned slot, and scheduled runs count as the daily run', async () => {
  const R = await import(path.join(__dirname, '..', 'api', '_lib', 'email-read.js'));
  const t = rows => [Object.keys(rows[0]), ...rows.map(r => Object.values(r))];
  const tables = R.toTables({
    Config: t([{ key: 'send_time_B', value: '10:30' }, { key: 'run_plan', value: JSON.stringify({ date: '2026-11-23', times: ['10:30', '14:15'], dropped: [] }) }]),
    Permissions: t([{ username: 'mau', roles: 'operator', active: 'Y' }]),
    Runs: t([{ run_id: 'r1', trigger: 'scheduled', planned_for: '10:30', started_at: '2026-11-23T16:31:00Z', sent: '3', skipped: '0', stopped_reason: 'done' }]),
    Batches: t([{ batch_id: 'b1', group: 'B', count: '20', start_on: '2026-11-30', send_time: '14:15', status: 'planned', contact_ids: '[]', filters_json: '{}' }])
  });
  const caps = R.capabilitiesFor('mau', tables.Permissions);
  const ov = R.buildOverview(tables, caps, Date.parse('2026-11-23T17:00:00Z'));
  assert.deepEqual(ov.engine.send_times, { B: '10:30', C: '09:00' });
  assert.deepEqual(ov.engine.run_plan.times, ['10:30', '14:15']);
  assert.equal(ov.runs[0].planned_for, '10:30');
  assert.equal(ov.health.daily_trigger_seen, true);
  assert.equal(R.buildContacts(tables, caps, {}).batches[0].send_time, '14:15');
});

// ── Wiring the Campaigns tab: move_batch, send_override, restarts (rows 62–64) ──
function wired(localNow) {
  const w = world(localNow);
  const BC = JSON.parse(read('email-engine/seed/ruleset-bc.json'));
  w.tables.Rulesets.push({ rule_rev: BC.rule_rev, json: BC });
  w.tables.Contacts.push({ contact_id: 'c1', email_norm: 'c1@x.com', bucket: 'B', sub_bucket: 'B1', review_status: 'confirmed', is_test: 'N' });
  w.tables.Enrollments.push({ enrollment_id: 'e1', contact_id: 'c1', sequence_id: 'B', rule_rev: BC.rule_rev, mode: 'production', status: 'active', enrolled_on: '2026-11-23', stopped_branches: [] });
  return w;
}
const sentIntro = w => w.tables.Deliveries.push({ delivery_id: 'e1:b_intro:1', key: 'e1:b_intro:1', enrollment_id: 'e1', contact_id: 'c1', step_id: 'b_intro', occurrence: 1, mode: 'production', state: 'sent', sent_at: '2026-11-23T15:00:00Z' });

test('move_batch: planned batches move to today or later; started ones can\'t', () => {
  const w = wired('08:00');
  w.tables.Batches.push({ batch_id: 'b1', group: 'B', pick: 'at_start', count: 2, start_on: '2026-11-30', status: 'planned' }, { batch_id: 'b2', status: 'started' });
  assert.equal(w.admin('move_batch', { batch_id: 'b1', start_on: '2026-12-07' }).ok, true);
  assert.equal(w.tables.Batches[0].start_on, '2026-12-07');
  assert.equal(w.admin('move_batch', { batch_id: 'b1', start_on: '2026-11-01' }).ok, false);
  assert.equal(w.admin('move_batch', { batch_id: 'b2', start_on: '2026-12-07' }).ok, false);
});

test('send_override: skip and clear are saved with who did it; sent emails refuse (row 62)', () => {
  const w = wired('08:00');
  const r = w.admin('send_override', { key: 'e1:b_intro:1', kind: 'skip' });
  assert.equal(r.ok, true);
  assert.equal(w.tables.Overrides[0].by, 'mau');
  assert.equal(w.ctx_.EE_overrideMap_(w.tables.Overrides)['e1:b_intro:1'].kind, 'skip');
  w.admin('send_override', { key: 'e1:b_intro:1', kind: 'clear' });
  assert.equal(w.ctx_.EE_overrideMap_(w.tables.Overrides)['e1:b_intro:1'], undefined);
  sentIntro(w);
  assert.equal(w.admin('send_override', { key: 'e1:b_intro:1', kind: 'skip' }).error, 'already sent');
});

test('send_override: move only inside the window; next run only after the prerequisite (row 63)', () => {
  const w = wired('08:00');
  assert.equal(w.admin('send_override', { key: 'e1:b_followup:1', kind: 'next_run' }).ok, false, 'Intro not sent yet');
  sentIntro(w);
  assert.equal(w.admin('send_override', { key: 'e1:b_followup:1', kind: 'next_run' }).ok, true);
  assert.equal(w.admin('send_override', { key: 'e1:b_followup:1', kind: 'move', date: '2026-11-29' }).ok, true, 'Follow Up due Nov 27, window 7 days');
  assert.match(w.admin('send_override', { key: 'e1:b_followup:1', kind: 'move', date: '2026-12-20' }).error, /pick a day from 2026-11-27 to 2026-12-04/);
  assert.equal(w.admin('send_override', { key: 'nope', kind: 'skip' }).ok, false);
});

test('Restart from a batch: an ended sequence gets restart_ok; an active one is skipped (row 64)', () => {
  const w = wired('08:00');
  w.tables.Contacts.push({ contact_id: 'c2', email_norm: 'c2@x.com', bucket: 'B', review_status: 'confirmed', is_test: 'N' });
  w.tables.Enrollments.push({ enrollment_id: 'e2', contact_id: 'c2', sequence_id: 'B', status: 'stopped' });
  const r = w.admin('create_batch', { group: 'B', pick: 'now', contact_ids: ['c1', 'c2'], restart_ids: ['c1', 'c2'], start_on: '2026-11-23' });
  assert.equal(JSON.stringify(r.started), JSON.stringify({ started: 1, skipped: 1 }));
  assert.equal(w.tables.Contacts.find(c => c.contact_id === 'c2').restart_ok, w.tables.Batches[0].batch_id);
  assert.equal(w.tables.Contacts.find(c => c.contact_id === 'c2').sub_bucket, 'B1', 'back to the start of MCP Legacy');
  assert.equal(w.tables.Contacts.find(c => c.contact_id === 'c1').restart_ok, undefined, 'c1 is still in its sequence');
  assert.equal(w.tables.Batches[0].skipped_json[0].reason, 'still_in_sequence');
});

test('Planner: a restarted person is enrolled again (new id) and the mark is cleared', () => {
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite };
  vm.createContext(ctx);
  vm.runInContext(read('js/lib/lifecycle-rules.js') + '\n' + read('email-engine/src/Planner.js'), ctx);
  const BC = JSON.parse(read('email-engine/seed/ruleset-bc.json'));
  const p = ctx.EE_planDay({ today: '2026-11-23', engineMode: 'production', ruleRev: BC.rule_rev, rulesets: { [BC.rule_rev]: BC },
    contacts: [{ contact_id: 'c2', email_norm: 'c2@x.com', bucket: 'B', sub_bucket: 'B1', review_status: 'confirmed', is_test: 'N', restart_ok: 'bat_1' }],
    enrollments: [{ enrollment_id: 'en_c2_B_1', contact_id: 'c2', sequence_id: 'B', rule_rev: BC.rule_rev, mode: 'production', status: 'stopped', enrolled_on: '2026-10-01', stopped_branches: [] }],
    deliveries: [], holds: [], inbox: [], suppressions: [], commsSentToday: [], paused: {}, publishedRevision: { b_intro: 'r1' } });
  assert.equal(p.enrollmentWrites[0].data.enrollment_id, 'en_c2_B_2');
  assert.deepEqual({ ...p.contactWrites[0].data }, { contact_id: 'c2', restart_ok: '' });
  assert.equal(p.due.length, 1);
});

test('Planned sends (view=plan): the engine\'s own decide() over enrollments, planned batches and overrides', async () => {
  const R = await import(path.join(__dirname, '..', 'api', '_lib', 'email-read.js'));
  const BC = JSON.parse(read('email-engine/seed/ruleset-bc.json'));
  const t = rows => [[...new Set(rows.flatMap(Object.keys))], ...rows.map(r => [...new Set(rows.flatMap(Object.keys))].map(k => r[k] === undefined ? '' : typeof r[k] === 'object' ? JSON.stringify(r[k]) : String(r[k])))];
  const tables = R.toTables({
    Config: t([{ key: 'rule_rev', value: BC.rule_rev }, { key: 'engine_mode', value: 'production' }, { key: 'send_time_B', value: '10:30' }]),
    Rulesets: t([{ rule_rev: BC.rule_rev, json: BC }]),
    Permissions: t([{ username: 'mau', roles: 'operator', active: 'Y' }]),
    Contacts: t([{ contact_id: 'c1', bucket: 'B', sub_bucket: 'B2', review_status: 'confirmed' }, { contact_id: 'p1', bucket: 'B', sub_bucket: 'B1', review_status: 'needs_review' }]),
    Enrollments: t([{ enrollment_id: 'e1', contact_id: 'c1', sequence_id: 'B', rule_rev: BC.rule_rev, mode: 'production', status: 'active', enrolled_on: '2026-11-20' }]),
    Deliveries: t([{ delivery_id: 'e1:b_intro:1', key: 'e1:b_intro:1', enrollment_id: 'e1', contact_id: 'c1', step_id: 'b_intro', occurrence: '1', mode: 'production', state: 'sent', sent_at: '2026-11-20T16:30:00Z' }]),
    Batches: t([{ batch_id: 'b1', group: 'B', pick: 'now', count: '1', start_on: '2026-11-30', send_time: '14:15', status: 'planned', contact_ids: ['p1'] },
      { batch_id: 'b2', group: 'B', pick: 'at_start', count: '20', start_on: '2026-12-07', status: 'planned', contact_ids: [] }]),
    Overrides: t([{ key: 'e1:b_followup:1', kind: 'move', date: '2026-11-26' }])
  });
  const caps = R.capabilitiesFor('mau', tables.Permissions);
  const plan = R.buildPlan(tables, caps, Date.parse('2026-11-23T15:00:00Z'), { bucket: 'B' });
  const row = (step, who) => plan.rows.find(r => r[2] === step && (r[3] === who || r[6] === who));
  assert.deepEqual(row('b_followup', 'c1').slice(0, 5), ['2026-11-26', '10:30', 'b_followup', 'c1', 'e1:b_followup:1'], 'moved from Nov 24, campaign time');
  assert.equal(row('b_followup', 'c1')[7], 'moved');
  assert.equal(row('b_followup', 'c1')[9], '2026-11-24');
  assert.deepEqual(row('b_intro', 'p1').slice(0, 4), ['2026-11-30', '14:15', 'b_intro', 'p1'], 'picked batch at its own time');
  assert.equal(row('b_intro', 'p1')[4], '', 'simulated: no key, nothing to override yet');
  assert.equal(row('b_followup', 'p1')[0], '2026-12-04', 'chained +4 from the batch start');
  const pick = row('b_intro', 'b2');
  assert.deepEqual([pick[0], pick[3], pick[5]], ['2026-12-07', '', 20], 'pick-on-the-day: one row weighted by the batch size');
});

test('Trigger-precision spike: plans 4 one-off triggers, records how early/late each fired, summarises', () => {
  const w = world('10:00');
  const made = [];
  const r = w.ctx_.EE_triggerTestPure_(w.env, 'start', { create: slots => slots.map((at, i) => { made.push(at); return 'uid' + i; }) });
  assert.equal(r.ok, true); assert.equal(made.length, 4);
  assert.equal(w.ctx_.EE_triggerTestPure_(w.env, 'start', { create: () => [] }).ok, false, 'one test at a time');
  const planned = made.map(ms => ms);
  [[0, 40], [1, -15], [2, 600], [3, 5]].forEach(([i, d]) => w.ctx_.EE_triggerTestFired_(w.env, 'uid' + i, planned[i] + d * 1000));
  const t = JSON.parse(JSON.stringify(w.ctx_.EE_triggerTestPure_(w.env, 'result').test));
  assert.equal(t.status, 'done');
  assert.deepEqual(t.slots.map(s => s.delta_s), [40, -15, 600, 5]);
  assert.deepEqual(t.summary, { earliest_s: -15, latest_s: 600, within_20_min: true });
});

test('Stored JSON comes back parsed from the real sheet: the run plan and the timing test still read it', () => {
  const w = world('10:00');
  const plan = { date: '2026-11-23', times: ['09:00', '14:15'], dropped: [] };
  assert.deepEqual(JSON.parse(JSON.stringify(w.ctx_.EE_runPlan_({ run_plan: plan }))), plan, 'object (real sheet)');
  assert.deepEqual(JSON.parse(JSON.stringify(w.ctx_.EE_runPlan_({ run_plan: JSON.stringify(plan) }))), plan, 'string (fake store)');
  assert.equal(w.ctx_.EE_runPlan_({ run_plan: '' }), null);
  // Timing test with Config values stored as objects, the way Env.js decodes them.
  const realStore = w.env.store, upsert = realStore.upsert;
  w.env.store = Object.assign({}, realStore, { upsert: (n, row) => upsert(n, n === 'Config' && typeof row.value === 'string' && row.value[0] === '{' ? Object.assign({}, row, { value: JSON.parse(row.value) }) : row) });
  const made = [];
  w.ctx_.EE_triggerTestPure_(w.env, 'start', { create: slots => slots.map((at, i) => { made.push(at); return 'u' + i; }) });
  made.forEach((ms, i) => w.ctx_.EE_triggerTestFired_(w.env, 'u' + i, ms + 30000));
  const t = JSON.parse(JSON.stringify(w.ctx_.EE_triggerTestPure_(w.env, 'result').test));
  assert.equal(t.status, 'done'); assert.deepEqual(t.slots.map(s => s.delta_s), [30, 30, 30, 30]);
});

test('Trigger timing: a run whose timers never report (e.g. they fired under older code) frees up 10 min after its last timer', () => {
  const w = world('10:00');
  const mk = () => w.ctx_.EE_triggerTestPure_(w.env, 'start', { create: slots => slots.map((at, i) => 'x' + i) });
  assert.equal(mk().ok, true);
  w.now += 17 * 60000;                       // last timer at +8 min, so 9 min past it: still running
  assert.equal(mk().ok, false);
  w.now += 2 * 60000;                        // 11 min past the last timer
  const again = mk();
  assert.equal(again.ok, true); assert.equal(again.test.status, 'running');
});

test('Alerts: the engine only records them (it runs as Tony); alerts_forwarded moves the marker forward only, outside the ChangeLog', () => {
  const w = world('10:00');
  const fwd = upto => JSON.parse(JSON.stringify(w.ctx_.EE_adminRun_(w.env, w.core, { action: 'alerts_forwarded', params: { upto }, actor: 'portal' }, {})));
  assert.equal(fwd('2026-11-23T16:00:00.000Z ab12').alert_forwarded_at, '2026-11-23T16:00:00.000Z ab12');
  assert.equal(fwd('2026-11-23T15:00:00.000Z cd34').alert_forwarded_at, '2026-11-23T16:00:00.000Z ab12', 'never backwards');
  assert.equal(fwd('nope').ok, false);
  assert.equal(w.env.store.rows('ChangeLog').filter(r => r.action === 'alerts_forwarded').length, 0);
  const env = require('fs').readFileSync(require('path').join(__dirname, '..', 'email-engine/src/Env.js'), 'utf8');
  assert.doesNotMatch(env.match(/alert: function[\s\S]*?\n    \},/)[0], /MailApp|GmailApp/, 'no alert email from the engine account');
});
