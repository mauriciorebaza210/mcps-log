// Funnel parity — the two calculators must agree.
//
//   node tests/funnel-parity.test.js        (exits non-zero on failure)
//
// ⚠️ WHY THIS EXISTS
//
// The Contracts page gets its numbers from one of TWO places:
//
//   api/contracts.js          buildContractsFunnel()      fast path, reads Sheets directly
//   appscript/SalesHub.js     handleGetSalesFunnel_()     fallback, via Apps Script
//
// The frontend tries the fast one and silently falls back. So the same page can be
// served by either, and the user cannot tell which.
//
// They agree today. Nothing structural keeps them agreeing — they are separate
// code in separate runtimes. If someone changes a rule in one, the page reports
// different numbers depending on which answered, with NO error and nothing red.
// A broken page announces itself; this one would just occasionally lie, and
// decisions would be made on whichever number happened to load.
//
// A shared implementation is not possible across the two runtimes, so this test is
// the substitute: one fixture through both, assert identical output.
//
// The fixture deliberately includes the three cases where the definitions are easy
// to get subtly wrong in one copy and not the other:
//   1. a deal SENT in June and SIGNED in July   → cohort attribution
//   2. an amendment                             → must be excluded from close rate
//   3. an empty current month                   → must still appear, reading zero
const fs = require('fs'), vm = require('vm'), path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..');

const DAY = 86400000;
const iso = d => new Date(d).toISOString();

const NOW  = Date.parse('2026-08-11T12:00:00Z');   // August — a deliberately quiet month
const JUN  = Date.parse('2026-06-10T12:00:00Z');
const JUL  = Date.parse('2026-07-05T12:00:00Z');
const TZ   = 'America/Chicago';

// ── One fixture, shared by both calculators ─────────────────────────────────
const APPROVALS = [
  // 1. sent June, signed July — must count in JUNE
  { approval_id:'A1', proposal_id:'P1', quote_id:'Q1', token:'t1', status:'APPROVED',
    sent_at: iso(JUN), responded_at: iso(JUL), expires_at: iso(JUN + 30*DAY),
    viewed_at: iso(JUN + DAY), target_agreement_id:'' },
  // 2. sent June, still open
  { approval_id:'A2', proposal_id:'P2', quote_id:'Q2', token:'t2', status:'SENT',
    sent_at: iso(JUN), responded_at:'', expires_at: iso(NOW + 3*DAY),
    viewed_at:'', target_agreement_id:'' },
  // 3. sent June, viewed but unsigned, expiring inside 7 days → live worklist
  { approval_id:'A3', proposal_id:'P3', quote_id:'Q3', token:'t3', status:'SENT',
    sent_at: iso(JUN), responded_at:'', expires_at: iso(NOW + 2*DAY),
    viewed_at: iso(JUN + 2*DAY), target_agreement_id:'' },
  // 4. sent July, signed same month
  { approval_id:'A4', proposal_id:'P4', quote_id:'Q4', token:'t4', status:'APPROVED',
    sent_at: iso(JUL), responded_at: iso(JUL + 4*DAY), expires_at: iso(JUL + 30*DAY),
    viewed_at: iso(JUL), target_agreement_id:'' },
  // 5. AN AMENDMENT — signed, and must NOT inflate the close rate
  { approval_id:'A5', proposal_id:'P5', quote_id:'Q1', token:'t5', status:'APPROVED',
    sent_at: iso(JUL), responded_at: iso(JUL + DAY), expires_at: iso(JUL + 30*DAY),
    viewed_at: iso(JUL), target_agreement_id:'AGR-AMD' },
  // 6–8. More signed June deals, deliberately SKEWED so median ≠ mean.
  // ⚠️ Without these every cohort had a single signed deal, where median and mean
  // are identical — so swapping one for the other in one copy went undetected.
  // Closes at 1, 2 and 100 days alongside #1's 25 → median 13.5, mean 32.
  { approval_id:'A6', proposal_id:'P6', quote_id:'Q6', token:'t6', status:'APPROVED',
    sent_at: iso(JUN), responded_at: iso(JUN + DAY), expires_at: iso(JUN + 30*DAY),
    viewed_at: iso(JUN), target_agreement_id:'' },
  { approval_id:'A7', proposal_id:'P7', quote_id:'Q7', token:'t7', status:'APPROVED',
    sent_at: iso(JUN), responded_at: iso(JUN + 2*DAY), expires_at: iso(JUN + 30*DAY),
    viewed_at: iso(JUN), target_agreement_id:'' },
  { approval_id:'A8', proposal_id:'P8', quote_id:'Q8', token:'t8', status:'APPROVED',
    sent_at: iso(JUN), responded_at: iso(JUN + 100*DAY), expires_at: iso(JUN + 30*DAY),
    viewed_at: iso(JUN), target_agreement_id:'' },
];

const AGREEMENTS = [
  // Original for Q1, signed 25 days after it was sent
  { agreement_id:'AGR-1', proposal_id:'P1', source_quote_id:'Q1', client_id:'C1', location_id:'L1',
    status:'SIGNED', signed_at: iso(JUL), agreement_type:'original' },
  // ⚠️ An AMENDMENT sharing Q1 — must never supply the close timestamp for Q1
  { agreement_id:'AGR-AMD', proposal_id:'P5', source_quote_id:'Q1', client_id:'C1', location_id:'L1',
    status:'SIGNED', signed_at: iso(JUL + DAY), agreement_type:'amendment',
    parent_agreement_id:'AGR-1' },
  // Original for Q4, blank type (legacy row) — must still count as original
  { agreement_id:'AGR-4', proposal_id:'P4', source_quote_id:'Q4', client_id:'C4', location_id:'L4',
    status:'SIGNED', signed_at: iso(JUL + 4*DAY), agreement_type:'' },
  { agreement_id:'AGR-6', proposal_id:'P6', source_quote_id:'Q6', client_id:'C6', location_id:'L6',
    status:'SIGNED', signed_at: iso(JUN + 1*DAY), agreement_type:'original' },
  { agreement_id:'AGR-7', proposal_id:'P7', source_quote_id:'Q7', client_id:'C7', location_id:'L7',
    status:'SIGNED', signed_at: iso(JUN + 2*DAY), agreement_type:'original' },
  { agreement_id:'AGR-8', proposal_id:'P8', source_quote_id:'Q8', client_id:'C8', location_id:'L8',
    status:'SIGNED', signed_at: iso(JUN + 100*DAY), agreement_type:'original' },
];

// ── GAS side, run in a vm with Sheets access stubbed ────────────────────────
function Sheet(headers, rows) {
  return {
    rows: [headers.slice(), ...rows],
    getLastRow() { return this.rows.length; },
    getDataRange() { return { getValues: () => this.rows }; }
  };
}

function objsToSheet(objs, headers) {
  return Sheet(headers, objs.map(o => headers.map(h => (o[h] === undefined ? '' : o[h]))));
}

const APPROVAL_HEADERS = ['approval_id','proposal_id','quote_id','token','status','customer_note',
  'sent_at','responded_at','expires_at','created_at','updated_at','viewed_at','target_agreement_id'];
const AGREEMENT_HEADERS = ['agreement_id','proposal_id','source_quote_id','client_id','location_id',
  'status','signed_at','agreement_type','parent_agreement_id','service_name','total'];

function runGasFunnel(months) {
  const sheets = {
    Proposal_Approvals: objsToSheet(APPROVALS, APPROVAL_HEADERS),
    Service_Agreements: objsToSheet(AGREEMENTS, AGREEMENT_HEADERS),
  };
  const ctx = {
    console, String, Number, Math, JSON, Array, Object, isNaN, RegExp, parseFloat, parseInt,
    Date: class FrozenDate extends Date {
      constructor(...a) { if (!a.length) super(NOW); else super(...a); }
      static now() { return NOW; }
      static parse(s) { return Date.parse(s); }
    },
    Logger: { log: () => {} },
    Session: { getScriptTimeZone: () => TZ },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    Utilities: {
      // America/Chicago is UTC-5 in June–August (CDT).
      formatDate: (d, tz, fmt) => {
        const x = new Date(d.getTime() - 5 * 3600000);
        const y = x.getUTCFullYear();
        const m = String(x.getUTCMonth() + 1).padStart(2, '0');
        const day = String(x.getUTCDate()).padStart(2, '0');
        return fmt === 'yyyy-MM' ? `${y}-${m}` : `${y}-${m}-${day}`;
      },
      getUuid: () => 'uuid'
    },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => null }),
                      getActiveSpreadsheet: () => ({ getSheetByName: () => null }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: { fetch: () => ({ getContentText: () => '{}' }) },
    HtmlService: { createHtmlOutputFromFile: () => ({ getContent: () => '' }) },
    DriveApp: {}, MailApp: {}, GmailApp: {}, Maps: {}, ScriptApp: {}, ContentService: {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, 'appscript/SalesHub.js'), 'utf8'), ctx,
                        { filename: 'SalesHub.js' }); }
  catch (e) { console.log('LOAD ERROR SalesHub.js: ' + e.message); process.exit(2); }

  ctx.__sheets = sheets;
  vm.runInContext(`
    ensureNormalizedSalesSheets_ = function () {};
    ensureSheet_ = function (n) { return __sheets[n] || { rows: [[]], getLastRow: function(){return 1;},
      getDataRange: function(){ return { getValues: function(){ return [[]]; } }; } }; };
    value_ = function (o, f) { return (o && o[f] != null) ? o[f] : ''; };
    sheetToObjects_ = function (sheet) {
      var h = sheet.rows[0];
      return { rows: sheet.rows.slice(1).map(function (r, i) {
        var o = {}; h.forEach(function (k, c) { o[k] = r[c]; }); o._rowNum = i + 2; return o;
      })};
    };
    nowIso_ = function () { return new Date().toISOString(); };
  `, ctx);

  return ctx.handleGetSalesFunnel_({ months: months });
}

// ── Compare ─────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

const METRICS = ['sent', 'viewed', 'signed', 'close_rate', 'median_days_to_close'];

(async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'api/contracts.js')).href);
  const vercel = mod.buildContractsFunnel(APPROVALS, AGREEMENTS, 6, new Date(NOW), TZ);
  const gas = runGasFunnel(6);

  console.log('\nBoth calculators answered');
  t('Vercel returned a funnel', !!vercel && Array.isArray(vercel.months));
  t('GAS returned a funnel', !!gas && gas.ok === true && Array.isArray(gas.months),
    '(' + (gas && gas.error || '') + ')');
  if (!vercel || !gas || !gas.ok) { console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); }

  const vMonth = k => vercel.months.find(m => m.month === k);
  const gMonth = k => gas.months.find(m => m.month === k);

  console.log('\nSame months are reported');
  const vKeys = vercel.months.map(m => m.month).sort();
  const gKeys = gas.months.map(m => m.month).sort();
  t('identical month sets', JSON.stringify(vKeys) === JSON.stringify(gKeys),
    '\n      Vercel: ' + vKeys.join(',') + '\n      GAS   : ' + gKeys.join(','));

  console.log('\nEvery metric agrees, month by month');
  vKeys.forEach(k => {
    const v = vMonth(k), g = gMonth(k);
    if (!v || !g) { t(`${k} present in both`, false); return; }
    METRICS.forEach(m => {
      t(`${k} · ${m}`, v[m] === g[m], `(Vercel ${JSON.stringify(v[m])} vs GAS ${JSON.stringify(g[m])})`);
    });
  });

  console.log('\nTop-level figures agree');
  [['expiring_soon'], ['amendments_signed'], ['viewed_tracking_since']].forEach(([k]) => {
    t(k, vercel[k] === gas[k], `(Vercel ${JSON.stringify(vercel[k])} vs GAS ${JSON.stringify(gas[k])})`);
  });
  t('current month matches',
    vercel.current && gas.current && vercel.current.month === gas.current.month,
    `(Vercel ${vercel.current && vercel.current.month} vs GAS ${gas.current && gas.current.month})`);
  METRICS.forEach(m => {
    t(`current · ${m}`, vercel.current[m] === gas.current[m],
      `(Vercel ${JSON.stringify(vercel.current[m])} vs GAS ${JSON.stringify(gas.current[m])})`);
  });
  const vLatest = vercel.latest_cohort ? vercel.latest_cohort.month : null;
  const gLatest = gas.latest_cohort ? gas.latest_cohort.month : null;
  t('latest_cohort matches', vLatest === gLatest, `(Vercel ${vLatest} vs GAS ${gLatest})`);

  // ── The three cases that are easy to get wrong in only one copy ───────────
  console.log('\nThe rules both must be applying (asserted on the shared answer)');
  const jun = vMonth('2026-06'), jul = vMonth('2026-07'), aug = vMonth('2026-08');

  t('June sent = 6 (cohort by SENT month)', jun && jun.sent === 6, '(got ' + (jun && jun.sent) + ')');
  t('June signed = 4 — the July signature counts in JUNE',
    jun && jun.signed === 4, '(got ' + (jun && jun.signed) + ')');
  // ⚠️ Closes at 1, 2, 25 and 100 days. MEDIAN is 13.5; the MEAN would be 32.
  // This is what makes swapping one for the other detectable.
  t('June median = 13.5d — median, not the 32d mean',
    jun && jun.median_days_to_close === 13.5, '(got ' + (jun && jun.median_days_to_close) + ')');
  t('  └ and GAS agrees', gMonth('2026-06').median_days_to_close === 13.5,
    '(got ' + gMonth('2026-06').median_days_to_close + ')');

  t('July sent = 1 — the AMENDMENT is excluded',
    jul && jul.sent === 1, '(got ' + (jul && jul.sent) + ')');
  t('July close rate = 100% and not inflated past it',
    jul && jul.close_rate === 100, '(got ' + (jul && jul.close_rate) + ')');
  t('amendment counted separately instead', vercel.amendments_signed === 1);
  t('  └ and GAS agrees', gas.amendments_signed === 1);
  t('July median = 4d — uses the ORIGINAL signature, not the amendment\'s 1d',
    jul && jul.median_days_to_close === 4, '(got ' + (jul && jul.median_days_to_close) + ')');
  t('  └ and GAS agrees', gMonth('2026-07').median_days_to_close === 4);

  t('August (current, quiet) still appears', !!aug);
  t('August reads zero rather than borrowing July', aug && aug.sent === 0);
  t('  └ and GAS agrees', gMonth('2026-08') && gMonth('2026-08').sent === 0);
  t('latest_cohort points at July as history', vLatest === '2026-07', '(got ' + vLatest + ')');

  t('expiring soon = 2 (live worklist, not cohort-scoped)',
    vercel.expiring_soon === 2, '(got ' + vercel.expiring_soon + ')');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\nHARNESS ERROR: ' + (e && e.stack || e));
  process.exit(2);
});
