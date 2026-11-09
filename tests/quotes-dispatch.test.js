// api/quotes/index.js: the three quote endpoints behind one Vercel Function
// (Hobby's 12-function cap). The URLs must not change: vercel.json rewrites
// /api/quotes/<op> to /api/quotes?op=<op>, and each op must reach its own
// handler. Checked without touching Sheets: each handler's method guard answers
// before any session or sheet read.
//
//   node tests/quotes-dispatch.test.js
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('✔ ' + name); } catch (e) { failed++; console.error('✖ ' + name + '\n  ' + e.message); } };
function fakeRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.status = c => { r.statusCode = c; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.json = b => { r.body = b; return r; };
  r.send = b => { r.body = typeof b === 'string' ? JSON.parse(b) : b; return r; };
  r.end = b => { if (b) r.body = JSON.parse(b); return r; };
  return r;
}

(async () => {
  const { default: handler } = await import(path.join(ROOT, 'api', 'quotes', 'index.js'));
  const call = async (op, method) => { const res = fakeRes(); await handler({ method, query: { op }, body: {} }, res); return res; };

  await t('rewrite keeps the old URLs, ahead of the catch-all', () => {
    const rw = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).rewrites;
    const i = rw.findIndex(r => r.source === '/api/quotes/:op' && r.destination === '/api/quotes?op=:op');
    assert.ok(i >= 0, 'missing /api/quotes/:op rewrite');
    assert.ok(i < rw.findIndex(r => r.source === '/api/:path*'), 'must come before /api/:path*');
  });
  await t('one function file for quotes', () => {
    assert.deepEqual(fs.readdirSync(path.join(ROOT, 'api', 'quotes')).filter(f => !f.startsWith('_')), ['index.js']);
  });
  await t('get is GET-only (reaches the get handler)', async () => assert.equal((await call('get', 'POST')).statusCode, 405));
  await t('save is POST-only (reaches the save handler)', async () => assert.equal((await call('save', 'GET')).statusCode, 405));
  await t('update is POST-only (reaches the update handler)', async () => assert.equal((await call('update', 'GET')).statusCode, 405));
  await t('get without a session is refused', async () => assert.equal((await call('get', 'GET')).statusCode, 401));
  await t('unknown op is a 404, not a fallthrough', async () => {
    const r = await call('delete', 'POST');
    assert.equal(r.statusCode, 404);
  });
  if (failed) { console.error(failed + ' failed'); process.exit(1); }
})();
