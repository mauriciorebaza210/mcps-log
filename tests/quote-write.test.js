// api/_repo/quote-write.js — the relational write planner.
//
//   node tests/quote-write.test.js
//
// ⚠️ WHY THIS MATTERS. handleSaveQuote_ in Apps Script could only ever be tested
// in production: the code needs a Google session, so id minting, find-or-create,
// pool_id allocation and the pricing hand-off were all unverifiable on a laptop.
// That is how `=== 'repair_job'` came to be compared against a display label and
// stayed broken. The planner is pure, so all of it is checked here first.
//
// The snapshot below is a hand-built stand-in for one batchGet of the relational
// tabs — no network, no clock, no randomness.
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };
const NOW = '2026-08-20T15:00:00.000Z';

const EMPTY = () => ({
  Clients: [], Client_Locations: [], Proposals: [], Proposal_Items: [],
  Service_Agreements: [], Service_Accounts: [], Quotes: []
});

const WEEKLY = (over = {}) => Object.assign({
  service_key: 'weekly_full', size: 'large', pool_type: 'inground', material: 'plaster',
  first_name: 'Tony', last_name: 'Siller', email: 'tony@example.com', phone: '(210) 555-0134',
  address: '123 Pool Lane', city: 'San Antonio', zip_code: '78245', area: 'NW',
  sales_flow: 'proposal_first', signature_required: 'TRUE'
}, over);

(async () => {
const M = await import(pathToFileURL(path.join(__dirname, '..', 'api', '_repo', 'quote-write.js')).href);
const plan = (input, snapshot, over = {}) => M.planQuoteWrite(Object.assign({
  snapshot: snapshot || EMPTY(), input, now: NOW, actor: 'tester', quoteSuffix: 'AAAA1111'
}, over));

console.log('\nThe planner refuses to invent the things it must be given');
{
  t('no clock', M.planQuoteWrite({ snapshot: EMPTY(), input: WEEKLY(), quoteSuffix: 'X' }).ok === false);
  t('no randomness', M.planQuoteWrite({ snapshot: EMPTY(), input: WEEKLY(), now: NOW }).ok === false);
  t('the randomness refusal says so',
    /quoteSuffix/.test(M.planQuoteWrite({ snapshot: EMPTY(), input: WEEKLY(), now: NOW }).error));
}

console.log('\nA new weekly quote, from an empty database');
{
  const r = plan(WEEKLY());
  t('planned', r.ok === true, r.error || '');
  t('quote id is derived from the supplied suffix', r.ids.quote_id === 'Q-AAAA1111');
  t('client minted CLI-000001', r.ids.client_id === 'CLI-000001');
  t('location minted LOC-000001', r.ids.location_id === 'LOC-000001');
  t('proposal minted PRP-000001', r.ids.proposal_id === 'PRP-000001');
  t('customer-facing proposal number is separate', r.ids.proposal_number === 'PRO-0001');
  t('agreement minted AGR-0001', r.ids.agreement_id === 'AGR-0001');
  t('service account minted SVA-000001', r.ids.service_account_id === 'SVA-000001');
  t('an unsigned weekly gets NO pool id yet', r.ids.pool_id === '');

  t('one row per entity', 
    r.inserts.Clients.length === 1 && r.inserts.Client_Locations.length === 1 &&
    r.inserts.Proposals.length === 1 && r.inserts.Service_Agreements.length === 1 &&
    r.inserts.Service_Accounts.length === 1);
  t('every child row points at its parent',
    r.inserts.Proposals[0].client_id === 'CLI-000001' &&
    r.inserts.Proposals[0].location_id === 'LOC-000001' &&
    r.inserts.Service_Agreements[0].proposal_id === 'PRP-000001' &&
    r.inserts.Service_Accounts[0].source_agreement_id === 'AGR-0001');
  t('the agreement starts unsigned', r.inserts.Service_Agreements[0].status === 'DRAFT');
  t('the service account starts pending', r.inserts.Service_Accounts[0].status === 'PENDING');
  t('nothing is updated on a first save', r.updates.length === 0);
}

console.log('\nThe SERVER prices it — the client only proposes');
{
  const r = plan(WEEKLY({ total_with_tax: 1, service_subtotal: 1, adjustment_type: 'custom', adjustment_value: '350' }));
  t('stored total is the server figure, not the claimed 1', r.priced.total_with_tax === 378.88);
  t('a mismatch is reported, not swallowed', r.verification.ok === false);
  t('it names both fields', r.verification.mismatches.length === 2);
  t('the proposal records who priced it', r.inserts.Proposals[0].pricing_source === 'server');
  t('the compat export records it too', r.compat.pricing_source === 'server');
  t('an honest client verifies clean',
    plan(WEEKLY({ adjustment_type: 'custom', adjustment_value: '350',
      service_subtotal: 300, adjusted_service: 350, quote_subtotal: 350,
      sales_tax: 28.88, total_with_tax: 378.88, travel_fee: 0 })).verification.ok === true);
}

console.log('\nA premium finally has somewhere to live');
{
  const r = plan(WEEKLY({ adjustment_type: 'custom', adjustment_value: '350' }));
  const prop = r.inserts.Proposals[0];
  t('adjustment_kind is premium', prop.adjustment_kind === 'premium');
  t('premium_amount holds the 50', prop.premium_amount === 50);
  t('discount_amount stays 0 — NOT a negative discount', prop.discount_amount === 0);
  t('legacy discount_type is blank', prop.discount_type === '');
  t('the rate card figure survives alongside it', prop.subtotal === 300);
  t('the agreed price is the discounted_subtotal column', prop.discounted_subtotal === 350);
  t('the operator’s literal entry is kept for audit', prop.adjustment_value === '350');

  const line = r.inserts.Proposal_Items.find(i => i.line_type === 'premium');
  t('a premium LINE ITEM is written', !!line);
  t('it is positive', line && line.amount === 50);
  t('it explains itself', line && /Rate card \$300\.00 → agreed \$350\.00/.test(line.description));
  t('no discount line is written', !r.inserts.Proposal_Items.some(i => i.line_type === 'discount'));
}

console.log('\nLine items are built forward, not reverse-engineered');
{
  const r = plan(WEEKLY({ adjustment_type: 'percentage', adjustment_value: '10',
                          travel_fee: 18.5, distance_source: 'maps' }));
  const items = r.inserts.Proposal_Items;
  t('service + discount + travel', items.length === 3);
  t('service line carries the rate card price', items[0].amount === 300);
  t('discount line is negative', items.find(i => i.line_type === 'discount').amount === -30);
  t('travel is its own line', items.find(i => i.line_type === 'travel').amount === 18.5);
  t('lines are ordered', items.map(i => i.sort_order).join(',') === '1,2,3');
  t('every line has its own id', new Set(items.map(i => i.proposal_item_id)).size === 3);
  t('ids are sequential', items[0].proposal_item_id === 'PIT-000001');
  t('every line points at the proposal', items.every(i => i.proposal_id === 'PRP-000001'));
}

console.log('\nRepair parts become real lines instead of a dead JSON blob');
{
  const r = plan({
    service_key: 'repair_job', manual_price: 480, repair_type: 'repair_replacement',
    first_name: 'Ada', last_name: 'Byron', email: 'ada@example.com',
    address: '9 Fix St', city: 'San Antonio', repair_issue: 'Failed niche seal',
    repair_parts: JSON.stringify([{ name: 'Pool light', qty: 1 }, { name: 'Niche gasket', qty: 2 }])
  });
  t('planned', r.ok === true, r.error || '');
  const parts = r.inserts.Proposal_Items.filter(i => i.line_type === 'part');
  t('both parts are itemised', parts.length === 2);
  t('quantities are kept', parts[1].quantity === 2);
  t('parts carry no price — the job is quoted whole', parts.every(p => p.amount === 0));
  t('parts are not taxed separately', parts.every(p => p.taxable === 'FALSE'));
  t('blank part names are dropped',
    plan({ service_key: 'repair_job', manual_price: 1, email: 'a@b.c',
           repair_parts: [{ name: '  ', qty: 1 }, { name: 'Real', qty: 1 }] })
      .inserts.Proposal_Items.filter(i => i.line_type === 'part').length === 1);
  t('the repair description reaches the record', r.compat.repair_job_description === 'Failed niche seal');
  t('service_key is stored as the KEY', r.inserts.Proposals[0].service_key === 'repair_job');
  t('billing is one-time', r.inserts.Service_Accounts[0].billing_type === 'one_time');
}

console.log('\nIdempotency — a double-click cannot mint a second customer');
{
  const first = plan(WEEKLY(), EMPTY(), { idempotencyKey: 'req-1' });
  t('first request plans writes', first.ok && !first.replayed);

  // Replay against a snapshot that already contains the first proposal.
  const after = EMPTY();
  after.Proposals.push(first.inserts.Proposals[0]);
  const second = M.planQuoteWrite({ snapshot: after, input: WEEKLY(), now: NOW,
    actor: 'tester', quoteSuffix: 'BBBB2222', idempotencyKey: 'req-1' });
  t('the replay is recognised', second.replayed === true);
  t('it returns the ORIGINAL quote id', second.ids.quote_id === 'Q-AAAA1111');
  t('and writes nothing at all', Object.keys(second.inserts).length === 0 && second.updates.length === 0);

  const different = M.planQuoteWrite({ snapshot: after, input: WEEKLY(), now: NOW,
    actor: 'tester', quoteSuffix: 'CCCC3333', idempotencyKey: 'req-2' });
  t('a genuinely new request still goes through', different.replayed === false);
  t('and its ids do not collide with the stored one', different.ids.proposal_id === 'PRP-000002');
}

console.log('\nFind-or-create: the same customer is not duplicated');
{
  const snap = EMPTY();
  snap.Clients.push({ client_id: 'CLI-000007', first_name: 'Tony', last_name: 'Siller',
    email: 'tony@example.com', phone: '2105550134', legacy_quote_ids: '["Q-OLD"]' });
  snap.Client_Locations.push({ location_id: 'LOC-000009', client_id: 'CLI-000007',
    service_address: '123 pool ln.', city: 'San Antonio', area: 'NW' });

  const r = plan(WEEKLY(), snap);
  t('matched the existing client by email', r.ids.client_id === 'CLI-000007');
  t('no duplicate client row', !r.inserts.Clients);
  t('matched the existing property despite "Pool Lane" vs "pool ln."',
    r.ids.location_id === 'LOC-000009');
  t('no duplicate location row', !r.inserts.Client_Locations);
  t('the new quote id is appended to the client history',
    r.updates.some(u => u.sheet === 'Clients' && /Q-AAAA1111/.test(u.patch.legacy_quote_ids || '')));
  t('the property specs are refreshed from this quote',
    r.updates.some(u => u.sheet === 'Client_Locations' && u.patch.pool_size === 'large'));

  const byPhone = plan(WEEKLY({ email: '' }), snap);
  t('falls back to name + phone when there is no email', byPhone.ids.client_id === 'CLI-000007');
  // A NEW client continues the sequence past the highest existing id — it does
  // not restart at 1, which is what would silently overwrite CLI-000001.
  const other = plan(WEEKLY({ email: 'someone.else@example.com', first_name: 'Grace', last_name: 'Hopper', phone: '2105559999' }), snap);
  t('a genuinely different person gets a NEW client id', other.ids.client_id === 'CLI-000008');
  t('and a client row is actually inserted for them', other.inserts.Clients.length === 1);
  t('name alone does NOT merge two people — a different phone means a different person',
    plan(WEEKLY({ email: '', phone: '2105557777' }), snap).ids.client_id === 'CLI-000008');
  t('a new id never reuses an existing one',
    other.ids.client_id !== 'CLI-000007');
}

console.log('\npool_id follows the lifecycle, and startups are no longer silent');
{
  const g2c = plan({ service_key: 'green_to_clean', email: 'g@x.com', first_name: 'G',
                     address: '1 A St', size: 'medium' });
  t('green-to-clean gets a pool id at save', g2c.ids.pool_id === 'MCPS-0001');
  t('and is immediately active', g2c.compat.status === 'ACTIVE_CUSTOMER');
  t('with route_status gtc', g2c.inserts.Service_Accounts[0].route_status === 'gtc');

  const su = plan({ service_key: 'pool_startup', startup_chemical: true, startup_programming: true,
                    startup_start_date: '2026-09-01', email: 's@x.com', first_name: 'S', address: '2 B St' });
  t('a startup with a date gets a pool id', su.ids.pool_id === 'MCPS-0001');
  t('its agreement needs no signature', su.inserts.Service_Agreements[0].signature_required === 'FALSE');
  t('activation method is STARTUP_AUTO', su.inserts.Service_Agreements[0].activation_method === 'STARTUP_AUTO');

  const noDate = plan({ service_key: 'pool_startup', startup_chemical: true,
                        email: 's@x.com', first_name: 'S', address: '2 B St' });
  t('a startup with NO date is refused instead of silently unscheduled', noDate.ok === false);
  t('and it says why', /start date/i.test(noDate.error));

  const override = plan(WEEKLY({ sales_flow: 'operational_override', signature_required: 'FALSE' }));
  t('an admin override gets a pool id', override.ids.pool_id === 'MCPS-0001');
  t('and no signature is required', override.compat.signature_required === 'FALSE');
  t('its agreement is NOT_REQUIRED', override.inserts.Service_Agreements[0].status === 'NOT_REQUIRED');

  const snap = EMPTY();
  snap.Quotes.push({ pool_id: 'MCPS-0042' });
  t('pool ids continue from the highest existing one',
    plan({ service_key: 'green_to_clean', email: 'g@x.com', first_name: 'G', address: '1 A St' }, snap)
      .ids.pool_id === 'MCPS-0043');
}

console.log('\nInvalid quotes are refused before anything is minted');
{
  const noName = plan(WEEKLY({ first_name: '', last_name: '', email: '' }));
  t('a nameless quote is refused', noName.ok === false);
  t('nothing was staged', Object.keys(noName.inserts).length === 0);

  const badAdj = plan(WEEKLY({ adjustment_type: 'dollar', adjustment_value: '9999' }));
  t('an impossible discount is refused', badAdj.ok === false);
  t('with the engine’s own reason', /custom price/i.test(badAdj.error));

  const ag = plan({ service_key: 'biweekly_maint', pool_type: 'above_ground', size: 'medium',
                    email: 'a@b.c', first_name: 'A', address: '1 A St' });
  t('above-ground bi-weekly without a price is refused', ag.ok === false);
  t('and asks for one', /rate card/i.test(ag.error));
  t('with a price it plans',
    plan({ service_key: 'biweekly_maint', pool_type: 'above_ground', size: 'medium',
           manual_price: 135, email: 'a@b.c', first_name: 'A', address: '1 A St' }).ok === true);
}

console.log('\nThe display label still resolves, so legacy callers keep working');
{
  const r = plan(WEEKLY({ service_key: '', service: 'Weekly Full Service' }));
  t('a stored LABEL prices correctly', r.ok === true && r.priced.service_subtotal === 300);
  t('and is normalised to the key', r.inserts.Proposals[0].service_key === 'weekly_full');
  const rep = plan({ service: 'Repair / Replacement / Other Job', manual_price: 200,
                     email: 'r@x.com', first_name: 'R', address: '1 R St' });
  t('the repair LABEL resolves to the key (the original bug)',
    rep.ok === true && rep.inserts.Proposals[0].service_key === 'repair_job');
}

console.log('\nThe compatibility export is complete and marked as derived');
{
  const r = plan(WEEKLY({ adjustment_type: 'custom', adjustment_value: '350',
                          scope_items: ['Weekly pool service', 'Water testing & balancing'] }));
  const c = r.compat;
  t('carries the quote id', c.quote_id === 'Q-AAAA1111');
  t('carries every relational id',
    c.client_id && c.location_id && c.proposal_id && c.agreement_id && c.service_account_id);
  t('carries the money the sheet reports expect',
    c.total_with_tax === 378.88 && c.discounted_service_subtotal === 350 && c.service_subtotal === 300);
  t('records a premium without faking a discount',
    c.premium_amount === 50 && c.discount_amount === 0);
  t('carries the specs summary', /Pool Type: Inground/.test(c.specs_summary));
  t('carries the resolved scope', /Weekly pool service/.test(c.scope_items_json));
  t('states its provenance so nobody treats it as a source',
    c.source_sheet === 'Proposals' && c.migration_status === 'RELATIONAL');
  t('status is UNSENT for a signature-gated weekly', c.status === 'UNSENT');
  t('quote_version marks the new write path', c.quote_version === '3.0');
}

console.log('\nId minting is safe within a single save');
{
  const snap = EMPTY();
  snap.Proposal_Items.push({ proposal_item_id: 'PIT-000005' });
  const r = plan(WEEKLY({ adjustment_type: 'percentage', adjustment_value: '5', travel_fee: 10 }), snap);
  const ids = r.inserts.Proposal_Items.map(i => i.proposal_item_id);
  t('continues from the highest existing id', ids[0] === 'PIT-000006');
  t('and increments within the same save', ids.join(',') === 'PIT-000006,PIT-000007,PIT-000008');
  t('no duplicates', new Set(ids).size === ids.length);

  const mint = M.makeMinter({ Clients: [{ client_id: 'CLI-000003' }, { client_id: 'garbage' }] });
  t('non-conforming ids are ignored rather than crashing',
    mint('Clients', 'client_id', 'CLI', 6) === 'CLI-000004');
  t('minting twice does not repeat', mint('Clients', 'client_id', 'CLI', 6) === 'CLI-000005');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})();
