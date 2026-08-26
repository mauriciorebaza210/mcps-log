// Stage 5c — amendments.
//
//   node tests/amendments.test.js        (exits non-zero on failure)
//
// ⚠️ THE NEGATIVE TEST IN THIS FILE IS NON-NEGOTIABLE.
//
// Signing an original agreement has eight side effects. Three of them must never
// run for an amendment, plus the quote mirroring:
//
//   activateQuoteServiceFromAgreement_  → a SECOND pool_id + duplicate Routes row
//                                         (a phantom customer on the board)
//   markRepairOrdersApprovedForQuote_   → re-advances unrelated work orders
//   sendSignedAgreementWelcomeEmail_    → "Welcome to the Mission family" to an
//                                         existing customer
//   quote mirroring (contract_url etc.) → repoints the PARENT quote at the
//                                         addendum PDF
//
// The guarantee is structural: those calls live only on the original path, so the
// amendment path cannot reach them. This file proves it by spying on all four and
// asserting ZERO calls. If someone later reintroduces a shared `isAmendment` flag,
// this fails loudly.
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');

const iso = d => new Date(d).toISOString();
const DAY = 86400000;

function Sheet(headers, rows) {
  return {
    rows: [headers.slice(), ...rows.map(r => r.slice())],
    getLastRow() { return this.rows.length; },
    getDataRange() { return { getValues: () => this.rows } }
  };
}

function build(opts) {
  const o = opts || {};
  const NOW = o.now || Date.parse('2026-08-11T12:00:00Z');

  const sheets = {
    Service_Agreements: Sheet(
      ['agreement_id','agreement_number','client_id','location_id','proposal_id','source_quote_id',
       'status','signature_required','activation_method','service_type','service_name','monthly_rate',
       'tax_rate','sales_tax','total','sent_at','signed_at','activated_at','created_at','updated_at',
       'agreement_pdf_url','contract_url','contract_file_id','signed_pdf_url','signature_name',
       'signature_image_url','signature_method','signer_ip','signer_user_agent','consent_accepted',
       'consent_at','agreement_version','parent_agreement_id','agreement_type','amendment_reason'],
      o.agreements || []),
    Proposal_Approvals: Sheet(
      ['approval_id','proposal_id','quote_id','token','status','customer_note','sent_at',
       'responded_at','expires_at','created_at','updated_at','target_agreement_id'],
      o.approvals || []),
    Proposals: Sheet(
      ['proposal_id','proposal_number','legacy_quote_id','client_id','location_id','status',
       'service_type','proposal_title','created_by','valid_until','subtotal','tax_rate','sales_tax',
       'total','accepted_at','created_at','updated_at','amends_agreement_id'],
      o.proposals || []),
  };
  const quotes = Sheet(['quote_id','first_name','last_name','email','service','pool_id',
                        'contract_url','contract_download_url','contract_file_id','contract_generated',
                        'proposal_accepted_at','status'],
                       o.quotes || [['Q1','Blasa','Rodriguez','b@x.com','Weekly Full Service','P-100',
                                     'https://drive/ORIGINAL.pdf','https://drive/ORIGINAL-dl','file-1','Yes',
                                     '2026-06-01T00:00:00Z','ACTIVE_CUSTOMER']]);

  // The spies. Every one of these is a side effect that must not fire.
  const calls = { activate: 0, repairOrders: 0, welcome: 0, poolIdMinted: 0, routeSync: 0 };

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
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    Utilities: {
      formatDate: (d, tz, fmt) => d.toISOString().slice(0, 10),
      getUuid: () => 'uuid-' + Math.random().toString(36).slice(2, 10)
    },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => null }), getActiveSpreadsheet: () => ({ getSheetByName: () => null }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: { fetch: () => ({ getContentText: () => '{}' }) },
    HtmlService: { createHtmlOutputFromFile: () => ({ getContent: () => '' }) },
    DriveApp: {}, MailApp: {}, GmailApp: {}, Maps: {}, ScriptApp: {}, ContentService: {},
    __calls: calls
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  ['appscript/SalesHub.js', 'appscript/Amendments.js'].forEach(f => {
    try { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }); }
    catch (e) { console.log('LOAD ERROR ' + f + ': ' + e.message); process.exit(2); }
  });

  ctx.__sheets = sheets; ctx.__quotes = quotes;
  ctx.__realActivation = !!o.realActivation;
  vm.runInContext(`
    ensureNormalizedSalesSheets_ = function () {};
    ensureSheet_ = function (n) { return __sheets[n] || { rows: [[]], getLastRow: function(){return 1;},
      getDataRange: function(){ return { getValues: function(){ return [[]]; } }; } }; };
    ensureColumn_ = function (sheet, name) {
      if (!sheet || !sheet.rows) return;
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
    appendObject_ = function (sheet, obj) {
      Object.keys(obj).forEach(function (k) { ensureColumn_(sheet, k); });
      var h = sheet.rows[0];
      sheet.rows.push(h.map(function (k) { return obj[k] !== undefined ? obj[k] : ''; }));
      return sheet.rows.length;
    };
    nextSequence_ = function (sheet, field, prefix, pad) {
      var n = sheet.rows.length;
      return prefix + '-' + String(n).padStart(pad || 4, '0');
    };
    proposalApprovalToken_ = function () { return 'tok-' + Math.random().toString(36).slice(2, 10); };
    proposalApprovalUrl_ = function (t) { return 'https://x/agreement.html?token=' + t; };
    nowIso_ = function () { return new Date().toISOString(); };
    getQuoteById_ = function (id) {
      var h = __quotes.rows[0], i = h.indexOf('quote_id');
      for (var r = 1; r < __quotes.rows.length; r++) {
        if (String(__quotes.rows[r][i]) === String(id)) {
          var o = {}; h.forEach(function (k, c) { o[k] = __quotes.rows[r][c]; });
          return { object: o, sheet: __quotes, rowNum: r + 1, headers: h, row: __quotes.rows[r] };
        }
      }
      return null;
    };
    getCrmSheet_ = function () { return __quotes; };
    headerIndex_ = function (h, n) {
      for (var i = 0; i < h.length; i++) if (String(h[i]).toLowerCase() === String(n).toLowerCase()) return i;
      return -1;
    };
    saveProposalImageToDrive_ = function () { return 'https://drive/sig.png'; };
    renderSignedAgreementPdf_ = function () {
      return { url: 'https://drive/AMENDMENT.pdf', downloadUrl: 'https://drive/AMENDMENT-dl', fileId: 'file-amd' };
    };

    // ── SPIES: these must record ZERO calls on the amendment path ───────────
    if (!__realActivation) {
      activateQuoteServiceFromAgreement_ = function () { __calls.activate++; return { ok: true }; };
    }
    markRepairOrdersApprovedForQuote_  = function () { __calls.repairOrders++; };
    sendSignedAgreementWelcomeEmail_   = function () { __calls.welcome++; return { ok: true }; };
    _mcpsNextPoolId_                   = function () { __calls.poolIdMinted++; return 'P-999'; };
    syncQuoteOperationalSchedule_      = function () { __calls.routeSync++; };
    syncQuoteToNormalized_             = function () { return { ok: true, agreement_id: 'AGR-0001' }; };
  `, ctx);

  return { ctx, sheets, quotes, calls, NOW };
}

// Mirrors api/agreement/sign.js: whitelist the action, then dispatch exactly as
// WebhookReceiver's doPost does. If the proxy's contract changes, this must too.
function simulateProxy(ctx, body) {
  const requested = String(body.action || 'sign_agreement');
  if (requested !== 'sign_agreement' && requested !== 'sign_amendment') {
    return { ok: false, error: 'Unsupported signing action.' };
  }
  const payload = Object.assign({}, body, { action: requested });
  return requested === 'sign_amendment'
    ? ctx.handleSignAmendment_(payload)
    : ctx.handleSignAgreement_(payload);
}

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };
const cell = (sheet, id, field, idField = 'agreement_id') => {
  const h = sheet.rows[0], ii = h.indexOf(idField), fi = h.indexOf(field);
  for (let r = 1; r < sheet.rows.length; r++) {
    if (String(sheet.rows[r][ii]) === String(id)) return fi === -1 ? undefined : sheet.rows[r][fi];
  }
  return undefined;
};

// A signed parent agreement.
const PARENT = (o = {}) => ([
  o.id || 'AGR-0001', 'SA-001', 'C1', 'L1', 'P1', 'Q1',
  o.status || 'SIGNED', 'TRUE', 'IN_PORTAL_ESIGN', 'Weekly', 'Weekly Full Service', '180',
  '8.25', '14.85', '194.85', iso(Date.parse('2026-06-01T00:00:00Z')),
  o.signed_at === undefined ? iso(Date.parse('2026-06-02T00:00:00Z')) : o.signed_at,
  iso(Date.parse('2026-06-02T00:00:00Z')), '', '',
  'https://drive/ORIGINAL.pdf', 'https://drive/ORIGINAL.pdf', 'file-1', 'https://drive/ORIGINAL.pdf',
  'Blasa Rodriguez', 'https://drive/sig-orig.png', 'draw', '70.1.2.3', 'Mozilla/5.0', 'TRUE',
  iso(Date.parse('2026-06-02T00:00:00Z')), 'PROP-1',
  o.parent || '', o.type === undefined ? 'original' : o.type, ''
]);

// ── Creation ────────────────────────────────────────────────────────────────
console.log('\nCreating an amendment');
{
  const s = build({ agreements: [PARENT()] });
  const r = s.ctx.handleCreateAmendment_({
    parent_agreement_id: 'AGR-0001', amendment_type: 'upgrade',
    amendment_reason: 'Adding spa service', total: '216.50'
  });
  t('created', r.ok === true, '(' + (r.error || '') + ')');
  t('has its own agreement id', !!r.amendment_id && r.amendment_id !== 'AGR-0001');
  t('has its own proposal', !!r.proposal_id);
  t('has its own signing link', /token=/.test(r.sign_url || ''));

  t('amendment row is typed as an amendment',
    cell(s.sheets.Service_Agreements, r.amendment_id, 'agreement_type') === 'amendment');
  t('parent recorded in parent_agreement_id',
    cell(s.sheets.Service_Agreements, r.amendment_id, 'parent_agreement_id') === 'AGR-0001');

  // ⚠️ The transposition guard: the approval must target the AMENDMENT.
  const approvals = s.sheets.Proposal_Approvals;
  const tgt = cell(approvals, r.approval_id, 'target_agreement_id', 'approval_id');
  t('approval targets the AMENDMENT, not the parent', tgt === r.amendment_id,
    '(got ' + tgt + ')');
  t('and specifically is NOT the parent id', tgt !== 'AGR-0001');

  // The parent must be untouched by creation.
  t('parent row still SIGNED', cell(s.sheets.Service_Agreements, 'AGR-0001', 'status') === 'SIGNED');
  t('parent PDF unchanged',
    cell(s.sheets.Service_Agreements, 'AGR-0001', 'signed_pdf_url') === 'https://drive/ORIGINAL.pdf');
}

console.log('\nRefuses invalid parents');
{
  let s = build({ agreements: [PARENT({ signed_at: '' })] });
  let r = s.ctx.handleCreateAmendment_({ parent_agreement_id: 'AGR-0001' });
  t('cannot amend an UNSIGNED agreement', r.ok === false && /not signed/i.test(r.error));

  s = build({ agreements: [PARENT({ id: 'AGR-0002', type: 'amendment', parent: 'AGR-0001' })] });
  r = s.ctx.handleCreateAmendment_({ parent_agreement_id: 'AGR-0002' });
  t('cannot amend an amendment', r.ok === false && /amend an amendment/i.test(r.error));

  s = build({ agreements: [PARENT()] });
  r = s.ctx.handleCreateAmendment_({});
  t('requires a parent id', r.ok === false);
  r = s.ctx.handleCreateAmendment_({ parent_agreement_id: 'NOPE' });
  t('unknown parent refused', r.ok === false);
}

// ══════════════════════════════════════════════════════════════════════════════
// THE NEGATIVE TEST
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n⚠️  NEGATIVE TEST — amendment signing must trigger NONE of the original-only effects');
{
  const s = build({ agreements: [PARENT()] });
  const created = s.ctx.handleCreateAmendment_({
    parent_agreement_id: 'AGR-0001', amendment_type: 'upgrade',
    amendment_reason: 'Adding spa service', total: '216.50'
  });
  const token = cell(s.sheets.Proposal_Approvals, created.approval_id, 'token', 'approval_id');

  const before = {
    quoteContract:  s.quotes.rows[1][s.quotes.rows[0].indexOf('contract_url')],
    quoteDownload:  s.quotes.rows[1][s.quotes.rows[0].indexOf('contract_download_url')],
    quoteFileId:    s.quotes.rows[1][s.quotes.rows[0].indexOf('contract_file_id')],
    quoteAccepted:  s.quotes.rows[1][s.quotes.rows[0].indexOf('proposal_accepted_at')],
    poolId:         s.quotes.rows[1][s.quotes.rows[0].indexOf('pool_id')],
    parentRow:      JSON.stringify(s.sheets.Service_Agreements.rows[1])
  };

  const r = s.ctx.handleSignAmendment_({
    token: token, signature_name: 'Blasa Rodriguez', signature_method: 'typed',
    consent: true, signer_ip: '70.1.2.3', signer_user_agent: 'Mozilla/5.0'
  });
  t('amendment signs successfully', r.ok === true, '(' + (r.error || '') + ')');

  t('ZERO calls to activateQuoteServiceFromAgreement_', s.calls.activate === 0,
    '(called ' + s.calls.activate + ' times — would mint a second pool_id)');
  t('ZERO calls to markRepairOrdersApprovedForQuote_', s.calls.repairOrders === 0,
    '(called ' + s.calls.repairOrders + ' times)');
  t('ZERO calls to sendSignedAgreementWelcomeEmail_', s.calls.welcome === 0,
    '(called ' + s.calls.welcome + ' times — existing customer would be re-welcomed)');
  t('ZERO new pool_id minted', s.calls.poolIdMinted === 0);
  t('ZERO route rows created', s.calls.routeSync === 0);

  // Quote mirroring — the fourth forbidden effect.
  const q = s.quotes.rows[1], qh = s.quotes.rows[0];
  t('parent QUOTE contract_url untouched',
    q[qh.indexOf('contract_url')] === before.quoteContract,
    '(now ' + q[qh.indexOf('contract_url')] + ')');
  t('parent QUOTE contract_download_url untouched',
    q[qh.indexOf('contract_download_url')] === before.quoteDownload);
  t('parent QUOTE contract_file_id untouched',
    q[qh.indexOf('contract_file_id')] === before.quoteFileId);
  t('parent QUOTE proposal_accepted_at untouched',
    q[qh.indexOf('proposal_accepted_at')] === before.quoteAccepted);
  t('parent QUOTE pool_id untouched', q[qh.indexOf('pool_id')] === before.poolId);

  // The parent agreement row itself.
  t('parent agreement row byte-identical',
    JSON.stringify(s.sheets.Service_Agreements.rows[1]) === before.parentRow);

  // And the amendment DID get its audit trail.
  const amd = created.amendment_id;
  t('amendment row marked SIGNED', cell(s.sheets.Service_Agreements, amd, 'status') === 'SIGNED');
  t('amendment has its own PDF, not the parent\'s',
    cell(s.sheets.Service_Agreements, amd, 'signed_pdf_url') === 'https://drive/AMENDMENT.pdf');
  t('amendment carries the ESIGN audit trail',
    cell(s.sheets.Service_Agreements, amd, 'signer_ip') === '70.1.2.3' &&
    cell(s.sheets.Service_Agreements, amd, 'consent_accepted') === 'TRUE');
  t('activation method distinguishes it',
    cell(s.sheets.Service_Agreements, amd, 'activation_method') === 'IN_PORTAL_ESIGN_AMENDMENT');
}

// ── Target resolution ───────────────────────────────────────────────────────
console.log('\nTarget is resolved from the TOKEN, never the client');
{
  const s = build({ agreements: [PARENT()] });
  const created = s.ctx.handleCreateAmendment_({ parent_agreement_id: 'AGR-0001', total: '216.50' });
  const token = cell(s.sheets.Proposal_Approvals, created.approval_id, 'token', 'approval_id');

  // Hostile payload: try to redirect the signature onto the executed parent.
  const r = s.ctx.handleSignAmendment_({
    token: token, agreement_id: 'AGR-0001', target_agreement_id: 'AGR-0001',
    signature_name: 'Attacker', signature_method: 'typed', consent: true
  });
  t('signs the amendment despite a hostile agreement_id', r.amendment_id === created.amendment_id);
  t('parent NOT signed by the injected id',
    cell(s.sheets.Service_Agreements, 'AGR-0001', 'signature_name') === 'Blasa Rodriguez');
  t('parent signer_ip unchanged',
    cell(s.sheets.Service_Agreements, 'AGR-0001', 'signer_ip') === '70.1.2.3');
}

console.log('\nRefuses to sign a non-amendment target');
{
  const s = build({ agreements: [PARENT()],
    approvals: [['APR-9','P1','Q1','tok-bad','SENT','', iso(Date.now()), '',
                 iso(Date.now() + 30 * DAY), '', '', 'AGR-0001']] });   // targets an ORIGINAL
  const r = s.ctx.handleSignAmendment_({
    token: 'tok-bad', signature_name: 'X', signature_method: 'typed', consent: true });
  t('refuses when the target is not an amendment', r.ok === false && /not an amendment/i.test(r.error),
    '(' + (r.error || 'signed!') + ')');
  t('and the original keeps its signature',
    cell(s.sheets.Service_Agreements, 'AGR-0001', 'signature_name') === 'Blasa Rodriguez');
}

console.log('\nStandard signing-link guards still apply');
{
  let s = build({ agreements: [PARENT()] });
  let r = s.ctx.handleSignAmendment_({ token: '', signature_name: 'X', consent: true });
  t('missing token refused', r.ok === false);
  r = s.ctx.handleSignAmendment_({ token: 'nope', signature_name: 'X', consent: true });
  t('unknown token refused', r.ok === false);

  s = build({ agreements: [PARENT()] });
  let c = s.ctx.handleCreateAmendment_({ parent_agreement_id: 'AGR-0001' });
  let tk = cell(s.sheets.Proposal_Approvals, c.approval_id, 'token', 'approval_id');
  r = s.ctx.handleSignAmendment_({ token: tk, signature_name: '', consent: true });
  t('signature name required', r.ok === false);
  r = s.ctx.handleSignAmendment_({ token: tk, signature_name: 'X', consent: false });
  t('consent required', r.ok === false);

  // An approval token that is not an amendment at all.
  s = build({ agreements: [PARENT()],
    approvals: [['APR-1','P1','Q1','tok-plain','SENT','', iso(Date.now()), '',
                 iso(Date.now() + 30 * DAY), '', '', '']] });
  r = s.ctx.handleSignAmendment_({ token: 'tok-plain', signature_name: 'X', consent: true });
  t('a normal agreement token is rejected here', r.ok === false && /not an amendment/i.test(r.error));
}

// ══════════════════════════════════════════════════════════════════════════════
// THE PUBLIC ROUTE
//
// The direct-call tests above prove handleSignAmendment_ is safe. They do NOT
// prove the browser can reach it. That was the real gap: the page loaded via
// get_proposal_approval and posted to /api/agreement/sign, which hard-coded
// action = 'sign_agreement' — so an amendment link ran the ORIGINAL path.
//
// These tests walk the whole path a customer actually takes.
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n⚠️  PUBLIC ROUTE — the path a customer actually takes');
{
  const s = build({ agreements: [PARENT()] });
  const created = s.ctx.handleCreateAmendment_({
    parent_agreement_id: 'AGR-0001', amendment_type: 'upgrade',
    amendment_reason: 'Adding spa service', total: '216.50', monthly_rate: '200.00',
    sales_tax: '16.50', service_name: 'Weekly Full Service + Spa'
  });
  const token = cell(s.sheets.Proposal_Approvals, created.approval_id, 'token', 'approval_id');

  // 1. The page loads through the SAME action the browser calls.
  const page = s.ctx.handleGetProposalApproval_({ token: token });
  t('amendment link loads through get_proposal_approval', page.ok === true, '(' + (page.error||'') + ')');
  t('server flags it as an amendment', page.is_amendment === true);
  t('server dictates the signing action', page.sign_action === 'sign_amendment',
    '(got ' + page.sign_action + ')');

  // 2. It shows the AMENDMENT's pricing, not the parent's.
  t('page shows the amendment total, not the parent total',
    String(page.proposal.total) === '216.50', '(got ' + page.proposal.total + ')');
  t('page does not leak the parent discount/travel lines',
    !String(page.proposal.discount_amount) && !String(page.proposal.travel_fee));

  // 3. Submitting through the proxy contract: action comes from sign_action.
  const proxied = simulateProxy(s.ctx, {
    action: page.sign_action, token: token,
    signature_name: 'Blasa Rodriguez', signature_method: 'typed', consent: true,
    signer_ip: '70.1.2.3', signer_user_agent: 'Mozilla/5.0'
  });
  t('proxy routes it to sign_amendment', proxied.ok === true, '(' + (proxied.error||'') + ')');
  t('and still ZERO original-only side effects',
    s.calls.activate === 0 && s.calls.repairOrders === 0 &&
    s.calls.welcome === 0 && s.calls.poolIdMinted === 0,
    '(activate=' + s.calls.activate + ' repair=' + s.calls.repairOrders +
    ' welcome=' + s.calls.welcome + ' pool=' + s.calls.poolIdMinted + ')');
  t('parent QUOTE contract_url untouched via the public path',
    s.quotes.rows[1][s.quotes.rows[0].indexOf('contract_url')] === 'https://drive/ORIGINAL.pdf');
}

console.log('An ORDINARY agreement still routes to sign_agreement');
{
  const s = build({ agreements: [PARENT()],
    approvals: [['APR-1','P1','Q1','tok-plain','SENT','', iso(Date.now()), '',
                 iso(Date.now() + 30 * DAY), '', '', '']],
    proposals: [['P1','SA-001','Q1','C1','L1','SENT','Weekly','Prop','', '2026-09-09',
                 '180','8.25','14.85','194.85','','','','']] });
  const page = s.ctx.handleGetProposalApproval_({ token: 'tok-plain' });
  t('ordinary link loads', page.ok === true, '(' + (page.error||'') + ')');
  t('not flagged as an amendment', page.is_amendment === false);
  t('routes to sign_agreement', page.sign_action === 'sign_agreement');
}

console.log('Defence in depth: an amendment token forced onto the ORIGINAL path');
{
  const s = build({ agreements: [PARENT()] });
  const created = s.ctx.handleCreateAmendment_({ parent_agreement_id: 'AGR-0001', total: '216.50' });
  const token = cell(s.sheets.Proposal_Approvals, created.approval_id, 'token', 'approval_id');

  // Simulate a stale page, a replay, or a future proxy bug.
  const forced = simulateProxy(s.ctx, {
    action: 'sign_agreement', token: token,
    signature_name: 'Blasa Rodriguez', signature_method: 'typed', consent: true
  });
  t('original path REFUSES an amendment token', forced.ok === false,
    '(it signed! ' + JSON.stringify(forced).slice(0, 90) + ')');
  t('and says why', /amendment link/i.test(forced.error || ''));
  t('refused BEFORE any activation', s.calls.activate === 0 && s.calls.poolIdMinted === 0);
  t('refused BEFORE any welcome email', s.calls.welcome === 0);
  t('parent quote untouched',
    s.quotes.rows[1][s.quotes.rows[0].indexOf('contract_url')] === 'https://drive/ORIGINAL.pdf');
}

console.log('respond_to_proposal on an amendment must not touch the parent');
{
  const s = build({ agreements: [PARENT()] });
  const created = s.ctx.handleCreateAmendment_({ parent_agreement_id: 'AGR-0001', total: '216.50' });
  const token = cell(s.sheets.Proposal_Approvals, created.approval_id, 'token', 'approval_id');
  const qh = s.quotes.rows[0], before = JSON.stringify(s.quotes.rows[1]);

  const r = s.ctx.handleRespondToProposal_({ token: token, response: 'changes', note: 'cheaper please' });
  t('changes-requested accepted', r.ok === true && r.amendment === true, '(' + JSON.stringify(r).slice(0,80) + ')');
  t('parent QUOTE row byte-identical', JSON.stringify(s.quotes.rows[1]) === before);
  t('no contract generated or sent for the parent', s.calls.repairOrders === 0);

  // A fresh amendment per response — an approval that has already been responded
  // to short-circuits, which would mask what these assertions are testing.
  const s2 = build({ agreements: [PARENT()] });
  const c2 = s2.ctx.handleCreateAmendment_({ parent_agreement_id: 'AGR-0001', total: '216.50' });
  const tk2 = cell(s2.sheets.Proposal_Approvals, c2.approval_id, 'token', 'approval_id');
  const before2 = JSON.stringify(s2.quotes.rows[1]);
  s2.ctx.handleRespondToProposal_({ token: tk2, response: 'decline', note: 'no thanks' });
  t('decline recorded on the AMENDMENT row',
    cell(s2.sheets.Service_Agreements, c2.amendment_id, 'status') === 'DECLINED',
    '(got ' + cell(s2.sheets.Service_Agreements, c2.amendment_id, 'status') + ')');
  t('parent agreement still SIGNED',
    cell(s2.sheets.Service_Agreements, 'AGR-0001', 'status') === 'SIGNED');
  t('parent QUOTE still byte-identical', JSON.stringify(s2.quotes.rows[1]) === before2);

  const s3 = build({ agreements: [PARENT()] });
  const c3 = s3.ctx.handleCreateAmendment_({ parent_agreement_id: 'AGR-0001', total: '216.50' });
  const tk3 = cell(s3.sheets.Proposal_Approvals, c3.approval_id, 'token', 'approval_id');
  const a = s3.ctx.handleRespondToProposal_({ token: tk3, response: 'approve' });
  t('approving an amendment here is refused (it must be signed)', a.ok === false,
    '(got ' + JSON.stringify(a).slice(0, 90) + ')');
  t('and no contract was generated for the parent', s3.calls.repairOrders === 0);
}

// ══════════════════════════════════════════════════════════════════════════════
// ACTIVATION EDGES
//
// Activation is the destructive one: it mints a pool_id, flips the quote to
// ACTIVE_CUSTOMER and creates Routes rows. None of that is undoable, so it must
// validate BEFORE it writes, and must never run from an amendment.
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n⚠️  ACTIVATION — validates before it mutates');
{
  // Real activation this time, not the spy.
  const s = build({ realActivation: true, agreements: [PARENT()],
    quotes: [['Q9','New','Customer','n@x.com','Weekly Full Service','', '', '', '', '', '', 'LEAD']] });
  const qBefore = JSON.stringify(s.quotes.rows[1]);
  const r = s.ctx.activateQuoteServiceFromAgreement_('Q9', iso(Date.now()), 'IN_PORTAL_ESIGN', '');
  t('missing agreement_id is REFUSED', r.ok === false && /explicit agreement_id/i.test(r.error || ''),
    '(' + JSON.stringify(r).slice(0, 90) + ')');
  t('and it mutated NOTHING — no pool_id, no status, no routes',
    JSON.stringify(s.quotes.rows[1]) === qBefore);
  t('no pool id minted', s.calls.poolIdMinted === 0);
  t('no route sync', s.calls.routeSync === 0);

  const r2 = s.ctx.activateQuoteServiceFromAgreement_('Q9', iso(Date.now()), 'IN_PORTAL_ESIGN', 'AGR-NOPE');
  t('unknown agreement_id is refused', r2.ok === false && /not found/i.test(r2.error || ''));
  t('still mutated nothing', JSON.stringify(s.quotes.rows[1]) === qBefore);
}

console.log('ACTIVATION from an AMENDMENT is refused');
{
  const s = build({ realActivation: true, agreements: [PARENT()] });
  const created = s.ctx.handleCreateAmendment_({ parent_agreement_id: 'AGR-0001', total: '216.50' });
  const qBefore = JSON.stringify(s.quotes.rows[1]);
  const r = s.ctx.activateQuoteServiceFromAgreement_('Q1', iso(Date.now()), 'IN_PORTAL_ESIGN',
                                                     created.amendment_id);
  t('activation from an amendment id is refused',
    r.ok === false && /amendment/i.test(r.error || ''), '(' + JSON.stringify(r).slice(0, 90) + ')');
  t('parent quote untouched — no second pool_id', JSON.stringify(s.quotes.rows[1]) === qBefore);
  t('no pool id minted', s.calls.poolIdMinted === 0);
}

// NOTE: three blocks were removed with the retirement of the SignRequest -> Zapier
// callback (`service_agreement_signed` / handleServiceAgreementSigned_). They covered
// that external, secret-authenticated entry point refusing amendment ids and rejecting
// conflicting identifiers. The route is gone, so the failure modes are gone with it.
// The in-portal guards (handleSignAgreement_, activate_service_account_from_agreement,
// handleRespondToProposal_) are still covered below.

console.log('STAFF activate_service_account_from_agreement refuses an amendment');
{
  const s = build({ agreements: [PARENT()] });
  const created = s.ctx.handleCreateAmendment_({ parent_agreement_id: 'AGR-0001', total: '216.50' });
  // Mark it signed so only the type check can stop it.
  const agr = s.sheets.Service_Agreements;
  for (let i = 1; i < agr.rows.length; i++) {
    if (String(agr.rows[i][agr.rows[0].indexOf('agreement_id')]) === created.amendment_id) {
      agr.rows[i][agr.rows[0].indexOf('status')] = 'SIGNED';
      agr.rows[i][agr.rows[0].indexOf('signed_at')] = iso(Date.now());
    }
  }
  const amdRow = s.ctx.findRowByValue_(agr, 'agreement_id', created.amendment_id);
  t('agreementCanActivate_ says NO for a signed amendment',
    s.ctx.agreementCanActivate_(amdRow) === false);

  const r = s.ctx.handleNormalizedSalesAction_({
    action: 'activate_service_account_from_agreement', agreement_id: created.amendment_id });
  t('staff route refuses an amendment', r.ok === false && /amendment/i.test(r.error || ''),
    '(' + JSON.stringify(r).slice(0, 100) + ')');
  t('no activation ran', s.calls.activate === 0);
}

console.log('Amendment token with a broken target FAILS instead of showing parent data');
{
  const s = build({ agreements: [PARENT()],
    approvals: [['APR-9','P1','Q1','tok-orphan','SENT','', iso(Date.now()), '',
                 iso(Date.now() + 30 * DAY), '', '', 'AGR-GONE']] });
  const page = s.ctx.handleGetProposalApproval_({ token: 'tok-orphan' });
  t('missing target row => explicit failure', page.ok === false,
    '(rendered anyway: ' + JSON.stringify(page).slice(0, 80) + ')');

  const s2 = build({ agreements: [PARENT()],
    approvals: [['APR-9','P1','Q1','tok-mistyped','SENT','', iso(Date.now()), '',
                 iso(Date.now() + 30 * DAY), '', '', 'AGR-0001']] });   // points at an ORIGINAL
  const page2 = s2.ctx.handleGetProposalApproval_({ token: 'tok-mistyped' });
  t('target that is not an amendment => explicit failure', page2.ok === false);
  t('never silently renders the parent quote', !(page2.proposal && page2.proposal.total));
}

console.log('\nACTIVATION requires the agreement to BELONG to the quote');
{
  // AGR-0001 belongs to Q1. Q2 is a different customer entirely.
  const s = build({ realActivation: true, agreements: [PARENT()],
    quotes: [['Q1','Blasa','Rodriguez','b@x.com','Weekly Full Service','P-100',
              'https://drive/ORIGINAL.pdf','https://drive/ORIGINAL-dl','file-1','Yes',
              '2026-06-01T00:00:00Z','ACTIVE_CUSTOMER'],
             ['Q2','Someone','Else','s@x.com','Weekly Full Service','', '', '', '', '', '', 'LEAD']] });

  const q2Before = JSON.stringify(s.quotes.rows[2]);
  const r = s.ctx.activateQuoteServiceFromAgreement_('Q2', iso(Date.now()), 'IN_PORTAL_ESIGN', 'AGR-0001');
  t('refuses an agreement belonging to a DIFFERENT quote',
    r.ok === false && /belongs to quote/i.test(r.error || ''),
    '(' + JSON.stringify(r).slice(0, 110) + ')');
  t('Q2 mutated nothing — no pool_id, no status flip', JSON.stringify(s.quotes.rows[2]) === q2Before);
  t('no pool id minted for the wrong customer', s.calls.poolIdMinted === 0);
  t('no route row created', s.calls.routeSync === 0);

  // The matching pair still works.
  const ok = s.ctx.activateQuoteServiceFromAgreement_('Q1', iso(Date.now()), 'IN_PORTAL_ESIGN', 'AGR-0001');
  t('the correct quote/agreement pair still activates', ok.ok === true,
    '(' + JSON.stringify(ok).slice(0, 90) + ')');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
