// "Request a change" (api/_lib/change-requests.js through api/email.js op=request):
// saved privately with its screenshot and files, emailed to Mau from the portal's
// Gmail, listed for anyone with Lifecycle access, marked done only with edit_config.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JPG = 'data:image/jpeg;base64,' + Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4]).toString('base64');
const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(8)]).toString('base64');
const FAKE_PNG = 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
const SHEET = {
  Permissions: [['username', 'roles', 'active'], ['mau', 'editor,approver,operator', 'Y'], ['tony', 'editor,operator', 'Y'], ['viewer1', 'viewer', 'Y']],
  Config: [['key', 'value'], ['engine_mode', 'test'], ['track_base', 'https://preview.example']]
};

function fakeBlob() {
  const store = new Map();
  return {
    store,
    put: async (p, data, o) => { if (store.has(p) && !o.allowOverwrite) throw new Error('exists'); store.set(p, { data: Buffer.isBuffer(data) ? data : Buffer.from(data), type: o.contentType, access: o.access }); return { pathname: p }; },
    get: async p => store.has(p) ? { stream: new Response(store.get(p).data).body } : null,
    list: async ({ prefix }) => ({ blobs: [...store.keys()].filter(k => k.startsWith(prefix)).map(pathname => ({ pathname })), hasMore: false })
  };
}
async function setup(over = {}) {
  process.env.EE_ENGINE_SS_ID = 'sheet-under-test';
  const { createEmailHandler } = await import(path.join(ROOT, 'api', 'email.js'));
  const blob = fakeBlob(), mails = [];
  const h = createEmailHandler({
    validatePortalSession: async t => ({ 'tok-mau': { username: 'mau' }, 'tok-tony': { username: 'tony' }, 'tok-viewer': { username: 'viewer1' }, 'tok-x': { username: 'stranger' } })[t] || null,
    readSheetRanges: async tabs => { const o = {}; tabs.forEach(t => { if (SHEET[t]) o[t] = SHEET[t]; }); return o; },
    getCached: async (k, ttl, f) => f(), blob, blobReady: () => true, now: () => Date.parse('2026-11-12T03:00:00Z'),
    changeRequestTo: () => 'mauricio@mcpoolsolutions.org',
    sendChangeRequest: async (to, mail, key) => { mails.push({ to, mail, key }); return { ok: true }; }, ...over
  });
  const call = async ({ method = 'GET', token = 'tok-tony', body, query = {} } = {}) => {
    const res = { statusCode: 0, headers: {}, body: null, raw: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; }; res.status = c => { res.statusCode = c; return res; };
    res.send = b => { res.raw = b; try { res.body = JSON.parse(b); } catch (_) { res.body = null; } return res; };
    await h({ method, query: { op: 'request', ...query }, headers: { authorization: 'Bearer ' + token }, body }, res);
    return res;
  };
  return { call, blob, mails };
}
const CONTEXT = { tab: 'campaigns', campaign: 'MCP Legacy', view: 'calendar', url: 'https://preview.example/#lifecycle', evil: '<x>',
  target: { selector: 'button[data-act="cmp-batch"][data-id="B"]', text: 'Start a batch', tag: 'button' } };

test('Send: saved privately (note, screenshot, real images/PDFs only), Mau emailed with where it was made', async () => {
  const { call, blob, mails } = await setup();
  const r = await call({ method: 'POST', body: { text: 'Can the Intro go out on Tuesdays?', context: CONTEXT, screenshot: JPG,
    files: [{ name: 'idea.png', data: PNG }, { name: 'sneaky.png', data: FAKE_PNG }] } });
  assert.equal(r.statusCode, 200); assert.equal(r.body.ok, true); assert.equal(r.body.emailed, true);
  const keys = [...blob.store.keys()].sort();
  assert.deepEqual(keys.map(k => k.split('/').pop()), ['file-0.png', 'request.json', 'shot.jpg'], 'the fake PNG (not an image) is dropped');
  assert.ok([...blob.store.values()].every(v => v.access === 'private'));
  const rec = JSON.parse(blob.store.get(keys.find(k => k.endsWith('request.json'))).data);
  assert.equal(rec.user, 'tony'); assert.equal(rec.context.evil, undefined, 'only known context fields are kept');
  assert.equal(mails.length, 1); assert.equal(mails[0].to, 'mauricio@mcpoolsolutions.org');
  assert.match(mails[0].mail.subject, /^Change request from tony: Can the Intro go out on Tuesdays\?/);
  assert.match(mails[0].mail.text, /Where: Campaigns › MCP Legacy › Calendar/);
  assert.match(mails[0].mail.text, /Pointed at: Start a batch/);
  assert.match(mails[0].mail.html, /https:\/\/preview\.example\/#lifecycle/);
  assert.equal(mails[0].key, 'ee-change:' + rec.id);
});

test('Send: an empty note is refused; files over 3 MB together are refused; a failed email still saves the request', async () => {
  const { call, blob } = await setup();
  assert.equal((await call({ method: 'POST', body: { text: '   ' } })).statusCode, 400);
  const big = 'data:application/pdf;base64,' + Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2 * 1024 * 1024)]).toString('base64');
  assert.equal((await call({ method: 'POST', body: { text: 'x', files: [{ name: 'a.pdf', data: big }, { name: 'b.pdf', data: big }] } })).statusCode, 413);
  const down = await setup({ sendChangeRequest: async () => ({ ok: false, skipped: 'no SERVICE_REQUEST_NOTIFY_SECRET configured' }) });
  const r = await down.call({ method: 'POST', body: { text: 'hello' } });
  assert.deepEqual([r.body.ok, r.body.emailed], [true, false]);
  assert.equal((await down.call()).body.requests.length, 1, 'saved and listed even without the email');
});

test('List, view a file, mark done: access rules hold', async () => {
  const { call } = await setup();
  await call({ method: 'POST', body: { text: 'First', context: CONTEXT, screenshot: JPG } });
  assert.equal((await call({ token: 'tok-x' })).statusCode, 403, 'no Lifecycle access, no requests');
  const list = (await call({ token: 'tok-viewer' })).body.requests;
  assert.equal(list.length, 1); assert.equal(list[0].where, 'Campaigns › MCP Legacy › Calendar'); assert.equal(list[0].status, 'open');
  const f = await call({ token: 'tok-viewer', query: { file: list[0].shot } });
  assert.equal(f.statusCode, 200); assert.equal(f.headers['content-type'], 'image/jpeg');
  assert.equal((await call({ query: { file: 'service-requests/abc/x.jpg' } })).statusCode, 400, 'only change-request files');
  assert.equal((await call({ method: 'POST', token: 'tok-viewer', body: { done: list[0].id } })).statusCode, 403);
  assert.equal((await call({ method: 'POST', token: 'tok-mau', body: { done: list[0].id } })).statusCode, 200);
  const after = (await call()).body.requests[0];
  assert.deepEqual([after.status, after.done_by], ['done', 'mau']);
});

test('The page routes its help/request actions (no dead buttons)', () => {
  const src = require('fs').readFileSync(path.join(ROOT, 'js/features/lifecycle.js'), 'utf8');
  assert.match(src, /act\.startsWith\('help'\) && typeof hlpAct_ === 'function'/);
  assert.match(src, /act\.startsWith\('rq-'\) && typeof rqAct_ === 'function'/);
  const html = require('fs').readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /lifecycle-help\.js/, 'loaded on the portal');
});
