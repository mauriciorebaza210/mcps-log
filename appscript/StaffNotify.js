// StaffNotify.js — internal staff notifications (agreement signed, startup
// scheduled, issue alerts reported, service requests submitted).
//
// Separate from Comms.js (customer-facing campaigns/receipts): this is a small,
// direct send to staff who've opted in, with no audience resolution, no
// Comms_Log row, no unsubscribe flow. It reuses Comms.js's sendCommsEmail_ as
// the transport so staff mail travels the same pipe as everything else.
//
// Preferences live on the Users sheet as one JSON column (notify_prefs_json),
// auto-created on first write like every other column in UserAuth.js. Adding a
// new notifiable event is one entry in STAFF_NOTIFY_EVENTS below plus one call
// to staffNotifyEvent_() at the trigger site — no schema change. Adding push
// later is a `push` key inside the same per-user blob plus a branch in
// staffNotifyEvent_ — also no schema change.

var STAFF_NOTIFY_EVENTS = {
  agreement_signed: {
    label: 'Agreement signed',
    description: 'A customer signs their service agreement.',
    defaultOnUsernames: ['mau', 'tony']
  },
  startup_scheduled: {
    label: 'Startup scheduled',
    description: 'A pool startup gets scheduled, however it was created.',
    defaultOnUsernames: ['mau', 'tony']
  },
  issue_alert_reported: {
    label: 'Issue/alert reported',
    description: 'A technician reports an issue or alert from the field.',
    defaultOnUsernames: []
  },
  service_request_submitted: {
    label: 'New service request submitted',
    description: 'A customer submits a pool service request form.',
    defaultOnUsernames: ['mau', 'tony']
  }
};

// ─── Preference parsing ───────────────────────────────────────────────────────
function staffNotifyParsePrefs_(raw) {
  if (!raw) return {};
  try {
    var p = JSON.parse(raw);
    return (p && typeof p === 'object') ? p : {};
  } catch (e) {
    return {};
  }
}

// Resolves STORED prefs against the catalog's defaults, so callers never have
// to know about defaultOnUsernames themselves — one definition of "effective
// state" shared by the session payload (so the Profile tab shows the truth,
// not just what's been explicitly saved) and by recipient resolution at send
// time.
function staffNotifyEffectivePrefs_(username, rawJson) {
  var uname = String(username || '').trim().toLowerCase();
  var stored = staffNotifyParsePrefs_(rawJson);
  var out = {};
  Object.keys(STAFF_NOTIFY_EVENTS).forEach(function (key) {
    var entry = stored[key];
    var enabled = (entry && typeof entry.email === 'boolean')
      ? entry.email
      : (STAFF_NOTIFY_EVENTS[key].defaultOnUsernames || []).indexOf(uname) !== -1;
    out[key] = { email: enabled };
  });
  return out;
}

// ─── Recipient resolution ─────────────────────────────────────────────────────
// Reuses the same cache key handleListUsers() populates (UserAuth.js) so this
// never costs an extra sheet scan beyond what the admin UI already triggers.
function staffNotifyAllUsersRaw_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('admin_users_list');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  var ss = SpreadsheetApp.openById(AUTH_SHEET_ID);
  var sheet = ss.getSheetByName(USERS_SHEET);
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0].map(function (h) { return String(h).trim().toLowerCase().replace(/ /g, '_'); });
  var users = data.slice(1).map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    delete obj.password_hash;
    return obj;
  });
  cache.put('admin_users_list', JSON.stringify(users), 300);
  return users;
}

// Not role-gated: any staff member can eventually opt into any catalog event,
// since role doesn't map cleanly onto "who cares about this" (Antonio/tony is
// a technician, not an admin, but needs these same notifications).
function staffNotifyRecipients_(eventType) {
  if (!STAFF_NOTIFY_EVENTS[eventType]) return [];
  var users = staffNotifyAllUsersRaw_();
  var out = [];
  users.forEach(function (u) {
    var username = String(u.username || '').trim().toLowerCase();
    var email = String(u.email || '').trim();
    if (!email) return;
    var effective = staffNotifyEffectivePrefs_(username, u.notify_prefs_json);
    if (effective[eventType] && effective[eventType].email) {
      out.push({ username: username, email: email, name: u.name || username });
    }
  });
  return out;
}

// ─── Rendering (short, plain, transactional — not the bulk/marketing template) ─
function staffNotifyEsc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function staffNotifyPortalUrl_() {
  return (typeof getPortalBaseUrl_ === 'function') ? getPortalBaseUrl_() : 'https://mcps-log.vercel.app';
}

function staffNotifyShell_(title, rows, linkUrl, linkLabel) {
  var esc = staffNotifyEsc_;
  var rowsHtml = rows.filter(function (r) { return r && r[1]; }).map(function (r) {
    return '<tr><td style="padding:8px 0;color:#5c6b6b;font-size:13px;width:38%;">' + esc(r[0]) + '</td>' +
           '<td style="padding:8px 0;color:#222222;font-size:14px;font-weight:600;">' + esc(r[1]) + '</td></tr>';
  }).join('');
  var link = linkUrl
    ? '<p style="margin:18px 0 0;"><a href="' + esc(linkUrl) + '" style="color:#1FA7A8;">' + esc(linkLabel || 'Open in the portal') + '</a></p>'
    : '';
  return '<div style="font-family:\'Open Sans\',Arial,Helvetica,sans-serif;">' +
    '<h2 style="font-family:\'Montserrat\',Arial,Helvetica,sans-serif;color:#0D3D3E;margin:0 0 12px;font-size:18px;">' + esc(title) + '</h2>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + rowsHtml + '</table>' + link + '</div>';
}

function staffNotifyRenderEmail_(eventType, ctx) {
  var portal = staffNotifyPortalUrl_();
  if (eventType === 'agreement_signed') {
    return {
      subject: 'Agreement signed — ' + (ctx.customerName || 'a customer'),
      html: staffNotifyShell_('Agreement signed', [
        ['Customer', ctx.customerName], ['Quote', ctx.quoteId], ['Pool', ctx.poolId]
      ], portal + '/#quotes', 'Open Quotes in the portal'),
      text: 'Agreement signed by ' + (ctx.customerName || '') +
        (ctx.quoteId ? ' — quote ' + ctx.quoteId : '') + (ctx.poolId ? ', pool ' + ctx.poolId : '') +
        '.\n' + portal + '/#quotes'
    };
  }
  if (eventType === 'startup_scheduled') {
    return {
      subject: 'Startup scheduled — ' + (ctx.customerName || 'a customer'),
      html: staffNotifyShell_('Startup scheduled', [
        ['Customer', ctx.customerName], ['Pool', ctx.poolId], ['Start date', ctx.startupDate]
      ], portal + '/#live_map', 'Open the schedule in the portal'),
      text: 'Startup scheduled for ' + (ctx.customerName || '') +
        (ctx.poolId ? ' — pool ' + ctx.poolId : '') + (ctx.startupDate ? ', starting ' + ctx.startupDate : '') +
        '.\n' + portal + '/#live_map'
    };
  }
  if (eventType === 'issue_alert_reported') {
    return {
      subject: 'Issue reported — ' + (ctx.poolId || ctx.customerName || 'a pool'),
      html: staffNotifyShell_('Issue/alert reported', [
        ['Pool', ctx.poolId], ['Customer', ctx.customerName], ['Reported by', ctx.actorName], ['Summary', ctx.summary]
      ], portal + '/#live_map', 'Open alerts in the portal'),
      text: 'Issue reported' + (ctx.poolId ? ' for pool ' + ctx.poolId : '') +
        (ctx.actorName ? ' by ' + ctx.actorName : '') + (ctx.summary ? '\n\n' + ctx.summary : '') +
        '.\n' + portal + '/#live_map'
    };
  }
  var label = (STAFF_NOTIFY_EVENTS[eventType] || {}).label || eventType;
  return { subject: label, html: staffNotifyShell_(label, [], portal, 'Open the portal'), text: label };
}

// ─── Dispatch ──────────────────────────────────────────────────────────────────
// Fails open: a broken notification must never block the write it's attached to.
function staffNotifyEvent_(eventType, ctx) {
  try {
    if (!STAFF_NOTIFY_EVENTS[eventType]) return;
    var recipients = staffNotifyRecipients_(eventType);
    if (!recipients.length) return;
    var rendered = staffNotifyRenderEmail_(eventType, ctx || {});
    recipients.forEach(function (r) {
      try {
        sendCommsEmail_({ to: r.email, subject: rendered.subject, htmlBody: rendered.html, plainBody: rendered.text });
      } catch (sendErr) {
        Logger.log('staffNotifyEvent_ send failed for ' + r.email + ': ' + sendErr);
      }
    });
  } catch (e) {
    Logger.log('staffNotifyEvent_ failed for ' + eventType + ': ' + e);
  }
}

// ─── doPost: get_notification_prefs (self-service) ───────────────────────────
function handleGetNotificationPrefs_(payload) {
  var auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };
  return { ok: true, catalog: STAFF_NOTIFY_EVENTS, prefs: auth.notify_prefs || {} };
}

// ─── doPost: update_notification_prefs (self-service; admin can set others,
//     mirroring handleUpdateUser's admin-override pattern) ───────────────────
function handleUpdateNotificationPrefs_(payload) {
  var auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };

  var targetUsername = String(payload.username || auth.username || '').trim().toLowerCase();
  var isSelf = targetUsername === auth.username;
  if (!isSelf && !hasRole(auth, 'admin')) {
    return { ok: false, error: "Admin access required to update another user's preferences." };
  }

  var eventType = String(payload.event_type || '').trim();
  if (!STAFF_NOTIFY_EVENTS[eventType]) return { ok: false, error: 'Unknown event type: ' + eventType };
  var channel = String(payload.channel || 'email').trim();
  if (channel !== 'email') return { ok: false, error: 'Only the email channel is available right now.' };
  var enabled = payload.enabled === true || payload.enabled === 'true';

  var ss = SpreadsheetApp.openById(AUTH_SHEET_ID);
  var sheet = ss.getSheetByName(USERS_SHEET);
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function (h) { return String(h).trim().toLowerCase().replace(/ /g, '_'); });
  var rowIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === targetUsername) { rowIdx = i; break; }
  }
  if (rowIdx === -1) return { ok: false, error: "User '" + targetUsername + "' not found." };

  var col = headers.indexOf('notify_prefs_json');
  var raw = col === -1 ? '' : data[rowIdx][col];
  var prefs = staffNotifyParsePrefs_(raw);
  prefs[eventType] = prefs[eventType] || {};
  prefs[eventType][channel] = enabled;

  if (col === -1) {
    col = headers.length;
    sheet.getRange(1, col + 1).setValue('notify_prefs_json');
  }
  sheet.getRange(rowIdx + 1, col + 1).setValue(JSON.stringify(prefs));

  var cache = CacheService.getScriptCache();
  cache.remove('usr:' + targetUsername);
  cache.remove('admin_users_list');

  return { ok: true, prefs: prefs };
}

// ─── doPost: get_notification_recipients ──────────────────────────────────────
// Server-to-server lookup for Vercel's service-request notifier, which has no
// portal session to authenticate with. Signed the same way
// ServiceRequestNotify.js already authenticates Vercel → GAS calls (HMAC-SHA256
// over the raw body, a timestamp skew window, a replay-nonce cache) — reuses
// SRN_SECRET_PROP and the srnHmacHex_/srnTimingSafeEqual_ helpers rather than a
// second secret and a second implementation of the same scheme.
function handleGetNotificationRecipients_(e) {
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
    var nonceKey = 'gnr:' + String(msg.nonce);
    if (cache.get(nonceKey)) return { ok: false, error: 'Replayed nonce.' };
    cache.put(nonceKey, '1', SRN_NONCE_TTL_S);

    var eventType = String(msg.event_type || '').trim();
    if (!STAFF_NOTIFY_EVENTS[eventType]) return { ok: false, error: 'Unknown event type.' };

    var recipients = staffNotifyRecipients_(eventType);
    return { ok: true, emails: recipients.map(function (r) { return r.email; }) };
  } catch (err) {
    Logger.log('handleGetNotificationRecipients_ failed: ' + err);
    return { ok: false, error: String((err && err.message) || err) };
  }
}
