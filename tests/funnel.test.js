// Stage 5b — sales funnel, viewed_at, and joined customer identity.
//
//   node tests/funnel.test.js        (exits non-zero on failure)
//
// Runs the REAL appscript/SalesHub.js in a vm with Apps Script services stubbed.
// The definitions being asserted here are the ones that make the numbers
// defensible: cohort attribution, median (not mean), amendment exclusion, and a
// signed-timestamp join that cannot pick up an amendment's signature.
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'appscript', 'SalesHub.js');

const DAY = 86400000;
const iso = d => new Date(d).toISOString();

function Sheet(headers, rows) {
  return {
    rows: [headers.slice(), ...rows.map(r => r.slice())],
    getLastRow() { return this.rows.length; },
    getDataRange() { return { getValues: () => this.rows }; }
  };
}

function build(opts) {
  const o = opts || {};
  const NOW = o.now || Date.parse('2026-08-11T12:00:00Z');
  const cache = {};

  const sheets = {
    Proposal_Approvals: Sheet(
      ['approval_id','proposal_id','quote_id','token','status','customer_note','sent_at',
       'responded_at','expires_at','created_at','updated_at','viewed_at','target_agreement_id'],
      o.approvals || []),
    Service_Agreements: Sheet(
      ['agreement_id','proposal_id','source_quote_id','client_id','location_id','status',
       'signed_at','agreement_type','service_name','total'],
      o.agreements || []),
    Clients: Sheet(['client_id','first_name','last_name','display_name','email'], o.clients || []),
    Client_Locations: Sheet(['location_id','client_id','service_address','city'], o.locations || []),
  };

  const quotes = Sheet(['quote_id','first_name','last_name','address','city','email'], o.quotes || []);
  const reads = { quotes: 0 };
  const origGetValues = quotes.getDataRange;
  quotes.getDataRange = function () { reads.quotes++; return origGetValues.call(this); };

  const ctx = {
    console, String, Number, Math, JSON, Array, Object, isNaN, RegExp, parseFloat, parseInt,
    Date: class FrozenDate extends Date {
      constructor(...a) { if (!a.length) super(NOW); else super(...a); }
      static now() { return NOW; }
      static parse(s) { return Date.parse(s); }
    },
    Logger: { log: () => {} },
    Session: { getScriptTimeZone: () => 'America/Chicago' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
    CacheService: { getScriptCache: () => ({
      get: k => (o.useCache ? (cache[k] || null) : null),
      put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; }
    })},
    Utilities: {
      // Minimal tz-aware month/day formatter: America/Chicago is UTC-5 in August.
      formatDate: (d, tz, fmt) => {
        const off = -5 * 3600000;
        const x = new Date(d.getTime() + off);
        const y = x.getUTCFullYear(), m = String(x.getUTCMonth() + 1).padStart(2, '0');
        const day = String(x.getUTCDate()).padStart(2, '0');
        return fmt === 'yyyy-MM' ? `${y}-${m}` : `${y}-${m}-${day}`;
      },
      getUuid: () => 'uuid'
    },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => null }), getActiveSpreadsheet: () => ({ getSheetByName: () => null }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: { fetch: () => ({ getContentText: () => '{}' }) },
    HtmlService: { createHtmlOutputFromFile: () => ({ getContent: () => '' }) },
    DriveApp: {}, MailApp: {}, GmailApp: {}, Maps: {}, ScriptApp: {}, ContentService: {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  try { vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'SalesHub.js' }); }
  catch (e) { console.log('LOAD ERROR: ' + e.message); process.exit(2); }

  ctx.__sheets = sheets; ctx.__quotes = quotes;
  vm.runInContext(`
    ensureNormalizedSalesSheets_ = function () {};
    ensureSheet_ = function (n) { return __sheets[n] || { rows: [[]], getLastRow: function(){return 1;},
                                   getDataRange: function(){return { getValues: function(){ return [[]]; } };} }; };
    ensureColumn_ = function (sheet, name) {
      if (sheet.rows[0].indexOf(name) !== -1) return;
      sheet.rows[0].push(name);
      for (var r = 1; r < sheet.rows.length; r++) sheet.rows[r].push('');
    };
    softSetCell_ = function (sheet, rowNum, field, val) {
      var i = sheet.rows[0].indexOf(field);
      if (i === -1) { sheet.rows[0].push(field); for (var r=1;r<sheet.rows.length;r++) sheet.rows[r].push(''); i = sheet.rows[0].length-1; }
      sheet.rows[rowNum - 1][i] = val;
    };
    value_ = function (o, f) { return (o && o[f] != null) ? o[f] : ''; };
    sheetToObjects_ = function (sheet) {
      var h = sheet.rows[0];
      return { rows: sheet.rows.slice(1).map(function (r, i) {
        var o = {}; h.forEach(function (k, c) { o[k] = r[c]; }); o._rowNum = i + 2; return o;
      })};
    };
    findRowByValue_ = function (sheet, field, val) {
      var h = sheet.rows[0], i = h.indexOf(field);
      if (i === -1) return null;
      for (var r = 1; r < sheet.rows.length; r++) {
        if (String(sheet.rows[r][i]) === String(val)) {
          var o = {}; h.forEach(function (k, c) { o[k] = sheet.rows[r][c]; }); o._rowNum = r + 1; return o;
        }
      }
      return null;
    };
    listSheetRows_ = function (name) {
      return sheetToObjects_(__sheets[name]).rows.map(function (r) {
        var c = {}; Object.keys(r).forEach(function (k) { if (k !== '_rowNum') c[k] = r[k]; }); return c;
      });
    };
    getQuoteById_ = function (id) {
      var h = __quotes.rows[0], i = h.indexOf('quote_id');
      for (var r = 1; r < __quotes.rows.length; r++) {
        if (String(__quotes.rows[r][i]) === String(id)) {
          var o = {}; h.forEach(function (k, c) { o[k] = __quotes.rows[r][c]; });
          return { object: o, sheet: __quotes, rowNum: r + 1 };
        }
      }
      return null;
    };
    nowIso_ = function () { return new Date().toISOString(); };
    getCrmSheet_ = function () { return __quotes; };
    headerIndex_ = function (headers, name) {
      for (var i = 0; i < headers.length; i++) {
        if (String(headers[i]).trim().toLowerCase() === String(name).trim().toLowerCase()) return i;
      }
      return -1;
    };
  `, ctx);
  return { ctx, sheets, quotes, NOW, reads };
}

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };
const col = (sheet, field, rowNum = 2) => {
  const i = sheet.rows[0].indexOf(field);
  return i === -1 ? undefined : sheet.rows[rowNum - 1][i];
};

const AP = (o) => [o.id || 'A1', o.proposal || 'P1', o.quote || 'Q1', o.token || 't1',
  o.status || 'SENT', '', o.sent_at || '', o.responded_at || '', o.expires_at || '',
  '', '', o.viewed_at || '', o.target || ''];
const AG = (o) => [o.id || 'AG1', o.proposal || 'P1', o.quote || 'Q1', o.client || '',
  o.location || '', o.status || 'SIGNED', o.signed_at || '', o.type || '', o.service || '', o.total || ''];

// ── viewed_at ───────────────────────────────────────────────────────────────
console.log('\nviewed_at is written once and stays isolated');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, approvals: [AP({ sent_at: iso(NOW - 3 * DAY) })] });
  const approvals = s.sheets.Proposal_Approvals;
  const before = col(approvals, 'updated_at');

  const row1 = s.ctx.findRowByValue_(approvals, 'approval_id', 'A1');
  s.ctx.recordApprovalViewed_(approvals, row1);
  const first = col(approvals, 'viewed_at');
  t('written on first view', !!first);
  t('updated_at NOT touched', col(approvals, 'updated_at') === before);

  const row2 = s.ctx.findRowByValue_(approvals, 'approval_id', 'A1');
  s.ctx.recordApprovalViewed_(approvals, row2);
  t('second view does not overwrite (first view, not last)', col(approvals, 'viewed_at') === first);

  // Must never throw into the customer's page.
  let threw = false;
  try { s.ctx.recordApprovalViewed_(null, null); } catch (e) { threw = true; }
  t('failure is swallowed, never propagated', threw === false);
}

// ── Funnel ──────────────────────────────────────────────────────────────────
console.log('\nCohort attribution: counted in the month SENT');
{
  const JUN = Date.parse('2026-06-10T12:00:00Z');
  const JUL = Date.parse('2026-07-05T12:00:00Z');
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW,
    approvals: [
      AP({ id: 'A1', proposal: 'P1', sent_at: iso(JUN), status: 'APPROVED', responded_at: iso(JUL) }),
      AP({ id: 'A2', proposal: 'P2', sent_at: iso(JUN), status: 'SENT' }),
    ],
    agreements: [AG({ id: 'AG1', proposal: 'P1', signed_at: iso(JUL), type: 'original' })] });
  const r = s.ctx.handleGetSalesFunnel_({});
  const jun = r.months.find(m => m.month === '2026-06');
  t('sent in June, signed in July → counts in June', !!jun && jun.sent === 2 && jun.signed === 1,
    JSON.stringify(jun));
  t('no phantom July cohort', !r.months.find(m => m.month === '2026-07'));
  t('close rate is signed ÷ sent for that cohort', jun.close_rate === 50, '(got ' + jun.close_rate + ')');
  t('median days uses signed_at − sent_at', jun.median_days_to_close === 25,
    '(got ' + jun.median_days_to_close + ')');
}

console.log('\ncurrent is always the CURRENT calendar month');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');   // August
  const JUN = Date.parse('2026-06-10T12:00:00Z');
  const s = build({ now: NOW,
    approvals: [AP({ id: 'A1', proposal: 'P1', sent_at: iso(JUN), status: 'SENT' })] });
  const r = s.ctx.handleGetSalesFunnel_({});
  // The bug: `current` used to be the newest month WITH data, so in August the
  // band read "Sent in June 2026" — indistinguishable from a stale page.
  t('current is August, not the last month with activity', r.current.month === '2026-08',
    '(got ' + r.current.month + ')');
  t('and it reads zero rather than borrowing June numbers', r.current.sent === 0);
  t('the active month is exposed separately as history',
    r.latest_cohort && r.latest_cohort.month === '2026-06' && r.latest_cohort.sent === 1);
  t('current month appears in the months list even when empty',
    r.months.some(m => m.month === '2026-08'));
}

console.log('No latest_cohort when the current month IS the active one');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW,
    approvals: [AP({ id: 'A1', proposal: 'P1', sent_at: iso(NOW - 2 * DAY), status: 'SENT' })] });
  const r = s.ctx.handleGetSalesFunnel_({});
  t('current month has the data', r.current.month === '2026-08' && r.current.sent === 1);
  t('no redundant historical pointer', r.latest_cohort === null);
}

console.log('\nMedian, not mean');
{
  const M = Date.parse('2026-07-01T12:00:00Z');
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  // Closes at 1, 2, 3 and 100 days. Mean ≈ 26.5, median = 2.5.
  const days = [1, 2, 3, 100];
  const s = build({ now: NOW,
    approvals: days.map((d, i) => AP({ id: 'A' + i, proposal: 'P' + i, sent_at: iso(M), status: 'APPROVED' })),
    agreements: days.map((d, i) => AG({ id: 'AG' + i, proposal: 'P' + i, signed_at: iso(M + d * DAY), type: 'original' })) });
  const r = s.ctx.handleGetSalesFunnel_({});
  const jul = r.months.find(m => m.month === '2026-07');
  t('one stalled deal does not drag the figure', jul.median_days_to_close === 2.5,
    '(got ' + jul.median_days_to_close + ')');
}

console.log('\nAmendments are excluded from the new-quote funnel');
{
  const M = Date.parse('2026-07-01T12:00:00Z');
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW,
    approvals: [
      AP({ id: 'A1', proposal: 'P1', sent_at: iso(M), status: 'SENT' }),
      // An amendment: nearly always signed, would inflate close rate to 100%.
      AP({ id: 'A2', proposal: 'P2', sent_at: iso(M), status: 'APPROVED', target: 'AG1' }),
    ]});
  const r = s.ctx.handleGetSalesFunnel_({});
  const jul2 = r.months.find(m => m.month === '2026-07');
  t('amendment not counted as a sent quote', jul2.sent === 1);
  t('amendment does not inflate close rate', jul2.close_rate === 0,
    '(got ' + jul2.close_rate + ')');
  t('reported separately instead', r.amendments_signed === 1);
}

console.log('\nSigned-timestamp join cannot pick up an amendment signature');
{
  const M = Date.parse('2026-07-01T12:00:00Z');
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  // Parent and amendment share source_quote_id — the collision the plan flags.
  const s = build({ now: NOW,
    approvals: [AP({ id: 'A1', proposal: 'P1', quote: 'Q1', sent_at: iso(M), status: 'APPROVED' })],
    agreements: [
      AG({ id: 'AG2', proposal: 'PX', quote: 'Q1', signed_at: iso(M + 1 * DAY), type: 'amendment' }),
      AG({ id: 'AG1', proposal: 'P1', quote: 'Q1', signed_at: iso(M + 20 * DAY), type: 'original' }),
    ]});
  const r = s.ctx.handleGetSalesFunnel_({});
  const jul3 = r.months.find(m => m.month === '2026-07');
  t('uses the ORIGINAL agreement signed_at, not the amendment',
    jul3.median_days_to_close === 20, '(got ' + jul3.median_days_to_close + ')');
}

console.log('\nresponded_at fallback when no agreement row exists');
{
  const M = Date.parse('2026-07-01T12:00:00Z');
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW,
    approvals: [AP({ id: 'A1', proposal: 'P9', sent_at: iso(M), status: 'APPROVED', responded_at: iso(M + 4 * DAY) })],
    agreements: [] });
  const r = s.ctx.handleGetSalesFunnel_({});
  const jul4 = r.months.find(m => m.month === '2026-07');
  t('falls back to responded_at', jul4.median_days_to_close === 4,
    '(got ' + jul4.median_days_to_close + ')');
}

console.log('\nExpiring soon is a live worklist, not cohort-scoped');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW,
    approvals: [
      AP({ id: 'A1', sent_at: iso(NOW - 300 * DAY), status: 'SENT', expires_at: iso(NOW + 3 * DAY) }),
      AP({ id: 'A2', sent_at: iso(NOW - 2 * DAY),   status: 'SENT', expires_at: iso(NOW + 20 * DAY) }),
      AP({ id: 'A3', sent_at: iso(NOW - 5 * DAY),   status: 'APPROVED', expires_at: iso(NOW + 2 * DAY) }),
      AP({ id: 'A4', sent_at: iso(NOW - 5 * DAY),   status: 'SENT', expires_at: iso(NOW - DAY) }),
    ]});
  const r = s.ctx.handleGetSalesFunnel_({});
  t('counts an old-cohort agreement expiring now', r.expiring_soon === 1, '(got ' + r.expiring_soon + ')');
  t('ignores far-off, already-signed and already-expired', r.expiring_soon === 1);
}

console.log('\nviewed tracking is labelled honestly');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW,
    approvals: [
      AP({ id: 'A1', sent_at: iso(NOW - 40 * DAY), status: 'SENT' }),                       // pre-tracking
      AP({ id: 'A2', sent_at: iso(NOW - 3 * DAY), status: 'SENT', viewed_at: iso(NOW - 2 * DAY) }),
    ]});
  const r = s.ctx.handleGetSalesFunnel_({});
  t('reports when view tracking began', !!r.viewed_tracking_since);
  t('so old quotes are not implied unopened', r.viewed_tracking_since === '2026-08-09',
    '(got ' + r.viewed_tracking_since + ')');
}

// ── Joined customer identity ────────────────────────────────────────────────
console.log('\nQuote fallback reads the sheet ONCE, not once per row');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const agreements = [], quoteRows = [];
  for (let i = 0; i < 30; i++) {
    agreements.push(AG({ id: 'AG' + i, client: '', location: '', quote: 'Q' + i }));
    quoteRows.push(['Q' + i, 'Cust', String(i), String(i) + ' Main St', 'San Antonio', '']);
  }
  const s = build({ now: NOW, agreements, quotes: quoteRows });
  s.ctx.withAgreementCustomer_(s.ctx.listSheetRows_('Service_Agreements'));
  // ⚠️ getQuoteById_ re-reads the entire Quotes sheet per call. Calling it per row
  // meant 30 contracts = 30 full-sheet scans, which is why names never arrived.
  t('30 contracts cause ONE Quotes read, not 30', s.reads.quotes === 1,
    '(reads: ' + s.reads.quotes + ')');
}

console.log('Index is not built when no row needs the fallback');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW,
    agreements: [AG({ id: 'AG1', client: 'C1', location: 'L1', quote: 'Q1' })],
    clients: [['C1','Jordan','Rivera','Rivera Household','j@x.com']],
    locations: [['L1','C1','123 Mission Creek Dr','San Antonio']],
    quotes: [['Q1','Someone','Else','999 Wrong St','Nowhere','']] });
  s.ctx.withAgreementCustomer_(s.ctx.listSheetRows_('Service_Agreements'));
  t('fully resolved rows never touch Quotes at all', s.reads.quotes === 0,
    '(reads: ' + s.reads.quotes + ')');
}

console.log('\nJoined customer identity: Clients → Locations → quote');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW,
    agreements: [AG({ id: 'AG1', client: 'C1', location: 'L1', quote: 'Q1' })],
    clients: [['C1','Jordan','Rivera','Rivera Household','j@x.com']],
    locations: [['L1','C1','123 Mission Creek Dr','San Antonio']],
    quotes: [['Q1','Someone','Else','999 Wrong St','Nowhere','']] });
  const out = s.ctx.withAgreementCustomer_(s.ctx.listSheetRows_('Service_Agreements'));
  t('prefers Clients.display_name over the quote', out[0].customer_name === 'Rivera Household',
    '(got ' + out[0].customer_name + ')');
  t('location label from Client_Locations',
    out[0].location_label === '123 Mission Creek Dr, San Antonio');
}

console.log('Falls back to the quote only when normalized records miss');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW,
    agreements: [AG({ id: 'AG1', client: '', location: '', quote: 'Q1' })],
    quotes: [['Q1','Jordan','Rivera','123 Mission Creek Dr','San Antonio','']] });
  const out = s.ctx.withAgreementCustomer_(s.ctx.listSheetRows_('Service_Agreements'));
  t('name from the quote', out[0].customer_name === 'Jordan Rivera');
  t('address from the quote', out[0].location_label === '123 Mission Creek Dr, San Antonio');
}

console.log('Unresolvable identity yields EMPTY, never a placeholder');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, agreements: [AG({ id: 'AG1', client: '', location: '', quote: '' })] });
  const out = s.ctx.withAgreementCustomer_(s.ctx.listSheetRows_('Service_Agreements'));
  t('customer_name is empty string', out[0].customer_name === '', '(got "' + out[0].customer_name + '")');
  t('never the literal word "Customer"', out[0].customer_name !== 'Customer');
  t('location_label empty too', out[0].location_label === '');
}

console.log('Client with no display_name uses first + last');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW,
    agreements: [AG({ id: 'AG1', client: 'C1', location: '', quote: '' })],
    clients: [['C1','Jordan','Rivera','','j@x.com']] });
  const out = s.ctx.withAgreementCustomer_(s.ctx.listSheetRows_('Service_Agreements'));
  t('composes first + last', out[0].customer_name === 'Jordan Rivera');
}

// ── 5c prerequisite: the source_quote_id landmine ───────────────────────────
console.log('\nAgreement lookup by quote id excludes amendments');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, agreements: [
    AG({ id: 'AG1', quote: 'Q1', type: 'original',  signed_at: iso(NOW - 10 * DAY) }),
    AG({ id: 'AG2', quote: 'Q1', type: 'amendment', signed_at: iso(NOW - 1 * DAY) }),
  ]});
  const sheet = s.ctx.ensureSheet_('Service_Agreements');
  const hit = s.ctx.findOriginalAgreementByQuote_(sheet, 'Q1');
  t('resolves the ORIGINAL, never the amendment', hit.row && hit.row.agreement_id === 'AG1',
    '(got ' + (hit.row && hit.row.agreement_id) + ')');
  t('counts only originals', hit.count === 1);
}

console.log('Legacy rows with a blank agreement_type count as original');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, agreements: [AG({ id: 'AG1', quote: 'Q1', type: '' })] });
  const hit = s.ctx.findOriginalAgreementByQuote_(s.ctx.ensureSheet_('Service_Agreements'), 'Q1');
  t('blank type still resolves', hit.row && hit.row.agreement_id === 'AG1');
}

console.log('Ambiguity is REFUSED, not guessed');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, agreements: [
    AG({ id: 'AG1', quote: 'Q1', type: 'original' }),
    AG({ id: 'AG2', quote: 'Q1', type: 'original' }),
  ]});
  const sheet = s.ctx.ensureSheet_('Service_Agreements');
  const hit = s.ctx.findOriginalAgreementByQuote_(sheet, 'Q1');
  t('two originals => no row returned', hit.row === null && hit.count === 2);
  // ⚠️ The strict helper must THROW, not return null. Returning null reads as
  // "none exists", and findOrCreateServiceAgreementFromQuote_ would then create a
  // THIRD original — turning a data fault into a worse one.
  let threw = false, msg = '';
  try { s.ctx.findOriginalAgreementByQuoteStrict_(sheet, 'Q1'); }
  catch (e) { threw = true; msg = String(e.message || e); }
  t('strict helper THROWS on ambiguity (never null)', threw, '(did not throw)');
  t('and the error names the fix', /Resolve by agreement_id/.test(msg));
}

console.log('Unknown quote resolves to nothing');
{
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const s = build({ now: NOW, agreements: [AG({ id: 'AG1', quote: 'Q1', type: 'original' })] });
  const hit = s.ctx.findOriginalAgreementByQuote_(s.ctx.ensureSheet_('Service_Agreements'), 'NOPE');
  t('no match, no guess', hit.row === null && hit.count === 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
