import { appsScriptUrl } from './_sheets.js';

// ⚠️ WITHOUT THIS, SLOW ACTIONS LOOK LIKE FAILURES. generate_proposal renders an
// HTML->PDF through Drive and routinely takes 30-90s; save_quote fans out across
// six tabs and can take ~80s. This function had no maxDuration, so it inherited
// the account default and died first — leaving the browser with a pending fetch
// forever while Apps Script quietly finished the work. Operators read that as
// "nothing happened", clicked again, and duplicated the output.
//
// Apps Script's own ceiling is 6 minutes, so match it and let the upstream be
// the thing that decides. Plans that cap lower will clamp this down; the
// explicit timeout below still turns a cutoff into a real error instead of a
// hang, so behaviour degrades to a clear message rather than silence.
export const config = { maxDuration: 300 };

const UPSTREAM_TIMEOUT_MS = 290_000;

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

    // An abort gives us a named failure we can explain, instead of the platform
    // killing the invocation and the client seeing a dead socket.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
    init.signal = abort.signal;

    let upstream, text;
    try {
      upstream = await fetch(upstreamUrl.toString(), init);
      text = await upstream.text();
    } finally {
      clearTimeout(timer);
    }
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
    // ⚠️ A timeout here is NOT proof the action failed. Apps Script keeps running
    // after we stop listening, so telling the operator "it failed" is what made
    // people re-click and duplicate PDFs and emails. Say what is actually known.
    if (error.name === 'AbortError') {
      return res.status(504).json({
        ok: false,
        timeout: true,
        error: 'Google did not respond in time. The action may still have completed — ' +
               'refresh and check before trying again.'
      });
    }
    return res.status(502).json({
      ok: false,
      error: error.message || 'Apps Script proxy failed'
    });
  }
}
