// Per-person sender suite: registry → locking → signed round-trip.
//
//   node tests/comms-per-person-sender.test.js
//
// Campaign mail leaves from the creating staff member's own Gmail account, via a
// sender web app they deploy themselves. That splits the system across TWO Apps
// Script projects that are deployed separately and can drift apart silently, so
// this suite loads BOTH — appscript/CommsSenders.js and sender-script/Code.gs —
// into one process and runs real signed requests between them.
//
// What is actually being defended:
//   - the two HMAC implementations must agree, forever, byte for byte
//   - a campaign must lock its sender at CREATION; re-resolving mid-send could
//     split one campaign across two mailboxes
//   - no sender mapping must BLOCK, never quietly fall back to the shared
//     mailbox — customer mail under the wrong name is the failure we are paying
//     all this complexity to avoid
//   - a signature must not be replayable, tamperable, or indefinitely reusable
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const COMMS_SRC = path.join(__dirname, '..', 'appscript', 'Comms.js');
const SENDERS_SRC = path.join(__dirname, '..', 'appscript', 'CommsSenders.js');
const SENDER_APP_SRC = path.join(__dirname, '..', 'sender-script', 'Code.gs');

const SECRET = 'test-secret-do-not-use-in-production';
const START = Date.parse('2026-08-17T15:00:00Z');

let pass = 0;
let fail = 0;
function t(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log('  ok - ' + name);
  } else {
    fail += 1;
    console.log('  FAIL - ' + name + (detail ? ' ' + detail : ''));
  }
}

// A clock both projects share, so skew can be driven from the test.
const clock = { now: START };
function makeDate(clockRef) {
  return class extends Date {
    constructor(...args) {
      if (args.length === 0) super(clockRef.now);
      else super(...args);
    }
    static now() { return clockRef.now; }
    static parse(s) { return Date.parse(s); }
  };
}

// GAS hands back SIGNED bytes (-128..127). Reproducing that is the point: the
// classic bug in these hex helpers is forgetting the negative half.
function gasHmacBytes(message, secret) {
  const digest = crypto.createHmac('sha256', String(secret)).update(String(message)).digest();
  return Array.from(digest).map(b => (b > 127 ? b - 256 : b));
}
function referenceHex(message, secret) {
  return crypto.createHmac('sha256', String(secret)).update(String(message)).digest('hex');
}

const gasCommon = () => ({
  console,
  String, Number, Math, JSON, Array, Object, RegExp, Set,
  isNaN, encodeURIComponent, parseInt, parseFloat,
  Logger: { log: () => {} },
  Utilities: {
    getUuid: (() => { let n = 0; return () => 'uuid-' + (++n); })(),
    formatDate: d => new Date(d).toISOString(),
    computeHmacSha256Signature: (msg, key) => gasHmacBytes(msg, key)
  }
});

// ─── The sender side: sender-script/Code.gs as its own project ───────────────
function buildSenderApp(opts = {}) {
  const props = Object.assign({ MCPS_SENDER_SECRET: SECRET }, opts.props || {});
  const nonces = new Map();
  const sent = [];

  const ctx = Object.assign(gasCommon(), {
    Date: makeDate(clock),
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props[k] === undefined ? null : props[k]),
        setProperty: (k, v) => { props[k] = String(v); }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => (nonces.has(k) ? nonces.get(k) : null),
        put: (k, v) => { nonces.set(k, v); }
      })
    },
    GmailApp: {
      sendEmail: (to, subject, body, options) => { sent.push({ to, subject, body, options }); }
    },
    MailApp: { getRemainingDailyQuota: () => 1400 },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => opts.deployedAs || 'tony@mcpoolsolutions.org' })
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ _text: text, setMimeType() { return this; } })
    }
  });
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SENDER_APP_SRC, 'utf8'), ctx, { filename: 'sender-script/Code.gs' });
  return { ctx, sent, props, nonces };
}

// ─── The portal side, wired to call a real sender app over the fake network ──
function buildPortal(opts = {}) {
  const senderApp = opts.senderApp || buildSenderApp();
  const fetches = [];

  const ctx = Object.assign(gasCommon(), {
    Date: makeDate(clock),
    SpreadsheetApp: { getActiveSpreadsheet: () => null, openById: () => null },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {}, removeAll: () => {} }) },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create: () => {} }), after: () => ({ create: () => {} }), at: () => ({ create: () => {} }) }) }),
      deleteTrigger: () => {}
    },
    MailApp: { getRemainingDailyQuota: () => 1500, sendEmail: () => { throw new Error('shared mailbox must not send here'); } },
    GmailApp: { getAliases: () => [], sendEmail: () => { throw new Error('shared mailbox must not send here'); } },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => 'portal@mcpoolsolutions.org' }),
      getActiveUser: () => ({ getEmail: () => '' }),
      getScriptTimeZone: () => 'America/Chicago'
    },
    huHeader_: h => String(h == null ? '' : h).trim().toLowerCase().replace(/ /g, '_'),
    PropertiesService: {
      getScriptProperties: () => {
        const p = Object.assign({ COMMS_SENDER_SECRET: SECRET }, opts.props || {});
        return {
          getProperty: k => (p[k] === undefined ? null : p[k]),
          setProperty: () => {}, deleteProperty: () => {}
        };
      }
    },
    // Deliver the signed POST straight into the sender project's doPost.
    UrlFetchApp: {
      fetch: (url, params) => {
        fetches.push({ url, params });
        if (opts.transport) return opts.transport(url, params);
        const sig = (String(url).split('sig=')[1] || '').split('&')[0];
        const out = senderApp.ctx.doPost({
          postData: { contents: params.payload },
          parameter: { sig: opts.tamperSig ? opts.tamperSig(sig) : sig }
        });
        return { getResponseCode: () => 200, getContentText: () => out._text };
      }
    }
  });
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(COMMS_SRC, 'utf8'), ctx, { filename: 'Comms.js' });
  vm.runInContext(fs.readFileSync(SENDERS_SRC, 'utf8'), ctx, { filename: 'CommsSenders.js' });

  ctx.commsSheetRows_ = key => (opts.rows && opts.rows[key]) || [];
  ctx.commsEnsureSheets_ = () => {};
  return { ctx, senderApp, fetches };
}

const ROW = (over = {}) => Object.assign({
  username: 'tony', sender_email: 'tony@mcpoolsolutions.org', sender_name: 'Tony — MCPS',
  sender_script_url: 'https://script.google.com/macros/s/AKfycbxABC123_-/exec', active: 'TRUE'
}, over);

console.log('\nHMAC parity across the two projects');
{
  const portal = buildPortal();
  const sender = buildSenderApp();
  const cases = [
    '{"to":"a@b.com"}',
    '', // empty
    JSON.stringify({ subject: 'Ünïcødé — “smart” quotes', body: '<p>é</p>' }),
    'x'.repeat(5000)
  ];
  let allMatch = true;
  let matchesReference = true;
  cases.forEach(msg => {
    const a = portal.ctx.commsHmacHex_(SECRET, msg);
    const b = sender.ctx.hmacHex_(SECRET, msg);
    if (a !== b) allMatch = false;
    if (a !== referenceHex(msg, SECRET)) matchesReference = false;
  });
  t('portal and sender hex agree on every payload shape', allMatch);
  t('and both match a real HMAC-SHA256 reference', matchesReference);
  t('output is lowercase hex of the right length',
    /^[0-9a-f]{64}$/.test(portal.ctx.commsHmacHex_(SECRET, 'abc')));
  t('negative signed bytes are encoded, not dropped',
    portal.ctx.commsHmacHex_(SECRET, 'abc') === referenceHex('abc', SECRET));
}

console.log('\nRegistry resolution');
{
  const { ctx } = buildPortal({ rows: { senders: [ROW()] } });
  const r = ctx.commsResolveSender_({ username: 'tony' });
  t('resolves an active row', r.ok === true && r.sender.sender_email === 'tony@mcpoolsolutions.org');
  t('matches the username case-insensitively',
    ctx.commsResolveSender_({ username: 'TONY' }).ok === true);
}

{
  const { ctx } = buildPortal({ rows: { senders: [ROW()] } });
  const r = ctx.commsResolveSender_({ username: 'mau' });
  t('an unmapped user is blocked', r.ok === false);
  t('and told exactly what to do', r.error.indexOf('Comms_Senders') !== -1, '→ ' + r.error);
}

{
  const { ctx } = buildPortal({ rows: { senders: [ROW({ active: 'FALSE' })] } });
  const r = ctx.commsResolveSender_({ username: 'tony' });
  t('a deactivated sender is blocked', r.ok === false);
  t('with a different message than "not configured"',
    r.error.indexOf('switched off') !== -1, '→ ' + r.error);
}

{
  // A typo in the active column must fail closed. Reading it as truthy would
  // authorise someone to send customer mail by accident.
  const bad = ['maybe', '', 'nope', '0', 'FALSE', 'tru'];
  const allBlocked = bad.every(v =>
    buildPortal({ rows: { senders: [ROW({ active: v })] } })
      .ctx.commsResolveSender_({ username: 'tony' }).ok === false);
  t('an unrecognised `active` value fails closed', allBlocked);
  const good = [true, 'TRUE', 'true', 'yes', 'Y', '1', 'active'];
  const allOk = good.every(v =>
    buildPortal({ rows: { senders: [ROW({ active: v })] } })
      .ctx.commsResolveSender_({ username: 'tony' }).ok === true);
  t('and the documented truthy spellings all work', allOk);
}

{
  const { ctx } = buildPortal({ rows: { senders: [ROW({ sender_email: 'not-an-email' })] } });
  t('an invalid sender_email is caught at resolve time',
    ctx.commsResolveSender_({ username: 'tony' }).error.indexOf('invalid sender_email') !== -1);
}

{
  const urls = [
    'https://example.com/exec',
    'https://script.google.com/macros/s/ABC/dev',   // dev URL: runs as the CALLER
    'http://script.google.com/macros/s/ABC/exec',   // not https
    ''
  ];
  const allRejected = urls.every(u =>
    buildPortal({ rows: { senders: [ROW({ sender_script_url: u })] } })
      .ctx.commsResolveSender_({ username: 'tony' }).ok === false);
  t('non-deployment URLs are rejected (including /dev)', allRejected);
  t('a Workspace-domain /exec URL is accepted',
    buildPortal({ rows: { senders: [ROW({ sender_script_url: 'https://script.google.com/a/macros/mcpoolsolutions.org/s/AKfycbx_-1/exec' })] } })
      .ctx.commsResolveSender_({ username: 'tony' }).ok === true);
}

{
  const { ctx } = buildPortal({ rows: { senders: [ROW()] } });
  t('a session with no username is blocked',
    ctx.commsResolveSender_({}).ok === false);
}

console.log('\nSender is locked at campaign creation');
function campaignHarness(rows) {
  const h = buildPortal({ rows });
  const appended = [];
  h.ctx.commsAppendRow_ = (key, obj) => { appended.push({ key, obj }); };
  h.ctx.commsAppendRows_ = () => {};
  h.ctx.commsEnsureGuardTrigger_ = () => {};
  h.ctx.commsScheduleSweep_ = () => {};
  h.ctx.commsRecomputeWake_ = () => {};
  h.ctx.resolveCommsAudience_ = () => ({
    ok: true, recipients: [{ email: 'cust@example.com', name: 'Cust', properties: [{}] }]
  });
  return { ...h, appended };
}

{
  const { ctx, appended } = campaignHarness({ senders: [ROW()] });
  const res = ctx.handleCommsSendCampaign_(
    { username: 'tony', name: 'Tony' },
    { name: 'Aug update', subject: 'Hi', body_markup: 'Hello', audience: {} }
  );
  t('campaign is created', res.ok === true);
  const camp = appended.find(a => a.key === 'campaigns').obj;
  t('sender_key is stamped on the campaign row', camp.sender_key === 'tony');
  t('sender_email is stamped', camp.sender_email === 'tony@mcpoolsolutions.org');
  t('sender_script_url is stamped', camp.sender_script_url.indexOf('/exec') !== -1);
}

{
  const { ctx, appended } = campaignHarness({ senders: [ROW()] });
  const res = ctx.handleCommsSendCampaign_(
    { username: 'mau', name: 'Mau' },
    { name: 'Aug update', subject: 'Hi', body_markup: 'Hello', audience: {} }
  );
  t('an unmapped creator cannot start a campaign', res.ok === false);
  t('and NO campaign row is written', appended.length === 0,
    '→ ' + JSON.stringify(appended.map(a => a.key)));
}

{
  // Under resend/zapier the provider is the sender, so per-person Gmail routing
  // must not apply — and must not block sending either.
  const { ctx, appended } = campaignHarness({ senders: [] });
  ctx.commsSendMode_ = () => 'resend';
  const res = ctx.handleCommsSendCampaign_(
    { username: 'nobody' },
    { name: 'x', subject: 'Hi', body_markup: 'Hello', audience: {} }
  );
  t('resend mode does not require a per-person sender', res.ok === true);
  const camp = appended.find(a => a.key === 'campaigns').obj;
  t('and stamps no sender', camp.sender_email === '' && camp.sender_script_url === '');
}

console.log('\nDispatch: a locked campaign always uses its sender script');
{
  const { ctx, fetches } = buildPortal({ rows: { senders: [ROW()] } });
  const out = ctx.sendCommsEmail_({
    to: 'cust@example.com', subject: 'Hi', plainBody: 'body',
    senderEmail: 'tony@mcpoolsolutions.org',
    senderScriptUrl: ROW().sender_script_url
  });
  t('routes to the sender script, not the shared mailbox', out.ok === true && fetches.length === 1);
  t('reports the account that actually sent',
    out.senderEmail === 'tony@mcpoolsolutions.org', '→ ' + out.senderEmail);
}

console.log('\nSigned round-trip, portal → sender');
{
  clock.now = START;
  const senderApp = buildSenderApp();
  const { ctx } = buildPortal({ senderApp, rows: { senders: [ROW()] } });
  const out = ctx.commsSendViaSenderScript_({
    to: 'cust@example.com', subject: 'Real subject', htmlBody: '<p>hi</p>', plainBody: 'hi',
    senderEmail: 'tony@mcpoolsolutions.org', senderName: 'Tony — MCPS',
    senderScriptUrl: ROW().sender_script_url, recipientId: 'r1'
  });
  t('the send succeeds end to end', out.ok === true, '→ ' + out.error);
  t('exactly one email was sent', senderApp.sent.length === 1);
  t('with the rendered subject and html intact',
    senderApp.sent[0].subject === 'Real subject'
    && senderApp.sent[0].options.htmlBody === '<p>hi</p>');
  t('and the configured display name', senderApp.sent[0].options.name === 'Tony — MCPS');
  t('the sender reports its own deployed identity',
    out.senderEmail === 'tony@mcpoolsolutions.org');
}

{
  // The whole security model is this check.
  clock.now = START;
  const senderApp = buildSenderApp();
  const { ctx } = buildPortal({
    senderApp, tamperSig: sig => sig.slice(0, -1) + (sig.slice(-1) === 'a' ? 'b' : 'a')
  });
  const out = ctx.commsSendViaSenderScript_({
    to: 'cust@example.com', subject: 'x', plainBody: 'x',
    senderScriptUrl: ROW().sender_script_url
  });
  t('a tampered signature is refused', out.ok === false);
  t('and nothing is sent', senderApp.sent.length === 0);
  t('with a signature-specific reason', out.error.indexOf('bad signature') !== -1, '→ ' + out.error);
}

{
  clock.now = START;
  const senderApp = buildSenderApp({ props: { MCPS_SENDER_SECRET: 'a-different-secret' } });
  const { ctx } = buildPortal({ senderApp });
  const out = ctx.commsSendViaSenderScript_({
    to: 'c@example.com', subject: 'x', plainBody: 'x', senderScriptUrl: ROW().sender_script_url
  });
  t('mismatched secrets refuse to send', out.ok === false && senderApp.sent.length === 0);
}

{
  clock.now = START;
  const senderApp = buildSenderApp();
  const { ctx } = buildPortal({ senderApp });
  const msg = {
    to: 'c@example.com', subject: 'x', plainBody: 'x', senderScriptUrl: ROW().sender_script_url
  };
  ctx.commsSendViaSenderScript_(msg);
  const capturedBody = ctx.globalThis === ctx ? null : null; // captured via fetches below
  t('first send goes through', senderApp.sent.length === 1);

  // Replay the exact same signed request the portal just made.
  const last = buildPortal({ senderApp });
  const fetchLog = [];
  last.ctx.UrlFetchApp = { fetch: (url, params) => { fetchLog.push({ url, params }); return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' }; } };
  // Re-deliver the original payload straight to the sender.
  const original = senderApp;
  const replayBody = JSON.stringify({
    to: 'c@example.com', subject: 'x', htmlBody: '', plainBody: 'x', replyTo: '',
    senderName: 'Mission Custom Pool Solutions', senderEmail: '', recipientId: '',
    ts: clock.now, nonce: 'fixed-nonce'
  });
  const sig = referenceHex(replayBody, SECRET);
  const first = original.ctx.doPost({ postData: { contents: replayBody }, parameter: { sig } });
  const second = original.ctx.doPost({ postData: { contents: replayBody }, parameter: { sig } });
  t('a validly signed payload is accepted once', JSON.parse(first._text).ok === true);
  t('and refused on replay', JSON.parse(second._text).ok === false
    && JSON.parse(second._text).error.indexOf('replayed nonce') !== -1);
}

{
  // A captured signed request must not stay valid indefinitely.
  clock.now = START;
  const senderApp = buildSenderApp();
  const { ctx } = buildPortal({ senderApp });
  const body = JSON.stringify({ to: 'c@example.com', subject: 'x', plainBody: 'x', ts: START, nonce: 'old-nonce' });
  const sig = referenceHex(body, SECRET);
  clock.now = START + 6 * 60000; // 6 min later
  const res = JSON.parse(senderApp.ctx.doPost({ postData: { contents: body }, parameter: { sig } })._text);
  t('a signature older than the skew window is refused', res.ok === false);
  t('with a staleness reason', res.error.indexOf('stale request') !== -1, '→ ' + res.error);
  t('and nothing is sent', senderApp.sent.length === 0);
  clock.now = START;
}

console.log('\nMisconfiguration is reported in plain language');
{
  const { ctx } = buildPortal({
    transport: () => ({
      getResponseCode: () => 200,
      getContentText: () => '<html><head><title>Sign in</title></head><body>accounts.google.com</body></html>'
    })
  });
  const out = ctx.commsSendViaSenderScript_({
    to: 'c@example.com', subject: 'x', plainBody: 'x', senderScriptUrl: ROW().sender_script_url
  });
  t('a sign-in page is diagnosed as an access setting, not bad JSON',
    out.ok === false && out.error.indexOf('access set to "Anyone"') !== -1, '→ ' + out.error);
}

{
  const { ctx } = buildPortal({ props: { COMMS_SENDER_SECRET: '' } });
  const out = ctx.commsSendViaSenderScript_({
    to: 'c@example.com', subject: 'x', plainBody: 'x', senderScriptUrl: ROW().sender_script_url
  });
  t('a missing portal secret is named explicitly',
    out.ok === false && out.error.indexOf('COMMS_SENDER_SECRET') !== -1);
}

{
  const senderApp = buildSenderApp({ props: { MCPS_SENDER_SECRET: '' } });
  const res = JSON.parse(senderApp.ctx.doPost({ postData: { contents: '{}' }, parameter: { sig: 'x' } })._text);
  t('an unconfigured sender script says so', res.ok === false
    && res.error.indexOf('MCPS_SENDER_SECRET') !== -1, '→ ' + res.error);
}

{
  clock.now = START;
  const senderApp = buildSenderApp();
  const body = JSON.stringify({ subject: 'no recipient', ts: START, nonce: 'n-missing-to' });
  const res = JSON.parse(senderApp.ctx.doPost({
    postData: { contents: body }, parameter: { sig: referenceHex(body, SECRET) }
  })._text);
  t('a payload missing `to` is refused', res.ok === false && res.error.indexOf('missing to/subject') !== -1);
  t('and nothing is sent', senderApp.sent.length === 0);
}

{
  clock.now = START;
  const senderApp = buildSenderApp();
  const body = JSON.stringify({ to: 'c@example.com', subject: 'x', ts: START });
  const res = JSON.parse(senderApp.ctx.doPost({
    postData: { contents: body }, parameter: { sig: referenceHex(body, SECRET) }
  })._text);
  t('a payload with no nonce is refused', res.ok === false && res.error.indexOf('missing nonce') !== -1);
}

console.log('\nSender mismatch is surfaced, not swallowed');
{
  clock.now = START;
  // Script deployed under the wrong account: registry says tony, it sends as mau.
  const senderApp = buildSenderApp({ deployedAs: 'mau@mcpoolsolutions.org' });
  const { ctx } = buildPortal({ senderApp, rows: { senders: [ROW()] } });
  const probe = ctx.handleCommsSenderProbe_(
    { username: 'tony', email: 'admin@mcpoolsolutions.org' }, { username: 'tony' }
  );
  t('the probe still reports success for the send', probe.ok === true);
  t('but flags that the sender does not match the registry', probe.sender_matches === false);
  t('and names both the expected and the actual account',
    probe.expected_sender === 'tony@mcpoolsolutions.org'
    && probe.reported_sender === 'mau@mcpoolsolutions.org');
}

{
  clock.now = START;
  const senderApp = buildSenderApp();
  const { ctx } = buildPortal({ senderApp, rows: { senders: [ROW()] } });
  const probe = ctx.handleCommsSenderProbe_(
    { username: 'tony', email: 'admin@mcpoolsolutions.org' }, { username: 'tony' }
  );
  t('a correctly deployed script matches', probe.ok === true && probe.sender_matches === true);
  t('the probe mails the caller, never a supplied address',
    probe.sent_to === 'admin@mcpoolsolutions.org'
    && senderApp.sent[0].to === 'admin@mcpoolsolutions.org');
}

{
  const { ctx } = buildPortal({ rows: { senders: [ROW()] } });
  const probe = ctx.handleCommsSenderProbe_({ username: 'tony', email: '' }, { username: 'tony' });
  t('a caller with no email address gets a clear refusal',
    probe.ok === false && probe.error.indexOf('no email address') !== -1);
}

console.log('\nProbe-all, the pre-deploy check');
{
  clock.now = START;
  const senderApp = buildSenderApp();
  const { ctx } = buildPortal({ senderApp, rows: { senders: [ROW()] } });
  const out = ctx.commsProbeAllSenders();
  t('probes every active sender', out.ok === true && out.results.length === 1);
  t('mails the operator, not a customer',
    out.probed_as === 'portal@mcpoolsolutions.org'
    && senderApp.sent[0].to === 'portal@mcpoolsolutions.org');
}

{
  clock.now = START;
  // One good, one deployed under the wrong account — the case this must catch.
  const senderApp = buildSenderApp({ deployedAs: 'mau@mcpoolsolutions.org' });
  const { ctx } = buildPortal({
    senderApp,
    rows: { senders: [ROW(), ROW({ username: 'jess', sender_email: 'jess@mcpoolsolutions.org' })] }
  });
  const out = ctx.commsProbeAllSenders();
  t('a mismatched deployment makes the whole run fail', out.ok === false);
  t('and every row is still reported', out.results.length === 2);
  t('naming expected vs actual per person',
    out.results[0].expected === 'tony@mcpoolsolutions.org'
    && out.results[0].actual === 'mau@mcpoolsolutions.org'
    && out.results[0].matches === false);
}

{
  const { ctx } = buildPortal({ rows: { senders: [ROW({ active: 'FALSE' })] } });
  const out = ctx.commsProbeAllSenders();
  t('skips inactive rows and says so', out.ok === false && out.error === 'no active senders');
}

console.log('\nRegistry listing');
{
  const { ctx } = buildPortal({
    rows: { senders: [ROW(), ROW({ username: 'mau', sender_script_url: 'https://example.com/nope' })] }
  });
  const out = ctx.handleCommsListSenders_();
  t('lists every row', out.ok === true && out.senders.length === 2);
  t('flags which URLs are actually deployable',
    out.senders[0].url_valid === true && out.senders[1].url_valid === false);
  t('reports whether the shared secret is set', out.secret_set === true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
