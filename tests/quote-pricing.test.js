// js/lib/pricing.js — the shared pricing engine.
//
//   node tests/quote-pricing.test.js        (exits non-zero on failure)
//
// ⚠️ WHY THIS FILE EXISTS. Before it, neither qCalcEngine nor qCalcDiscount had a
// single test. That is how a custom price above the preset came to be silently
// rewritten DOWN to the preset for however long it has been live: nothing ever
// asserted that the number you type is the number you get.
//
// The engine is pure, so every case below is exact arithmetic — no fixtures, no
// mocks, no spreadsheet.
const P = require('../js/lib/pricing.js');

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };
const q = (o) => P.priceQuote(o);

console.log('\nRate card — weekly full service');
{
  t('small = 220',  q({ service: 'weekly_full', size: 'small'  }).service_subtotal === 220);
  t('medium = 260', q({ service: 'weekly_full', size: 'medium' }).service_subtotal === 260);
  t('large = 300',  q({ service: 'weekly_full', size: 'large'  }).service_subtotal === 300);
  t('chem cost tracks size', q({ service: 'weekly_full', size: 'large' }).chem_cost_est === 60);
  t('margin is computed off chem cost',
    q({ service: 'weekly_full', size: 'large' }).net_profit_est === 240);
}

console.log('\nRate card — bi-weekly, green-to-clean, startup');
{
  t('bi-weekly inground medium = 140',
    q({ service: 'biweekly_maint', pool_type: 'inground', size: 'medium' }).service_subtotal === 140);
  t('green-to-clean is a flat 200',
    q({ service: 'green_to_clean', size: 'large' }).service_subtotal === 200);
  t('startup defaults (chem + programming) = 350.36',
    q({ service: 'pool_startup', startup_chemical: true, startup_programming: true }).service_subtotal === 350.36);
  t('startup chem carries its cost basis',
    q({ service: 'pool_startup', startup_chemical: true }).chem_cost_est === 162.86);
  t('startup with nothing selected is not saveable',
    q({ service: 'pool_startup' }).pricing_ready === false);
}

console.log('\nModifiers are additive on recurring work');
{
  const base = q({ service: 'weekly_full', size: 'medium' }).service_subtotal;
  t('spa +25',       q({ service: 'weekly_full', size: 'medium', spa: true }).service_subtotal === base + 25);
  t('dark +10',      q({ service: 'weekly_full', size: 'medium', finish: 'dark' }).service_subtotal === base + 10);
  t('heavy +10',     q({ service: 'weekly_full', size: 'medium', debris: 'heavy' }).service_subtotal === base + 10);
  t('high sun +10',  q({ service: 'weekly_full', size: 'medium', high_sun_exposure: true }).service_subtotal === base + 10);
  t('pets +5',       q({ service: 'weekly_full', size: 'medium', has_pets: true }).service_subtotal === base + 5);
  t('robot -5',      q({ service: 'weekly_full', size: 'medium', has_robot: true }).service_subtotal === base - 5);
  t('all stack',
    q({ service: 'weekly_full', size: 'medium', spa: true, finish: 'dark', debris: 'heavy',
        high_sun_exposure: true, has_pets: true, has_robot: true }).service_subtotal === base + 55);
  t('modifiers do NOT apply to green-to-clean',
    q({ service: 'green_to_clean', spa: true, finish: 'dark' }).service_subtotal === 200);
}

console.log('\nTHE REGRESSION: a custom price above preset must HOLD');
{
  const r = q({ service: 'weekly_full', size: 'large', adjustment_type: 'custom', adjustment_value: 350 });
  t('charged 350, not clamped to 300', r.adjusted_service === 350,
    '(got ' + r.adjusted_service + ')');
  t('reported as a premium', r.adjustment_kind === 'premium');
  t('premium amount is 50', r.adjustment_amount === 50);
  t('premium percent is 16.67', r.adjustment_percent === 16.67);
  t('the preset is still reported alongside it', r.service_subtotal === 300);
  t('tax is charged on the premium price', r.sales_tax === 28.88, '(got ' + r.sales_tax + ')');
  t('total reflects 350', r.total_with_tax === 378.88, '(got ' + r.total_with_tax + ')');
  t('saveable', r.pricing_ready === true);
  t('no error raised for a legitimate premium', r.adjustment_error === '');
}

console.log('\nCustom price below preset reads as a discount');
{
  const r = q({ service: 'weekly_full', size: 'large', adjustment_type: 'custom', adjustment_value: 260 });
  t('charged 260', r.adjusted_service === 260);
  t('reported as a discount', r.adjustment_kind === 'discount');
  t('discount amount is 40', r.adjustment_amount === 40);
  t('custom price equal to preset is neither',
    q({ service: 'weekly_full', size: 'large', adjustment_type: 'custom', adjustment_value: 300 }).adjustment_kind === 'none');
}

console.log('\nInvalid adjustments are REFUSED, never silently coerced');
{
  const neg = q({ service: 'weekly_full', size: 'large', adjustment_type: 'custom', adjustment_value: -50 });
  t('negative custom price is refused', !!neg.adjustment_error);
  t('refusal leaves the price at preset', neg.adjusted_service === 300);
  t('refusal blocks save', neg.pricing_ready === false);

  const over = q({ service: 'weekly_full', size: 'large', adjustment_type: 'percentage', adjustment_value: 120 });
  t('percentage over 100 is refused', !!over.adjustment_error);
  t('and does not produce a negative price', over.adjusted_service === 300);

  const bigD = q({ service: 'weekly_full', size: 'large', adjustment_type: 'dollar', adjustment_value: 400 });
  t('dollar discount exceeding the price is refused (was silently clamped)', !!bigD.adjustment_error);
  t('its message points at Custom Price', /custom price/i.test(bigD.adjustment_error));

  const blank = q({ service: 'weekly_full', size: 'large', adjustment_type: 'custom', adjustment_value: '' });
  t('empty value is refused rather than treated as $0', !!blank.adjustment_error);
}

console.log('\nValid percentage and dollar discounts still work');
{
  const pct = q({ service: 'weekly_full', size: 'large', adjustment_type: 'percentage', adjustment_value: 10 });
  t('10% off 300 = 270', pct.adjusted_service === 270);
  t('amount recorded as 30', pct.adjustment_amount === 30);
  const dol = q({ service: 'weekly_full', size: 'large', adjustment_type: 'dollar', adjustment_value: 45 });
  t('$45 off 300 = 255', dol.adjusted_service === 255);
  t('100% off is allowed (a comp)', 
    q({ service: 'weekly_full', size: 'large', adjustment_type: 'percentage', adjustment_value: 100 }).adjusted_service === 0);
}

console.log('\nOperator-typed pricing replaces the dead ends');
{
  const ag = q({ service: 'biweekly_maint', pool_type: 'above_ground', size: 'medium' });
  t('above-ground bi-weekly asks for a price', ag.requires_manual_price === true);
  t('and is not saveable until one is given', ag.pricing_ready === false);
  t('it explains why', /rate card/i.test(ag.warnings.join(' ')));
  const agp = q({ service: 'biweekly_maint', pool_type: 'above_ground', size: 'medium', manual_price: 135 });
  t('with a price it saves', agp.pricing_ready === true && agp.service_subtotal === 135);

  const rep = q({ service: 'repair_job', manual_price: 480 });
  t('repair is operator-priced', rep.requires_manual_price === true && rep.service_subtotal === 480);
  t('repair carries no chemical cost', rep.chem_cost_est === 0);
  t('repair SKU follows the job type',
    q({ service: 'repair_job', manual_price: 1, repair_type: 'other_job' }).qb_skus[0] === 'OTHER-JOB');
  t('negative manual price floors at 0', q({ service: 'repair_job', manual_price: -99 }).service_subtotal === 0);
}

console.log('\nFiberglass flat rate reports what it suppresses');
{
  const fg = q({ service: 'weekly_full', size: 'large', material: 'fiberglass',
                 spa: true, finish: 'dark', has_pets: true });
  t('flat 200 regardless of size', fg.service_subtotal === 200);
  t('flagged as a flat rate', fg.flat_rate === true);
  t('names every modifier it ignored', fg.suppressed_modifiers.length === 3);
  t('applies none of them', fg.applied_modifiers.length === 0);
  t('warns in words the operator can read', /do not change the price/.test(fg.warnings.join(' ')));
  t('fiberglass BI-weekly is NOT flat-rated (weekly only)',
    q({ service: 'biweekly_maint', pool_type: 'inground', size: 'large', material: 'fiberglass' }).service_subtotal === 170);
}

console.log('\nTravel and tax');
{
  const r = q({ service: 'weekly_full', size: 'medium', travel_fee: 18.5 });
  t('travel is added before tax', r.quote_subtotal === 278.5);
  t('tax is 8.25% of service + travel', r.sales_tax === 22.98, '(got ' + r.sales_tax + ')');
  t('total = subtotal + tax', r.total_with_tax === 301.48, '(got ' + r.total_with_tax + ')');
  t('void_travel removes it', q({ service: 'weekly_full', size: 'medium', travel_fee: 18.5, void_travel: true }).travel_fee === 0);
  t('travel is excluded from the chem-cost margin base',
    q({ service: 'weekly_full', size: 'medium', travel_fee: 18.5 }).net_profit_est === 238.5);
}

console.log('\nService keys vs display labels (the repair-order bug)');
{
  t('a key resolves to itself', P.serviceKeyOf('repair_job') === 'repair_job');
  t('the stored LABEL resolves to the key', P.serviceKeyOf('Repair / Replacement / Other Job') === 'repair_job');
  t('weekly label resolves', P.serviceKeyOf('Weekly Full Service') === 'weekly_full');
  t('green label resolves', P.serviceKeyOf('Green-to-Clean Cleaning Service') === 'green_to_clean');
  t('startup label resolves', P.serviceKeyOf('Pool Startup') === 'pool_startup');
  t('bi-weekly label resolves', P.serviceKeyOf('Bi-Weekly Maintenance') === 'biweekly_maint');
  t('legacy free text still resolves', P.serviceKeyOf('weekly full service') === 'weekly_full');
  t('nonsense resolves to empty, not a wrong guess', P.serviceKeyOf('flurb') === '');
  t('an unknown service is not saveable',
    q({ service: 'flurb' }).pricing_ready === false);
  t('every service exposes a scope key for the Scope Library',
    Object.keys(P.SERVICES).every(k => !!P.SERVICES[k].scope));
}

console.log('\nServer-side verification catches a tampered client');
{
  const input = { service: 'weekly_full', size: 'large', travel_fee: 0 };
  const honest = P.priceQuote(input);
  t('matching arithmetic verifies', P.verifyQuote(input, honest).ok === true);

  const tampered = P.verifyQuote(input, Object.assign({}, honest, { total_with_tax: 1 }));
  t('a forged total is caught', tampered.ok === false);
  t('it names the field', tampered.mismatches[0].field === 'total_with_tax');
  t('it reports both figures',
    tampered.mismatches[0].claimed === 1 && tampered.mismatches[0].computed === 324.75);
  t('the server keeps its OWN number regardless', tampered.priced.total_with_tax === 324.75);

  t('a zeroed price is caught', P.verifyQuote(input, { service_subtotal: 0 }).ok === false);
  t('rounding noise within a cent is tolerated',
    P.verifyQuote(input, Object.assign({}, honest, { sales_tax: honest.sales_tax + 0.004 })).ok === true);
  t('fields the client omits are not invented as mismatches',
    P.verifyQuote(input, { total_with_tax: honest.total_with_tax }).ok === true);
}

console.log('\nThe rate card is data, not scattered literals');
{
  t('tax rate is in the catalog', P.CATALOG.tax_rate === 0.0825);
  t('modifier deltas are readable by the UI', P.CATALOG.modifiers.spa === 25);
  t('every modifier has a human label',
    Object.keys(P.CATALOG.modifiers).every(k => !!P.MODIFIER_LABELS[k]));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
