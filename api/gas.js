import { appsScriptUrl } from './_sheets.js';

function parseBody(body) {
  if (!body) return {};
  if (Buffer.isBuffer(body)) return parseBody(body.toString('utf8'));
  if (typeof body === 'object') return body;
  try {
    return JSON.parse(body);
  } catch (_) {
    return body;
  }
}

function sendUpstream(res, status, contentType, body) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', contentType || 'application/json; charset=utf-8');
  return res.status(status).send(body);
}

function looksLikeHtml(contentType, body) {
  return String(contentType || '').toLowerCase().includes('text/html')
    || String(body || '').trimStart().toLowerCase().startsWith('<!doctype')
    || String(body || '').trimStart().toLowerCase().startsWith('<html');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('allow', 'GET, POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const upstreamUrl = new URL(appsScriptUrl());
    const init = { method: req.method, redirect: 'follow' };

    if (req.method === 'GET') {
      Object.entries(req.query || {}).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        if (Array.isArray(value)) {
          value.forEach(item => upstreamUrl.searchParams.append(key, item));
        } else {
          upstreamUrl.searchParams.set(key, value);
        }
      });
    } else {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(parseBody(req.body));
    }

    const upstream = await fetch(upstreamUrl.toString(), init);
    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';

    if (looksLikeHtml(contentType, text)) {
      console.error('Apps Script returned HTML', {
        status: upstream.status,
        action: req.method === 'GET' ? req.query?.action : parseBody(req.body)?.action,
        preview: text.slice(0, 200)
      });
      return res.status(502).json({
        ok: false,
        error: 'Apps Script returned HTML instead of JSON',
        status: upstream.status
      });
    }

    return sendUpstream(res, upstream.status, contentType, text);
  } catch (error) {
    console.error('Apps Script proxy failed', error);
    return res.status(502).json({
      ok: false,
      error: error.message || 'Apps Script proxy failed'
    });
  }
}
