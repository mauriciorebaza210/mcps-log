// Local dev server for the service-request feature.
//
//   node scripts/dev-service-request.mjs          → http://localhost:3999/service
//
// `vercel dev` cannot start in this repo: a requirements.txt at the root makes
// the CLI treat the project as Python, and the build fails before any route is
// served. That is a pre-existing repo/CLI issue unrelated to this feature, so
// rather than change project-wide config to work around it, this serves the two
// pages and their endpoints directly.
//
// It mimics only what the handlers actually use from Vercel's req/res: query,
// parsed body, status().send(), setHeader(). Nothing here ships to production.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env.local'), override: true, quiet: true });
if (!process.env.SERVICE_LINK_SECRET) process.env.SERVICE_LINK_SECRET = 'local-dev-secret';

const PORT = Number(process.env.PORT || 3999);

const ROUTES = {
  '/service': '/service-request.html',
  '/service-requests': '/service-requests.html'
};

const API = {
  '/api/service-request': () => import('../api/service-request.js'),
  '/api/service-request-photo': () => import('../api/service-request-photo.js'),
  '/api/service-requests/review': () => import('../api/service-requests/review.js')
};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp'
};

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { resolve({}); }
    });
  });
}

// The shape the handlers expect from Vercel: res.status(n).send(body).
function shim(res) {
  return {
    _status: 200,
    setHeader: (k, v) => res.setHeader(k, v),
    status(code) { this._status = code; return this; },
    send(body) { res.writeHead(this._status); res.end(body); return this; },
    json(body) { res.setHeader('content-type', 'application/json'); res.writeHead(this._status); res.end(JSON.stringify(body)); return this; },
    end() { res.writeHead(this._status); res.end(); return this; }
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const started = Date.now();
  const log = code => console.log(`  ${String(code).padEnd(3)} ${req.method.padEnd(4)} ${pathname}${url.search}  ${Date.now() - started}ms`);

  if (API[pathname]) {
    try {
      const mod = await API[pathname]();
      const query = Object.fromEntries(url.searchParams);
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = shim(res);
      await mod.default(
        { method: req.method, url: req.url, query, body,
          headers: { ...req.headers, 'x-forwarded-for': '127.0.0.1' },
          socket: req.socket },
        out
      );
      log(out._status);
    } catch (e) {
      console.error(`  500 ${req.method} ${pathname}\n`, e);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
    return;
  }

  const rel = ROUTES[pathname] || pathname;
  const file = path.join(ROOT, rel === '/' ? '/index.html' : rel);
  // Never serve outside the repo, even in dev.
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }

  fs.readFile(file, (err, data) => {
    if (err) { log(404); res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
    log(200);
  });
});

server.listen(PORT, () => {
  console.log(`\n  service-request dev server\n`);
  console.log(`    customer page   http://localhost:${PORT}/service`);
  console.log(`    review console  http://localhost:${PORT}/service-requests`);
  console.log(`    status view     http://localhost:${PORT}/service?r=SR-XXXXXXXX\n`);
});
