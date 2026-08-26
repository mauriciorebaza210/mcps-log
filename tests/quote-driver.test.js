// api/_repo/sheets-driver.js — the only layer that knows the store is Sheets.
//
//   node tests/quote-driver.test.js
//
// Runs against a FAKE Sheets API: fetch is replaced, so the requests the driver
// would send are inspected directly. That is what makes the HTTP shape testable
// without a Google account — and the request COUNT is the whole point of this
// rewrite, so it is asserted rather than assumed.
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };

// ── the fake spreadsheet ─────────────────────────────────────────────────────
const HEADERS = {
  Clients: ['client_id', 'first_name', 'last_name', 'display_name', 'email', 'phone',
            'billing_address', 'billing_city', 'billing_state', 'billing_zip', 'status',
            'created_at', 'updated_at', 'legacy_quote_ids', 'notes'],
  Client_Locations: ['location_id', 'client_id', 'pool_id', 'service_address', 'city', 'state',
            'zip_code', 'area', 'pool_type', 'pool_size', 'material', 'spa', 'finish',
            'debris_level', 'sun_exposure', 'pets_on_property', 'robot_on_site',
            'year_built', 'active', 'created_at', 'updated_at', 'notes'],
  // Deliberately MISSING the newer columns, to prove header repair works. A value
  // written to a column that does not exist is a silent drop.
  Proposals: ['proposal_id', 'proposal_number', 'legacy_quote_id', 'client_id', 'location_id',
            'status', 'service_type', 'subtotal', 'discount_amount', 'discounted_subtotal',
            'sales_tax', 'total', 'created_at', 'updated_at'],
  Proposal_Items: ['proposal_item_id', 'proposal_id', 'line_type', 'product_service_name',
            'description', 'quantity', 'rate', 'amount', 'taxable', 'quickbooks_sku',
            'quickbooks_item_name', 'sort_order', 'created_at', 'updated_at'],
  Service_Agreements: ['agreement_id', 'agreement_number', 'client_id', 'location_id', 'proposal_id',
            'service_account_id', 'source_quote_id', 'status', 'signature_required',
            'activation_method', 'service_type', 'service_name', 'monthly_rate', 'total',
            'created_at', 'updated_at', 'agreement_type'],
  Service_Accounts: ['service_account_id', 'client_id', 'location_id', 'source_proposal_id',
            'source_agreement_id', 'source_quote_id', 'pool_id', 'service_type', 'service_name',
            'status', 'route_status', 'billing_type', 'monthly_rate', 'created_at', 'updated_at'],
  Quotes: ['quote_id', 'first_name', 'last_name', 'email', 'phone', 'address', 'city', 'zip_code',
            'area', 'service', 'pool_type', 'size', 'material', 'status', 'pool_id',
            'service_subtotal', 'discount_amount', 'discounted_service_subtotal', 'quote_subtotal',
            'sales_tax', 'total_with_tax', 'specs_summary', 'timestamp', 'client_id', 'location_id',
            'proposal_id', 'agreement_id', 'service_account_id']
};

let sheetData, requests;
function reset() {
  sheetData = {};
  Object.keys(HEADERS).forEach(k => { sheetData[k] = [HEADERS[k].slice()]; });
  requests = [];
}

// Minimal stand-in for the three Sheets endpoints the driver uses.
function installFakeSheets() {
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    // The token request is form-encoded, not JSON — parse defensively.
    let body = null;
    if (init.body) { try { body = JSON.parse(init.body); } catch (_) { body = String(init.body); } }

    if (u.includes('oauth2.googleapis.com') || u.includes('/token')) {
      return json({ access_token: 'fake-token', expires_in: 3600 });
    }
    requests.push({ url: u, method: init.method || 'GET', body });
    if (u.includes('values:batchGet')) {
      const ranges = [...new URL(u).searchParams.getAll('ranges')];
      return json({ valueRanges: ranges.map(r => ({ range: r, values: sheetData[r] || [] })) });
    }
    if (u.includes(':append')) {
      const sheet = decodeURIComponent(u.split('/values/')[1].split(':append')[0]);
      const rows = JSON.parse(init.body).values;
      rows.forEach(r => sheetData[sheet].push(r));
      return json({ updates: { updatedRows: rows.length } });
    }
    if (u.includes('values:batchUpdate')) {
      let cells = 0;
      JSON.parse(init.body).data.forEach(d => {
        const m = /^'?([^'!]+)'?!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(d.range);
        if (!m) return;
        const sheet = m[1], row = parseInt(m[3], 10);
        while (sheetData[sheet].length < row) sheetData[sheet].push([]);
        sheetData[sheet][row - 1] = d.values[0];
        cells += d.values[0].length;
      });
      return json({ totalUpdatedCells: cells });
    }
    return json({});
  };
}
const json = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj),
                         headers: { get: () => 'application/json' } });

// ⚠️ Hermetic on purpose. These OVERRIDE whatever is in the environment so a real
// service-account key can never be signed with, and no request can ever leave the
// machine even if the fetch stub were bypassed. fetch is replaced before any
// module that uses it runs.
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'fake@example.com';
process.env.MCPS_CRM_SHEET_ID = 'fake-sheet';
process.env.MCPS_SHEET_ID = 'fake-sheet';

const rowsOf = (sheet) => sheetData[sheet].slice(1);
const objOf = (sheet, i) => {
  const h = sheetData[sheet][0], r = rowsOf(sheet)[i] || [];
  const o = {}; h.forEach((k, j) => { o[k] = r[j]; }); return o;
};
const countReq = (kind) => requests.filter(r =>
  kind === 'batchGet' ? r.url.includes('values:batchGet')
  : kind === 'append' ? r.url.includes(':append')
  : kind === 'batchUpdate' ? r.url.includes('values:batchUpdate') : false).length;

(async () => {
installFakeSheets();
const D = await import(pathToFileURL(path.join(__dirname, '..', 'api', '_repo', 'sheets-driver.js')).href);
const W = await import(pathToFileURL(path.join(__dirname, '..', 'api', '_repo', 'quote-write.js')).href);
const U = await import(pathToFileURL(path.join(__dirname, '..', 'api', '_repo', 'quote-update.js')).href);

const NOW = '2026-08-20T18:00:00.000Z';
const INPUT = {
  service_key: 'weekly_full', size: 'large', pool_type: 'inground', material: 'plaster',
  first_name: 'Tony', last_name: 'Siller', email: 'tony@example.com', phone: '2105550134',
  address: '123 Pool Lane', city: 'San Antonio', zip_code: '78245', area: 'NW',
  adjustment_type: 'custom', adjustment_value: '350',
  scope_items: ['Weekly pool service', 'Water testing & balancing']
};

console.log('\nReading the whole model costs ONE request');
{
  reset();
  const ctx = await D.loadQuoteContext();
  t('exactly one batchGet', countReq('batchGet') === 1);
  t('all seven tabs came back', Object.keys(ctx.rows).length === 7);
  t('headers were normalised', ctx.headers.Proposals.includes('proposal_id'));
  t('no writes were made by a read', countReq('append') + countReq('batchUpdate') === 0);
}

console.log('\nA full save, end to end, against the fake spreadsheet');
{
  reset();
  const ctx = await D.loadQuoteContext();
  const plan = W.planQuoteWrite({ snapshot: D.toSnapshot(ctx), input: INPUT, now: NOW,
                                  actor: 'mau', quoteSuffix: 'AAAA1111', idempotencyKey: 'req-1' });
  t('planned', plan.ok === true, plan.error || '');
  const stats = await D.commitPlan(plan, ctx);

  t('a row landed in every relational tab',
    rowsOf('Clients').length === 1 && rowsOf('Client_Locations').length === 1 &&
    rowsOf('Proposals').length === 1 && rowsOf('Service_Agreements').length === 1 &&
    rowsOf('Service_Accounts').length === 1);
  t('line items landed', rowsOf('Proposal_Items').length === 2);
  t('the compatibility row landed in Quotes', rowsOf('Quotes').length === 1);

  const prop = objOf('Proposals', 0);
  t('the proposal carries the premium price', Number(prop.discounted_subtotal) === 350);
  t('and the rate card figure beside it', Number(prop.subtotal) === 300);
  t('and the recomputed total', Number(prop.total) === 378.88);
  t('foreign keys resolve', prop.client_id === objOf('Clients', 0).client_id);

  const q = objOf('Quotes', 0);
  t('the export carries the same total', Number(q.total_with_tax) === 378.88);
  t('and links back to every entity',
    q.client_id && q.location_id && q.proposal_id && q.agreement_id && q.service_account_id);
  t('and the quote id', q.quote_id === 'Q-AAAA1111');

  console.log('    requests: ' + stats.requests + ' (batchGet ' + countReq('batchGet') +
              ', append ' + countReq('append') + ', batchUpdate ' + countReq('batchUpdate') + ')');
  t('the whole save is under 10 requests', stats.requests < 10, '(' + stats.requests + ')');
  t('one append per tab receiving rows, not one per row', countReq('append') === 7);
}

console.log('\nMissing columns are repaired, not silently dropped');
{
  reset();
  const ctx = await D.loadQuoteContext();
  t('the fake Proposals tab starts without adjustment_kind',
    !ctx.headers.Proposals.includes('adjustment_kind'));
  const plan = W.planQuoteWrite({ snapshot: D.toSnapshot(ctx), input: INPUT, now: NOW,
                                  actor: 'mau', quoteSuffix: 'BBBB2222' });
  const stats = await D.commitPlan(plan, ctx);
  t('the header row was repaired', stats.headerRepairs > 0);
  t('adjustment_kind now exists', sheetData.Proposals[0].includes('adjustment_kind'));
  t('and the value actually landed there', objOf('Proposals', 0).adjustment_kind === 'premium');
  t('premium_amount landed too', Number(objOf('Proposals', 0).premium_amount) === 50);
  t('scope_items_json landed', /Weekly pool service/.test(objOf('Proposals', 0).scope_items_json));
  t('repair happened in ONE request', countReq('batchUpdate') === 1);
  t('pre-existing columns were not disturbed',
    sheetData.Proposals[0].slice(0, 5).join(',') === 'proposal_id,proposal_number,legacy_quote_id,client_id,location_id');
}

console.log('\nA replay writes nothing');
{
  reset();
  let ctx = await D.loadQuoteContext();
  let plan = W.planQuoteWrite({ snapshot: D.toSnapshot(ctx), input: INPUT, now: NOW,
                                actor: 'mau', quoteSuffix: 'AAAA1111', idempotencyKey: 'dbl-click' });
  await D.commitPlan(plan, ctx);
  const afterFirst = { quotes: rowsOf('Quotes').length, clients: rowsOf('Clients').length };

  ctx = await D.loadQuoteContext();
  plan = W.planQuoteWrite({ snapshot: D.toSnapshot(ctx), input: INPUT, now: NOW,
                            actor: 'mau', quoteSuffix: 'CCCC3333', idempotencyKey: 'dbl-click' });
  t('the second request is recognised as a replay', plan.replayed === true);
  const before = requests.length;
  await D.commitPlan(plan, ctx);
  t('and issues no write requests', requests.length === before);
  t('no duplicate quote row', rowsOf('Quotes').length === afterFirst.quotes);
  t('no duplicate client row', rowsOf('Clients').length === afterFirst.clients);
}

console.log('\nReading a saved quote back — the thing that had no endpoint at all');
{
  reset();
  let ctx = await D.loadQuoteContext();
  const plan = W.planQuoteWrite({ snapshot: D.toSnapshot(ctx), input: INPUT, now: NOW,
                                  actor: 'mau', quoteSuffix: 'AAAA1111' });
  await D.commitPlan(plan, ctx);

  ctx = await D.loadQuoteContext();
  const rec = D.hydrateQuote(D.toSnapshot(ctx), 'Q-AAAA1111');
  t('the quote is found', !!rec);
  t('the client is joined', rec.client && rec.client.email === 'tony@example.com');
  t('the property is joined', rec.location && rec.location.service_address === '123 Pool Lane');
  t('the agreement is joined', rec.agreement && rec.agreement.agreement_id === 'AGR-0001');
  t('the service account is joined', !!rec.service_account);
  t('line items come back in order',
    rec.items.length === 2 && rec.items[0].line_type === 'service' && rec.items[1].line_type === 'premium');
  t('the stored premium survives the round trip', Number(rec.proposal.discounted_subtotal) === 350);
  t('the scope survives the round trip', /Water testing/.test(rec.proposal.scope_items_json));
  t('an unknown id returns null rather than a wrong record',
    D.hydrateQuote(D.toSnapshot(ctx), 'Q-NOPE') === null);
}

console.log('\nhydrateQuote never hands back an amendment as the agreement');
{
  reset();
  let ctx = await D.loadQuoteContext();
  const plan = W.planQuoteWrite({ snapshot: D.toSnapshot(ctx), input: INPUT, now: NOW,
                                  actor: 'mau', quoteSuffix: 'AAAA1111' });
  await D.commitPlan(plan, ctx);
  // An amendment shares source_quote_id with its parent. Taking the first match
  // is a bug that had to be fixed in five places on the Apps Script side.
  const h = sheetData.Service_Agreements[0];
  const amendment = h.map(col =>
    col === 'agreement_id' ? 'AGR-0002' :
    col === 'source_quote_id' ? 'Q-AAAA1111' :
    col === 'agreement_type' ? 'amendment' :
    col === 'status' ? 'SIGNED' : '');
  sheetData.Service_Agreements.splice(1, 0, amendment);   // FIRST row, before the parent

  ctx = await D.loadQuoteContext();
  const rec = D.hydrateQuote(D.toSnapshot(ctx), 'Q-AAAA1111');
  t('the ORIGINAL is returned even though the amendment sorts first',
    rec.agreement.agreement_id === 'AGR-0001');
  t('the amendment is reported separately', rec.amendments.length === 1);
  t('a blank agreement_type still counts as original',
    (sheetData.Service_Agreements[2][h.indexOf('agreement_type')] = '',
     D.hydrateQuote(D.toSnapshot(await D.loadQuoteContext()), 'Q-AAAA1111').agreement.agreement_id === 'AGR-0001'));
}

console.log('\nAn edit updates in place and supersedes the old lines');
{
  reset();
  let ctx = await D.loadQuoteContext();
  let plan = W.planQuoteWrite({ snapshot: D.toSnapshot(ctx), input: INPUT, now: NOW,
                                actor: 'mau', quoteSuffix: 'AAAA1111' });
  await D.commitPlan(plan, ctx);

  ctx = await D.loadQuoteContext();
  const snapshot = D.toSnapshot(ctx);
  const rec = D.hydrateQuote(snapshot, 'Q-AAAA1111');
  rec.allItems = snapshot.Proposal_Items.filter(r => r.proposal_id === rec.proposal.proposal_id);

  const before = { proposals: rowsOf('Proposals').length, quotes: rowsOf('Quotes').length };
  const up = U.planQuoteUpdate({ record: rec, patch: { adjustment_type: 'custom', adjustment_value: '420' },
                                 now: NOW, actor: 'mau' });
  t('the edit plans', up.ok === true, up.error || '');
  await D.commitPlan(up, ctx);

  t('no new proposal row — it was updated in place', rowsOf('Proposals').length === before.proposals);
  t('no new Quotes row either', rowsOf('Quotes').length === before.quotes);
  t('the stored price is the new one', Number(objOf('Proposals', 0).discounted_subtotal) === 420);
  t('the export followed', Number(objOf('Quotes', 0).total_with_tax) === 454.65);
  t('the premium was recorded', Number(objOf('Proposals', 0).premium_amount) === 120);

  const items = rowsOf('Proposal_Items').map((_, i) => objOf('Proposal_Items', i));
  t('the old lines are marked superseded, not deleted',
    items.filter(i => i.status === 'superseded').length === 2);
  t('a fresh active set was appended', items.filter(i => i.status === 'active').length === 2);
  t('every line id is still unique', new Set(items.map(i => i.proposal_item_id)).size === items.length);
  t('the change log records the edit',
    /adjusted: 350 → 420/.test(objOf('Proposals', 0).change_log));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})();
