// ══════════════════════════════════════════════════════════════════════════════
// CONTACT CLEAN: tidy names, recognise couples / families / businesses, format
// phones, warn about likely email mistakes, and find (possible) duplicates.
// Pure, no I/O; shared by the Lifecycle page, the API (imports, MCP leads) and
// the tests. PLAN.md → Plan changes 2026-11-11 "Contact cleanup and duplicates".
//
//   name(first, last)            → { first_name, last_name, kind, greeting, flags[], needs_ai, changed }
//   phone(v) / place(v)          → formatted phone / re-cased city or street
//   emailIssues(email)           → [{ kind: 'role'|'typo', suggestion? }]
//   cleanContact(c)              → { changes: {field: value}, kind, flags, needs_ai, issues }
//   duplicates(incoming, existing) → [{ a, b, reason, confidence }]
// Loads as browser global MCPS_CONTACT_CLEAN or CommonJS / ESM default import.
// ══════════════════════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MCPS_CONTACT_CLEAN = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var squash = function (v) { return String(v == null ? '' : v).replace(/[ \t]/g, ' ').replace(/\s+/g, ' ').trim(); };
  var low = function (v) { return squash(v).toLowerCase(); };
  var letters = function (v) { return String(v).replace(/[^A-Za-zÀ-ÿ]/g, ''); };
  // Typed all in capitals or all in lower case: the only names we re-case.
  function needsCase(v) {
    var l = letters(v);
    return l.length > 1 && (l === l.toUpperCase() || l === l.toLowerCase());
  }
  var PARTICLES = { de: 1, del: 1, la: 1, las: 1, los: 1, da: 1, di: 1, du: 1, van: 1, von: 1, der: 1, den: 1, le: 1, y: 1, e: 1 };
  var SUFFIX = { jr: 'Jr.', 'jr.': 'Jr.', sr: 'Sr.', 'sr.': 'Sr.', ii: 'II', iii: 'III', iv: 'IV' };
  function capWord(w) {
    if (!w) return w;
    return w.split('-').map(function (part) {
      return part.split("'").map(function (p, i, all) {
        var x = p.toLowerCase();
        if (!x) return x;
        if (all.length > 1 && i === 0 && x.length === 1) return x.toUpperCase();            // O'Brien, D'Angelo
        if (/^mc[a-z]{2,}/.test(x)) return 'Mc' + x.charAt(2).toUpperCase() + x.slice(3);    // McDonald
        return x.charAt(0).toUpperCase() + x.slice(1);
      }).join("'");
    }).join('-');
  }
  function recase(v) {
    var words = squash(v).split(' ');
    return words.map(function (w, i) {
      var x = w.toLowerCase();
      if (SUFFIX[x]) return SUFFIX[x];
      if (/^[a-z]\.?$/i.test(w)) return w.charAt(0).toUpperCase() + (w.length > 1 ? '.' : '');  // initials
      if (i > 0 && PARTICLES[x] && i < words.length - 1) return x;
      return capWord(w);
    }).join(' ');
  }
  var TITLES = /^(mr|mrs|ms|miss|mx|dr|sr|sra|srta|don|dona|doña)\.?$/i;
  var PLACEHOLDER = /^(n\/?a|none|null|unknown|customer|client|homeowner|home ?owner|resident|owner|test|tbd|-+|\.+|x+|\?+)$/i;
  var BUSINESS = /\b(llc|l\.l\.c\.|inc|inc\.|corp|corporation|company|co\.|ltd|pools?|builders?|construction|contractors?|homes|realty|properties|property management|hoa|association|church|school|apartments|services?|enterprises|group)\b/i;
  var JOINERS = /\s+(?:&|and|y|\+|\/)\s+|\s*&\s*|\s*\/\s*/i;

  // first/last as typed (either may hold the whole name).
  function name(first, last) {
    var f0 = squash(first), l0 = squash(last), raw = squash([f0, l0].filter(Boolean).join(' '));
    var out = { first_name: f0, last_name: l0, kind: 'person', greeting: '', flags: [], needs_ai: false, changed: false };
    if (!raw) { out.flags.push('no_name'); return out; }
    if (PLACEHOLDER.test(raw)) { out.first_name = ''; out.last_name = ''; out.flags.push('placeholder_name'); out.changed = true; return out; }
    var fix = function (v) { return needsCase(v) ? recase(v) : squash(v); };
    // "Smith, John" in one field → John Smith
    var comma = (!l0 && f0.indexOf(',') > 0) ? f0.split(',') : null;
    if (comma && comma.length === 2 && !BUSINESS.test(f0)) { f0 = squash(comma[1]); l0 = squash(comma[0]); out.flags.push('flipped'); }
    var whole = squash([f0, l0].filter(Boolean).join(' '));
    if (BUSINESS.test(whole)) {
      // Business names keep their own capitals (LLC, ABC); only all-lower ones are re-cased.
      out.kind = 'business'; out.first_name = ''; out.last_name = whole === whole.toLowerCase() ? recase(whole) : whole; out.greeting = '';
      out.flags.push('business'); out.changed = out.last_name !== l0 || !!f0;
      return out;
    }
    var fam = whole.match(/^(?:the\s+)?([A-Za-zÀ-ÿ'-]+(?:\s+[A-Za-zÀ-ÿ'-]+)?)\s+(family|household|residence|home)$/i) ||
      whole.match(/^the\s+([A-Za-zÀ-ÿ'-]+?)(?:'?s)$/i);
    var familia = whole.match(/^(?:la\s+)?familia\s+([A-Za-zÀ-ÿ' -]+)$/i);
    if (familia) { out.kind = 'family'; out.last_name = fix(familia[1]); out.first_name = 'Familia ' + out.last_name; }
    else if (fam) { out.kind = 'family'; out.last_name = fix(fam[1]); out.first_name = out.last_name + ' family'; }
    if (out.kind === 'family') { out.greeting = out.first_name; out.changed = out.first_name !== first || out.last_name !== last; return out; }
    // Couples: "John & Mary Smith", "John and Mary", "John Smith / Mary Jones"
    var parts = whole.split(JOINERS).map(squash).filter(Boolean);
    if (parts.length === 2) {
      var a = parts[0].split(' ').filter(function (w) { return !TITLES.test(w); }), b = parts[1].split(' ').filter(function (w) { return !TITLES.test(w); });
      // "Mr. & Mrs. John Smith": one named person plus titles → greet "Mr. and Mrs. Smith".
      if (!a.length && b.length) {
        out.kind = 'couple'; out.last_name = fix(b.length > 1 ? b[b.length - 1] : l0);
        out.first_name = 'Mr. and Mrs. ' + out.last_name; out.greeting = out.first_name; out.flags.push('titles'); out.changed = true;
        return out;
      }
      out.kind = 'couple';
      var lastA = a.length > 1 ? a[a.length - 1] : '', lastB = b.length > 1 ? b[b.length - 1] : '';
      var firstA = a.length > 1 ? a.slice(0, -1).join(' ') : a.join(' '), firstB = b.length > 1 ? b.slice(0, -1).join(' ') : b.join(' ');
      var surname = lastB || lastA || l0;
      if (lastA && lastB && low(lastA) !== low(lastB)) { out.flags.push('two_surnames'); out.needs_ai = true; }
      out.first_name = fix(firstA && firstB ? firstA + ' and ' + firstB : firstA || firstB);
      out.first_name = out.first_name.replace(/ And /, ' and ');
      out.last_name = fix(surname);
      out.greeting = out.first_name;
      out.changed = true;
      return out;
    }
    // One person: drop titles; one field with the whole name → split.
    var words = whole.split(' ').filter(function (w) { return !TITLES.test(w); });
    if (words.length !== whole.split(' ').length) out.flags.push('title_dropped');
    if (!l0 || out.flags.indexOf('flipped') !== -1 || out.flags.indexOf('title_dropped') !== -1) {
      if (!l0 && words.length >= 3) out.needs_ai = true;                                         // "Mary Ann Smith" vs "Jose Rodriguez Garza"
      f0 = words.length > 1 ? words[0] : words.join(' ');
      l0 = words.length > 1 ? words.slice(1).join(' ') : (out.flags.indexOf('flipped') !== -1 ? l0 : '');
    }
    out.first_name = fix(f0); out.last_name = fix(l0); out.greeting = out.first_name;
    out.changed = out.first_name !== squash(first) || out.last_name !== squash(last);
    return out;
  }

  function phone(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : squash(v);
  }
  var KEEP_UPPER = { tx: 'TX', nw: 'NW', ne: 'NE', sw: 'SW', se: 'SE', n: 'N', s: 'S', e: 'E', w: 'W', us: 'US', fm: 'FM', po: 'PO', hwy: 'Hwy' };
  function place(v) {
    if (!needsCase(v)) return squash(v);
    return squash(v).split(' ').map(function (w) {
      var x = w.toLowerCase().replace(/[.,]$/, ''), tail = w.slice(x.length);
      if (KEEP_UPPER[x]) return KEEP_UPPER[x] + tail;
      if (/^\d+(st|nd|rd|th)$/.test(x)) return x + tail;
      return capWord(w);
    }).join(' ');
  }

  var ROLE = /^(info|office|admin|sales|contact|hello|support|billing|accounts?|frontdesk|reception|noreply|no-reply|webmaster|team|mail)@/i;
  var DOMAINS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'live.com', 'att.net', 'sbcglobal.net', 'msn.com', 'me.com', 'comcast.net'];
  var KNOWN = { 'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.con': 'gmail.com',
    'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.co': 'yahoo.com', 'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmail.co': 'hotmail.com',
    'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com', 'iclod.com': 'icloud.com', 'icloud.co': 'icloud.com', 'sbcgloble.net': 'sbcglobal.net' };
  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    var m = [], i, j;
    for (i = 0; i <= a.length; i++) { m[i] = [i]; }
    for (j = 0; j <= b.length; j++) m[0][j] = j;
    for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
    return m[a.length][b.length];
  }
  function emailIssues(email) {
    var e = low(email), at = e.lastIndexOf('@'), out = [];
    if (at < 1) return out;
    if (ROLE.test(e)) out.push({ kind: 'role' });
    var dom = e.slice(at + 1), fixD = KNOWN[dom];
    if (!fixD && DOMAINS.indexOf(dom) === -1) DOMAINS.some(function (d) { if (editDistance(dom, d) === 1) { fixD = d; return true; } return false; });
    if (fixD && fixD !== dom) out.push({ kind: 'typo', suggestion: e.slice(0, at + 1) + fixD });
    return out;
  }

  // What would change for one contact (only fields that differ), plus kind and warnings.
  function cleanContact(c) {
    var n = name(c.first_name, c.last_name), changes = {};
    if (n.first_name !== squash(c.first_name)) changes.first_name = n.first_name;
    if (n.last_name !== squash(c.last_name)) changes.last_name = n.last_name;
    ['phone'].forEach(function (k) { if (c[k] != null && c[k] !== '') { var v = phone(c[k]); if (v !== c[k]) changes[k] = v; } });
    ['city', 'address'].forEach(function (k) { if (c[k]) { var v = place(c[k]); if (v !== c[k]) changes[k] = v; } });
    return { changes: changes, kind: n.kind, flags: n.flags, needs_ai: n.needs_ai, issues: emailIssues(c.email_norm || c.email) };
  }

  // ── Duplicates ──
  // Gmail ignores dots and anything after "+": the same inbox, for detection only.
  function emailKey(e) {
    var x = low(e), at = x.lastIndexOf('@');
    if (at < 1) return x;
    var user = x.slice(0, at), dom = x.slice(at + 1);
    if (dom === 'gmail.com' || dom === 'googlemail.com') { user = user.split('+')[0].replace(/\./g, ''); dom = 'gmail.com'; }
    return user + '@' + dom;
  }
  var STREET = { street: 'st', st: 'st', avenue: 'ave', ave: 'ave', drive: 'dr', dr: 'dr', road: 'rd', rd: 'rd', lane: 'ln', ln: 'ln', court: 'ct', ct: 'ct',
    boulevard: 'blvd', blvd: 'blvd', circle: 'cir', cir: 'cir', trail: 'trl', trl: 'trl', parkway: 'pkwy', pkwy: 'pkwy', place: 'pl', pl: 'pl', way: 'way', cove: 'cv', cv: 'cv' };
  function houseKey(c) {
    var street = low(String(c.address || '').split(',')[0]).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/^\d+\s+\S/.test(street)) return '';
    street = street.split(' ').map(function (w) { return STREET[w] || w; }).join(' ');
    var city = low(c.city || (String(c.address || '').split(',')[1] || '')).replace(/[^a-z ]/g, '').trim();
    return street + '|' + city;
  }
  var personName = function (c) { return low([c.first_name, c.last_name].join(' ')).replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); };
  function similar(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    var d = editDistance(a, b);
    return d <= 2 && Math.max(a.length, b.length) >= 6;
  }
  // incoming: contacts not saved yet (or the engine's own, to scan it); existing: the engine's.
  // Each pair: reason same_email | same_inbox | same_person | similar_name | same_household.
  function duplicates(incoming, existing, opts) {
    opts = opts || {};
    var byEmail = {}, byInbox = {}, byHouse = {}, out = [], seen = {};
    (existing || []).forEach(function (c) {
      var es = [c.email_norm].concat(String(c.alt_emails || '').split(','));
      es.forEach(function (e) { e = low(e); if (e) { byEmail[e] = c; byInbox[emailKey(e)] = c; } });
      var h = houseKey(c); if (h) (byHouse[h] = byHouse[h] || []).push(c);
    });
    (incoming || []).forEach(function (a) {
      var id = a.contact_id || a.row, e = low(a.email_norm || a.email), hit = null, reason = '', conf = 'high';
      if (e && byEmail[e] && byEmail[e] !== a) { hit = byEmail[e]; reason = 'same_email'; }
      else if (e && byInbox[emailKey(e)] && byInbox[emailKey(e)] !== a) { hit = byInbox[emailKey(e)]; reason = 'same_inbox'; }
      else {
        var h = houseKey(a), others = (byHouse[h] || []).filter(function (b) { return b !== a && (b.contact_id || b.row) !== id; });
        if (others.length) {
          var n = personName(a);
          hit = others.filter(function (b) { return personName(b) === n; })[0];
          if (hit) reason = 'same_person';
          else { hit = others.filter(function (b) { return similar(personName(b), n); })[0]; if (hit) { reason = 'similar_name'; conf = 'medium'; } }
          if (!hit) { hit = others[0]; reason = 'same_household'; conf = 'medium'; }
        }
      }
      if (!hit) return;
      var key = [id, hit.contact_id || hit.row].sort().join('~');
      if (opts.symmetric && seen[key]) return;
      seen[key] = 1;
      out.push({ a: a, b: hit, reason: reason, confidence: conf });
    });
    return out;
  }

  return { name: name, phone: phone, place: place, recase: recase, needsCase: needsCase, emailIssues: emailIssues, cleanContact: cleanContact,
    duplicates: duplicates, emailKey: emailKey, houseKey: houseKey };
}));
