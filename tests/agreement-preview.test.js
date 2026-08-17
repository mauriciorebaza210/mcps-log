// Stage 4e — preview must be byte-identical to what the customer sees.
// Loads the real SalesHub.js; only Apps Script services and sheet access stubbed.
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'appscript/SalesHub.js');

const QUOTE = {
  quote_id: 'Q-1001', first_name: 'Jordan', last_name: 'Rivera',
  service: 'Weekly Full Service', address: '123 Mission Creek Dr', city: 'San Antonio',
  zip_code: '78258', specs_summary: '15,000 gal · Pebble · Salt',
  service_subtotal: '180', discount_amount: '0', travel_fee: '0',
  total_with_tax: '194.85', sales_tax: '14.85',
  discounted_service_subtotal: '180', email: 'j@example.com'
};
const PROPOSAL = {
  proposal_id: 'PROP-1', proposal_number: 'PROP-DEMO-001', status: 'SENT',
  proposal_pdf_url: 'https://drive.example/p.pdf', service_type: 'Weekly Full Service',
  total: '194.85', sales_tax: '14.85', valid_until: '2026-09-09'
};

function build(opts) {
  const o = opts || {};
  const approvals = { __name: 'Proposal_Approvals' };
  const ctx = {
    console, Date, String, Number, Math, JSON, Array, Object, isNaN, RegExp, parseFloat, parseInt,
    Logger: { log: () => {} },
    Utilities: { formatDate: d => d.toISOString().slice(0, 10), base64Encode: x => x },
    Session: { getScriptTimeZone: () => 'America/Chicago' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => null, insertSheet: () => ({ appendRow: () => {} }) }),
                      getActiveSpreadsheet: () => ({ getSheetByName: () => null }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: { fetch: () => ({ getContentText: () => '{}' }) },
    HtmlService: { createHtmlOutputFromFile: () => ({ getContent: () => '' }) },
    DriveApp: {}, MailApp: {}, GmailApp: {}, Maps: {}, ScriptApp: {}, ContentService: {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  try {
    vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'SalesHub.js' });
  } catch (e) {
    console.log('LOAD ERROR: ' + e.message);
    process.exit(2);
  }

  // Override sheet access AFTER load so the real handlers run against fixtures.
  const approvalRow = o.approval === undefined
    ? { approval_id: 'APR-1', proposal_id: 'PROP-1', quote_id: 'Q-1001', token: 'tok-good',
        status: 'SENT', customer_note: '', sent_at: '2026-08-01T00:00:00Z', responded_at: '',
        expires_at: o.expiresAt || '2026-09-09T00:00:00Z', _rowNum: 2 }
    : o.approval;

  ctx.__fixtures = { approvalRow, quote: QUOTE, proposal: PROPOSAL, hasProposal: o.hasProposal !== false };
  vm.runInContext(`
    ensureNormalizedSalesSheets_ = function () {};
    ensureSheet_ = function (n) { return { __name: n }; };
    findRowByValue_ = function (sheet, field, val) {
      if (sheet.__name === 'Proposal_Approvals') {
        return (__fixtures.approvalRow && String(val) === String(__fixtures.approvalRow.token)) ? __fixtures.approvalRow : null;
      }
      if (sheet.__name === 'Proposals') {
        return String(val) === 'PROP-1' ? __fixtures.proposal : null;
      }
      return null;
    };
    getQuoteById_ = function (id) {
      return String(id) === 'Q-1001' ? { object: __fixtures.quote, sheet: {}, rowNum: 2 } : null;
    };
    getProposalByQuoteId_ = function (id) {
      if (!__fixtures.hasProposal) return { proposal: null };
      return String(id) === 'Q-1001' ? { proposal: __fixtures.proposal } : { proposal: null };
    };
  `, ctx);
  return ctx;
}

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

console.log('\nPreview vs live — must not drift');
{
  const ctx = build({});
  const live = ctx.handleGetProposalApproval_({ token: 'tok-good' });
  const prev = ctx.handleGetAgreementPreview_({ quote_id: 'Q-1001' });

  t('live loads', live.ok === true, '(' + (live.error || '') + ')');
  t('preview loads', prev.ok === true, '(' + (prev.error || '') + ')');
  t('preview is flagged', prev.preview === true);
  t('live is NOT flagged as preview', live.preview === undefined);

  // The contract text and every rendered block must be identical.
  t('terms html identical', live.agreement_terms_html === prev.agreement_terms_html);
  t('scope html identical', live.proposal.scope_html === prev.proposal.scope_html);
  t('service plan html identical', live.proposal.service_plan_html === prev.proposal.service_plan_html);
  t('pricing identical',
    JSON.stringify([live.proposal.subtotal, live.proposal.sales_tax, live.proposal.total, live.proposal.investment]) ===
    JSON.stringify([prev.proposal.subtotal, prev.proposal.sales_tax, prev.proposal.total, prev.proposal.investment]));
  t('whole proposal block identical',
    JSON.stringify(live.proposal) === JSON.stringify(prev.proposal));

  // Only the fields that legitimately differ may differ.
  const diff = Object.keys(live).concat(Object.keys(prev))
    .filter((k, i, a) => a.indexOf(k) === i)
    .filter(k => JSON.stringify(live[k]) !== JSON.stringify(prev[k]));
  t('the ONLY differing top-level key is `preview`',
    diff.length === 1 && diff[0] === 'preview', '(differs: ' + diff.join(', ') + ')');
}

console.log('\nPreview safety');
{
  let ctx = build({});
  t('rejects a missing quote_id', ctx.handleGetAgreementPreview_({}).ok === false);
  t('rejects an unknown quote', ctx.handleGetAgreementPreview_({ quote_id: 'NOPE' }).ok === false);

  ctx = build({ hasProposal: false });
  const r = ctx.handleGetAgreementPreview_({ quote_id: 'Q-1001' });
  t('refuses when no proposal exists yet', r.ok === false);
  t('and says why', /generate the proposal/i.test(r.error || ''), '(' + r.error + ')');

  // Preview must never mint an approval or a token.
  ctx = build({});
  const prev = ctx.handleGetAgreementPreview_({ quote_id: 'Q-1001' });
  t('no token in the preview payload', !JSON.stringify(prev).includes('tok-good'));
  t('reports status SENT so the page renders the signing form',
    prev.approval.status === 'SENT');
  t('never marked expired', prev.expired === false);
}

console.log('\nLive path still behaves');
{
  let ctx = build({});
  t('bad token rejected', ctx.handleGetProposalApproval_({ token: 'nope' }).ok === false);
  t('missing token rejected', ctx.handleGetProposalApproval_({}).ok === false);

  ctx = build({ expiresAt: '2020-01-01T00:00:00Z' });
  const exp = ctx.handleGetProposalApproval_({ token: 'tok-good' });
  t('expired link still flags expired', exp.expired === true);
  t('expired link still ok:true (so the page can offer recovery)', exp.ok === true);

  // An approval that has already been responded to keeps its real status.
  ctx = build({ approval: { approval_id: 'APR-1', proposal_id: 'PROP-1', quote_id: 'Q-1001',
    token: 'tok-good', status: 'APPROVED', customer_note: 'note here',
    responded_at: '2026-08-02T00:00:00Z', expires_at: '2026-09-09T00:00:00Z', _rowNum: 2 } });
  const done = ctx.handleGetProposalApproval_({ token: 'tok-good' });
  t('responded status preserved', done.approval.status === 'APPROVED');
  t('customer note preserved', done.approval.customer_note === 'note here');
  t('responded_at preserved', done.approval.responded_at === '2026-08-02T00:00:00Z');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
