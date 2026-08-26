// The per-quote scope chips must actually drive what reaches the contract.
const fs=require('fs'), vm=require('vm'), path = require('path'); const R = path.join(__dirname, '..') + '/';
const els={};
function mk(id){ if(!els[id]) els[id]={id,style:{},value:'',innerHTML:'',textContent:'',
  classList:{_s:new Set(),add(c){this._s.add(c)},remove(c){this._s.delete(c)},contains(c){return this._s.has(c)},toggle(){}},
  focus(){},querySelectorAll(){return []}}; return els[id]; }
const ctx={console,Date,String,Number,Math,JSON,Array,Object,isNaN,
  document:{getElementById:mk,querySelectorAll:()=>[],querySelector:()=>null,
    createElement:()=>({innerHTML:'',querySelectorAll:()=>[]}),body:{style:{},classList:{add(){},remove(){},toggle(){}}},addEventListener(){}},
  window:{addEventListener(){},matchMedia:()=>({matches:false,addEventListener(){}})},
  localStorage:{_d:{},getItem(k){return this._d[k]??null},setItem(k,v){this._d[k]=v},removeItem(k){delete this._d[k]}},
  location:{hash:''},navigator:{userAgent:'node'},alert(){},confirm:()=>true,
  setTimeout,clearTimeout,setInterval,clearInterval,requestIdleCallback:cb=>cb(),
  fetch:()=>Promise.resolve({json:()=>Promise.resolve({ok:true})})};
ctx.globalThis=ctx; ctx.window.location=ctx.location; vm.createContext(ctx);
const load=f=>{try{vm.runInContext(fs.readFileSync(R+f,'utf8'),ctx,{filename:f});}catch(e){console.log('load '+f+': '+e.message);}};
['js/lib/constants.js','js/lib/pricing.js','js/lib/api.js','js/lib/auth.js','js/features/quotes.js'].forEach(load);
const ev=c=>vm.runInContext(c,ctx);
ev(`qRenderSavedCard = function(){};`);            // isolate state logic from rendering
ev(`_s={token:'t',roles:['admin'],pages:['quotes']};`);

let pass=0,fail=0; const t=(n,c,x='')=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+' '+x));};

ev(`_qS.service='weekly_service'; _qS.spa=false; _qS.proposal_scope_options={}; _qS.scope_custom_items=[];`);
const lib = ev(`qScopeItemsForService()`);
console.log('\nLibrary drives the chips');
t('service filter returns weekly items', lib.length > 0);
t('chips are keyed by scope_item_id, not legacy names',
  lib.every(i => /^(_w|_s|_g|_r|SCP)/.test(i.scope_item_id)));

const on  = lib.find(i => i.default_on);
const off = lib.find(i => !i.default_on);
console.log('\nDefaults are respected before any click');
let sel = ev(`qResolvedScopeItems()`);
t('default-on item is included', sel.includes(on.label));
t('default-off item is excluded', !sel.includes(off.label), '(' + off.label + ')');
t('chip renders ON for a default-on item',
  ev(`qProposalOptionChip('scope','${on.scope_item_id}','x')`).includes('active'));
t('chip renders OFF for a default-off item',
  !ev(`qProposalOptionChip('scope','${off.scope_item_id}','x')`).includes('active'));

console.log('\nToggling actually changes what ships (this was silently broken)');
ev(`qToggleProposalScope('${on.scope_item_id}')`);
sel = ev(`qResolvedScopeItems()`);
t('turning a default-ON item off REMOVES it from the contract', !sel.includes(on.label),
  '(still present: ' + JSON.stringify(sel.slice(0,3)) + ')');
t('its chip now renders OFF',
  !ev(`qProposalOptionChip('scope','${on.scope_item_id}','x')`).includes('active'));

ev(`qToggleProposalScope('${off.scope_item_id}')`);
sel = ev(`qResolvedScopeItems()`);
t('turning a default-OFF item on ADDS it', sel.includes(off.label));
t('its chip now renders ON',
  ev(`qProposalOptionChip('scope','${off.scope_item_id}','x')`).includes('active'));

ev(`qToggleProposalScope('${on.scope_item_id}')`);
t('toggling back restores it', ev(`qResolvedScopeItems()`).includes(on.label));

console.log('\nOne-off custom lines');
mk('q-scope-custom').value = 'Salt cell inspection';
ev(`qAddCustomScope()`);
t('custom line added', ev(`_qS.scope_custom_items`).includes('Salt cell inspection'));
t('reaches the contract', ev(`qResolvedScopeItems()`).includes('Salt cell inspection'));
t('input cleared', els['q-scope-custom'].value === '');

mk('q-scope-custom').value = 'salt cell inspection';
ev(`qAddCustomScope()`);
t('duplicate (case-insensitive) refused', ev(`_qS.scope_custom_items`).length === 1);

mk('q-scope-custom').value = on.label;
ev(`qAddCustomScope()`);
t('duplicate of a LIBRARY item refused', ev(`_qS.scope_custom_items`).length === 1);

mk('q-scope-custom').value = '   ';
ev(`qAddCustomScope()`);
t('blank refused', ev(`_qS.scope_custom_items`).length === 1);

ev(`qRemoveCustomScope(0)`);
t('removable', ev(`_qS.scope_custom_items`).length === 0);
t('and gone from the contract', !ev(`qResolvedScopeItems()`).includes('Salt cell inspection'));

console.log('\nService type switches the offered list');
ev(`_qS.service='pool_startup';`);
const su = ev(`qScopeItemsForService()`).map(i=>i.scope_item_id);
t('startup shows startup items', su.some(k=>k.startsWith('_s')));
t('startup hides weekly-only items', !su.includes('_w7'));

console.log('\nExisting-customer identity rides on every quote type');
ev(`_qS.service='weekly_full'; _qS.client_id='CLI-001'; _qS.location_id='LOC-001'; _qS.pool_id='P-001';`);
let ident = ev(`qSelectedIdentityPayload_()`);
t('weekly quotes keep selected client_id', ident.client_id === 'CLI-001');
t('weekly quotes keep selected location_id', ident.location_id === 'LOC-001');
t('weekly quotes can carry the selected pool hint', ident.pool_id === 'P-001');

ev(`_qS.client_id=''; _qS.location_id=''; _qS.pool_id=''; _qS.repair_client_id='CLI-R'; _qS.repair_location_id='LOC-R'; _qS.repair_pool_id='P-R';`);
ident = ev(`qSelectedIdentityPayload_()`);
t('repair compatibility fields still feed the save payload', ident.client_id === 'CLI-R' && ident.location_id === 'LOC-R' && ident.pool_id === 'P-R');

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
