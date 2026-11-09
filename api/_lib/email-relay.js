// Signed relay from api/email.js to the Lifecycle Email Engine's web app
// (email-engine/src/Main.js → EE_relay_), which runs as Tony in its own Apps
// Script project.
//
// Same scheme as api/_lib/notify.js ↔ appscript/ServiceRequestNotify.js:
// HMAC-SHA256 over the exact body, sent as ?sig= (Apps Script's doPost can't
// read headers), plus a timestamp and a nonce so a captured request can't be
// replayed. The body is pure ASCII (see asciiJson in notify.js for why).
import crypto from 'node:crypto';
// UMD: a default import yields module.exports (never createRequire in api/).
import TRACKING from '../../js/lib/email-tracking.js';

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
export function relayEvents(events, cfg = relayConfig(), fetchImpl = fetch) {
  return relayCall({ action: 'ee_track', events }, cfg, fetchImpl);
}
// admin: {action, params, actor}: actor is the validated portal username (Admin.js).
export function relayAdmin(admin, cfg = relayConfig(), fetchImpl = fetch) {
  return relayCall({ action: 'ee_admin', admin }, cfg, fetchImpl);
}
async function relayCall(payload, cfg, fetchImpl) {
  if (!cfg.url || !cfg.secret) return { ok: false, error: 'relay not configured' };
  const body = asciiJson({ ...payload, ts: Date.now(), nonce: crypto.randomUUID() });
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

// A service request submitted from a lifecycle email's landing page: the form
// carries the signed beacon value (js/service-request.js), which becomes a
// `form` stop signal for that email's sequence. Best effort and never throws:
// the customer's request is already saved by the time this runs.
export async function relayFormSignal(ee, req, deps = {}) {
  const secret = String(process.env.EE_LINK_SECRET || '').trim();
  if (!ee || !secret) return { ok: false, skipped: 'no beacon or not configured' };
  const hmacHex = m => crypto.createHmac('sha256', secret).update(m).digest('hex');
  const v = TRACKING.verifyBeacon(ee, hmacHex);
  if (!v.ok) return { ok: false, skipped: v.reason };
  const event = { event_id: crypto.randomUUID(), type: 'form', token: v.token, link_id: v.link_id, mode: v.mode,
    method: 'POST', ua: String((req.headers && req.headers['user-agent']) || '').slice(0, 300), received_at: Date.now(), source: 'service_request' };
  return (deps.relayEvents || relayEvents)([event]);
}
