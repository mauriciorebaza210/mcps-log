// Signed relay from api/email.js to the Lifecycle Email Engine's web app
// (email-engine/src/Main.js → EE_relay_), which runs as Tony in its own Apps
// Script project.
//
// Same scheme as api/_lib/notify.js ↔ appscript/ServiceRequestNotify.js:
// HMAC-SHA256 over the exact body, sent as ?sig= (Apps Script's doPost can't
// read headers), plus a timestamp and a nonce so a captured request can't be
// replayed. The body is pure ASCII (see asciiJson in notify.js for why).
import crypto from 'node:crypto';

export function relayConfig() {
  return {
    url: String(process.env.EE_ENGINE_WEBAPP_URL || '').trim(),
    secret: String(process.env.EE_RELAY_SECRET || '').trim()
  };
}

function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

// events: [{event_id, type, token, link_id, mode, method, ua, ip_hash, received_at}]
// → {ok, results} from the engine, or {ok:false, error}. Never throws.
export async function relayEvents(events, cfg = relayConfig(), fetchImpl = fetch) {
  if (!cfg.url || !cfg.secret) return { ok: false, error: 'relay not configured' };
  const body = asciiJson({ action: 'ee_track', events, ts: Date.now(), nonce: crypto.randomUUID() });
  const sig = crypto.createHmac('sha256', cfg.secret).update(body).digest('hex');
  try {
    const res = await fetchImpl(cfg.url + (cfg.url.includes('?') ? '&' : '?') + 'sig=' + sig, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'follow'
    });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (_) { return { ok: false, error: 'engine returned non-JSON: ' + text.slice(0, 120) }; }
  } catch (e) {
    return { ok: false, error: 'relay failed: ' + String(e && e.message || e) };
  }
}
