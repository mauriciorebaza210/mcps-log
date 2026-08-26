// CommsSenders.js — per-person Gmail sending for MCPS campaigns.
//
// Campaign mail leaves from the Gmail account of the staff member who created
// the campaign: it lands in THEIR Sent folder and draws on THEIR daily quota.
// Apps Script cannot do that from one project — GmailApp always sends as the
// executing account — so each staff member deploys a tiny sender web app under
// their own Google account, and this project calls it.
//
//   portal (this project)                    Tony's sender web app
//   ─────────────────────                    ─────────────────────
//   resolve sender at CREATION               verify HMAC + freshness
//   render subject/body                      reject replayed nonce
//   POST signed payload  ───────────────►    GmailApp.sendEmail(...)
//   record what actually sent   ◄────────    { ok, sender }
//
// The sender scripts stay deliberately stupid: they hold no audience, no
// templates, no logging, no unsubscribe handling. They receive an already
// rendered email and send it. Everything else stays here.
//
// ⚠️ The sender script source lives in sender-script/ at the repo root, NOT in
// appscript/. It declares its own doPost, so a copy inside appscript/ would be
// pushed into this project by clasp and collide with WebhookReceiver's doPost —
// breaking the entire portal API. See sender-script/README.md.

var COMMS_SENDER_SECRET_PROP = 'COMMS_SENDER_SECRET';
var COMMS_SENDER_MAX_SKEW_MS = 300000; // 5 min — bounds replay of a signed payload
var COMMS_SENDER_TIMEOUT_TAG = 'sender_script';

// ─── Shared signing (mirrored byte-for-byte in sender-script/Code.gs) ─────────
// The signature covers the EXACT transmitted body and travels in the query
// string, so neither side has to agree on a canonical field order — the raw
// string is the message.
function commsHmacHex_(secret, message) {
  var raw = Utilities.computeHmacSha256Signature(String(message), String(secret));
  var out = '';
  for (var i = 0; i < raw.length; i++) {
    var b = raw[i] < 0 ? raw[i] + 256 : raw[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

// ─── Registry ────────────────────────────────────────────────────────────────
// One row per staff member who may send. A person with no active row cannot
// send campaigns at all — see commsResolveSender_.
function commsSenderRows_() {
  return commsSheetRows_('senders').map(function (r) {
    return {
      username: String(r.username || '').trim(),
      sender_email: String(r.sender_email || '').trim(),
      sender_name: String(r.sender_name || '').trim(),
      sender_script_url: String(r.sender_script_url || '').trim(),
      active: commsSenderTruthy_(r.active)
    };
  });
}

// Sheets hand back booleans, 'TRUE', 'yes', 1 … depending on how the cell was
// filled in. Anything unrecognised is treated as inactive: a typo must fail
// closed, not silently authorise someone to send customer mail.
function commsSenderTruthy_(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === 'active';
}

// A sender endpoint must be a deployed Apps Script web app. Catching this here
// turns a per-recipient send failure into one clear error at campaign creation.
// Both deployment URL shapes are legitimate: the plain form, and the
// Workspace-domain form (script.google.com/a/macros/<domain>/s/…). A /dev URL is
// rejected on purpose — it executes as the CALLER rather than the deploying
// account, which would silently defeat the entire point of per-person senders.
function commsValidSenderUrl_(url) {
  return /^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[A-Za-z0-9_-]+\/exec(\?.*)?$/
    .test(String(url || ''));
}

// Resolve the sender for the staff member creating a campaign.
// Returns { ok: true, sender } or { ok: false, error } — never a silent fallback
// to the shared account, because a customer campaign leaving from the wrong
// mailbox is worse than a campaign that refuses to start.
function commsResolveSender_(auth) {
  var username = String((auth && auth.username) || '').trim();
  if (!username) return { ok: false, error: 'No portal username on this session; cannot determine a sender.' };

  var rows;
  try { rows = commsSenderRows_(); }
  catch (e) { return { ok: false, error: 'Sender registry unreadable: ' + ((e && e.message) || e) }; }

  var lower = username.toLowerCase();
  var match = null, inactive = false;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].username.toLowerCase() !== lower) continue;
    if (rows[i].active) { match = rows[i]; break; }
    inactive = true;
  }

  if (!match) {
    return { ok: false, error: inactive
      ? 'Sending is switched off for "' + username + '" in Comms_Senders. Set active to TRUE to re-enable it.'
      : 'No sender configured for "' + username + '". Add a row to Comms_Senders with their address and deployed sender-script URL before sending campaigns.' };
  }
  if (!COMMS_EMAIL_RE.test(match.sender_email)) {
    return { ok: false, error: 'Sender row for "' + username + '" has an invalid sender_email.' };
  }
  if (!commsValidSenderUrl_(match.sender_script_url)) {
    return { ok: false, error: 'Sender row for "' + username + '" has no valid sender_script_url '
      + '(expected a deployed Apps Script /exec URL).' };
  }
  return { ok: true, sender: match };
}

// ─── Transport: hand a rendered email to one person's sender script ──────────
function commsSendViaSenderScript_(msg) {
  var fail = function (error) {
    return { ok: false, provider: COMMS_SENDER_TIMEOUT_TAG, providerMessageId: '', error: error };
  };
  var secret = commsProps_().getProperty(COMMS_SENDER_SECRET_PROP);
  if (!secret) return fail('COMMS_SENDER_SECRET is not set on the portal script.');
  var url = String(msg.senderScriptUrl || '');
  if (!commsValidSenderUrl_(url)) return fail('Campaign has no valid sender_script_url.');

  var body = JSON.stringify({
    to: msg.to,
    subject: msg.subject,
    htmlBody: msg.htmlBody || '',
    plainBody: msg.plainBody || '',
    replyTo: msg.replyTo || '',
    senderName: msg.senderName || COMMS_FROM_NAME,
    senderEmail: msg.senderEmail || '',
    recipientId: msg.recipientId || '',
    ts: Date.now(),
    nonce: Utilities.getUuid()
  });

  var res;
  try {
    res = UrlFetchApp.fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + 'sig=' + commsHmacHex_(secret, body), {
      method: 'post',
      contentType: 'application/json',
      payload: body,
      muteHttpExceptions: true
    });
  } catch (e) {
    return fail('Sender script unreachable: ' + ((e && e.message) || e));
  }

  var code = res.getResponseCode();
  var text = res.getContentText();
  var parsed = null;
  try { parsed = JSON.parse(text); } catch (e) {}

  if (!parsed) {
    // A GAS web app deployed with anything other than "Anyone" access answers an
    // unauthenticated POST with an HTML sign-in page, which is by far the most
    // likely misconfiguration here. Say so instead of reporting "bad JSON".
    var looksLikeLogin = text.indexOf('<html') !== -1 || text.indexOf('accounts.google.com') !== -1;
    return fail(looksLikeLogin
      ? 'Sender script returned a sign-in page — redeploy it with access set to "Anyone" (HTTP ' + code + ').'
      : 'Sender script returned a non-JSON response (HTTP ' + code + '): ' + text.slice(0, 200));
  }
  if (code < 200 || code >= 300) return fail('Sender script HTTP ' + code + ': ' + text.slice(0, 200));
  if (!parsed.ok) return fail('Sender script refused: ' + (parsed.error || 'unknown error'));

  // Trust but verify: if the sender script sent from a different account than the
  // campaign was locked to, the audit trail must record what actually happened.
  return {
    ok: true,
    provider: COMMS_SENDER_TIMEOUT_TAG,
    providerMessageId: String(parsed.messageId || ''),
    senderEmail: String(parsed.sender || msg.senderEmail || '')
  };
}

// ─── Proof-of-concept probe (admin/manager) ──────────────────────────────────
// Sends ONE email through a named person's sender script, so the whole chain can
// be verified — signature, deployment, From address, Sent folder — before any
// customer campaign is routed through it.
//
// The recipient is the caller's own account email, never client-supplied, so the
// probe cannot be used to mail arbitrary addresses.
function handleCommsSenderProbe_(auth, payload) {
  var username = String((payload && payload.username) || (auth && auth.username) || '').trim();
  var to = (auth && auth.email) ? String(auth.email).trim() : '';
  if (!to) return { ok: false, error: 'Your user account has no email address; add one in Admin to receive the probe.' };

  var resolved = commsResolveSender_({ username: username });
  if (!resolved.ok) return resolved;
  var s = resolved.sender;

  var send = commsSendViaSenderScript_({
    to: to,
    subject: 'MCPS sender probe — ' + s.sender_email,
    plainBody: 'Sender probe for ' + username + '.\n\n'
             + 'Expected sender: ' + s.sender_email + '\n'
             + 'Check the From header on this message, and check that a copy is in '
             + s.sender_email + "'s Sent folder.",
    htmlBody: '<p>Sender probe for <strong>' + escHtmlComms_(username) + '</strong>.</p>'
            + '<p>Expected sender: <strong>' + escHtmlComms_(s.sender_email) + '</strong></p>'
            + '<p>Check the From header on this message, and check that a copy is in '
            + escHtmlComms_(s.sender_email) + "'s Sent folder.</p>",
    senderEmail: s.sender_email,
    senderName: s.sender_name || COMMS_FROM_NAME,
    senderScriptUrl: s.sender_script_url,
    recipientId: 'probe_' + username
  });

  return {
    ok: send.ok,
    error: send.error || '',
    sent_to: to,
    expected_sender: s.sender_email,
    reported_sender: send.senderEmail || '',
    sender_matches: !!send.ok && String(send.senderEmail || '') === s.sender_email,
    sender_script_url: s.sender_script_url
  };
}

// Local escaper: Comms.js templates run through their own sanitiser, but this
// probe builds HTML directly from registry values.
function escHtmlComms_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Editor-runnable: probe EVERY active sender at once and report.
//
// Two reasons this exists separately from the doPost probe. It needs no portal
// session, so it works after `clasp push` but BEFORE the web app is redeployed —
// exactly the window where you want to know the registry is right, while the
// blocking rule is not live yet. And it is the standing check for senders going
// stale later, when someone's script quietly loses its Gmail authorization.
//
// Mails the account RUNNING it, once per sender. Never a customer.
function commsProbeAllSenders() {
  var me = commsEffectiveUser_();
  if (!me) {
    Logger.log('Cannot determine your address — run this from the editor while signed in.');
    return { ok: false, error: 'no effective user' };
  }
  commsEnsureSheets_();
  var rows = commsSenderRows_().filter(function (r) { return r.active; });
  if (!rows.length) {
    Logger.log('No active rows in Comms_Senders — nothing to probe.');
    return { ok: false, error: 'no active senders' };
  }
  var results = rows.map(function (r) {
    var out = handleCommsSenderProbe_({ username: r.username, email: me }, { username: r.username });
    return {
      username: r.username,
      expected: out.expected_sender || r.sender_email,
      actual: out.reported_sender || '',
      matches: !!out.sender_matches,
      error: out.error || ''
    };
  });
  var allGood = results.every(function (r) { return r.matches; });
  Logger.log(JSON.stringify({ probed_as: me, all_ok: allGood, results: results }, null, 2));
  return { ok: allGood, probed_as: me, results: results };
}

// ─── "Who will this send from?" for the compose screen ───────────────────────
// Always returns ok:true with a `source` the UI can render differently, rather
// than an error — "you have no sender configured" is a state the compose screen
// must be able to WARN about before someone writes a whole campaign, not an
// exception. It is the only place the blocking rule is visible before it bites.
//
//   per_person  → resolved from Comms_Senders; this is what customers will see
//   provider    → resend/zapier is the transport, so the provider decides
//   unconfigured→ gmail mode with no active registry row; sending WILL be refused
function handleCommsMySender_(auth) {
  var mode = commsSendMode_();
  // Config that silently degrades the customer-facing email, surfaced on the
  // compose screen because that is the last moment anyone looks before a send.
  var missing = [];
  if (!commsProps_().getProperty('COMMS_BUSINESS_ADDRESS')) missing.push('COMMS_BUSINESS_ADDRESS');
  if (mode !== 'gmail') {
    var from = commsProps_().getProperty('COMMS_RESEND_FROM') || '';
    return { ok: true, mode: mode, source: 'provider', from_email: from, from_name: COMMS_FROM_NAME,
             missing_config: missing };
  }
  var resolved = commsResolveSender_(auth);
  if (resolved.ok) {
    return {
      ok: true, mode: 'gmail', source: 'per_person',
      from_email: resolved.sender.sender_email,
      from_name: resolved.sender.sender_name || COMMS_FROM_NAME,
      username: resolved.sender.username,
      missing_config: missing
    };
  }
  return {
    ok: true, mode: 'gmail', source: 'unconfigured',
    from_email: '', from_name: COMMS_FROM_NAME, reason: resolved.error || '',
    missing_config: missing
  };
}

// ─── Registry admin ──────────────────────────────────────────────────────────
function handleCommsListSenders_() {
  commsEnsureSheets_();
  var rows = commsSenderRows_().map(function (r) {
    return {
      username: r.username, sender_email: r.sender_email, sender_name: r.sender_name,
      sender_script_url: r.sender_script_url, active: r.active,
      url_valid: commsValidSenderUrl_(r.sender_script_url)
    };
  });
  return { ok: true, senders: rows, secret_set: !!commsProps_().getProperty(COMMS_SENDER_SECRET_PROP) };
}
