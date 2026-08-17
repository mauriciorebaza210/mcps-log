import { appsScriptUrl } from '../_sheets.js';

// Thin proxy for the public in-portal e-signature. Its one job beyond forwarding
// to Apps Script is to capture the signer's IP address server-side (the browser
// cannot set it and GAS doPost cannot read it) so the ESIGN/UETA audit trail on
// the Service_Agreements row is complete.

function parseBody(body) {
  if (!body) return {};
  if (Buffer.isBuffer(body)) return parseBody(body.toString('utf8'));
  if (typeof body === 'object') return body;
  try { return JSON.parse(body); } catch (_) { return {}; }
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || '';
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.setHeader('allow', 'POST, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const payload = parseBody(req.body) || {};

    // ⚠️ WHITELIST, not passthrough. This endpoint is public, so it must never
    // forward an arbitrary `action` — that would turn the signing proxy into an
    // unauthenticated gateway to every route in the Apps Script backend.
    //
    // It also cannot hard-code sign_agreement any more: an amendment token routed
    // to the original path would activate the customer a second time, mint another
    // pool_id and re-send the welcome email. The page tells us which of the two it
    // is, from the server-issued `sign_action` on the approval payload.
    const requested = String(payload.action || 'sign_agreement');
    if (requested !== 'sign_agreement' && requested !== 'sign_amendment') {
      return res.status(400).json({ ok: false, error: 'Unsupported signing action.' });
    }
    payload.action = requested;

    payload.signer_ip = clientIp(req);
    if (!payload.signer_user_agent) payload.signer_user_agent = req.headers['user-agent'] || '';

    const upstream = await fetch(appsScriptUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'follow',
      body: JSON.stringify(payload)
    });
    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';

    if (String(contentType).toLowerCase().includes('text/html') ||
        String(text || '').trimStart().toLowerCase().startsWith('<')) {
      console.error('agreement/sign: Apps Script returned HTML', { status: upstream.status, preview: text.slice(0, 200) });
      return res.status(502).json({ ok: false, error: 'Apps Script returned HTML instead of JSON' });
    }

    res.setHeader('content-type', contentType);
    return res.status(upstream.status).send(text);
  } catch (error) {
    console.error('agreement/sign proxy failed', error);
    return res.status(502).json({ ok: false, error: error.message || 'Sign proxy failed' });
  }
}
