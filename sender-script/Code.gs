/**
 * MCPS per-person sender — deploy ONE copy per staff member, under THEIR account.
 *
 * ⚠️ This file must never be copied into appscript/. It declares its own doPost,
 *    and clasp push would install it into the portal project alongside
 *    WebhookReceiver's doPost — the second declaration wins and the entire portal
 *    API stops answering. It belongs in a separate, standalone Apps Script
 *    project. See README.md in this folder.
 *
 * What it does: verifies a signed request from the portal, then sends one
 * already-rendered email as the account that deployed it. That is the whole job.
 * It holds no audience, no templates, no logging, no unsubscribe handling.
 *
 * Setup is in README.md.
 */

var SECRET_PROP  = 'MCPS_SENDER_SECRET';
var MAX_SKEW_MS  = 300000;  // 5 min — must match COMMS_SENDER_MAX_SKEW_MS
var NONCE_TTL_S  = 21600;   // 6h — replay window for an already-sent payload
var FROM_NAME    = 'Mission Custom Pool Solutions';

function doPost(e) {
  try {
    var secret = PropertiesService.getScriptProperties().getProperty(SECRET_PROP);
    if (!secret) return json_({ ok: false, error: 'sender not configured: ' + SECRET_PROP + ' is unset' });

    var raw = (e && e.postData && e.postData.contents) || '';
    if (!raw) return json_({ ok: false, error: 'empty body' });

    var sig = (e && e.parameter && e.parameter.sig) || '';
    // The signature covers the exact bytes received, so there is no canonical
    // form to agree on and no field-ordering bug to have.
    if (!sig || !timingSafeEqual_(sig, hmacHex_(secret, raw))) {
      return json_({ ok: false, error: 'bad signature' });
    }

    var msg;
    try { msg = JSON.parse(raw); } catch (err) { return json_({ ok: false, error: 'unparseable body' }); }

    // A valid signature is replayable forever without these two checks: the skew
    // window bounds it, and the nonce cache stops repeats inside that window.
    var skew = Math.abs(Date.now() - (Number(msg.ts) || 0));
    if (skew > MAX_SKEW_MS) return json_({ ok: false, error: 'stale request (' + Math.round(skew / 1000) + 's skew)' });

    var cache = CacheService.getScriptCache();
    var nonceKey = 'n:' + String(msg.nonce || '');
    if (!msg.nonce) return json_({ ok: false, error: 'missing nonce' });
    if (cache.get(nonceKey)) return json_({ ok: false, error: 'replayed nonce' });
    cache.put(nonceKey, '1', NONCE_TTL_S);

    if (!msg.to || !msg.subject) return json_({ ok: false, error: 'missing to/subject' });

    var opts = { name: msg.senderName || FROM_NAME };
    if (msg.htmlBody) opts.htmlBody = msg.htmlBody;
    if (msg.replyTo)  opts.replyTo  = msg.replyTo;
    GmailApp.sendEmail(msg.to, msg.subject, msg.plainBody || ' ', opts);

    return json_({ ok: true, sender: effectiveUser_(), recipientId: msg.recipientId || '' });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/** Liveness check. Deliberately reveals no identity — it is unauthenticated. */
function doGet() {
  return json_({ ok: true, service: 'mcps-sender' });
}

function hmacHex_(secret, message) {
  var raw = Utilities.computeHmacSha256Signature(String(message), String(secret));
  var out = '';
  for (var i = 0; i < raw.length; i++) {
    var b = raw[i] < 0 ? raw[i] + 256 : raw[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

/** Compares without an early exit, so a wrong signature costs the same either way. */
function timingSafeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function effectiveUser_() {
  try { return String(Session.getEffectiveUser().getEmail() || ''); } catch (e) { return ''; }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run this from the editor after deploying. It confirms the secret is set and
 * prints the account this script sends as — which must be YOUR address.
 */
function whoAmI() {
  var set = !!PropertiesService.getScriptProperties().getProperty(SECRET_PROP);
  var info = { sends_as: effectiveUser_(), secret_set: set, remaining_quota: MailApp.getRemainingDailyQuota() };
  Logger.log(JSON.stringify(info, null, 2));
  return info;
}
