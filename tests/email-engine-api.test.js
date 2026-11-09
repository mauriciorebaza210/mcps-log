// api/email.js read path (PLAN.md → Read-path security; matrix row 31), run
// offline: the real handler with injected session + Sheets stand-ins.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NOW = Date.now();
const iso = daysAgo => new Date(NOW - daysAgo * 86400000).toISOString();

const SHEET = {
  Permissions: [['username', 'roles', 'active'], ['mau', 'editor,approver,operator', 'Y'], ['viewer1', 'viewer', 'Y'], ['gone', 'operator', 'N']],
  Config: [['key', 'value'], ['engine_mode', 'test'], ['rule_rev', 'bc-1'], ['engine_enabled', 'true'], ['daily_cap', '50'], ['paused_buckets', '']],
  Rulesets: [['rule_rev', 'json'], ['bc-1', JSON.stringify({ steps: [
    { step_id: 'b_intro', sequence_id: 'B', order: 1, name: 'MCP x MCPS Intro', category: 'marketing', status: 'active' },
    { step_id: 'c_welcome', sequence_id: 'C', order: 1, name: 'Welcome Email', category: 'service', status: 'active' }] })]],
  Revisions: [['revision_id', 'step_id', 'rev_no', 'subject', 'status', 'approver', 'approved_at'],
    ['rev_b_intro_1', 'b_intro', '1', 'An introduction', 'published', 'antonio@mcpoolsolutions.org', iso(3)]],
  Contacts: [['contact_id', 'email_norm', 'first_name', 'last_name', 'address', 'bucket', 'sub_bucket', 'is_test'],
    ['c1', 'maria@example.com', 'Maria', 'Lopez', '1 Elm St', 'B', 'B2', 'N'],
    ['c2', 'james@example.com', 'James', 'Park', '', 'C', '', 'N']],
  Enrollments: [['enrollment_id', 'contact_id', 'sequence_id', 'mode', 'status'], ['e1', 'c1', 'B', 'test', 'active'], ['e2', 'c2', 'C', 'test', 'active']],
  Deliveries: [['delivery_id', 'contact_id', 'enrollment_id', 'step_id', 'occurrence', 'mode', 'email_norm', 'state', 'attempt', 'claimed_at', 'sent_at'],
    ['e1:b_intro:1', 'c1', 'e1', 'b_intro', '1', 'test', 'maria@example.com', 'sent', '1', iso(2), iso(2)],
    ['e2:c_welcome:1', 'c2', 'e2', 'c_welcome', '1', 'test', 'james@example.com', 'unknown', '1', iso(1), ''],
    ['old:b_intro:1', 'c1', 'e1', 'b_intro', '2', 'test', 'maria@example.com', 'sent', '1', iso(90), iso(90)]],
  Runs: [['run_id', 'trigger', 'started_at', 'sent', 'stopped_reason'], ['r1', 'daily', iso(1), '1', 'done'], ['r2', 'manual', iso(0.5), '0', 'done']],
  Alerts: [['at', 'kind', 'detail'], [iso(1) + ' ab12', 'delivery_unknown', 'e2:c_welcome:1 to james@example.com']],
  Engagement: [['delivery_id', 'opens_total', 'opens_low', 'opens_medium', 'clicks_total', 'clicks_low', 'clicks_medium', 'clicks_high', 'first_open_at', 'links_json'],
    ['e1:b_intro:1', '3', '1', '2', '2', '1', '1', '1', iso(1), '{"button1":2}']]
};

async function load() {
  process.env.EE_ENGINE_SS_ID = 'sheet-under-test';
  const mod = await import(path.join(ROOT, 'api', 'email.js'));
  return mod.createEmailHandler;
}
function world(over = {}) {
  const calls = { reads: 0 };
  const deps = {
    validatePortalSession: async tok => ({ 'tok-mau': { username: 'mau' }, 'tok-viewer': { username: 'viewer1' },
      'tok-gone': { username: 'gone' }, 'tok-stranger': { username: 'someone' } })[tok] || null,
    readSheetRanges: async tabs => { calls.reads++; const o = {}; tabs.forEach(t => { if (SHEET[t]) o[t] = SHEET[t]; }); return o; },
    getCached: async (k, ttl, loader) => loader(),
    ...over
  };
  return { deps, calls };
}
async function call(handler, { method = 'GET', query = {}, token } = {}) {
  const res = { statusCode: 0, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = c => { res.statusCode = c; return res; };
  res.send = b => { res.body = JSON.parse(b); return res; };
  await handler({ method, query: { op: 'read', ...query }, headers: token ? { authorization: 'Bearer ' + token } : {} }, res);
  return res;
}

test('Row 31: no token → 401, token in the URL → 400; always private, no-store, Vary: Authorization', async () => {
  const h = (await load())(world().deps);
  for (const r of [await call(h), await call(h, { query: { token: 'tok-mau' } }), await call(h, { token: 'tok-mau' })]) {
    assert.equal(r.headers['cache-control'], 'private, no-store');
    assert.equal(r.headers.vary, 'Authorization');
  }
  assert.equal((await call(h)).statusCode, 401);
  assert.equal((await call(h, { query: { token: 'tok-mau' } })).statusCode, 400);
  assert.equal((await call(h, { token: 'bogus' })).statusCode, 401);
});

test('Row 31: access comes from the engine Permissions tab, not portal roles', async () => {
  const h = (await load())(world().deps);
  assert.equal((await call(h, { token: 'tok-stranger' })).statusCode, 403, 'not listed');
  assert.equal((await call(h, { token: 'tok-gone' })).statusCode, 403, 'listed but inactive');
  const ok = await call(h, { token: 'tok-mau' });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.body.capabilities.includes('run_now') && ok.body.capabilities.includes('view_pii'));
});

test('Row 31: a viewer gets aggregates with emails, addresses and alert details redacted', async () => {
  const h = (await load())(world().deps);
  const v = (await call(h, { token: 'tok-viewer', query: { view: 'contacts' } })).body;
  assert.deepEqual(v.capabilities, ['view_aggregates']);
  const maria = v.data.contacts.find(c => c.contact_id === 'c1');
  assert.equal(maria.email, 'm•••@example.com');
  assert.equal(maria.address, 'hidden');
  assert.equal(maria.first_name, 'Maria');
  const o = (await call(h, { token: 'tok-viewer' })).body.data;
  assert.equal(o.attention[0].email, 'j•••@example.com');
  assert.equal(o.alerts[0].detail, '');
  // A search can't probe hidden fields: an email fragment finds nothing for a viewer.
  assert.equal((await call(h, { token: 'tok-viewer', query: { view: 'contacts', q: 'maria@' } })).body.data.total, 0);
  assert.equal((await call(h, { token: 'tok-mau', query: { view: 'contacts', q: 'maria@' } })).body.data.total, 1);
  const full = (await call(h, { token: 'tok-mau', query: { view: 'contacts' } })).body.data.contacts.find(c => c.contact_id === 'c1');
  assert.equal(full.email, 'maria@example.com');
  assert.equal(full.address, '1 Elm St');
});

test('Overview: per-step counts, audience, attention list, latest runs first, 60-day window', async () => {
  const h = (await load())(world().deps);
  const o = (await call(h, { token: 'tok-mau' })).body.data;
  assert.equal(o.mode, 'test');
  const b = o.steps.find(s => s.step_id === 'b_intro'), c = o.steps.find(s => s.step_id === 'c_welcome');
  assert.equal(b.counts.sent, 1, 'the 90-day-old send is outside the window');
  assert.equal(b.counts.sent_7d, 1);
  assert.equal(b.audience, 1);
  assert.equal(b.published.rev_no, 1);
  assert.equal(c.published, null);
  assert.equal(c.counts.unknown, 1);
  assert.deepEqual(o.attention.map(d => d.delivery_id), ['e2:c_welcome:1']);
  assert.equal(o.runs[0].run_id, 'r2');
  assert.equal(o.engine.last_run.run_id, 'r2');
  assert.deepEqual({ ...b.tracking }, { opened_est: 1, clicked: 1, verified_clicks: 1, unsubscribed: 0, forms: 0, scanner_like: 1 });
  const r = (await call(h, { token: 'tok-mau', query: { view: 'contact', id: 'c1' } })).body.data.deliveries[0].engagement;
  assert.deepEqual([r.opened, r.opens, r.verified_clicks, r.links.button1], [true, 3, 1, 2]);
  assert.equal((await call(h, { token: 'tok-mau', query: { mode: 'production' } })).body.data.steps[0].counts.sent, 0, 'test data never shows in production');
});

test('Contact view: enrollments and deliveries, newest first; unknown contact → 404', async () => {
  const h = (await load())(world().deps);
  const r = (await call(h, { token: 'tok-mau', query: { view: 'contact', id: 'c1' } })).body.data;
  assert.equal(r.enrollments[0].enrollment_id, 'e1');
  assert.deepEqual(r.deliveries.map(d => d.delivery_id), ['e1:b_intro:1', 'old:b_intro:1']);
  assert.equal((await call(h, { token: 'tok-mau', query: { view: 'contact', id: 'nope' } })).statusCode, 404);
});

test('Raw sheet values are cached and shared; redaction still differs per viewer', async () => {
  const cache = {};
  const w = world({ getCached: async (k, ttl, loader) => (cache[k] = cache[k] || await loader()) });
  const h = (await load())(w.deps);
  const a = (await call(h, { token: 'tok-viewer', query: { view: 'contacts' } })).body.data.contacts[0].email;
  const b = (await call(h, { token: 'tok-mau', query: { view: 'contacts' } })).body.data.contacts[0].email;
  assert.equal(w.calls.reads, 1, 'one Sheets read for both');
  assert.notEqual(a, b);
  await call(h, { token: 'tok-mau', query: { fresh: '1' } });
  assert.equal(w.calls.reads, 2, 'fresh=1 bypasses the cache');
});

test('Missing engine tabs → 503 with a clear message; wrong method → 405; unknown op → 404', async () => {
  const h = (await load())(world({ readSheetRanges: async () => { throw new Error("Unable to parse range: 'Permissions'"); } }).deps);
  const r = await call(h, { token: 'tok-mau' });
  assert.equal(r.statusCode, 503);
  assert.match(r.body.error, /eeSetup/);
  const h2 = (await load())(world().deps);
  assert.equal((await call(h2, { token: 'tok-mau', method: 'POST' })).statusCode, 405);
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, send() { return this; } };
  await h2({ method: 'GET', query: { op: 'nope' }, headers: {} }, res);
  assert.equal(res.statusCode, 404);
});

// ── Heartbeat (PLAN.md → Operations → Independent heartbeat) ─────────────────

async function heartbeat(tablesOver = {}, { auth = 'Bearer cron-s3cret', readFails = false } = {}) {
  const sent = [];
  const values = { ...SHEET, ...tablesOver };
  const h = (await load())({
    ...world({ readSheetRanges: async tabs => { if (readFails) throw new Error('quota exceeded'); const o = {}; tabs.forEach(t => { if (values[t]) o[t] = values[t]; }); return o; } }).deps,
    cronSecret: () => 'cron-s3cret', now: () => NOW,
    sendEngineAlert: async (to, subject, text) => { sent.push({ to, subject, text }); return { ok: true }; }
  });
  const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, send(b) { this.body = JSON.parse(b); return this; } };
  await h({ method: 'GET', query: { op: 'heartbeat' }, headers: auth ? { authorization: auth } : {} }, res);
  return { res, sent };
}

test('Heartbeat: only Vercel Cron (CRON_SECRET) can run it', async () => {
  assert.equal((await heartbeat({}, { auth: '' })).res.statusCode, 401);
  assert.equal((await heartbeat({}, { auth: 'Bearer wrong' })).res.statusCode, 401);
});

test('Heartbeat: a stale daily run, an old unknown delivery and a crashed run → one alert email listing them', async () => {
  const { res, sent } = await heartbeat({
    Runs: [['run_id', 'trigger', 'started_at', 'stopped_reason'], ['r1', 'daily', iso(2), 'done'], ['r2', 'manual', iso(0.1), 'crashed: boom']],
    Deliveries: [['delivery_id', 'state', 'claimed_at', 'send_invoked_at', 'mode'], ['x:1', 'unknown', iso(2), iso(2), 'test']]
  });
  assert.equal(res.body.healthy, false);
  assert.deepEqual(res.body.issues.map(i => i.kind).sort(), ['last_run_crashed', 'no_recent_run', 'unresolved_unknown']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'mauricio@mcpoolsolutions.org');
  assert.match(sent[0].text, /unresolved_unknown: x:1/);
});

test('Heartbeat: healthy (or the daily trigger not installed yet) sends nothing; an unreadable engine is itself an alert', async () => {
  const ok = await heartbeat({ Runs: [['run_id', 'trigger', 'started_at', 'stopped_reason'], ['r1', 'daily', iso(0.5), 'done']],
    Deliveries: [['delivery_id', 'state', 'claimed_at', 'mode'], ['a', 'sent', iso(1), 'test']] });
  assert.equal(ok.res.body.healthy, true); assert.equal(ok.sent.length, 0);
  const manualOnly = await heartbeat({ Deliveries: [['delivery_id', 'state', 'claimed_at', 'mode'], ['a', 'sent', iso(1), 'test']] });
  assert.equal(manualOnly.res.body.healthy, true, 'only manual runs so far: nothing to miss yet');
  const down = await heartbeat({}, { readFails: true });
  assert.deepEqual(down.res.body.issues.map(i => i.kind), ['engine_unreadable']);
  assert.equal(down.sent.length, 1);
});

test('Overview carries health for the portal banner; details hidden without view_pii', async () => {
  const stale = { ...SHEET, Deliveries: [['delivery_id', 'state', 'claimed_at', 'send_invoked_at', 'mode'], ['x:1', 'unknown', iso(3), iso(3), 'test']] };
  const h = (await load())(world({ readSheetRanges: async tabs => { const o = {}; tabs.forEach(t => { if (stale[t]) o[t] = stale[t]; }); return o; } }).deps);
  const mau = (await call(h, { token: 'tok-mau' })).body.data.health;
  const viewer = (await call(h, { token: 'tok-viewer' })).body.data.health;
  assert.equal(mau.ok, false);
  assert.deepEqual(mau.issues.map(i => i.kind), ['unresolved_unknown']);
  assert.match(mau.issues[0].detail, /x:1/);
  assert.deepEqual(viewer.issues, [{ kind: 'unresolved_unknown', detail: '' }]);
});
