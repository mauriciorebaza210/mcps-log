// Tracking (CP5c): signed links + classifier (js/lib/email-tracking.js), the
// engine's ingest (email-engine/src/Tracking.js) and the api/email.js c / o /
// beacon / u operations, end to end and offline. Matrix rows 22, 23, 28, 40.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const T = require('../js/lib/email-tracking.js');
const { fakeWorld, item, T0, MIN } = require('./helpers/ee-fake-env.js');
const ROOT = path.join(__dirname, '..');
const SECRET = 'test-link-secret';
const hmac = m => crypto.createHmac('sha256', SECRET).update(m).digest('hex');
const TOKEN = 'dlv_' + 'ab'.repeat(16);
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const GMAIL_PROXY = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';

function trackerWorld(mode = 'production') {
  const w = fakeWorld();
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, encodeURIComponent, isFinite };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/lib/email-tracking.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(ROOT, 'email-engine/src/Tracking.js'), 'utf8'), ctx);
  w.tables.Enrollments.push({ enrollment_id: 'e1', status: 'active', stopped_branches: [] });
  w.tables.Deliveries.push({ delivery_id: 'e1:b_intro:1', token: TOKEN, mode, email_norm: 'maria@example.com', contact_id: 'c1',
    enrollment_id: 'e1', step_id: 'b_intro', state: 'sent', sent_at: new Date(T0 - 60 * MIN).toISOString() });
  w.tracker = ctx.EE_createTracker(w.env, w.core);
  let n = 0;
  w.ev = (type, extra = {}) => Object.assign({ event_id: 'ev' + (++n), type, token: TOKEN, link_id: type === 'open' ? '' : 'button1',
    mode, method: 'GET', ua: BROWSER, received_at: T0 }, extra);
  w.eng = () => w.tables.Engagement.find(g => g.delivery_id === 'e1:b_intro:1');
  w.signals = () => w.tables.Inbox.filter(r => r.type === 'signal');
  return w;
}

// ── Links and classifier ─────────────────────────────────────────────────────

test('Links: signed round trip for click, open, unsubscribe; any tampered field is refused', () => {
  const L = T.links({ base: 'https://mcps-log.vercel.app/', token: TOKEN, mode: 'production', hmacHex: hmac });
  const params = u => Object.fromEntries(new URL(u).searchParams);
  const c = params(L.click('button1', 'https://mcps-log.vercel.app/service?x=1#top'));
  assert.equal(c.op, 'c');
  const ok = T.verify('c', c, hmac);
  assert.ok(ok.ok); assert.equal(ok.url, 'https://mcps-log.vercel.app/service?x=1#top'); assert.equal(ok.mode, 'production');
  for (const [k, v] of [['u', 'https://evil.example/'], ['l', 'button2'], ['m', 'test'], ['t', 'dlv_' + 'cd'.repeat(16)], ['s', c.s.replace(/.$/, '0')]]) {
    assert.equal(T.verify('c', { ...c, [k]: v }, hmac).ok, false, 'tampered ' + k);
  }
  assert.equal(T.verify('c', { ...c, u: 'javascript:alert(1)' }, hmac).ok, false);
  assert.ok(T.verify('o', params(L.open()), hmac).ok);
  assert.ok(T.verify('u', params(L.unsubscribe()), hmac).ok);
  assert.equal(T.verify('u', params(L.open()), hmac).ok, false, 'an open signature is not an unsubscribe signature');
  assert.equal(T.verify('c', c, m => crypto.createHmac('sha256', 'other').update(m).digest('hex')).ok, false, 'wrong secret');
});

test('Beacon: signed value survives the destination’s own query and hash; tampering is refused', () => {
  const b = T.beaconParam(hmac, TOKEN, 'button1', 'test');
  const url = T.withBeacon('https://mcps-log.vercel.app/service?ref=x#form', b);
  assert.match(url, /^https:\/\/mcps-log\.vercel\.app\/service\?ref=x&ee=[^#]+#form$/);
  assert.ok(T.verifyBeacon(new URL(url).searchParams.get('ee'), hmac).ok);
  assert.equal(T.verifyBeacon(b.replace('.test.', '.production.'), hmac).ok, false);
});

test('Classifier: opens never above medium; only a clean beacon is high; scanners, HEAD, bursts and very early hits are low', () => {
  assert.equal(T.classify({ type: 'open', ua: GMAIL_PROXY, seconds_since_send: 3600 }).confidence, 'medium');
  assert.equal(T.classify({ type: 'open', ua: BROWSER, seconds_since_send: 3 }).confidence, 'low');
  assert.equal(T.classify({ type: 'open', ua: 'Mozilla/5.0', seconds_since_send: 3600 }).confidence, 'low', 'Apple Mail Privacy prefetch');
  assert.equal(T.classify({ type: 'click', ua: BROWSER, seconds_since_send: 3600 }).confidence, 'medium');
  assert.equal(T.classify({ type: 'click', ua: BROWSER, seconds_since_send: 3600, method: 'HEAD' }).confidence, 'low');
  assert.equal(T.classify({ type: 'click', ua: 'Proofpoint URL Defense', seconds_since_send: 3600 }).confidence, 'low');
  assert.equal(T.classify({ type: 'click', ua: BROWSER, seconds_since_send: 4 }).confidence, 'low');
  assert.equal(T.classify({ type: 'click', ua: BROWSER, seconds_since_send: 3600, burst_count: 3 }).confidence, 'low');
  assert.equal(T.classify({ type: 'click', ua: '', seconds_since_send: 3600 }).confidence, 'low');
  assert.equal(T.classify({ type: 'beacon', ua: BROWSER, seconds_since_send: 3600 }).confidence, 'high');
  assert.equal(T.classify({ type: 'beacon', ua: 'python-requests/2.31', seconds_since_send: 3600 }).confidence, 'low');
});

// ── Engine ingest ────────────────────────────────────────────────────────────

test('Ingest: an open and a redirect click are recorded but stop nothing (row 23: a lost beacon means no stop)', () => {
  const w = trackerWorld();
  const r = w.tracker.ingest([w.ev('open', { ua: GMAIL_PROXY }), w.ev('click')]);
  assert.deepEqual(r.map(x => [x.status, x.confidence]), [['recorded', 'medium'], ['recorded', 'medium']]);
  const g = w.eng();
  assert.equal(g.opens_total, 1); assert.equal(g.opens_medium, 1);
  assert.equal(g.clicks_total, 1); assert.equal(g.clicks_medium, 1); assert.equal(g.clicks_high, 0);
  assert.equal(JSON.stringify(g.links_json), '{"button1":1}');
  assert.equal(g.classifier_version, T.CLASSIFIER_VERSION);
  assert.equal(w.signals().length, 0);
  assert.equal(w.events.length, 2);
  assert.equal(w.events[1].seconds_since_send, 3600);
});

test('Ingest: a browser-verified click (beacon) becomes a high-confidence stop signal for that enrollment', () => {
  const w = trackerWorld();
  w.tracker.ingest([w.ev('click'), w.ev('beacon')]);
  const s = w.signals();
  assert.equal(s.length, 1);
  // The shape Planner.js reads: type 'signal' with enrollment_id, signal, confidence.
  assert.deepEqual([s[0].enrollment_id, s[0].step_id, s[0].signal, s[0].confidence, s[0].mode], ['e1', 'b_intro', 'click', 'high', 'production']);
  assert.equal(w.eng().clicks_high, 1);
});

test('Ingest (row 22): scanner, HEAD and burst hits are low and never stop; a scanner beacon is not "verified"', () => {
  const w = trackerWorld();
  w.tracker.ingest([w.ev('click', { ua: 'Mimecast Safe Links' }), w.ev('click', { method: 'HEAD' }),
    w.ev('click', { received_at: T0 + 1000 }), w.ev('click', { received_at: T0 + 2000 }), w.ev('click', { received_at: T0 + 3000 }),
    w.ev('beacon', { ua: 'curl/8.4' })]);
  const conf = w.events.map(e => e.confidence);
  assert.deepEqual(conf, ['low', 'low', 'low', 'low', 'low', 'low'], 'the 3rd+ hit inside 10 s is a burst');
  assert.equal(w.signals().length, 0);
});

test('Ingest: a duplicate event is recorded once; an unknown token is ignored; a mode that disagrees with the delivery is refused', () => {
  const w = trackerWorld();
  const e = w.ev('open', { ua: GMAIL_PROXY });
  assert.equal(w.tracker.ingest([e])[0].status, 'recorded');
  assert.equal(w.tracker.ingest([e])[0].status, 'duplicate');
  assert.equal(w.eng().opens_total, 1);
  assert.equal(w.tracker.ingest([w.ev('open', { token: 'dlv_' + 'ee'.repeat(16) })])[0].status, 'ignored');
  const r = w.tracker.ingest([w.ev('beacon', { mode: 'test' })])[0];
  assert.deepEqual([r.status, r.reason], ['rejected', 'mode_mismatch']);
  assert.equal(w.signals().length, 0);
});

test('Ingest: an unsubscribe is journaled first and blocks the next send; Comms_Optouts gets it in production', () => {
  const w = trackerWorld();
  const r = w.tracker.ingest([w.ev('unsubscribe')])[0];
  assert.equal(r.stop_recorded, true);
  assert.equal(w.optouts.length, 1, 'production opt-out reaches the shared Comms_Optouts');
  assert.ok(w.eng().unsubscribed_at);
  const s = w.core.run({ plan: () => [item('e1:b_intro:2', { occurrence: 2 })] });
  assert.equal(s.sent, 0);
  assert.equal(w.outbox.length, 0);
});

test('Ingest (rows 28, 40): test-mode click and unsubscribe touch only test data', () => {
  const w = trackerWorld('test');
  w.tracker.ingest([w.ev('beacon'), w.ev('unsubscribe')]);
  assert.equal(w.optouts.length, 0, 'never the shared Comms_Optouts');
  assert.ok(w.tables.Suppressions_Test.find(x => x.email_norm === 'maria@example.com'));
  assert.ok(!w.cache['sup:production:maria@example.com']);
  assert.ok(w.signals().every(x => x.mode === 'test' && x.enrollment_id === 'e1'));
});

// ── api/email.js c / o / beacon / u, wired to the engine tracker ─────────────

async function apiWorld({ relayDown = false, mode = 'production' } = {}) {
  const w = trackerWorld(mode);
  const relayed = [], pending = [];
  const { createEmailHandler } = await import(path.join(ROOT, 'api', 'email.js'));
  const handler = createEmailHandler({
    linkSecret: () => SECRET,
    relayEvents: async events => { relayed.push(...events); return relayDown ? { ok: false, error: 'down' } : { ok: true, results: w.tracker.ingest(events) }; },
    waitUntil: p => { pending.push(p); }
  });
  async function call(url, { method = 'GET', body, ua = BROWSER } = {}) {
    const u = new URL(url, 'https://mcps-log.vercel.app');
    const res = { statusCode: 0, headers: {}, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.status = c => { res.statusCode = c; return res; };
    res.send = b => { res.body = b; return res; };
    await handler({ method, query: Object.fromEntries(u.searchParams), body, headers: { 'user-agent': ua, 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } }, res);
    await Promise.all(pending.splice(0));
    return res;
  }
  const L = T.links({ base: 'https://mcps-log.vercel.app', token: TOKEN, mode, hmacHex: hmac });
  return { w, call, relayed, L };
}

test('API click: 302 to the signed destination with a beacon; relayed after the response; the beacon completes a verified click', async () => {
  const { w, call, relayed, L } = await apiWorld();
  const r = await call(L.click('button1', 'https://mcps-log.vercel.app/service'));
  assert.equal(r.statusCode, 302);
  const loc = new URL(r.headers.location);
  assert.equal(loc.origin + loc.pathname, 'https://mcps-log.vercel.app/service');
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].type, 'click');
  assert.match(relayed[0].ip_hash, /^[0-9a-f]{16}$/, 'only a salted prefix hash, never the address');
  assert.ok(!JSON.stringify(relayed[0]).includes('203.0.113'));
  const b = await call('/api/email?op=beacon', { method: 'POST', body: { ee: loc.searchParams.get('ee') } });
  assert.equal(b.statusCode, 200);
  assert.equal(w.signals().length, 1);
  assert.equal(w.signals()[0].confidence, 'high');
});

test('API click (row 22): external destinations get no beacon; forged links get a 400 and record nothing', async () => {
  const { call, relayed, L } = await apiWorld();
  const ext = await call(L.click('a1', 'https://www.google.com/maps?q=pool'));
  assert.equal(ext.statusCode, 302);
  assert.equal(ext.headers.location, 'https://www.google.com/maps?q=pool');
  relayed.length = 0;
  const u = new URL(L.click('a1', 'https://mcps-log.vercel.app/service'));
  u.searchParams.set('u', 'https://evil.example/phish');
  const forged = await call(u.toString());
  assert.equal(forged.statusCode, 400);
  assert.equal(forged.headers.location, undefined, 'never an open redirect');
  const flipped = new URL(L.click('a1', 'https://mcps-log.vercel.app/service')); flipped.searchParams.set('m', 'test');
  assert.equal((await call(flipped.toString())).statusCode, 400);
  assert.equal(relayed.length, 0);
});

test('API open: always a GIF; only a valid pixel is relayed', async () => {
  const { w, call, relayed, L } = await apiWorld();
  const ok = await call(L.open(), { ua: GMAIL_PROXY });
  assert.equal(ok.headers['content-type'], 'image/gif');
  assert.equal(relayed.length, 1);
  assert.equal(w.eng().opens_total, 1);
  const bad = await call('/api/email?op=o&t=' + TOKEN + '&m=production&s=nope');
  assert.equal(bad.headers['content-type'], 'image/gif');
  assert.equal(relayed.length, 1);
});

test('API unsubscribe: a GET only shows the button (scanners can’t unsubscribe anyone); the POST records it before answering', async () => {
  const { w, call, relayed, L } = await apiWorld();
  const g = await call(L.unsubscribe());
  assert.equal(g.statusCode, 200);
  assert.match(g.body, /<form method="post"/);
  assert.equal(relayed.length, 0);
  const p = Object.fromEntries(new URL(L.unsubscribe()).searchParams);
  const post = await call('/api/email?op=u', { method: 'POST', body: { t: p.t, m: p.m, s: p.s } });
  assert.equal(post.statusCode, 200);
  assert.match(post.body, /unsubscribed/);
  assert.ok(w.tables.Inbox.find(r => r.type === 'unsubscribe' && r.email_norm === 'maria@example.com'));
  const forged = await call('/api/email?op=u', { method: 'POST', body: { t: p.t, m: 'test', s: p.s } });
  assert.equal(forged.statusCode, 400);
});

test('API: when the engine can’t be reached, the unsubscribe page says how to opt out instead of claiming success; a beacon asks for a retry', async () => {
  const { call, L } = await apiWorld({ relayDown: true });
  const p = Object.fromEntries(new URL(L.unsubscribe()).searchParams);
  const post = await call('/api/email?op=u', { method: 'POST', body: p });
  assert.equal(post.statusCode, 503);
  assert.match(post.body, /Reply to any of our emails/);
  const b = await call('/api/email?op=beacon', { method: 'POST', body: { ee: T.beaconParam(hmac, TOKEN, 'button1', 'production') } });
  assert.equal(b.statusCode, 502);
});

test('The real B Intro, rendered with signed links: every link, the pixel and the unsubscribe verify after HTML escaping', () => {
  const R = require('../js/lib/email-render.js');
  const tpl = rel => fs.readFileSync(path.join(ROOT, 'email-engine', 'templates', rel), 'utf8');
  const content = JSON.parse(fs.readFileSync(path.join(ROOT, 'email-engine', 'seed', 'content-bc.json'), 'utf8'));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'email-engine', 'seed', 'config.json'), 'utf8'));
  const fields = JSON.parse(fs.readFileSync(path.join(ROOT, 'email-engine', 'seed', 'fields.json'), 'utf8')).fields;
  const step = content.steps.b_intro;
  const L = T.links({ base: 'https://mcps-log.vercel.app', token: TOKEN, mode: 'test', hmacHex: hmac });
  const r = R.render({ revision: { subject: step.subject, preheader: step.preheader, body_html: tpl(step.body) }, blocks: {}, fields,
    contact: { first_name: 'Maria' }, context: { sender_name: 'Tony', business: cfg.business, links: cfg.links, deliveryToken: TOKEN,
      unsubscribeUrl: L.unsubscribe(), openPixelUrl: L.open(), trackLink: L.click } });
  assert.deepEqual(r.errors, []);
  const urls = [...r.html.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&')).filter(u => u.includes('/api/email?'));
  const ops = urls.map(u => new URL(u).searchParams.get('op'));
  assert.ok(ops.includes('c') && ops.includes('o') && ops.includes('u'), ops.join(','));
  for (const u of urls) {
    const p = Object.fromEntries(new URL(u).searchParams);
    assert.ok(T.verify(p.op, p, hmac).ok, 'does not verify: ' + u);
    if (p.op === 'c') assert.match(p.u, /^https:\/\//);
  }
  // The CTA still lands on the quote page once followed.
  const cta = urls.map(u => Object.fromEntries(new URL(u).searchParams)).find(p => p.l === 'button1');
  assert.equal(cta.u, cfg.links.quote);
});

test('Form submit from a lifecycle landing page becomes a form stop signal; a missing, forged or unconfigured beacon relays nothing', async () => {
  const w = trackerWorld();
  const { relayFormSignal } = await import(path.join(ROOT, 'api', '_lib', 'email-relay.js'));
  const relayEvents = async events => ({ ok: true, results: w.tracker.ingest(events) });
  const req = { headers: { 'user-agent': BROWSER } };
  const prev = process.env.EE_LINK_SECRET;
  try {
    delete process.env.EE_LINK_SECRET;
    assert.ok((await relayFormSignal(T.beaconParam(hmac, TOKEN, 'button1', 'production'), req, { relayEvents })).skipped);
    process.env.EE_LINK_SECRET = SECRET;
    assert.ok((await relayFormSignal('', req, { relayEvents })).skipped);
    const forged = T.beaconParam(hmac, TOKEN, 'button1', 'production').replace(/.$/, '0');
    assert.equal((await relayFormSignal(forged, req, { relayEvents })).skipped, 'bad_signature');
    assert.equal(w.signals().length, 0);
    const r = await relayFormSignal(T.beaconParam(hmac, TOKEN, 'button1', 'production'), req, { relayEvents });
    assert.equal(r.results[0].status, 'recorded');
    const s = w.signals();
    assert.equal(s.length, 1);
    assert.deepEqual([s[0].signal, s[0].confidence, s[0].enrollment_id], ['form', 'high', 'e1']);
    assert.ok(w.eng().form_submitted_at);
  } finally { if (prev === undefined) delete process.env.EE_LINK_SECRET; else process.env.EE_LINK_SECRET = prev; }
});
