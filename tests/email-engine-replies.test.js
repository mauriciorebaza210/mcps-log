// Replies and bounces (CP6a): email-engine/src/Replies.js through the tracker
// and the core, against the fake env. Matrix rows 20 and 21, plus the bounce
// rules shared with the portal's CommsBounces.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { fakeWorld, item, T0, MIN } = require('./helpers/ee-fake-env.js');
const ROOT = path.join(__dirname, '..');
const OWNER = 'antonio@mcpoolsolutions.org';
const tok = n => 'dlv_' + String(n).repeat(32).slice(0, 32);

function world(mode = 'production') {
  const w = fakeWorld();
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, encodeURIComponent, isFinite };
  vm.createContext(ctx);
  vm.runInContext(['js/lib/email-tracking.js', 'email-engine/src/Tracking.js', 'email-engine/src/Replies.js']
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n'), ctx);
  w.ctx = ctx;
  w.threads = {}; w.bounces = [];
  Object.assign(w.env.gmail, { threadMessages: id => w.threads[id] || [], bounceMessages: () => w.bounces, aliases: () => ['tony@missioncustompools.com'] });
  w.tables.Contacts.push({ contact_id: 'c1', email_norm: 'maria@example.com', alt_emails: 'maria.l@work.example' });
  w.tables.Enrollments.push({ enrollment_id: 'e1', status: 'active', stopped_branches: [] });
  w.sent = (key, n, minutesAgo, thread = 't1') => w.tables.Deliveries.push({ delivery_id: key, key, token: tok(n), mode, email_norm: 'maria@example.com',
    contact_id: 'c1', enrollment_id: 'e1', step_id: key.split(':')[1], state: 'sent', thread_id: thread,
    sent_at: new Date(T0 - minutesAgo * MIN).toISOString() });
  let n = 0;
  w.msg = (from, minutesAgo, extra = {}) => Object.assign({ id: 'm' + (++n), from, date: T0 - minutesAgo * MIN, subject: 'Re: An introduction',
    body: 'Thanks!', headers: {} }, extra);
  w.scan = () => w.ctx.EE_createReplyScanner(w.env, w.core).scan();
  w.signals = () => w.tables.Inbox.filter(r => r.type === 'signal');
  w.eng = key => w.tables.Engagement.find(g => g.delivery_id === key);
  return w;
}

test('A reply from the contact is a high-confidence reply signal for that enrollment, with a snippet', () => {
  const w = world();
  w.sent('e1:b_intro:1', 1, 120);
  w.threads.t1 = [w.msg(OWNER, 120, { subject: 'An introduction' }), w.msg('"Maria Lopez" <Maria@Example.com>', 30, { body: 'Yes please, call me Tuesday.' })];
  const s = w.scan();
  assert.equal(s.replies, 1);
  const sig = w.signals();
  assert.deepEqual(sig.map(x => [x.signal, x.confidence, x.enrollment_id]), [['reply', 'high', 'e1']]);
  assert.ok(w.eng('e1:b_intro:1').replied_at);
  assert.equal(w.eng('e1:b_intro:1').last_reply_snippet, 'Yes please, call me Tuesday.');
});

test('Row 20: an out-of-office from the contact’s own address is auto_reply and stops nothing (headers or wording)', () => {
  const w = world();
  w.sent('e1:b_intro:1', 1, 120);
  w.threads.t1 = [
    w.msg('maria@example.com', 100, { headers: { auto_submitted: 'auto-replied' } }),
    w.msg('maria@example.com', 90, { subject: 'Out of Office: An introduction', body: 'I am away until Monday.' }),
    w.msg('maria@example.com', 80, { headers: { precedence: 'auto_reply' } })];
  const s = w.scan();
  assert.equal(s.auto, 3);
  assert.equal(w.signals().length, 0);
  assert.equal(w.eng('e1:b_intro:1').auto_replies, 3);
});

test('Precedence: Tony and his aliases are ignored; a bounce wins over its own Auto-Submitted header; a stranger is reply_other', () => {
  const w = world();
  w.sent('e1:b_intro:1', 1, 120);
  w.threads.t1 = [
    w.msg('Tony <tony@missioncustompools.com>', 60),
    w.msg('Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 50, { headers: { auto_submitted: 'auto-replied' },
      subject: 'Delivery Status Notification (Failure)', body: 'Final-Recipient: rfc822; maria@example.com\nAction: failed\nStatus: 4.2.2\n' }),
    w.msg('husband@example.com', 40, { body: 'She asked me to reply' })];
  w.scan();
  assert.deepEqual(w.events.map(e => e.type), ['bounce', 'reply_other']);
  assert.deepEqual(w.signals().map(x => [x.signal, x.confidence]), [['reply', 'medium']], 'reply_other stops marketing conservatively');
  assert.equal(w.events[0].confidence, 'low', 'one soft bounce is not a hard bounce');
});

test('Row 21: one reply in a thread shared by two emails → one event, credited to the latest email sent before it', () => {
  const w = world();
  w.sent('e1:b_intro:1', 1, 6000);          // ~4 days ago
  w.sent('e1:b_followup:1', 2, 60);         // an hour ago, same thread
  w.threads.t1 = [w.msg('maria@example.com', 3000), w.msg('maria@example.com', 30)];
  w.scan();
  assert.deepEqual(w.events.map(e => e.delivery_id), ['e1:b_intro:1', 'e1:b_followup:1']);
  // Scanning again changes nothing: the cursor and the event ids both dedupe.
  w.threads.t1 = w.threads.t1.slice();
  const again = w.scan();
  assert.equal(again.replies, 0);
  assert.equal(w.events.length, 2);
  assert.equal(w.signals().length, 2);
  w.tables.Threads.forEach(t => { t.message_count = 0; });      // force a rescan past the cursor
  w.scan();
  assert.equal(w.events.length, 2, 'msg_<id> event ids never record a message twice');
});

test('A hard bounce suppresses the address everywhere (production → Comms_Optouts) and blocks the next send', () => {
  const w = world();
  w.sent('e1:b_intro:1', 1, 120);
  w.threads.t1 = [w.msg('mailer-daemon@googlemail.com', 100, { body: 'Final-Recipient: rfc822; maria@example.com\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 user unknown' })];
  assert.equal(w.scan().bounces, 1);
  assert.ok(w.tables.Inbox.find(r => r.type === 'bounce' && r.email_norm === 'maria@example.com'));
  assert.equal(w.optouts.length, 1);
  assert.equal(w.eng('e1:b_intro:1').bounce_kind, 'hard');
  const run = w.core.run({ plan: () => [item('e1:b_intro:2', { occurrence: 2 })] });
  assert.equal(run.sent, 0);
});

test('A bounce outside the thread is matched by the token; three soft bounces count as hard', () => {
  const w = world();
  w.sent('e1:b_intro:1', 1, 120, 't-none');
  const dsn = (i, status) => w.msg('postmaster@example.com', 100 - i, { id: 'b' + i, body: 'Status: ' + status + '\n--- original ---\nRef ' + tok(1) });
  w.bounces = [dsn(1, '4.2.2'), dsn(2, '4.2.2')];
  w.scan();
  assert.equal(w.tables.Inbox.filter(r => r.type === 'bounce').length, 0, 'two soft bounces: not yet');
  assert.equal(w.eng('e1:b_intro:1').soft_bounces, 2);
  w.bounces.push(dsn(3, '4.2.2'));
  w.scan();
  assert.equal(w.tables.Inbox.filter(r => r.type === 'bounce').length, 1, 'the third soft bounce suppresses');
  assert.equal(w.events.filter(e => e.type === 'bounce').length, 3, 'each DSN recorded once across scans');
});

test('Test mode: a reply and a hard bounce on a test email touch only test data', () => {
  const w = world('test');
  w.sent('e1:b_intro:1', 1, 120);
  w.threads.t1 = [w.msg('maria@example.com', 60), w.msg('mailer-daemon@googlemail.com', 50, { body: 'Status: 5.1.1' })];
  w.scan();
  assert.equal(w.optouts.length, 0);
  assert.ok(w.tables.Suppressions_Test.find(x => x.email_norm === 'maria@example.com'));
  assert.ok(w.signals().every(x => x.mode === 'test'));
});

test('Only the engine’s own sent emails are scanned, newest first, within the time budget', () => {
  const w = world();
  w.sent('e1:b_intro:1', 1, 120, 'tA');
  w.tables.Deliveries.push({ delivery_id: 'x', token: tok(9), mode: 'production', state: 'failed', thread_id: 'tB', sent_at: '' });
  let calls = [];
  w.env.gmail.threadMessages = id => { calls.push(id); return []; };
  w.scan();
  assert.deepEqual(calls, ['tA']);
  const slow = w.ctx.EE_createReplyScanner(w.env, w.core, { budgetMs: -1 }).scan();
  assert.equal(slow.stopped, 'time_budget');
});
