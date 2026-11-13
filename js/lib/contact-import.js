// ══════════════════════════════════════════════════════════════════════════════
// CONTACT IMPORT: any spreadsheet → clean contacts (pure; no network, no DOM).
//
// Used by the Lifecycle page's import (js/features/lifecycle.js) in the browser,
// and by tests/email-engine-import.test.js in Node. The page turns a CSV, a
// paste from Google Sheets, or an Excel sheet (read with SheetJS) into a grid of
// rows; everything after that is here:
//
//   findHeaderRow(rows)               the header is not always row 1
//   suggestMapping(headers, samples)  which column is which, from names and values
//   toContacts(rows, h, mapping, o)   normalize, split names/addresses, dedupe the file
//   mappingKey(headers)               remember a mapping for the next file of this shape
//
// Contract: email-engine/docs/PLAN.md → Plan changes 2026-11-09 / 2026-11-10
// (import handles any format; duplicate rules).
// ══════════════════════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MCPS_CONTACT_IMPORT = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The fields a column can map to, in the order the mapping screen lists them.
  var FIELDS = [
    { key: 'first_name', label: 'First name' }, { key: 'last_name', label: 'Last name' },
    { key: 'full_name', label: 'Full name (split into first and last)' }, { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' }, { key: 'address', label: 'Full address' }, { key: 'street', label: 'Street' },
    { key: 'city', label: 'City' }, { key: 'state', label: 'State' }, { key: 'zip', label: 'ZIP' },
    { key: 'area', label: 'Area' }, { key: 'pool_build_year', label: 'Pool build year' }, { key: 'tags', label: 'Tags' },
    { key: 'notes', label: 'Notes' }, { key: 'do_not_contact', label: 'Do not contact (yes/no)' },
    { key: 'current_customer', label: 'Already an MCPS customer (yes/no)' },
    // A campaign already under way (Plan changes 2026-11-12).
    { key: 'planned_start', label: 'Planned start date' }, { key: 'intro_sent_on', label: 'Intro already sent on (date)' },
    { key: 'flag_reason', label: 'Hold for review (reason)' }, { key: '', label: 'Ignore this column' }
  ];
  // Header words → field. Checked against the header with punctuation and case removed.
  var SYNONYMS = [
    ['first_name', /^(first|firstname|first name|fname|given name|nombre)$/],
    ['last_name', /^(last|lastname|last name|lname|surname|family name|apellido)$/],
    ['full_name', /^(name|full name|fullname|customer|customer name|client|client name|homeowner|homeowner name|owner|owner name|contact|contact name)$/],
    ['email', /(^|\b)(e ?mail|email address|e mail address|correo)(\b|$)/],
    ['phone', /(^|\b)(phone|mobile|cell|telephone|tel|phone number|phone #|celular)(\b|$)/],
    ['address', /^(address|full address|property address|service address|pool address|home address|location|direccion)$/],
    ['street', /^(street|street address|address 1|address line 1|addr1|address1)$/],
    ['city', /^(city|town|ciudad)$/], ['state', /^(state|st|province)$/],
    ['zip', /^(zip|zipcode|zip code|postal|postal code|postcode)$/],
    ['area', /^(area|region|service area|neighborhood|neighbourhood|subdivision|community)$/],
    ['pool_build_year', /(build|built|install|construction|completion).*(year|date)|^(year built|build year|pool year|year)$/],
    ['tags', /^(tags?|labels?|categories|category|segment|groups?)$/],
    ['notes', /^(notes?|comments?|remarks|memo)$/],
    ['do_not_contact', /(do not (contact|email|mail)|dnc|unsubscribed|opt ?out|no email|no contact)/],
    ['current_customer', /(current|existing|active).*(mcps|customer|client)|^(mcps customer|is customer|customer\?)$/],
    ['planned_start', /^(planned start|planned start date|start date|batch start|batch date|day 1 planned)$/],
    ['intro_sent_on', /^(intro sent|intro sent on|intro already sent on|introduction sent|day 1 sent)$/],
    ['flag_reason', /^(flag|flag reason|hold for review|review flag|hold reason)$/]
  ];
  var EMAIL_RE = /[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
  var EMAIL_ONE = /^[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

  function clean(v) { return String(v == null ? '' : v).replace(/ /g, ' ').replace(/\s+/g, ' ').trim(); }
  function headerWords(h) { return clean(h).toLowerCase().replace(/[_\-./:()]+/g, ' ').replace(/[^a-z0-9#?& ]/g, '').replace(/\s+/g, ' ').trim(); }

  // CSV or TSV (a paste from Google Sheets is tab-separated). Quotes, embedded
  // commas and newlines, CRLF and a BOM are handled.
  function parseDelimited(text) {
    text = String(text || '').replace(/^﻿/, '');
    // The separator is judged on the first 10 lines, not the first: exports often open with a title line.
    var head = text.split(/\r?\n/).slice(0, 10).join('\n');
    var count = function (re) { return (head.match(re) || []).length; };
    var tabs = count(/\t/g), commas = count(/,/g), semis = count(/;/g);
    var delim = tabs && tabs >= commas / 2 ? '\t' : (semis > commas ? ';' : ',');
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    // Blank rows are kept, so row numbers match the file; later steps skip them.
    return rows;
  }

  // The header row: within the first 15 rows, the one whose cells look most like
  // header words, preferring one followed by a row with an email in it.
  function findHeaderRow(rows) {
    var best = 0, bestScore = -1;
    for (var i = 0; i < Math.min(rows.length, 15); i++) {
      var cells = (rows[i] || []).map(headerWords).filter(Boolean);
      if (cells.length < 2) continue;
      var known = cells.filter(function (c) { return SYNONYMS.some(function (s) { return s[1].test(c); }); }).length;
      var hasEmailBelow = (rows[i + 1] || []).some(function (c) { return EMAIL_ONE.test(clean(c).split(/[;,\s/]+/)[0] || ''); });
      var noEmailHere = !(rows[i] || []).some(function (c) { return /@/.test(String(c)); });
      var score = known * 3 + (hasEmailBelow ? 2 : 0) + (noEmailHere ? 1 : -5);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  // {columnIndex: fieldKey}. Header names first; then the values of still-unmapped
  // columns (a column of @-values is email, of 10-digit numbers is phone, …).
  function suggestMapping(headers, samples) {
    var map = {}, used = {};
    (headers || []).forEach(function (h, i) {
      var w = headerWords(h);
      for (var k = 0; k < SYNONYMS.length; k++) {
        var f = SYNONYMS[k][0];
        if (!used[f] && SYNONYMS[k][1].test(w)) { map[i] = f; used[f] = true; return; }
      }
    });
    var col = function (i) { return (samples || []).map(function (r) { return clean(r[i]); }).filter(Boolean); };
    (headers || []).forEach(function (h, i) {
      if (map[i] !== undefined) return;
      var v = col(i); if (!v.length) return;
      var share = function (re) { return v.filter(function (x) { return re.test(x); }).length / v.length; };
      if (!used.email && share(/@.+\./) >= 0.6) { map[i] = 'email'; used.email = true; }
      else if (!used.phone && share(/^\+?1?[\s.\-()]*\d{3}[\s.\-)]*\d{3}[\s.\-]*\d{4}$/) >= 0.6) { map[i] = 'phone'; used.phone = true; }
      else if (!used.zip && share(/^\d{5}(-\d{4})?$/) >= 0.8) { map[i] = 'zip'; used.zip = true; }
    });
    // Both a full name and first/last found: keep first/last, ignore the full name.
    if (used.first_name && used.last_name) Object.keys(map).forEach(function (i) { if (map[i] === 'full_name') delete map[i]; });
    return map;
  }

  function yes(v) { return /^(y|yes|true|1|x|si|sí|✓|✔)$/i.test(clean(v)); }
  function firstEmail(v) {
    var all = String(v || '').match(EMAIL_RE) || [];
    for (var i = 0; i < all.length; i++) { var e = all[i].toLowerCase().replace(/[.']+$/, ''); if (EMAIL_ONE.test(e)) return e; }
    return '';
  }
  function phone(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : clean(v);
  }
  function titleCase(s) {
    s = clean(s);
    if (s && (s === s.toUpperCase() || s === s.toLowerCase())) s = s.toLowerCase().replace(/(^|[\s\-'])([a-zà-ÿ])/g, function (m, a, b) { return a + b.toUpperCase(); });
    return s;
  }
  // "Lopez, Maria" | "Maria Lopez" | "Maria de la Cruz" | "Mr. and Mrs. John Smith"
  function splitName(full) {
    var s = clean(full).replace(/^(mr|mrs|ms|dr|miss)\.?\s+(and|&)\s+(mr|mrs|ms|dr)\.?\s+/i, '').replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, '');
    if (!s) return { first: '', last: '' };
    if (s.indexOf(',') > 0) { var p = s.split(','); return { first: titleCase(p.slice(1).join(' ')), last: titleCase(p[0]) }; }
    var w = s.split(' ');
    if (w.length === 1) return { first: titleCase(w[0]), last: '' };
    return { first: titleCase(w[0]), last: titleCase(w.slice(1).join(' ')) };
  }
  function year(v) {
    var m = clean(v).match(/\b(19[5-9]\d|20[0-4]\d)\b/);
    if (m) return m[1];
    var n = Number(v);                                  // an Excel date serial
    if (n > 20000 && n < 60000) return String(new Date(Date.UTC(1899, 11, 30) + n * 86400000).getUTCFullYear());
    return '';
  }

  // → { contacts: [...], skipped: [{row, reason, detail}], duplicates: [{row, email, first_row}] }
  // row numbers are spreadsheet row numbers (1-based), so the screen can point at them.
  function toContacts(rows, headerIndex, mapping, opts) {
    opts = opts || {};
    var cols = {};
    Object.keys(mapping || {}).forEach(function (i) { if (mapping[i]) (cols[mapping[i]] = cols[mapping[i]] || []).push(Number(i)); });
    var get = function (r, f) { return (cols[f] || []).map(function (i) { return clean(r[i]); }).filter(Boolean).join(' '); };
    var out = { contacts: [], skipped: [], duplicates: [] }, seen = {};
    for (var n = headerIndex + 1; n < rows.length; n++) {
      var r = rows[n] || [], rowNo = n + 1;
      if (!r.some(function (c) { return clean(c) !== ''; })) continue;
      var email = firstEmail(get(r, 'email'));
      var first = titleCase(get(r, 'first_name')), last = titleCase(get(r, 'last_name'));
      if (!first && !last && get(r, 'full_name')) { var sp = splitName(get(r, 'full_name')); first = sp.first; last = sp.last; }
      if (!email) { out.skipped.push({ row: rowNo, reason: get(r, 'email') ? 'bad_email' : 'no_email', detail: get(r, 'email') }); continue; }
      if (seen[email]) { out.duplicates.push({ row: rowNo, email: email, first_row: seen[email] }); continue; }
      seen[email] = rowNo;
      var street = get(r, 'street'), city = titleCase(get(r, 'city')), state = clean(get(r, 'state')).toUpperCase(), zip = get(r, 'zip');
      var address = get(r, 'address') || [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      out.contacts.push({
        row: rowNo, email_norm: email, first_name: first, last_name: last, phone: get(r, 'phone') ? phone(get(r, 'phone')) : '',
        address: address, city: city, state: state, zip: zip, area: titleCase(get(r, 'area')) || city,
        pool_build_year: year(get(r, 'pool_build_year')),
        tags: get(r, 'tags').split(/[,;|]+/).map(clean).filter(Boolean).map(function (t) { return t.toLowerCase(); }),
        notes: get(r, 'notes').slice(0, 500), do_not_contact: yes(get(r, 'do_not_contact')), current_customer: yes(get(r, 'current_customer')),
        planned_start: isoDate(get(r, 'planned_start')), intro_sent_on: isoDate(get(r, 'intro_sent_on')), flag_reason: get(r, 'flag_reason').slice(0, 200),
        source: clean(opts.source || '')
      });
    }
    return out;
  }

  // 2026-11-02, 11/02/26, 11/2/2026 or a spreadsheet day number → 2026-11-02; anything else → ''.
  function isoDate(v) {
    v = clean(v); var m;
    if ((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return pad(m[1], m[2], m[3]);
    if ((m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) return pad(m[3].length === 2 ? '20' + m[3] : m[3], m[1], m[2]);
    if (/^\d{5}(\.\d+)?$/.test(v)) { var d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 86400000); return d.toISOString().slice(0, 10); }
    return '';
  }
  function pad(y, mo, d) {
    mo = Number(mo); d = Number(d);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
  }

  // The same set of headers maps the same way next time.
  function mappingKey(headers) {
    return (headers || []).map(headerWords).filter(Boolean).sort().join('|').slice(0, 300);
  }

  return { FIELDS: FIELDS, isoDate: isoDate, parseDelimited: parseDelimited, findHeaderRow: findHeaderRow, suggestMapping: suggestMapping,
    toContacts: toContacts, mappingKey: mappingKey, splitName: splitName, firstEmail: firstEmail, phone: phone };
}));
