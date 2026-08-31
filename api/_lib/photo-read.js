// ══════════════════════════════════════════════════════════════════════════════
// PHOTO READ — authenticated proxy for private blobs
//
//   GET /api/service-requests/photo?pathname=service-requests/<draft>/<file>
//
// Customer photos live in a PRIVATE blob store, so there is no URL an <img> can
// point at. This streams the bytes back to an admin who presents a valid portal
// session, and to nobody else.
//
// Why a proxy rather than a presigned URL: a presigned URL is a bearer token in
// a query string that stays valid until it expires, and it would end up in the
// console's DOM, in browser history and in any log that records URLs. Checking
// the session on every read costs one function call and leaks nothing.
//
// The console cannot simply set <img src> to this, because that would put the
// session token in the URL. It fetches with the token in a header and converts
// the response to an object URL instead.
// ══════════════════════════════════════════════════════════════════════════════

import { get } from '@vercel/blob';
import { sendJson } from '../_sheets.js';

// Exactly the shape api/service-request-photo.js generates. Anything else is
// either a bug or an attempt to read a different part of the store.
const PATHNAME = /^service-requests\/[a-z0-9]{8,40}\/[A-Za-z0-9._-]{1,80}$/;

const CONTENT_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', heic: 'image/heic'
};

export async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('allow', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET, OPTIONS');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  try {
    // Auth already enforced by the dispatcher in api/service-request.js, which
    // is the single gate for every admin op. req.session is what it resolved.
    const session = req.session;

    const pathname = String((req.query && req.query.pathname) || '').trim();
    if (!PATHNAME.test(pathname)) {
      return sendJson(res, 400, { ok: false, error: 'Invalid photo reference.' });
    }
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return sendJson(res, 503, { ok: false, error: 'Photo storage is not configured.' });
    }

    const result = await get(pathname, { access: 'private' });
    if (!result) return sendJson(res, 404, { ok: false, error: 'Photo not found.' });

    const ext = pathname.split('.').pop().toLowerCase();
    res.setHeader('content-type', CONTENT_TYPES[ext] || 'application/octet-stream');
    // Private by every hop: never a shared cache, and never an inline document.
    res.setHeader('cache-control', 'private, max-age=300');
    res.setHeader('content-disposition', 'inline');
    res.setHeader('x-content-type-options', 'nosniff');
    res.status(200);

    const body = result.stream || result.body || result;
    if (body && typeof body.pipe === 'function') return body.pipe(res);
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    }
    return res.end(Buffer.from(await new Response(body).arrayBuffer()));
  } catch (error) {
    console.error('service-requests/photo failed', error);
    // A missing blob is the common case and must not read as a server fault.
    if (String(error && error.name) === 'BlobNotFoundError') {
      return sendJson(res, 404, { ok: false, error: 'Photo not found.' });
    }
    return sendJson(res, 500, { ok: false, error: 'Could not load that photo.' });
  }
}
