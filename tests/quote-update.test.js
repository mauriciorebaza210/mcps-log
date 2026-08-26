// api/_repo/quote-update.js — editing a saved quote.
//
//   node tests/quote-update.test.js
//
// ⚠️ WHAT THIS COVERS THAT NOTHING COULD BEFORE. There was no way to change a
// price after saving. handleUpdateQuoteInfo_ allowed seven contact fields;
// handleUpdateLead_ allowed status, notes and a service end date. Fixing a wrong
// price meant building a second quote and abandoning the first row in the sheet.
//
// The two properties that matter most here are the ones a business gets sued over:
// a SIGNED agreement must be immutable, and every price change must be attributable.
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };
const NOW = '2026-08-20T18:00:00.000Z';

// A saved weekly quote as hydrateQuote() returns it.
const REC = (over = {}) => {
  const base = {
    quote_id: 'Q-AAAA1111',
    proposal: {
      proposal_id: 'PRP-000001', proposal_number: 'PRO-0001', legacy_quote_id: 'Q-AAAA1111',
      client_id: 'CLI-000001', location_id: 'LOC-000001',
      status: 'DRAFT', service_type: 'Weekly Full Service', service_key: 'weekly_full',
      subtotal: 300, discounted_subtotal: 300, total: 324.75, sales_tax: 24.75,
      travel_fee: 0, tax_rate: 0.0825, margin_percent: 80, chem_cost_est: 60,
      adjustment_kind: 'none', adjustment_type: '', adjustment_value: '',
      discount_amount: 0, premium_amount: 0, manual_price: '',
      specs_summary: 'Pool Type: Inground, Size: large, Material: Plaster',
      change_log: JSON.stringify([{ at: '2026-08-19T00:00:00.000Z', by: 'mau', action: 'created' }])
    },
    client: { client_id: 'CLI-000001', first_name: 'Tony', last_name: 'Siller',
              email: 'tony@example.com', phone: '2105550134' },
    location: { location_id: 'LOC-000001', client_id: 'CLI-000001', service_address: '123 Pool Lane',
                city: 'San Antonio', zip_code: '78245', area: 'NW',
                pool_type: 'inground', pool_size: 'large', material: 'plaster',
                spa: 'FALSE', finish: 'light', debris_level: 'light',
                sun_exposure: 'FALSE', pets_on_property: 'FALSE', robot_on_site: 'FALSE' },
    items: [
      { proposal_item_id: 'PIT-000001', proposal_id: 'PRP-000001', line_type: 'service',
        product_service_name: 'Weekly Full Service', amount: 300, sort_order: 1, status: 'active' }
    ],
    agreement: { agreement_id: 'AGR-0001', agreement_number: 'AGN-0001', status: 'DRAFT',
                 source_quote_id: 'Q-AAAA1111', agreement_type: 'original' },
    amendments: [],
    service_account: { service_account_id: 'SVA-000001', source_quote_id: 'Q-AAAA1111', status: 'PENDING' }
  };
  return Object.assign(base, over);
};

(async () => {
const M = await import(pathToFileURL(path.join(__dirname, '..', 'api', '_repo', 'quote-update.js')).href);
const upd = (patch, rec, over = {}) =>
  M.planQuoteUpdate(Object.assign({ record: rec || REC(), patch, now: NOW, actor: 'mau' }, over));

const find = (r, sheet) => r.updates.filter(u => u.sheet === sheet);
const patchOf = (r, sheet) => (find(r, sheet)[0] || {}).patch || {};

console.log('\nA SIGNED agreement is immutable');
{
  const signed = REC({ agreement: { agreement_id: 'AGR-0001', status: 'SIGNED', agreement_type: 'original' } });
  const r = upd({ adjustment_type: 'custom', adjustment_value: '999' }, signed);
  t('the edit is refused', r.ok === false);
  t('it is flagged as the signed case, not a generic error', r.code === 'SIGNED');
  t('it points at plan changes', /plan change/i.test(r.error));
  t('absolutely nothing is staged', r.updates.length === 0 && Object.keys(r.inserts).length === 0);
  t('an unsigned agreement is editable', upd({ adjustment_value: '350', adjustment_type: 'custom' }).ok === true);
  t('a DECLINED agreement is still editable — the customer may be re-quoted',
    upd({ adjustment_type: 'custom', adjustment_value: '280' },
        REC({ agreement: { agreement_id: 'AGR-0001', status: 'DECLINED', agreement_type: 'original' } })).ok === true);
}

console.log('\nRe-pricing an edit is the SERVER’s job');
{
  const r = upd({ adjustment_type: 'custom', adjustment_value: '350' });
  t('planned', r.ok === true, r.error || '');
  const p = patchOf(r, 'Proposals');
  t('the new price is charged', p.discounted_subtotal === 350);
  t('recorded as a premium', p.adjustment_kind === 'premium');
  t('premium_amount is 50', p.premium_amount === 50);
  t('discount_amount stays 0', p.discount_amount === 0);
  t('the total is recomputed, not accepted', p.total === 378.88);
  t('tax is recomputed', p.sales_tax === 28.88);
  t('margin is recomputed', p.margin_percent === 82.9, '(' + p.margin_percent + ')');
  t('the row is stamped as server-priced', p.pricing_source === 'server');

  const forged = upd({ adjustment_type: 'custom', adjustment_value: '350', total: 1, total_with_tax: 1 });
  t('a total supplied in the patch is ignored', patchOf(forged, 'Proposals').total === 378.88);
  t('and the stray keys are reported back', forged.unknown_fields.includes('total_with_tax'));
}

console.log('\nChanging the configuration re-prices from the MERGED record');
{
  const r = upd({ size: 'small' });
  t('a size change re-prices', patchOf(r, 'Proposals').subtotal === 220);
  t('the location row follows', patchOf(r, 'Client_Locations').pool_size === 'small');

  // The spa surcharge lives on the location, not in the patch. Re-pricing from
  // the patch alone would silently drop it.
  const withSpa = REC();
  withSpa.location.spa = 'TRUE';
  t('an unrelated edit KEEPS the stored spa surcharge',
    M.planQuoteUpdate({ record: withSpa, patch: { size: 'medium' }, now: NOW, actor: 'mau' })
      .priced.service_subtotal === 285, '(260 + 25 spa)');

  const svc = upd({ service_key: 'biweekly_maint' });
  t('a service-type change re-prices', patchOf(svc, 'Proposals').subtotal === 170);
  t('and relabels', patchOf(svc, 'Proposals').service_type === 'Bi-Weekly Maintenance');
  t('the agreement rate follows', patchOf(svc, 'Service_Agreements').monthly_rate === 170);
  t('the service account rate follows', patchOf(svc, 'Service_Accounts').monthly_rate === 170);
}

console.log('\nAn impossible edit is refused, and nothing is written');
{
  const bad = upd({ adjustment_type: 'dollar', adjustment_value: '9999' });
  t('refused', bad.ok === false);
  t('with the engine’s reason', /custom price/i.test(bad.error));
  t('nothing staged', bad.updates.length === 0);

  const ag = upd({ service_key: 'biweekly_maint', pool_type: 'above_ground' });
  t('editing into an unpriceable configuration is refused', ag.ok === false);
  t('and asks for a price', /rate card/i.test(ag.error));
  t('supplying one lets it through',
    upd({ service_key: 'biweekly_maint', pool_type: 'above_ground', manual_price: 150 }).ok === true);
}

console.log('\nEvery change is attributable');
{
  const r = upd({ adjustment_type: 'custom', adjustment_value: '350' });
  const log = JSON.parse(patchOf(r, 'Proposals').change_log);
  t('the original creation entry is preserved', log[0].action === 'created' && log[0].by === 'mau');
  t('an edit entry is appended', log.length === 2 && log[1].action === 'edited');
  t('it records who', log[1].by === 'mau');
  t('it records when', log[1].at === NOW);
  t('it records old → new', log[1].changes.some(c => /adjusted: 300 → 350/.test(c)));
  t('the structured diff is returned to the caller',
    r.changes.some(c => c.field === 'adjusted' && c.from === 300 && c.to === 350));

  const contact = upd({ email: 'new@example.com' });
  t('contact edits are logged too',
    JSON.parse(patchOf(contact, 'Proposals').change_log)[1].changes
      .some(c => /email: tony@example.com → new@example.com/.test(c)));
  t('and reach the client row', patchOf(contact, 'Clients').email === 'new@example.com');
  t('display_name is rebuilt when a name changes',
    patchOf(upd({ first_name: 'Anthony' }), 'Clients').display_name === 'Anthony Siller');

  // A cell has a hard character limit; an unbounded log would eventually make the
  // whole row write fail, losing the very edit being recorded.
  let big = REC();
  big.proposal.change_log = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ at: NOW, by: 'x', action: 'e' + i })));
  const capped = JSON.parse(patchOf(M.planQuoteUpdate({ record: big, patch: { size: 'small' }, now: NOW, actor: 'mau' }), 'Proposals').change_log);
  t('the log is capped rather than growing without limit', capped.length === 40);
  t('the newest entry survives the cap', capped[capped.length - 1].action === 'edited');
}

console.log('\nLine items are superseded, never deleted');
{
  const r = upd({ adjustment_type: 'custom', adjustment_value: '350' });
  const supers = find(r, 'Proposal_Items').filter(u => u.patch.status === 'superseded');
  t('the existing line is marked superseded', supers.length === 1);
  t('with a timestamp', supers[0].patch.superseded_at === NOW);
  t('the old line is NOT removed', !r.updates.some(u => u.patch && u.patch.proposal_item_id === ''));

  const fresh = r.inserts.Proposal_Items || [];
  t('a fresh line set is written', fresh.length === 2, '(service + premium)');
  t('the new lines are active', fresh.every(i => i.status === 'active'));
  t('new ids continue past the existing one', fresh[0].proposal_item_id === 'PIT-000002');
  t('the premium appears as its own line',
    fresh.some(i => i.line_type === 'premium' && i.amount === 50));
  t('all lines point at the proposal', fresh.every(i => i.proposal_id === 'PRP-000001'));
}

console.log('\nA sent proposal returns to DRAFT so the record cannot lie');
{
  const sent = REC();
  sent.proposal.status = 'SENT';
  sent.proposal.sent_at = '2026-08-19T12:00:00.000Z';
  const p = patchOf(M.planQuoteUpdate({ record: sent, patch: { adjustment_type: 'custom', adjustment_value: '350' }, now: NOW, actor: 'mau' }), 'Proposals');
  t('status drops back to DRAFT', p.status === 'DRAFT');
  t('and sent_at is cleared', p.sent_at === '');
  t('a DRAFT proposal is left alone', patchOf(upd({ size: 'small' }), 'Proposals').status === undefined);
}

console.log('\nThe legacy export is refreshed so downstream documents follow');
{
  const r = upd({ adjustment_type: 'custom', adjustment_value: '350', email: 'new@example.com' });
  const c = patchOf(r, 'Quotes');
  t('the Quotes row is updated', find(r, 'Quotes').length === 1);
  t('with the new total', c.total_with_tax === 378.88);
  t('with the premium recorded honestly', c.premium_amount === 50 && c.discount_amount === 0);
  t('with the refreshed specs', /Size: large/.test(c.specs_summary));
  t('with the changed contact field', c.email === 'new@example.com');
  t('and still marked server-priced', c.pricing_source === 'server');
  t('untouched contact fields are not blanked', c.first_name === undefined);
}

console.log('\nScope and plan options are editable after the fact');
{
  const r = upd({ scope_items: ['Weekly pool service', 'Clean pool baskets'] });
  t('scope is stored', /Clean pool baskets/.test(patchOf(r, 'Proposals').scope_items_json));
  t('and mirrored to the export', /Clean pool baskets/.test(patchOf(r, 'Quotes').scope_items_json));
  // Clearing a scope that EXISTS must write an empty cell, not an empty object.
  const hadScope = REC();
  hadScope.proposal.scope_items_json = JSON.stringify({ items: ['Weekly pool service'] });
  const cleared = M.planQuoteUpdate({ record: hadScope, patch: { scope_items: [] }, now: NOW, actor: 'mau' });
  t('clearing a stored scope writes an empty cell', patchOf(cleared, 'Proposals').scope_items_json === '');
  t('and is recorded as a change', cleared.changes.some(c => c.field === 'scope_items'));
  t('clearing an ALREADY-empty scope is a no-op', upd({ scope_items: [] }).noop === true);
  t('plan options persist — they were previously in-memory only',
    patchOf(upd({ plan_options: { main_service: true, priority_service: false } }), 'Proposals')
      .plan_options_json === '{"main_service":true,"priority_service":false}');
}

console.log('\nA no-op edit does nothing at all');
{
  const r = upd({ size: 'large' });
  t('recognised as a no-op', r.noop === true);
  t('no updates staged', r.updates.length === 0);
  t('no inserts staged', Object.keys(r.inserts).length === 0);
  t('no change_log entry is invented', r.changes.length === 0);
}

console.log('\nOnly allow-listed fields can be written');
{
  const r = upd({ adjustment_type: 'custom', adjustment_value: '350',
                  status: 'ACTIVE_CUSTOMER', pool_id: 'MCPS-9999', quote_version: 'x' });
  t('the edit still succeeds', r.ok === true);
  t('the stray keys are named', r.unknown_fields.sort().join(',') === 'pool_id,quote_version,status');
  t('status cannot be set through this route',
    patchOf(r, 'Proposals').status === undefined || patchOf(r, 'Proposals').status === 'DRAFT');
  t('pool_id cannot be set through this route', patchOf(r, 'Quotes').pool_id === undefined);
  t('the allow-list is exported for the UI to read', M.EDITABLE.includes('adjustment_value'));
  t('and does not include identity or lifecycle columns',
    !M.EDITABLE.includes('pool_id') && !M.EDITABLE.includes('status') && !M.EDITABLE.includes('quote_id'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})();
