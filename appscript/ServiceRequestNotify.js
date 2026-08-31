// ── Service-request notifications ────────────────────────────────────────────
//
// An authenticated send relay for the service-request page (/service on the
// portal, api/service-request.js on the Vercel side).
//
// WHY THIS EXISTS: Vercel has no mail of its own, and MCPS sends everything
// through GmailApp from this script (COMMS_SEND_MODE = gmail). So when a
// customer submits a request, the receipt to them and the alert to the office
// have to come back through here.
//
// The relay is deliberately DUMB. Vercel builds the subject, the HTML and the
// plain text; this only verifies and sends. That keeps email copy on the side
// that can be changed without a clasp push and a redeploy.
//
// ⚠️ AUTHENTICATION IS THE SIGNATURE, NOT A SESSION. There is no portal user
// behind a customer's submission, so this cannot use validateToken(). It uses
// the same scheme as commsSendViaSenderScript_ / sender-script/Code.gs:
// HMAC-SHA256 over the exact request body, a timestamp skew window, and a nonce
// cache. Without the last two a captured request is replayable forever and this
// becomes an open send relay wearing the company's name.
//
// SETUP: set SERVICE_REQUEST_NOTIFY_SECRET in this script's properties and in
// the Vercel project's environment. Until it is set here, every call is refused
// and the Vercel side logs and carries on — the request is already saved and
// already visible in the review queue.

var SRN_SECRET_PROP = 'SERVICE_REQUEST_NOTIFY_SECRET';
var SRN_MAX_SKEW_MS = 5 * 60 * 1000;
var SRN_NONCE_TTL_S = 6 * 60 * 60;
var SRN_FROM_NAME = 'Mission Custom Pool Solutions';

// Bounded so a bug on the calling side cannot turn into a mail run.
var SRN_MAX_RECIPIENTS = 5;

function srnHmacHex_(secret, message) {
  var raw = Utilities.computeHmacSha256Signature(String(message), String(secret));
  var out = '';
  for (var i = 0; i < raw.length; i++) {
    var b = raw[i] < 0 ? raw[i] + 256 : raw[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

// Length-independent compare. The values are fixed-length hex, so a mismatch
// here means forgery rather than a malformed request, but constant time costs
// nothing and removes the question.
function srnTimingSafeEqual_(a, b) {
  var x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  var diff = 0;
  for (var i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function srnValidEmail_(value) {
  return /^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/.test(String(value || '').trim());
}

/**
 * doPost handler. `e` is needed for the raw body and the `sig` query parameter,
 * so this takes the event rather than the parsed payload.
 * Returns a plain object; the router wraps it in jsonResponse_.
 */
function handleServiceRequestNotify_(e) {
  try {
    var secret = PropertiesService.getScriptProperties().getProperty(SRN_SECRET_PROP);
    if (!secret) return { ok: false, error: 'Notifications are not configured (' + SRN_SECRET_PROP + ' is unset).' };

    var raw = (e && e.postData && e.postData.contents) || '';
    if (!raw) return { ok: false, error: 'Empty body.' };

    var sig = (e && e.parameter && e.parameter.sig) || '';
    if (!sig || !srnTimingSafeEqual_(sig, srnHmacHex_(secret, raw))) {
      return { ok: false, error: 'Bad signature.' };
    }

    var msg;
    try { msg = JSON.parse(raw); } catch (err) { return { ok: false, error: 'Unparseable body.' }; }

    var skew = Math.abs(Date.now() - (Number(msg.ts) || 0));
    if (skew > SRN_MAX_SKEW_MS) {
      return { ok: false, error: 'Stale request (' + Math.round(skew / 1000) + 's skew).' };
    }

    var cache = CacheService.getScriptCache();
    if (!msg.nonce) return { ok: false, error: 'Missing nonce.' };
    var nonceKey = 'srn:' + String(msg.nonce);
    if (cache.get(nonceKey)) return { ok: false, error: 'Replayed nonce.' };
    cache.put(nonceKey, '1', SRN_NONCE_TTL_S);

    // A second guard on top of the nonce: the caller sends a stable dedupeKey
    // per request+audience, so a retry after a timeout — where the mail went out
    // but the response never arrived — does not send twice.
    var dedupe = String(msg.dedupeKey || '').trim();
    if (dedupe) {
      var dedupeKey = 'srnd:' + dedupe;
      if (cache.get(dedupeKey)) return { ok: true, skipped: 'already sent' };
      cache.put(dedupeKey, '1', SRN_NONCE_TTL_S);
    }

    var recipients = String(msg.to || '').split(',')
      .map(function (r) { return r.trim(); })
      .filter(srnValidEmail_)
      .slice(0, SRN_MAX_RECIPIENTS);
    if (!recipients.length) return { ok: false, error: 'No valid recipient.' };

    var subject = String(msg.subject || '').slice(0, 300);
    if (!subject) return { ok: false, error: 'No subject.' };

    var opts = { name: SRN_FROM_NAME };
    if (msg.htmlBody) opts.htmlBody = String(msg.htmlBody);
    if (msg.replyTo && srnValidEmail_(msg.replyTo)) opts.replyTo = String(msg.replyTo).trim();

    GmailApp.sendEmail(recipients.join(','), subject, String(msg.plainBody || ' '), opts);

    return { ok: true, sent: recipients.length };
  } catch (err) {
    Logger.log('handleServiceRequestNotify_ failed: ' + err);
    return { ok: false, error: 'Send failed: ' + ((err && err.message) || err) };
  }
}
