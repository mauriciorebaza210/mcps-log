// Attribution — does a campaign show revenue, and is that revenue real?
//
//   node tests/comms-attribution.test.js
//
// The fixture is shaped deliberately around the trap: a converting lead exists
// TWICE in the Quotes sheet, because handleSaveQuote_ mints a fresh quote_id and
// appends rather than updating the lead. Joining on quote_id — the obvious choice,
// since Comms_Log stores one — silently misses exactly the conversions this report
// exists to find. The join must be on email.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const COMMS_SRC = path.join(ROOT, 'appscript', 'Comms.js');
const REPORT_SRC = path.join(ROOT, 'appscript', 'CommsReport.js');

let pass = 0, fail = 0;
function t(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? '  ' + detail : '')); }
}

const DAY = 86400000;
const NOW = Date.parse('2026-08-26T12:00:00Z');
const ago = d => new Date(NOW - d * DAY).toISOString();

function build(props = {}, sheets = {}, crmRows = []) {
  const ctx = {
    console, JSON, Math, String, Number, Array, Object, RegExp, Date, isNaN, encodeURIComponent,
    Logger: { log: () => {} },
    Utilities: { getUuid: () => 'u', formatDate: d => new Date(d).toISOString(),
                 computeHmacSha256Signature: () => [1, 2, 3] },
    SpreadsheetApp: { getActiveSpreadsheet: () => null, openById: () => null },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    ScriptApp: { getProjectTriggers: () => [] },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'p@x.com' }), getActiveUser: () => ({ getEmail: () => '' }) },
    MailApp: { getRemainingDailyQuota: () => 1500 },
    GmailApp: { getAliases: () => [] },
    HtmlService: { createHtmlOutput: h => ({ getContent: () => h }) },
    UrlFetchApp: { fetch: () => { throw new Error('no network'); } },
    huHeader_: h => String(h == null ? '' : h).trim().toLowerCase().replace(/ /g, '_'),
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (props[k] === undefined ? null : props[k]),
      setProperty: () => {}, deleteProperty: () => {} }) }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(COMMS_SRC, 'utf8'), ctx, { filename: 'Comms.js' });
  vm.runInContext(fs.readFileSync(REPORT_SRC, 'utf8'), ctx, { filename: 'CommsReport.js' });
  ctx.commsEnsureSheets_ = () => {};
  ctx.commsSheetRows_ = k => (sheets[k] || []);
  ctx.handleGetCRMData = () => ({ ok: true, data: crmRows });
  return ctx;
}

const CAMP = (id, over = {}) => Object.assign({
  campaign_id: id, name: 'Campaign ' + id, category: 'marketing', lane: 'bulk',
  status: 'done', started_at: ago(20), created_at: ago(20)
}, over);

const LOG = (cid, email, over = {}) => Object.assign({
  campaign_id: cid, recipient_id: cid + ':' + email, email, status: 'sent',
  sent_at: ago(20), quote_id: 'Q-lead', clicked_at: '', bounce_reason: ''
}, over);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nA converting lead exists twice — the join must survive that');
{
  const ctx = build({}, {
    campaigns: [CAMP('C1')],
    log: [LOG('C1', 'ana@x.com')]
  }, [
    // The row the campaign was sent to — still a LEAD, no signed_at, no revenue.
    { quote_id: 'Q-lead', email: 'ana@x.com', status: 'LEAD', timestamp: ago(300) },
    // The row created when she converted: NEW quote_id, carries the money.
    { quote_id: 'Q-new', email: 'ana@x.com', status: 'ACTIVE_CUSTOMER',
      timestamp: ago(10), signed_at: ago(5), total_with_tax: '1450' }
  ]);
  const rep = ctx.handleCommsCampaignReport_({});
  const c1 = rep.campaigns[0];

  t('the report runs', rep.ok === true);
  t('the signing is attributed despite the new quote_id', c1.signings === 1, 'signings=' + c1.signings);
  t('and the revenue lands on the campaign', c1.revenue === 1450, 'rev=' + c1.revenue);
  t('the quote raised after the send is counted', c1.quotes_after === 1);
  t('totals agree with the per-campaign figure', rep.totals.revenue === 1450);
  // The whole point: joining on quote_id would have found nothing here.
  t('the recorded quote_id is NOT the one that signed',
    ctx.commsSheetRows_('log')[0].quote_id !== 'Q-new');
}

console.log('\nThe window and the direction of time');
{
  const mk = (signedDaysAgo) => build({}, {
    campaigns: [CAMP('C1', { started_at: ago(20) })],
    log: [LOG('C1', 'a@x.com', { sent_at: ago(20) })]
  }, [{ quote_id: 'Q2', email: 'a@x.com', signed_at: ago(signedDaysAgo), total_with_tax: '1000' }]
  ).handleCommsCampaignReport_({});

  t('a signing inside the window is attributed', mk(5).campaigns[0].signings === 1);
  t('a signing outside the 30-day window is not', mk(-40).campaigns[0].signings === 0);
  // Someone who signed BEFORE we mailed them was not persuaded by the email.
  t('a signing before the send is never attributed', mk(25).campaigns[0].signings === 0);
  t('and is reported as outside-window rather than silently dropped',
    mk(25).totals.signings_outside_window === 1);

  const wide = build({ COMMS_ATTRIBUTION_DAYS: '90' }, {
    campaigns: [CAMP('C1', { started_at: ago(60) })],
    log: [LOG('C1', 'a@x.com', { sent_at: ago(60) })]
  }, [{ quote_id: 'Q2', email: 'a@x.com', signed_at: ago(5), total_with_tax: '900' }]
  ).handleCommsCampaignReport_({});
  t('the window is configurable', wide.campaigns[0].signings === 1);
  t('and the model reports the window it used', wide.model.window_days === 90);
}

console.log('\nLast touch, not every touch');
{
  const rep = build({}, {
    campaigns: [CAMP('C1', { started_at: ago(25) }), CAMP('C2', { started_at: ago(6) })],
    log: [LOG('C1', 'a@x.com', { sent_at: ago(25) }), LOG('C2', 'a@x.com', { sent_at: ago(6) })]
  }, [{ quote_id: 'Q2', email: 'a@x.com', signed_at: ago(2), total_with_tax: '2000' }]
  ).handleCommsCampaignReport_({});

  const byId = {}; rep.campaigns.forEach(c => { byId[c.campaign_id] = c; });
  t('the most recent campaign gets the credit', byId.C2.signings === 1 && byId.C2.revenue === 2000);
  t('the earlier one gets none', byId.C1.signings === 0 && byId.C1.revenue === 0);
  // Double-counting would make the total larger than the deal.
  t('revenue is not counted twice', rep.totals.revenue === 2000);
}

console.log('\nOnly commercial mail earns credit');
{
  const rep = build({}, {
    campaigns: [CAMP('C1', { category: 'service_update', lane: 'personal', started_at: ago(10) })],
    log: [LOG('C1', 'a@x.com', { sent_at: ago(10) })]
  }, [{ quote_id: 'Q2', email: 'a@x.com', signed_at: ago(3), total_with_tax: '5000' }]
  ).handleCommsCampaignReport_({});

  // A reschedule notice that happened to precede a signing did not sell anything.
  t('a service update is marked unattributable', rep.campaigns[0].attributable === false);
  t('and earns no revenue', rep.campaigns[0].revenue === 0);
  // Someone who only ever received operational mail is organic business, not a
  // failed attribution. Counting them would fold every walk-in customer into a
  // number that is supposed to measure campaign reach.
  t('the signing is out of scope entirely, not an attribution miss',
    rep.totals.signings_outside_window === 0 && rep.totals.signings === 0);
}

console.log('\nDelivery counters');
{
  const rep = build({}, {
    campaigns: [CAMP('C1')],
    log: [
      LOG('C1', 'a@x.com', { clicked_at: ago(19) }),
      LOG('C1', 'b@x.com'),
      LOG('C1', 'c@x.com', { status: 'failed', bounce_reason: '550 no such user' }),
      LOG('C1', 'd@x.com', { status: 'skipped_optout' }),
      // A stray row from the test-draft path must not pollute a real campaign.
      { campaign_id: 'TEST_DRAFT', email: 'z@x.com', status: 'sent', sent_at: ago(1) }
    ]
  }, []).handleCommsCampaignReport_({});
  const c = rep.campaigns[0];

  t('sent is counted', c.sent === 2, 'sent=' + c.sent);
  t('failed is counted', c.failed === 1);
  t('skipped is counted', c.skipped === 1);
  t('bounced is counted', c.bounced === 1);
  t('clicks are counted', c.clicked === 1);
  t('click rate is a percentage of sent', c.click_rate === 50, 'rate=' + c.click_rate);
  t('an orphan log row is ignored', rep.campaigns.length === 1);
  t('a campaign with no sends has a zero rate, not a divide-by-zero',
    build({}, { campaigns: [CAMP('C9')], log: [] }, []).handleCommsCampaignReport_({}).campaigns[0].click_rate === 0);
}

console.log('\nThe number states what it is');
{
  const rep = build({}, { campaigns: [], log: [] }, []).handleCommsCampaignReport_({});
  t('the basis is declared', rep.model.basis === 'last-touch');
  t('the join key is declared', rep.model.join === 'email');
  t('the scope is declared', /marketing/.test(rep.model.scope));
  t('the outside-window counter is present even when empty',
    rep.totals.signings_outside_window === 0);
  // Without a holdout there is no causal claim, and saying so is the difference
  // between a useful figure and a vanity metric.
  t('it does not claim to be incremental', /not incremental/i.test(rep.model.caveat));
  t('an empty install returns zeroes rather than failing',
    rep.ok === true && rep.totals.revenue === 0);
}

console.log('\nMessy real-world values');
{
  const rep = build({}, {
    campaigns: [CAMP('C1', { started_at: ago(10) })],
    log: [LOG('C1', 'Ana@X.com ', { sent_at: ago(10) })]
  }, [
    // Address case and padding differ between the log and the CRM.
    { quote_id: 'Q2', email: ' ana@x.com', signed_at: ago(2), total_with_tax: '$1,250.50' },
    { quote_id: 'Q3', email: '', signed_at: ago(2), total_with_tax: '900' }
  ]).handleCommsCampaignReport_({});

  t('email matching is case- and whitespace-insensitive', rep.campaigns[0].signings === 1);
  t('a currency-formatted value is parsed', rep.campaigns[0].revenue === 1250.5, 'rev=' + rep.campaigns[0].revenue);
  t('a blank address is skipped without error', rep.totals.signings === 1);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
