// Who an email comes from (Admin.js → list_senders / set_step_sender / test_sender,
// Config step_senders). One email (the MCP Legacy Intro) can come from another
// address linked in Tony's Gmail; everything else stays Tony's. The address must be
// linked before the email can be turned on, and replies go to Tony.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeWorld, item } = require('./helpers/ee-fake-env.js');

const BC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'email-engine', 'seed', 'ruleset-bc.json'), 'utf8'));
const MCP = 'info@missioncustompools.com';

function engine() {
  const w = fakeWorld();
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite };
  vm.createContext(ctx);
  vm.runInContext(['js/lib/lifecycle-rules.js', 'js/lib/batches.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n') +
    '\nvar EE_TZ = "America/Chicago";\n' + fs.readFileSync(path.join(__dirname, '..', 'email-engine', 'src', 'Admin.js'), 'utf8'), ctx);
  w.tables.Rulesets.push({ rule_rev: 'bc-1', json: JSON.parse(JSON.stringify(BC)), published_at: '', published_by: 'seed' });
  w.tables.Config.push({ key: 'rule_rev', value: 'bc-1' });
  w.tables.Config.push({ key: 'test_recipients', value: 'mau@example.com,other@example.com' });
  w.aliases = [w.owner];
  w.tests = [];
  w.env.gmail.aliases = () => w.aliases.slice();
  w.env.gmail.sendTest = m => w.tests.push(m);
  w.ctx_ = ctx;
  w.admin = (action, params) => JSON.parse(JSON.stringify(ctx.EE_adminRun_(w.env, w.core, { action, params, actor: 'mau' }, { scheduleRun: () => 'queued', planRuns: () => ({ times: [] }) })));
  w.senders = () => JSON.parse(w.tables.Config.find(c => c.key === 'step_senders').value);
  return w;
}

test('An email can be set to another address before it is linked; it shows as not linked', () => {
  const w = engine();
  const r = w.admin('set_step_sender', { step_id: 'b_intro', email: ' Info@MissionCustomPools.com ', name: 'Mission Custom Pools' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.sender, { email: MCP, name: 'Mission Custom Pools', linked: false });
  assert.deepEqual(w.senders(), { b_intro: { email: MCP, name: 'Mission Custom Pools' } });
  const l = w.admin('list_senders', {});
  assert.deepEqual(l.steps.b_intro, { email: MCP, name: 'Mission Custom Pools', linked: false });
  w.aliases.push(MCP);
  assert.equal(w.admin('list_senders', {}).steps.b_intro.linked, true, 'linked once Gmail lists the alias');
});

test('Only the chosen email changes; Tony’s address or a blank resets it', () => {
  const w = engine();
  w.admin('set_step_sender', { step_id: 'b_intro', email: MCP, name: 'Mission Custom Pools' });
  assert.equal(w.ctx_.EE_senderFor_(w.env.store, 'b_followup'), null);
  assert.equal(w.ctx_.EE_senderFor_(w.env.store, 'b_intro').email, MCP);
  w.admin('set_step_sender', { step_id: 'b_intro', email: w.owner });
  assert.deepEqual(w.senders(), {});
  w.admin('set_step_sender', { step_id: 'b_intro', email: MCP, name: 'MCP' });
  w.admin('set_step_sender', { step_id: 'b_intro', email: '' });
  assert.deepEqual(w.senders(), {});
});

test('Bad input is refused and nothing is saved', () => {
  const w = engine();
  assert.equal(w.admin('set_step_sender', { step_id: 'b_intro', email: 'not-an-email', name: 'X' }).ok, false);
  assert.equal(w.admin('set_step_sender', { step_id: 'b_intro', email: MCP, name: '' }).ok, false);
  assert.equal(w.admin('set_step_sender', { step_id: 'b_intro', email: 'a@b.com>, c@d.com', name: 'X' }).ok, false);
  assert.equal(w.admin('set_step_sender', { step_id: '', email: MCP, name: 'X' }).ok, false);
  assert.equal(w.tables.Config.find(c => c.key === 'step_senders'), undefined);
});

test('An email whose address is not linked cannot be turned on; once linked it can', () => {
  const w = engine();
  w.admin('set_step_sender', { step_id: 'b_intro', email: MCP, name: 'Mission Custom Pools' });
  const off = w.admin('publish_rules', { edits: [{ step_id: 'b_intro', status: 'off' }], scope: 'new' });
  assert.equal(off.ok, true, 'turning it off is always allowed');
  const on = w.admin('publish_rules', { edits: [{ step_id: 'b_intro', status: 'active' }], scope: 'new' });
  assert.equal(on.ok, false);
  assert.match(on.error, /isn’t linked/);
  w.aliases.push(MCP);
  assert.equal(w.admin('publish_rules', { edits: [{ step_id: 'b_intro', status: 'active' }], scope: 'new' }).ok, true);
  // Other emails are unaffected.
  w.aliases.pop();
  assert.equal(w.admin('publish_rules', { edits: [{ step_id: 'b_followup', status: 'active' }], scope: 'new' }).ok, true);
});

test('A test goes from the linked address to the first test recipient, replies to Tony', () => {
  const w = engine();
  assert.equal(w.admin('test_sender', { email: MCP, name: 'Mission Custom Pools' }).ok, false, 'not linked yet');
  assert.equal(w.tests.length, 0);
  w.aliases.push(MCP);
  const r = w.admin('test_sender', { email: MCP, name: 'Mission Custom Pools' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.to, 'mau@example.com');
  assert.equal(w.tests.length, 1);
  assert.equal(w.tests[0].from, MCP);
  assert.equal(w.tests[0].name, 'Mission Custom Pools');
  assert.equal(w.tests[0].reply_to, w.owner);
});

test('The core hands the sender to Gmail’s draft unchanged (Env.js sets from, name, replyTo)', () => {
  const w = fakeWorld();
  w.env.render = row => ({ to: row.email_norm, subject: 'Hello', html: '<p>Hi ' + row.token + '</p>', text: 'Hi ' + row.token,
    from: MCP, from_name: 'Mission Custom Pools', reply_to: w.owner });
  const seen = [], create = w.env.gmail.createDraft;
  w.env.gmail.createDraft = m => { seen.push(m); return create(m); };
  w.tables.Enrollments.push({ enrollment_id: 'e1', status: 'active', stopped_branches: [] });
  w.core.run({ plan: () => [item('e1:b_intro:1')] });
  assert.equal(w.delivery('e1:b_intro:1').state, 'sent');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].from, MCP);
  assert.equal(seen[0].from_name, 'Mission Custom Pools');
  assert.equal(seen[0].reply_to, w.owner);
});
