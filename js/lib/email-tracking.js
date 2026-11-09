// ══════════════════════════════════════════════════════════════════════════════
// EMAIL TRACKING: signed tracking links + the evidence classifier.
//
// One source, three users: the engine (Apps Script, via scripts/ee-sync.mjs)
// builds the links when it sends; api/email.js verifies them when they're hit;
// the engine grades what came in. Contract: email-engine/docs/PLAN.md →
// Tracking: evidence and confidence.
//
//   click   {base}/api/email?op=c&t=<token>&l=<link_id>&m=<mode>&u=<dest>&s=<sig>
//   open    {base}/api/email?op=o&t=<token>&m=<mode>&s=<sig>
//   unsub   {base}/api/email?op=u&t=<token>&m=<mode>&s=<sig>
//   beacon  ee=<token>.<link_id>.<mode>.<sig>   appended to first-party landings
//
// The signature covers every field, so a link can't be pointed somewhere else
// (no open redirect), and the mode can't be flipped from test to production
// (PLAN.md → Execution modes). The HMAC itself is injected: Node uses crypto,
// Apps Script uses Utilities. Signed text is always ASCII (the destination is
// URL-encoded first), because the two disagree on anything above U+007F.
// ══════════════════════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MCPS_EMAIL_TRACKING = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CLASSIFIER_VERSION = 'c1';
  var SIG_LEN = 32;                                   // hex chars = 128 bits
  var TOKEN_RE = /^dlv_[0-9a-f]{32}$/;
  var LINK_RE = /^[A-Za-z0-9_]{1,40}$/;

  function message(kind, t, l, m, u) {
    return [kind, t, l || '', m, u ? encodeURIComponent(u) : ''].join('|');
  }
  function sign(hmacHex, kind, t, l, m, u) { return String(hmacHex(message(kind, t, l, m, u))).slice(0, SIG_LEN); }
  function same(a, b) {
    a = String(a || ''); b = String(b || '');
    if (a.length !== b.length || !a.length) return false;
    var d = 0; for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
  }
  function q(params) {
    return Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  }

  // For the sender. opts: { base, token, mode, hmacHex(text) -> hex }
  function links(opts) {
    var base = String(opts.base).replace(/\/+$/, '') + '/api/email?';
    var t = opts.token, m = opts.mode === 'test' ? 'test' : 'production', h = opts.hmacHex;
    return {
      click: function (linkId, url) {
        var l = String(linkId).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);
        return base + q({ op: 'c', t: t, l: l, m: m, u: url, s: sign(h, 'c', t, l, m, url) });
      },
      open: function () { return base + q({ op: 'o', t: t, m: m, s: sign(h, 'o', t, '', m) }); },
      unsubscribe: function () { return base + q({ op: 'u', t: t, m: m, s: sign(h, 'u', t, '', m) }); }
    };
  }

  // For the receiver. p = query params; returns {ok, token, link_id, mode, url} or {ok:false, reason}.
  function verify(kind, p, hmacHex) {
    p = p || {};
    var t = String(p.t || ''), m = String(p.m || ''), l = kind === 'c' ? String(p.l || '') : '', u = kind === 'c' ? String(p.u || '') : '';
    if (!TOKEN_RE.test(t)) return { ok: false, reason: 'bad_token' };
    if (m !== 'test' && m !== 'production') return { ok: false, reason: 'bad_mode' };
    if (kind === 'c') {
      if (!LINK_RE.test(l)) return { ok: false, reason: 'bad_link' };
      if (!/^https?:\/\//i.test(u)) return { ok: false, reason: 'bad_url' };
    }
    if (!same(p.s, sign(hmacHex, kind, t, l, m, u))) return { ok: false, reason: 'bad_signature' };
    return { ok: true, token: t, link_id: l, mode: m, url: u };
  }

  // Beacon: the landing page proves a real browser (JS ran) opened the click.
  function beaconParam(hmacHex, t, l, m) { return [t, l, m, sign(hmacHex, 'b', t, l, m)].join('.'); }
  function verifyBeacon(value, hmacHex) {
    var parts = String(value || '').split('.');
    if (parts.length !== 4) return { ok: false, reason: 'bad_beacon' };
    var t = parts[0], l = parts[1], m = parts[2];
    if (!TOKEN_RE.test(t) || !LINK_RE.test(l) || (m !== 'test' && m !== 'production')) return { ok: false, reason: 'bad_beacon' };
    if (!same(parts[3], sign(hmacHex, 'b', t, l, m))) return { ok: false, reason: 'bad_signature' };
    return { ok: true, token: t, link_id: l, mode: m };
  }
  // Appends the beacon to a first-party destination, keeping its own query and hash.
  function withBeacon(url, value) {
    var hash = '', i = url.indexOf('#');
    if (i !== -1) { hash = url.slice(i); url = url.slice(0, i); }
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'ee=' + encodeURIComponent(value) + hash;
  }

  // ── Classifier (versioned; raw events are kept, so Engagement can be recomputed) ──
  var SCANNER_UA = /bot\b|crawler|spider|scanner|preview|headless|python|curl|wget|java\/|go-http|okhttp|axios|node-fetch|barracuda|proofpoint|mimecast|safelinks|urldefense|forcepoint|symantec|trendmicro|sophos|zscaler|checkpoint|fireeye|ironport|existence discovery/i;
  function uaFamily(ua) {
    ua = String(ua || '');
    if (!ua) return 'none';
    if (/googleimageproxy|ggpht/i.test(ua)) return 'gmail_proxy';
    if (/^mozilla\/5\.0$/i.test(ua.trim())) return 'apple_privacy_proxy';   // Mail Privacy Protection prefetch
    if (SCANNER_UA.test(ua)) return 'scanner';
    if (/iphone|ipad|macintosh/i.test(ua) && /applewebkit/i.test(ua) && !/chrome|crios|fxios|edg/i.test(ua)) return 'apple';
    if (/android/i.test(ua)) return 'android';
    if (/chrome|crios|edg|firefox|fxios|safari/i.test(ua)) return 'browser';
    return 'other';
  }
  // e: { type: open|click|beacon, method, ua, seconds_since_send, burst_count }
  // → { confidence: low|medium|high, reasons: [...] }. Opens never go above medium,
  // and only a beacon can be high ("browser-verified"): PLAN.md → Tracking.
  function classify(e) {
    var reasons = [], fam = uaFamily(e.ua), secs = Number(e.seconds_since_send);
    var early = isFinite(secs) && secs >= 0 && secs < (e.type === 'open' ? 10 : 15);
    if (e.type === 'open') {
      if (early) reasons.push('very_early');
      if (fam === 'apple_privacy_proxy') reasons.push('prefetch_proxy');
      if (fam === 'scanner') reasons.push('scanner_ua');
      return { confidence: reasons.length ? 'low' : 'medium', reasons: reasons, ua_family: fam };
    }
    if (String(e.method || 'GET').toUpperCase() === 'HEAD') reasons.push('head_request');
    if (fam === 'scanner' || fam === 'none') reasons.push(fam === 'none' ? 'no_ua' : 'scanner_ua');
    if (Number(e.burst_count || 0) >= 3) reasons.push('burst');
    if (early && e.type === 'click') reasons.push('very_early');
    if (reasons.length) return { confidence: 'low', reasons: reasons, ua_family: fam };
    return { confidence: e.type === 'beacon' ? 'high' : 'medium', reasons: [], ua_family: fam };
  }

  return { CLASSIFIER_VERSION: CLASSIFIER_VERSION, links: links, verify: verify, beaconParam: beaconParam,
    verifyBeacon: verifyBeacon, withBeacon: withBeacon, classify: classify, uaFamily: uaFamily, message: message };
}));
