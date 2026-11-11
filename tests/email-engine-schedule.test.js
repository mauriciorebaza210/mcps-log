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
