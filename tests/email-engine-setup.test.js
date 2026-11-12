// Email Setup edits (Admin.js → publish_rules) and the rules they rely on:
// the Welcome sent at approval with its deadline still tied to the startup,
// a turned-off email that the next one still chains from, and rule revisions
// that never change in place (PLAN.md → Scheduling: per-enrollment rule_rev).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const L = require('../js/lib/lifecycle-rules.js');
const { fakeWorld } = require('./helpers/ee-fake-env.js');

const BC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'email-engine', 'seed', 'ruleset-bc.json'), 'utf8'));

function engine() {
  const w = fakeWorld();
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite };
  vm.createContext(ctx);
  vm.runInContext(['js/lib/lifecycle-rules.js', 'js/lib/batches.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n') +
    '\nvar EE_TZ = "America/Chicago";\n' + fs.readFileSync(path.join(__dirname, '..', 'email-engine', 'src', 'Admin.js'), 'utf8'), ctx);
  w.tables.Rulesets.push({ rule_rev: 'bc-1', json: JSON.parse(JSON.stringify(BC)), published_at: '', published_by: 'seed' });
  w.tables.Config.push({ key: 'rule_rev', value: 'bc-1' });
  w.ctx_ = ctx;
  w.planned = 0;
  w.admin = (action, params) => ctx.EE_adminRun_(w.env, w.core, { action, params, actor: 'mau' }, { scheduleRun: () => 'queued', planRuns: () => { w.planned++; return { times: [] }; } });
  w.cfg = k => (w.tables.Config.find(c => c.key === k) || {}).value;
  w.rules = rev => w.tables.Rulesets.find(r => r.rule_rev === rev).json;
  w.step = (rev, id) => JSON.parse(JSON.stringify(w.rules(rev).steps.find(s => s.step_id === id)));   // out of the vm realm
  return w;
}
const plan = (rs, contact, en, today) => L.decide({ today, rulesets: { [rs.rule_rev]: rs }, contacts: [contact], enrollments: [en],
  deliveries: [], holds: {}, signals: [], suppressions: [], paused: {} }).deliveries;

test('Welcome at approval: sends the day they join, and its deadline still counts from the startup', () => {
  const w = engine();
  const r = w.admin('publish_rules', { edits: [{ step_id: 'c_welcome', anchor: 'enrollment', offset: 0 }], scope: 'new' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rule_rev, 'bc-2');
  const st = w.step('bc-2', 'c_welcome');
  assert.equal(st.anchor, 'enrollment');
  assert.deepEqual(st.hard_deadline, { from: 'startup', offset: -1 });
  const rs = w.rules('bc-2');
  const c = { contact_id: 'c1', bucket: 'C', review_status: 'confirmed', startup_date: '2026-11-20' };
  const en = { enrollment_id: 'e1', contact_id: 'c1', sequence_id: 'C', rule_rev: 'bc-2', mode: 'production', status: 'active', enrolled_on: '2026-11-11', stopped_branches: [] };
  const d = plan(rs, c, en, '2026-11-11').find(x => x.step_id === 'c_welcome');
  assert.equal(d.due, '2026-11-11');
  assert.equal(d.outcome, 'due');
  // Approved the day before the startup: the window would allow later, the startup deadline doesn't.
  const late = plan(rs, Object.assign({}, c, { startup_date: '2026-11-12' }), en, '2026-11-12').find(x => x.step_id === 'c_welcome');
  assert.equal(late.last_send_day, '2026-11-11');
  assert.equal(late.outcome, 'expired');
  // And back to "days before the startup".
  const back = w.admin('publish_rules', { edits: [{ step_id: 'c_welcome', anchor: 'startup', offset: -5 }], scope: 'new' });
  assert.equal(back.ok, true, back.error);
  assert.deepEqual(w.step('bc-3', 'c_welcome').hard_deadline, { from: 'anchor', offset: -1 });
  assert.equal(w.step('bc-3', 'c_welcome').offset, -5);
});

test('Rules are never changed in place: each save is a new revision, Config points at it, the old one stays', () => {
  const w = engine();
  w.admin('publish_rules', { edits: [{ step_id: 'b_followup', offset: 6 }], scope: 'new' });
  assert.equal(w.cfg('rule_rev'), 'bc-2');
  assert.equal(w.step('bc-1', 'b_followup').offset, 4);
  assert.equal(w.step('bc-2', 'b_followup').offset, 6);
  assert.equal(w.planned, 1, 'today’s runs are re-planned');
  assert.equal(w.tables.ChangeLog.at(-1).action, 'publish_rules');
  // A page that loaded bc-1 can't overwrite bc-2 unknowingly.
  const stale = w.admin('publish_rules', { edits: [{ step_id: 'b_followup', offset: 3 }], scope: 'new', base_rev: 'bc-1' });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /Reload/);
  assert.equal(stale.conflict, true, 'row 30: flagged so the API answers 409');
  // Saving the same thing again makes no revision.
  assert.equal(w.admin('publish_rules', { edits: [{ step_id: 'b_followup', offset: 6 }], scope: 'new' }).unchanged, true);
  assert.equal(w.tables.Rulesets.length, 2);
});

test('Scope: "everyone" moves running enrollments of that sequence; "new only" leaves them on their revision', () => {
  const w = engine();
  w.tables.Enrollments.push(
    { enrollment_id: 'b1', contact_id: 'x', sequence_id: 'B', rule_rev: 'bc-1', status: 'active' },
    { enrollment_id: 'b2', contact_id: 'y', sequence_id: 'B', rule_rev: 'bc-1', status: 'completed' },
    { enrollment_id: 'c1', contact_id: 'z', sequence_id: 'C', rule_rev: 'bc-1', status: 'active' });
  const keep = w.admin('publish_rules', { edits: [{ step_id: 'b_checkin', offset: 12 }], scope: 'new' });
  assert.equal(keep.moved, 0);
  assert.equal(w.tables.Enrollments.find(e => e.enrollment_id === 'b1').rule_rev, 'bc-1');
  const all = w.admin('publish_rules', { edits: [{ step_id: 'b_checkin', offset: 10 }], scope: 'all' });
  assert.equal(all.moved, 1);
  const by = id => w.tables.Enrollments.find(e => e.enrollment_id === id).rule_rev;
  assert.deepEqual([by('b1'), by('b2'), by('c1')], ['bc-3', 'bc-1', 'bc-1'], 'only running B enrollments move');
});

test('Stops: toggled per signal on marketing emails; a service email refuses stops', () => {
  const w = engine();
  const r = w.admin('publish_rules', { edits: [{ step_id: 'b_intro', stops: { reply: true, click: false, form: true } }], scope: 'new' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(w.step('bc-2', 'b_intro').stop_rules, [{ signal: 'reply', stops: 'enrollment' }, { signal: 'form', stops: 'enrollment' }]);
  w.admin('publish_rules', { edits: [{ step_id: 'b_intro', stops: { reply: true, click: true, form: true } }], scope: 'new' });
  assert.deepEqual(w.step('bc-3', 'b_intro').stop_rules.find(x => x.signal === 'click'), { signal: 'click', min_confidence: 'high', stops: 'enrollment' });
  w.admin('publish_rules', { edits: [{ step_id: 'c_maint', stops: { reply: true, click: true, form: true } }], scope: 'new' });
  assert.ok(w.step('bc-4', 'c_maint').stop_rules.every(x => x.stops === 'marketing_branch'), 'C keeps stopping only the marketing branch');
  assert.equal(w.admin('publish_rules', { edits: [{ step_id: 'c_progress', stops: { reply: true } }], scope: 'new' }).ok, false);
});

test('Bad edits are refused and nothing is published', () => {
  const w = engine();
  const bad = [
    [{ step_id: 'nope', offset: 1 }, /unknown/],
    [{ step_id: 'b_followup', offset: 0 }, /between 1 and 60/],
    [{ step_id: 'b_followup', offset: 2.5 }, /whole number/],
    [{ step_id: 'b_intro', anchor: 'startup' }, /isn’t available/],
    [{ step_id: 'c_progress', offset: 3 }, /repeats/],
    [{ step_id: 'c_welcome', offset: 0 }, /before the startup/],
    [{ step_id: 'b_intro', status: 'paused' }, /on or off/]
  ];
  bad.forEach(([e, re]) => { const r = w.admin('publish_rules', { edits: [e], scope: 'new' }); assert.equal(r.ok, false, JSON.stringify(e)); assert.match(r.error, re); });
  assert.equal(w.admin('publish_rules', { edits: [{ step_id: 'b_intro', offset: 1 }], scope: 'some' }).ok, false);
  assert.equal(w.tables.Rulesets.length, 1);
  assert.equal(w.cfg('rule_rev'), 'bc-1');
});

test('A turned-off email is never sent, and the next one still chains from the day it would have gone', () => {
  const w = engine();
  w.admin('publish_rules', { edits: [{ step_id: 'b_followup', status: 'off' }], scope: 'new' });
  const rs = w.rules('bc-2');
  const c = { contact_id: 'c1', bucket: 'B', sub_bucket: 'B2', review_status: 'confirmed' };
  const en = { enrollment_id: 'e1', contact_id: 'c1', sequence_id: 'B', rule_rev: 'bc-2', mode: 'production', status: 'active', enrolled_on: '2026-10-26', stopped_branches: [] };
  const deliveries = [{ key: 'e1:b_intro:1', enrollment_id: 'e1', contact_id: 'c1', step_id: 'b_intro', occurrence: 1, state: 'sent', sent_at: '2026-10-26T15:00:00Z' }];
  const out = L.decide({ today: '2026-10-30', rulesets: { 'bc-2': rs }, contacts: [c], enrollments: [en], deliveries, holds: {}, signals: [], suppressions: [], paused: {} }).deliveries;
  const fu = out.find(x => x.step_id === 'b_followup'), ci = out.find(x => x.step_id === 'b_checkin');
  assert.equal(fu.outcome, 'excluded'); assert.equal(fu.reason, 'turned_off');
  assert.equal(ci.due, '2026-11-08', 'Check-In: 9 days after the Follow Up’s planned day (Oct 30)');
  assert.equal(ci.outcome, 'upcoming');
  // The core's gate refuses it too (Env.stepStatus reads the current revision).
  assert.equal(w.step('bc-2', 'b_followup').status, 'off');
});
