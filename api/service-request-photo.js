// ══════════════════════════════════════════════════════════════════════════════
// PHOTO UPLOAD for the public service-request page
//
//   POST /api/service-request-photo   { draft_id, data_url, name }  ->  { url }
//
// Public and unauthenticated, so every claim in the request is treated as
// hostile until checked:
//
//   * the file type comes from the BYTES, never from the declared mime type or
//     the filename — a .pdf renamed .jpg does not get through
//   * the size is capped server-side, after decoding, not before
//   * the stored path is SERVER-BUILT from draft_id + a random suffix. The
//     client never chooses where its file lands, so it cannot overwrite another
//     draft's photo or guess one
//
// The draft_id scoping is what the submit endpoint later relies on: it only
// accepts photo URLs under service-requests/<draft_id>/, so a submission cannot
// attach photos belonging to somebody else's request.
//
// Photos are pool photos of private homes. They are never returned by the
// unauthenticated status or prefill endpoints — only the authenticated admin
// console reads them back.
// ══════════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import { put } from '@vercel/blob';
import { sendJson } from './_sheets.js';

const MAX_BYTES = 5 * 1024 * 1024;
const RATE_MAX = 24;                       // 4 photos x a few retries
const RATE_WINDOW_MS = 10 * 60 * 1000;
const hits = new Map();

// Magic-byte sniffing. The declared content-type is attacker-controlled; these
// first bytes are what a decoder will actually act on.
const SIGNATURES = [
  { ext: 'jpg',  mime: 'image/jpeg', test: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { ext: 'png',  mime: 'image/png',  test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  { ext: 'webp', mime: 'image/webp', test: b => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
  { ext: 'heic', mime: 'image/heic', test: b => b.slice(4, 8).toString('ascii') === 'ftyp' &&
      ['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(b.slice(8, 12).toString('ascii')) }
];

function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  return SIGNATURES.find(s => { try { return s.test(buf); } catch (_) { return false; } }) || null;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
}

function rateLimited(ip) {
  const now = Date.now();
  const key = String(ip || 'unknown');
  const list = (hits.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > RATE_MAX;
}

function parseBody(body) {
  if (!body) return {};
  if (Buffer.isBuffer(body)) return parseBody(body.toString('utf8'));
  if (typeof body === 'object') return body;
  try { return JSON.parse(body); } catch (_) { return {}; }
}

// A draft id we generated is [a-z0-9] and short. Anything else is either a bug
// or an attempt to escape the prefix with ../, so it is refused outright rather
// than sanitised into something that looks valid.
function validDraftId(value) {
  return /^[a-z0-9]{8,40}$/.test(String(value || ''));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('allow', 'POST, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST, OPTIONS');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  try {
    if (String(process.env.SERVICE_REQUEST_INTAKE || '').toLowerCase() === 'off') {
      return sendJson(res, 503, { ok: false, error: 'Uploads are paused right now.' });
    }
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      // Photos are optional by design, so a missing store is a soft failure: the
      // page marks the thumbnail failed and the customer can still submit.
      return sendJson(res, 503, { ok: false, error: 'Photo uploads are not available right now.' });
    }
    if (rateLimited(clientIp(req))) {
      return sendJson(res, 429, { ok: false, error: 'Too many uploads. Please wait a moment.' });
    }

    const body = parseBody(req.body);
    const draftId = String(body.draft_id || '');
    if (!validDraftId(draftId)) {
      return sendJson(res, 400, { ok: false, error: 'Missing or invalid draft reference.' });
    }

    const dataUrl = String(body.data_url || '');
    const m = dataUrl.match(/^data:([a-z0-9/+.-]+);base64,(.+)$/i);
    if (!m) return sendJson(res, 400, { ok: false, error: 'That file could not be read.' });

    // Guard on the encoded length first — decoding a huge string to find out it
    // is huge is the allocation an unauthenticated endpoint should not make.
    if (m[2].length > Math.ceil(MAX_BYTES / 3) * 4 + 64) {
      return sendJson(res, 413, { ok: false, error: 'That photo is too large. Please try a smaller one.' });
    }

    let buf;
    try { buf = Buffer.from(m[2], 'base64'); }
    catch (_) { return sendJson(res, 400, { ok: false, error: 'That file could not be read.' }); }

    if (!buf.length) return sendJson(res, 400, { ok: false, error: 'That file is empty.' });
    if (buf.length > MAX_BYTES) {
      return sendJson(res, 413, { ok: false, error: 'That photo is too large. Please try a smaller one.' });
    }

    const kind = sniff(buf);
    if (!kind) {
      return sendJson(res, 415, { ok: false, error: 'Please upload a photo (JPG, PNG, WebP or HEIC).' });
    }

    // Server-built path. The random suffix means a URL cannot be guessed from a
    // draft id, which matters while the store is public.
    const suffix = crypto.randomBytes(9).toString('base64url');
    const key = `service-requests/${draftId}/${Date.now().toString(36)}-${suffix}.${kind.ext}`;

    const blob = await put(key, buf, {
      access: 'public',
      contentType: kind.mime,
      addRandomSuffix: false,
      cacheControlMaxAge: 31536000
    });

    return sendJson(res, 200, { ok: true, url: blob.url, content_type: kind.mime, bytes: buf.length });
  } catch (error) {
    console.error('service-request-photo failed', error);
    return sendJson(res, 500, { ok: false, error: 'We could not save that photo. You can still send your request without it.' });
  }
}
