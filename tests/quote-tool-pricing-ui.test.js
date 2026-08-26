// The quote tool's pricing UI — js/features/quotes.js against js/lib/pricing.js.
//
//   node tests/quote-tool-pricing-ui.test.js
//
// ⚠️ WHY THIS EXISTS SEPARATELY from tests/quote-pricing.test.js. That file proves
// the engine is right. This one proves the SCREEN is wired to it — that the number
// typed into #q-adj-val reaches the save payload, that the summary says "premium"
// out loud, and that Save is enabled/disabled for the right reason. The original
// defect was invisible at the engine boundary: qCalcDiscount clamped, and every
// layer above it faithfully displayed the clamped figure.
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..') + '/';

const els = {};
function mk(id) {
  if (!els[id]) els[id] = { id, style: {}, value: '', innerHTML: '', textContent: '', placeholder: '',
    dataset: {}, disabled: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { on === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (on ? this._s.add(c) : this._s.delete(c)); } },
    focus() {}, querySelectorAll() { return []; }, setAttribute() {}, scrollIntoView() {} };
  return els[id];
}
let sent = [];
const ctx = { console, Date, String, Number, Math, JSON, Array, Object, isNaN, isFinite, parseFloat, parseInt,
  document: { getElementById: mk, querySelectorAll: () => [], querySelector: () => null,
    createElement: () => ({ innerHTML: '', querySelectorAll: () => [], getContext: () => ({ drawImage() {} }) }),
    body: { style: {}, classList: { add() {}, remove() {}, toggle() {} } }, addEventListener() {} },
  window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
  location: { hash: '' }, navigator: { userAgent: 'node' }, alert() {}, confirm: () => true,
  setTimeout, clearTimeout, setInterval, clearInterval, requestIdleCallback: cb => cb(),
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }) };
ctx.globalThis = ctx; ctx.window.location = ctx.location;
vm.createContext(ctx);
const load = f => { try { vm.runInContext(fs.readFileSync(R + f, 'utf8'), ctx, { filename: f }); }
                    catch (e) { console.log('LOAD FAIL ' + f + ': ' + e.message); process.exit(1); } };
['js/lib/constants.js', 'js/lib/pricing.js', 'js/lib/api.js', 'js/lib/auth.js', 'js/features/quotes.js'].forEach(load);
const ev = c => vm.runInContext(c, ctx);

// Capture the save payload instead of posting it, and neutralise the saved-card render.
ev(`_s = { token:'t', name:'Tester', roles:['admin'], pages:['quotes'] };
    _crmCache = [];
    qRenderSavedCard = function(){};
    __sent = []; __gas = [];
    // qSave now posts to the Vercel relational endpoint, not to Apps Script.
    apiLocalPost = function(path, p){ __sent.push(Object.assign({ __path: path }, p));
      return Promise.resolve({ ok:true, quote_id:'Q-TEST01', proposal_id:'PRP-000001',
        agreement_id:'AGR-0001', service_account_id:'SVA-000001', ms: 420 }); };
    apiLocalGet = function(){ return Promise.resolve({ ok:false, error:'not used here' }); };
    // Apps Script is now only used for the AFTER-save operational provisioning.
    api = function(p){ __gas.push(p); return Promise.resolve({ ok:true, pool_id:'' }); };
    apiGet = function(){ return Promise.resolve({ ok:true }); };
    _clearRouteCache = function(){};`)

let pass = 0, fail = 0;
const t = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + x)); };
const sum = () => ctx.document.getElementById('q-sum-content').innerHTML;
const saveBtn = () => ctx.document.getElementById('q-save-btn');

// qSave() resolves on a microtask, so anything it does AFTER the await — notably
// the background provisioning call — has not run yet when a synchronous
// assertion reads it. flush() lets the queue drain.
const flush = () => new Promise(r => setTimeout(r, 0));

(async () => {

console.log('\nBaseline: a large weekly quote');
{
  ev(`_qS = _qDef(); _qS.service='weekly_full'; _qS.size='large'; qRecalc();`);
  t('rate card price is shown', /\$300\.00/.test(sum()));
  t('Save is enabled', saveBtn().disabled === false);
  t('no adjustment bar yet', !/Premium|Discount/.test(sum()));
}

console.log('\nA quote with no contact details is refused before any round trip');
{
  ev(`_qS = _qDef(); _qS.service='weekly_full'; _qS.size='large'; qRecalc();
      __sent = []; qSave();`);
  t('nothing is posted', ev(`__sent.length`) === 0);
  t('the operator is told what is missing',
    /Missing:/.test(ctx.document.getElementById('q-save-msg').textContent));
  t('it names the address', /address/.test(ctx.document.getElementById('q-save-msg').textContent));
  t('the offending fields are flagged',
    ctx.document.getElementById('q-address').classList.contains('is-invalid'));
}


console.log('\nTHE FIX: a custom price ABOVE the rate card');
{
  ev(`qAdjTypeChange('custom'); qAdjValChange('350');`);
  t('state kept the typed value', ev(`_qS.adjustment_value`) === '350');
  t('engine charged 350, not 300', ev(`_qS._calc.adjusted_service`) === 350);
  t('the summary says PREMIUM in words', /Premium/.test(sum()), '(' + sum().slice(0, 80) + ')');
  t('it names the amount', /\+\$50\.00/.test(sum()));
  t('it still shows the preset for comparison', /Preset \$300\.00/.test(sum()));
  t('the total reflects 350 + tax', /\$378\.88/.test(sum()));
  t('Save stays enabled', saveBtn().disabled === false);
  t('no error is shown on the field',
    ctx.document.getElementById('q-adj-err').style.display === 'none');
  t('the field is not marked invalid',
    !ctx.document.getElementById('q-adj-val').classList.contains('is-invalid'));
}

console.log('\nThe premium survives all the way into the save payload');
{
  ev(`_qS = _qDef(); _qS.service='weekly_full'; _qS.size='large'; qRecalc();
      qAdjTypeChange('custom'); qAdjValChange('350');
      _qS.first_name='Tony'; _qS.last_name='Siller'; _qS.email='t@x.com';
      _qS.address='123 Pool Lane'; _qS.city='San Antonio';
      __sent = []; __gas = []; qSave();`);
  const p = ev(`__sent[0]`);
  t('one save posted', !!p);
  t('to the relational endpoint, not Apps Script', p && p.__path === '/api/quotes/save');
  t('the service KEY is sent — the label alone killed repair orders',
    p.service_key === 'weekly_full');
  t('the adjustment is sent as type + typed value, not as a computed total',
    p.adjustment_type === 'custom' && p.adjustment_value === '350');
  t('the browser figures ride along as a CLAIM for the server to check',
    p.adjusted_service === 350 && p.total_with_tax === 378.88);
  t('the rate-card figure is included so a mismatch is detectable', p.service_subtotal === 300);
  t('an idempotency key is attached', !!p.idempotency_key);
  t('scope items are sent', Array.isArray(p.scope_items));
  t('plan options are sent — they used to be in-memory only', !!p.plan_options);
}

console.log('\nSaving twice reuses the SAME idempotency key');
{
  const first = ev(`__sent[0].idempotency_key`);
  ev(`_qS.saving = false; qSave();`);
  t('a second save carries the same key', ev(`__sent[1].idempotency_key`) === first);
  t('so the server can recognise the duplicate', typeof first === 'string' && first.length > 8);
  ev(`qReset();`);
  t('a NEW quote gets a fresh key', ev(`_qS.idempotency_key`) === '');
}

console.log('\nProvisioning happens AFTER the operator is told it saved');
{
  await flush();
  const gas = ev(`__gas`);
  t('Apps Script is called for the operational side', gas.length >= 1);
  t('with the provisioning action', gas[0].action === 'provision_quote_schedule');
  t('for the saved quote', gas[0].quote_id === 'Q-TEST01');
  t('the success message was already shown',
    /Saved!/.test(ctx.document.getElementById('q-save-msg').textContent));
  t('and it reports how long the save took',
    /0\.4s/.test(ctx.document.getElementById('q-save-msg').textContent));
}

console.log('\nA discount still works and reads as one');
{
  ev(`_qS = _qDef(); _qS.service='weekly_full'; _qS.size='large'; qAdjTypeChange('custom'); qAdjValChange('260');`);
  t('charged 260', ev(`_qS._calc.adjusted_service`) === 260);
  t('summary says Discount', /Discount/.test(sum()));
  t('names the amount', /−\$40\.00/.test(sum()) || /-\$40\.00/.test(sum()));
}

console.log('\nInvalid input is refused ON THE FIELD, not silently absorbed');
{
  ev(`_qS = _qDef(); _qS.service='weekly_full'; _qS.size='large'; qAdjTypeChange('dollar'); qAdjValChange('400');`);
  t('Save is disabled', saveBtn().disabled === true);
  t('the field is flagged invalid',
    ctx.document.getElementById('q-adj-val').classList.contains('is-invalid'));
  t('a reason is displayed', !!ctx.document.getElementById('q-adj-err').textContent);
  t('the reason points at Custom Price',
    /custom price/i.test(ctx.document.getElementById('q-adj-err').textContent));
  t('the price falls back to the rate card, not to zero', ev(`_qS._calc.adjusted_service`) === 300);

  ev(`__sent = []; qSave();`);
  t('qSave refuses to post an invalid quote', ev(`__sent.length`) === 0);
}

console.log('\nAbove-ground bi-weekly: was an unrecoverable dead end');
{
  ev(`_qS = _qDef(); _qS.service='biweekly_maint'; _qS.pool_type='above_ground'; _qS.size='medium'; qRecalc();`);
  t('the operator price field is revealed',
    ctx.document.getElementById('q-manual-price-wrap').style.display === '');
  t('Save is disabled until a price is entered', saveBtn().disabled === true);
  t('the summary explains why', /rate card/i.test(sum()));
  ev(`qManualPriceChange('135');`);
  t('entering a price enables Save', saveBtn().disabled === false);
  t('the price is used', ev(`_qS._calc.service_subtotal`) === 135);
  t('the field hides again for a priced service',
    (ev(`_qS = _qDef(); _qS.service='weekly_full'; qRecalc();`),
     ctx.document.getElementById('q-manual-price-wrap').style.display === 'none'));
}

console.log('\nFiberglass weekly stops advertising surcharges it will not apply');
{
  ev(`_qS = _qDef(); _qS.service='weekly_full'; _qS.size='large'; _qS.material='fiberglass'; _qS.spa=true; qRecalc();`);
  t('flat rate applied', ev(`_qS._calc.service_subtotal`) === 200);
  t('the spa label is struck through',
    ctx.document.getElementById('q-mod-spa').style.textDecoration === 'line-through');
  t('and reads "no charge"', ctx.document.getElementById('q-mod-spa').textContent === 'no charge');
  t('the summary warns in words', /do not change the price/.test(sum()));
  t('Save is still enabled — a flat rate is valid', saveBtn().disabled === false);
}

console.log('\nModifier hints are stamped from the rate card, not hardcoded');
{
  ev(`_qS = _qDef(); _qS.service='weekly_full'; _qS.material='plaster'; qRecalc();`);
  t('spa reads +$25.00', ctx.document.getElementById('q-mod-spa').textContent === '+$25.00');
  t('robot reads as a credit', /^−\$5\.00$/.test(ctx.document.getElementById('q-mod-robot').textContent));
  t('pets reads +$5.00', ctx.document.getElementById('q-mod-pets').textContent === '+$5.00');
  t('nothing is struck through on a rate-card pool',
    ctx.document.getElementById('q-mod-spa').style.textDecoration === '');
}

console.log('\nRepair quotes send what the form collected');
{
  ev(`_qS = _qDef(); _qS.service='repair_job'; qRecalc(); qManualPriceChange('480');
      _qS.repair_job_name='Pool Light Replacement'; _qS.repair_issue='Failed niche seal';
      _qS.repair_equipment='Lighting'; _qS.repair_priority='high'; _qS.repair_assigned_to='jose';
      _qS.repair_parts=[{name:'Pool light',qty:1},{name:'Niche gasket',qty:2}];
      _qS.address='1 Pool Ln'; _qS.city='San Antonio';
      _qS.first_name='Tony'; _qS.email='tony@example.com';
      __sent = []; qSave();`);
  const p = ev(`__sent[0]`);
  t('a repair quote posts', !!p);
  t('the service KEY is repair_job — not the display label', p.service_key === 'repair_job');
  t('the operator-typed price is sent as manual_price', p.manual_price === 480);
  t('the specific issue reaches the server', p.repair_issue === 'Failed niche seal');
  t('the work-order fields ride along',
    p.repair_job_name === 'Pool Light Replacement' && p.repair_priority === 'high' &&
    p.repair_equipment === 'Lighting' && p.repair_assigned_to === 'jose');
  t('parts are sent, and blank ones are dropped',
    JSON.parse(p.repair_parts).length === 2);
  t('no margin row for a repair', !/Margin:/.test(sum()));
  t('a repair needs no signature gate for pricing to be ready',
    ev(`_qS._calc.pricing_ready`) === true);
}

console.log('\nNew Quote clears the repair form it used to leave behind');
{
  ev(`_qS = _qDef(); _qS.service='repair_job';`);
  ctx.document.getElementById('q-rep-name').value = 'Old Job';
  ctx.document.getElementById('q-rep-issue').value = 'Old issue';
  ctx.document.getElementById('q-rep-equip').value = 'Pump';
  ctx.document.getElementById('q-rep-tech').value = 'someone';
  ctx.document.getElementById('q-adj-val').value = '999';
  ev(`qReset();`);
  t('job name cleared', ctx.document.getElementById('q-rep-name').value === '');
  t('issue cleared', ctx.document.getElementById('q-rep-issue').value === '');
  t('equipment cleared', ctx.document.getElementById('q-rep-equip').value === '');
  t('assigned tech cleared', ctx.document.getElementById('q-rep-tech').value === '');
  t('adjustment value cleared', ctx.document.getElementById('q-adj-val').value === '');
  t('adjustment type reset', ctx.document.getElementById('q-adj-type').value === 'none');
  t('state is back to defaults', ev(`_qS.adjustment_type`) === 'none' && ev(`_qS.manual_price`) === 0);
}

console.log('\nThe retired direct-contract path is gone from the tool');
{
  t('qGenerateContract no longer exists', ev(`typeof qGenerateContract`) === 'undefined');
  t('qSendContract no longer exists', ev(`typeof qSendContract`) === 'undefined');
  t('no agreement_direct flow can be selected',
    (ev(`qSetSalesFlow('operational_override')`), ev(`_qS.activation_method`) === 'ADMIN_OVERRIDE'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})();
