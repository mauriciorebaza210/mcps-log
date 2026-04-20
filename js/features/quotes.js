// ══════════════════════════════════════════════════════════════════════════════
// QUOTE CALCULATOR — pool quote generation, billing setup, customer activation
// Depends on: constants.js (SEC), api.js (api, apiGet), auth.js (isAdmin)
// Uses globals: _s
// ══════════════════════════════════════════════════════════════════════════════
// QUOTE CALCULATOR
// ══════════════════════════════════════════════════════════════════════════════
const Q_TAX = 0.0825;

const _qDef = () => ({
  service:'weekly_full', size:'medium', pool_type:'inground', material:'plaster',
  spa:false, finish:'light', debris:'light', has_robot:false,
  high_sun_exposure:false, has_pets:false,
  startup_chemical:true, startup_programming:true, startup_pool_school:false,
  startup_company:'', sponsored_by_mcp:false, startup_start_date:'', override_signed:false,
  repair_type:'repair_replacement', repair_company:'', repair_address:'',
  repair_desc:'', repair_amount:0, repair_sku:'',
  discount_type:'none', discount_value:0, custom_price:0,
  void_travel:false, travel:null, travel_loading:false, travel_error:'',
  first_name:'', last_name:'', email:'', phone:'', address:'', zip_code:'', city:'', area:'',
  _calc:null, saved_id:null, saving:false,
  contract_status:'none', contract_url:'', contract_download_url:'', contract_error:'',
  send_contract_status:'none', sent_at:''
});
let _qS = _qDef();

function qSetService(svc) {
  _qS.service = svc;
  document.querySelectorAll('.q-svc-card').forEach(c => c.classList.toggle('active', c.dataset.svc === svc));
  const isRepair  = svc === 'repair_job';
  const isStartup = svc === 'pool_startup';
  document.getElementById('q-pool-sec').style.display    = (!isRepair && !isStartup) ? '' : 'none';
  document.getElementById('q-startup-sec').style.display = isStartup ? '' : 'none';
  document.getElementById('q-repair-sec').style.display  = isRepair  ? '' : 'none';
  qRecalc();
}

function qPill(el, grp) {
  document.querySelectorAll(`.q-pill[data-grp="${grp}"]`).forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  _qS[grp] = el.dataset.val;
  qRecalc();
}

function qChk(key) {
  const map = { spa:'spa', robot:'has_robot', sun:'high_sun_exposure', pets:'has_pets',
    chem:'startup_chemical', prog:'startup_programming', school:'startup_pool_school',
    mcp:'sponsored_by_mcp', override:'override_signed' };
  const field = map[key];
  _qS[field] = !_qS[field];
  document.getElementById('qchk-' + key).classList.toggle('active', _qS[field]);
  if (key === 'mcp') {
    const show = _qS.sponsored_by_mcp;
    document.getElementById('q-startup-date-row').style.display = show ? '' : 'none';
    if (show && !_qS.startup_start_date) {
      const d = new Date(), diff = (8 - d.getDay()) % 7 || 7;
      const nm = new Date(d); nm.setDate(d.getDate() + diff);
      const ds = nm.toISOString().slice(0, 10);
      _qS.startup_start_date = ds;
      document.getElementById('q-startup-date').value = ds;
      qStartupDateHint(ds);
    }
  }
  qRecalc();
}

function qStartupDateHint(ds) {
  const hint = document.getElementById('q-startup-date-hint');
  if (!hint || !ds) return;
  const d = new Date(ds + 'T12:00:00'), d2 = new Date(d);
  d2.setDate(d.getDate() + 2);
  const fmt = x => x.toLocaleDateString('en-US', {month:'short', day:'numeric'});
  hint.textContent = `Startup: ${fmt(d)} → ${fmt(d2)} (3 days)`;
}

function qField(field, val) {
  _qS[field] = val;
  if (field === 'startup_start_date') qStartupDateHint(val);
  qRecalc();
}

function qDiscTypeChange(val) {
  _qS.discount_type = val; _qS.discount_value = 0; _qS.custom_price = 0;
  const wrap = document.getElementById('q-disc-val-wrap');
  const lbl  = document.getElementById('q-disc-val-lbl');
  const inp  = document.getElementById('q-disc-val');
  inp.value = '';
  if (val === 'none') { wrap.style.display = 'none'; }
  else {
    wrap.style.display = '';
    if (val === 'Percentage')    { lbl.textContent = 'Discount %'; inp.placeholder = '10'; }
    else if (val === 'Dollar Amount') { lbl.textContent = 'Discount $'; inp.placeholder = '20.00'; }
    else                              { lbl.textContent = 'Custom Service Price'; inp.placeholder = '220.00'; }
  }
  qRecalc();
}

function qDiscValChange(raw) {
  const v = parseFloat(raw) || 0;
  if (_qS.discount_type === 'Custom Price') { _qS.custom_price = v; _qS.discount_value = 0; }
  else { _qS.discount_value = v; _qS.custom_price = 0; }
  qRecalc();
}

function qLookupTravel() {
  const dest = (_qS.zip_code || _qS.address || '').trim();
  if (!dest) { _qS.travel = null; _qS.travel_error = ''; qRecalc(); return; }
  if (_qS.travel && _qS.travel._dest === dest) return;
  _qS.travel_loading = true; _qS.travel_error = ''; qRecalc();
  apiGet({ action:'distance', dest })
    .then(res => {
      _qS.travel_loading = false;
      if (res.ok && res.travel) { _qS.travel = { ...res.travel, _dest: dest }; _qS.travel_error = ''; }
      else { _qS.travel = null; _qS.travel_error = res.error || 'Travel fee unavailable'; }
      qRecalc();
    })
    .catch(() => { _qS.travel_loading = false; _qS.travel = null; _qS.travel_error = 'Travel lookup failed'; qRecalc(); });
}

function qVoidTravel() { _qS.void_travel = !_qS.void_travel; qRecalc(); }

// ─── Pricing engine — faithful port of pricing.py ────────────────────────────
function qCalcEngine(s) {
  const { service, size, pool_type, material, spa, finish, debris, has_robot,
          high_sun_exposure, has_pets, startup_chemical, startup_programming,
          startup_pool_school, startup_company, repair_type, repair_company,
          repair_address, repair_desc, repair_amount, repair_sku, first_name, last_name } = s;

  let base = 0, chem = 0, pr = true, pw = '';
  let svcLabel = '', sizeLabel = size, qbNames = [], qbSkus = [];
  const ptLabel  = pool_type === 'inground' ? 'Inground' : 'Above Ground';
  const matLabel = material.charAt(0).toUpperCase() + material.slice(1);

  if (service === 'green_to_clean') {
    base = 200; svcLabel = 'Green-to-Clean Cleaning Service';
    qbNames = [svcLabel]; qbSkus = ['GTC-CLEAN'];
  } else if (service === 'pool_startup') {
    svcLabel = 'Pool Startup'; sizeLabel = 'startup';
    if (startup_chemical)    { base += 287.86; chem += 162.86; qbNames.push('Startup Chemicals','Pool Startup Chemical Work'); qbSkus.push('START-CHEM','START-CHEM-LABOR'); }
    if (startup_programming) { base += 125;    qbNames.push('Pool Startup Programming'); qbSkus.push('START-PROGRAM'); }
    if (startup_pool_school) { base += 62.5;   qbNames.push('Pool School'); qbSkus.push('POOL-SCHOOL'); }
  } else if (service === 'repair_job') {
    base = Math.max(parseFloat(repair_amount) || 0, 0);
    svcLabel = 'Repair / Replacement / Other Job'; sizeLabel = 'repair';
    const sku = (repair_sku || '').trim() || (repair_type === 'repair_replacement' ? 'REPAIR-GENERAL' : 'OTHER-JOB');
    qbNames = [(repair_desc || '').trim() || svcLabel]; qbSkus = [sku];
  } else {
    svcLabel = service === 'weekly_full' ? 'Weekly Full Service' : 'Bi-Weekly Maintenance';
    if (service === 'weekly_full') {
      const r = {small:220,medium:260,large:300}, c = {small:25,medium:40,large:60};
      base = r[size]||0; chem = c[size]||0;
      qbNames = [svcLabel]; qbSkus = [`WEEKLY-${size.toUpperCase()}`];
    } else {
      if (pool_type === 'above_ground') { base = 0; pr = false; pw = 'Above-ground bi-weekly pricing not set yet.'; }
      else { const r = {small:120,medium:140,large:170}; base = r[size]||0; }
      qbNames = [svcLabel]; qbSkus = [`BIWEEKLY-${size.toUpperCase()}`];
    }
  }

  let specs = [`Pool Type: ${ptLabel}`, `Size: ${sizeLabel}`, `Material: ${matLabel}`];

  if (service === 'weekly_full' || service === 'biweekly_maint') {
    const fg = service === 'weekly_full' && material === 'fiberglass';
    if (fg) { base = 200; qbNames = ['Swimming Pool Maintenance (Fiberglass Pool)']; qbSkus = ['WEEKLY-FIBERGLASS']; specs.push('Fiberglass Weekly Full Service Flat Rate'); }
    if (spa)               { if (!fg) { base += 25; specs.push('Attached Spa'); } }
    if (finish === 'dark') { if (!fg) { base += 10; specs.push('Dark Pool Color'); } } else { if (!fg) specs.push('Light Pool Color'); }
    if (debris === 'heavy'){ if (!fg) { base += 10; specs.push('Debris: Heavy'); } } else { if (!fg) specs.push('Debris: Light'); }
    if (high_sun_exposure && !fg) { base += 10; specs.push('High Sun Exposure'); }
    if (has_pets && !fg)          { base +=  5; specs.push('Pets on Property'); }
    if (has_robot && !fg)         { base -=  5; specs.push('Cleaning Robot Discount'); }
  } else {
    if (spa) specs.push('Attached Spa');
    specs.push(`Pool Color: ${finish === 'dark' ? 'Dark' : 'Light'}`);
    specs.push(`Debris: ${debris === 'heavy' ? 'Heavy' : 'Light'}`);
    if (high_sun_exposure) specs.push('High Sun Exposure');
    if (has_pets)          specs.push('Pets on Property');
    if (has_robot)         specs.push('Cleaning Robot On Site');
    if (service === 'pool_startup') {
      const si = [startup_chemical?'Chemical Work':'', startup_programming?'Programming':'', startup_pool_school?'Pool School':''].filter(Boolean);
      specs.push(`Startup Services: ${si.join(', ') || 'None Selected'}`);
      if ((startup_company || '').trim()) specs.push(`Startup Coming From: ${startup_company.trim()}`);
    } else if (service === 'repair_job') {
      const sku = (repair_sku || '').trim() || (repair_type === 'repair_replacement' ? 'REPAIR-GENERAL' : 'OTHER-JOB');
      const cn = ((first_name||'')+' '+(last_name||'')).trim() || (repair_company||'').trim();
      specs = [
        `Job Type: ${repair_type === 'repair_replacement' ? 'Repair / Replacement' : 'Other Job'}`,
        `Company: ${(repair_company||'').trim() || cn || 'N/A'}`,
        `Address: ${(repair_address||'').trim() || 'Not provided'}`,
        `Job Description: ${(repair_desc||'').trim() || 'Not provided'}`,
        `QuickBooks SKU: ${sku}`
      ];
    }
  }

  return { service_label:svcLabel, pool_type:ptLabel, size:sizeLabel, material:matLabel,
           spa:spa?'Yes':'No', finish:finish==='dark'?'Dark':'Light', debris:debris==='heavy'?'Heavy':'Light',
           subtotal:Math.round(base*100)/100, chem_cost:Math.round(chem*100)/100,
           specs_summary:specs.join(', '), pricing_ready:pr, pricing_warning:pw, qb_names:qbNames, qb_skus:qbSkus };
}

function qCalcDiscount(subtotal, dtype, dval, cprice) {
  if (dtype === 'Percentage') {
    const da = Math.round(subtotal * Math.min(dval, 100) / 100 * 100) / 100;
    return { da, discounted: Math.round(Math.max(subtotal-da,0)*100)/100 };
  } else if (dtype === 'Dollar Amount') {
    const da = Math.round(Math.min(dval, subtotal)*100)/100;
    return { da, discounted: Math.round(Math.max(subtotal-da,0)*100)/100 };
  } else if (dtype === 'Custom Price') {
    const cp = Math.round(Math.min(cprice, subtotal)*100)/100;
    return { da: Math.round(Math.max(subtotal-cp,0)*100)/100, discounted: cp };
  }
  return { da:0, discounted:subtotal };
}

function qRecalc() {
  const eng = qCalcEngine(_qS);
  const tFee = _qS.void_travel ? 0 : ((_qS.travel && !_qS.travel_loading) ? (_qS.travel.travel_fee||0) : 0);
  const { da, discounted } = qCalcDiscount(eng.subtotal, _qS.discount_type, _qS.discount_value, _qS.custom_price);
  const sub   = Math.round((discounted+tFee)*100)/100;
  const tax   = Math.round(sub*Q_TAX*100)/100;
  const total = Math.round((sub+tax)*100)/100;
  const net   = Math.round((sub-eng.chem_cost)*100)/100;
  const margin = sub > 0 ? Math.round(net/sub*1000)/10 : 0;
  _qS._calc = { eng, tFee, da, discounted, sub, tax, total, net, margin };
  qRenderSummary();
}

function qRenderSummary() {
  const c = _qS._calc;
  if (!c) { document.getElementById('q-summary').style.display='none'; return; }
  document.getElementById('q-summary').style.display = '';
  const { eng, tFee, da, discounted, sub, tax, total, net, margin } = c;
  let html = '';

  html += `<div class="q-metrics4">
    <div class="q-met"><div class="q-met-lbl">Service</div><div class="q-met-val">$${eng.subtotal.toFixed(2)}</div></div>
    <div class="q-met"><div class="q-met-lbl">Travel</div><div class="q-met-val">${_qS.travel_loading?'…':`$${tFee.toFixed(2)}`}</div></div>
    <div class="q-met"><div class="q-met-lbl">Tax (8.25%)</div><div class="q-met-val">$${tax.toFixed(2)}</div></div>
    <div class="q-met hi"><div class="q-met-lbl">Total</div><div class="q-met-val">$${total.toFixed(2)}</div></div>
  </div>`;

  if (_qS.travel && !_qS.void_travel) {
    html += `<div class="q-travel-bar">
      <div class="q-travel-info">🚗 ${_qS.travel.round_trip_miles} mi RT · Billable: ${_qS.travel.billable_round_trip_miles} mi · <em>${_qS.travel.distance_source}</em></div>
      <button class="q-voidbtn" onclick="qVoidTravel()">Void Travel</button>
    </div>`;
  } else if (_qS.void_travel && _qS.travel) {
    html += `<div class="q-travel-bar">
      <div class="q-travel-info">Travel fee voided (was $${_qS.travel.travel_fee.toFixed(2)})</div>
      <button class="q-voidbtn restored" onclick="qVoidTravel()">Restore</button>
    </div>`;
  } else if (_qS.travel_loading) {
    html += `<div class="q-travel-bar"><div class="q-travel-info">⏳ Looking up travel distance…</div></div>`;
  } else if (_qS.travel_error) {
    html += `<div class="q-travel-bar"><div class="q-travel-info" style="color:var(--warn)">⚠️ ${_qS.travel_error}</div></div>`;
  }

  if (_qS.discount_type !== 'none' && da > 0) {
    html += `<div class="q-disc-bar">🏷️ Discount: <b>−$${da.toFixed(2)}</b> · Discounted service: <b>$${discounted.toFixed(2)}</b></div>`;
  }

  html += `<div class="q-specs-txt">${eng.specs_summary || '—'}</div>`;
  if (eng.qb_skus && eng.qb_skus.length) html += eng.qb_skus.map(s=>`<span class="q-sku-chip">${s}</span>`).join('');
  if (!eng.pricing_ready && eng.pricing_warning) html += `<div class="q-warn-box">⚠️ ${eng.pricing_warning}</div>`;
  if (_qS.service !== 'repair_job') {
    const mc = margin >= 50 ? 'var(--success)' : margin >= 25 ? 'var(--warn)' : 'var(--error)';
    html += `<div class="q-margin-row">Margin: <b style="color:${mc}">${margin.toFixed(1)}%</b> · Est. Net: <b>$${net.toFixed(2)}</b> · Chem: $${eng.chem_cost.toFixed(2)}</div>`;
  }

  document.getElementById('q-sum-content').innerHTML = html;
  const btn = document.getElementById('q-save-btn');
  btn.disabled = !eng.pricing_ready || _qS.saving;
  btn.textContent = _qS.saving ? 'Saving…' : (_qS.saved_id ? `Saved ✓ (${_qS.saved_id})` : 'Save to CRM');
}

function qReset() {
  _qS = _qDef();
  document.querySelectorAll('.q-svc-card').forEach(c => c.classList.toggle('active', c.dataset.svc==='weekly_full'));
  const pd = { size:'medium', pool_type:'inground', material:'plaster', finish:'light', debris:'light', repair_type:'repair_replacement' };
  Object.entries(pd).forEach(([g,v]) => document.querySelectorAll(`.q-pill[data-grp="${g}"]`).forEach(p => p.classList.toggle('active', p.dataset.val===v)));
  document.getElementById('q-pool-sec').style.display    = '';
  document.getElementById('q-startup-sec').style.display = 'none';
  document.getElementById('q-repair-sec').style.display  = 'none';
  document.getElementById('q-startup-date-row').style.display = 'none';
  const hint = document.getElementById('q-startup-date-hint'); if(hint) hint.textContent='';
  ['spa','robot','sun','pets','school','mcp','override'].forEach(k => document.getElementById('qchk-'+k)?.classList.remove('active'));
  document.getElementById('qchk-chem')?.classList.add('active');
  document.getElementById('qchk-prog')?.classList.add('active');
  ['q-fname','q-lname','q-email','q-phone','q-address','q-zip','q-city','q-area',
   'q-startup-co','q-startup-date','q-rep-co','q-rep-sku','q-rep-addr','q-rep-desc','q-rep-amt'
  ].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('q-disc-type').value = 'none';
  document.getElementById('q-disc-val-wrap').style.display = 'none';
  document.getElementById('q-disc-val').value = '';
  const msg = document.getElementById('q-save-msg'); msg.className='q-msg'; msg.textContent='';
  qRenderSavedCard();
  qRecalc();
}

async function qSave() {
  const c = _qS._calc;
  if (!c || !c.eng.pricing_ready || _qS.saving) return;
  const { eng, tFee, da, discounted, sub, tax, total, net, margin } = c;
  _qS.saving = true; qRenderSummary();

  const payload = {
    action: 'save_quote', token: _s ? _s.token : '',
    first_name:_qS.first_name, last_name:_qS.last_name, email:_qS.email, phone:_qS.phone,
    address:_qS.address, city:_qS.city, zip_code:_qS.zip_code, area:_qS.area,
    service:eng.service_label, pool_type:eng.pool_type, size:eng.size, material:eng.material,
    spa:eng.spa, finish:eng.finish, debris:eng.debris,
    has_robot:_qS.has_robot, high_sun_exposure:_qS.high_sun_exposure, has_pets:_qS.has_pets,
    startup_chemical_work:_qS.startup_chemical, startup_programming:_qS.startup_programming,
    startup_pool_school:_qS.startup_pool_school, startup_company:_qS.startup_company,
    sponsored_by_mcp:_qS.sponsored_by_mcp, startup_start_date:_qS.startup_start_date,
    startup_total_days:_qS.sponsored_by_mcp ? 3 : 0,
    repair_job_type:        _qS.service==='repair_job' ? _qS.repair_type    : '',
    repair_company_name:    _qS.service==='repair_job' ? _qS.repair_company  : '',
    repair_company_address: _qS.service==='repair_job' ? _qS.repair_address  : '',
    repair_job_description: _qS.service==='repair_job' ? _qS.repair_desc     : '',
    repair_invoice_amount:  _qS.service==='repair_job' ? _qS.repair_amount   : 0,
    repair_sku:             _qS.service==='repair_job' ? _qS.repair_sku      : '',
    travel_fee:tFee,
    travel_one_way_miles:             (_qS.travel&&!_qS.void_travel)?_qS.travel.one_way_miles:0,
    travel_round_trip_miles:          (_qS.travel&&!_qS.void_travel)?_qS.travel.round_trip_miles:0,
    travel_billable_round_trip_miles: (_qS.travel&&!_qS.void_travel)?_qS.travel.billable_round_trip_miles:0,
    distance_source: (_qS.travel&&!_qS.void_travel)?_qS.travel.distance_source:'none',
    service_subtotal:eng.subtotal, discount_type:_qS.discount_type==='none'?'':_qS.discount_type,
    discount_value:_qS.discount_value, discount_amount:da, discounted_service_subtotal:discounted,
    quote_subtotal:sub, sales_tax:tax, total_with_tax:total,
    chem_cost_est:eng.chem_cost, net_profit_est:net, margin_percent:margin,
    specs_summary:eng.specs_summary, quickbooks_skus:eng.qb_skus.join(', '), quickbooks_item_names:eng.qb_names.join(', '),
    created_by:(_s&&_s.name)||'portal', quote_source:'portal', quote_version:'2.0',
    status:(_qS.service==='pool_startup'&&_qS.override_signed)?'SIGNED':'UNSENT'
  };

  try {
    const res = await api(payload);
    _qS.saving = false;
    const msg = document.getElementById('q-save-msg');
    if (res.ok) {
      _qS.saved_id = res.quote_id || '✓';
      msg.className = 'q-msg ok';
      msg.textContent = `Saved! Quote ID: ${res.quote_id || '—'}`;
      msg.scrollIntoView({ behavior:'smooth', block:'nearest' });
      qRenderSavedCard();
    } else {
      msg.className = 'q-msg err';
      msg.textContent = `Error: ${res.error || 'Save failed — check Apps Script logs.'}`;
    }
  } catch(e) {
    _qS.saving = false;
    const msg = document.getElementById('q-save-msg');
    msg.className = 'q-msg err';
    msg.textContent = 'Network error — check connection.';
  }
  qRenderSummary();
}

function qInit() { if (!_qS._calc) qRecalc(); }

// ──────────────────────────────────────────────────────────────────────────────
// SAVED QUOTE CARD
// ──────────────────────────────────────────────────────────────────────────────

function qRenderSavedCard() {
  const el = document.getElementById('q-saved-card');
  if (!el) return;
  if (!_qS.saved_id) { el.innerHTML = ''; return; }

  const c = _qS._calc;
  const eng = c ? c.eng : null;
  const tFee  = c ? c.tFee  : 0;
  const tax   = c ? c.tax   : 0;
  const total = c ? c.total : 0;
  const sub   = c ? c.sub   : 0;

  const fullName = [_qS.first_name, _qS.last_name].filter(Boolean).join(' ') || '—';
  const serviceLabel = eng ? eng.service_label : (_qS.service || '—');
  const specs = eng ? (eng.specs_summary || '') : '';

  // Contract section
  let contractHtml = '';
  if (_qS.contract_status === 'generating') {
    contractHtml = `<div class="q-contract-section">
      <span class="q-contract-status generating">Generating contract…</span>
    </div>`;
  } else if (_qS.contract_status === 'generated') {
    const sendLabel = _qS.send_contract_status === 'sending' ? 'Sending…'
                    : _qS.sent_at ? 'Resend Contract'
                    : 'Send Contract ✉';
    const sentNote = _qS.sent_at
      ? `<span style="font-size:.75rem;color:var(--muted)">Sent ${new Date(_qS.sent_at).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span>`
      : '';
    contractHtml = `<div class="q-contract-section">
      <span class="q-contract-status ok">Contract ready</span>
      <div class="q-contract-btns">
        <a class="q-btn-outline" href="${_qS.contract_url}" target="_blank" rel="noopener">View PDF</a>
        <a class="q-btn-outline" href="${_qS.contract_download_url}" target="_blank" rel="noopener">Download</a>
        <button class="q-btn-ghost" onclick="qGenerateContract()">Regenerate</button>
        <button class="q-btn-primary" onclick="qSendContract()" id="q-send-contract-btn"
          ${_qS.send_contract_status === 'sending' ? 'disabled' : ''}>${sendLabel}</button>
      </div>
      ${sentNote}
      <div id="q-send-msg" style="display:none;font-size:.8rem;margin-top:.35rem;color:var(--error)"></div>
    </div>`;
  } else {
    const errHtml = _qS.contract_error
      ? `<span class="q-contract-err">${_qS.contract_error}</span>` : '';
    contractHtml = `<div class="q-contract-section">
      <span class="q-contract-status none">No contract yet</span>
      ${errHtml}
      <div class="q-contract-btns">
        <button class="q-btn-primary" onclick="qGenerateContract()">Generate Contract</button>
      </div>
    </div>`;
  }

  // Edit panel (hidden initially)
  const editPanel = `<div class="q-edit-panel" id="q-edit-panel" style="display:none">
    <div class="q-edit-grid">
      <div><label class="q-flabel">First Name</label><input class="q-inp" id="qe-fname" value="${esc(_qS.first_name)}"></div>
      <div><label class="q-flabel">Last Name</label><input class="q-inp" id="qe-lname" value="${esc(_qS.last_name)}"></div>
      <div><label class="q-flabel">Email</label><input class="q-inp" id="qe-email" type="email" value="${esc(_qS.email)}"></div>
      <div><label class="q-flabel">Phone</label><input class="q-inp" id="qe-phone" type="tel" value="${esc(_qS.phone)}"></div>
      <div class="q-edit-full"><label class="q-flabel">Address</label><input class="q-inp" id="qe-address" value="${esc(_qS.address)}"></div>
      <div><label class="q-flabel">City</label><input class="q-inp" id="qe-city" value="${esc(_qS.city)}"></div>
      <div><label class="q-flabel">ZIP Code</label><input class="q-inp" id="qe-zip" value="${esc(_qS.zip_code)}"></div>
    </div>
    <div class="q-edit-actions">
      <button class="q-btn-primary" onclick="qSaveQuoteInfo()">Save Changes</button>
      <button class="q-btn-ghost" onclick="qToggleEditPanel(false)">Cancel</button>
      <span id="q-edit-msg" class="q-edit-msg"></span>
    </div>
  </div>`;

  el.innerHTML = `<div class="q-saved-card">
    <div class="q-saved-card-header">
      <div class="q-saved-card-id">
        <span class="q-id-badge">${_qS.saved_id}</span>
        <span class="q-saved-name">${esc(fullName)}</span>
      </div>
      <button class="q-btn-ghost q-edit-btn" onclick="qToggleEditPanel(true)">Edit Info</button>
    </div>

    <div class="q-saved-card-fields">
      ${_qS.email    ? `<div class="q-scf"><span class="q-scf-lbl">Email</span><span>${esc(_qS.email)}</span></div>` : ''}
      ${_qS.phone    ? `<div class="q-scf"><span class="q-scf-lbl">Phone</span><span>${esc(_qS.phone)}</span></div>` : ''}
      ${_qS.address  ? `<div class="q-scf q-scf-full"><span class="q-scf-lbl">Address</span><span>${esc(_qS.address)}</span></div>` : ''}
      ${(_qS.city || _qS.zip_code) ? `<div class="q-scf"><span class="q-scf-lbl">City / ZIP</span><span>${esc([_qS.city,_qS.zip_code].filter(Boolean).join(', '))}</span></div>` : ''}
    </div>

    <div class="q-saved-card-service">
      <span class="q-saved-svc-label">${esc(serviceLabel)}</span>
      ${specs ? `<span class="q-saved-specs">${esc(specs)}</span>` : ''}
    </div>

    <div class="q-metrics4 q-saved-pricing">
      <div class="q-met"><div class="q-met-lbl">Service</div><div class="q-met-val">$${(sub || 0).toFixed(2)}</div></div>
      <div class="q-met"><div class="q-met-lbl">Travel</div><div class="q-met-val">$${(tFee || 0).toFixed(2)}</div></div>
      <div class="q-met"><div class="q-met-lbl">Tax</div><div class="q-met-val">$${(tax || 0).toFixed(2)}</div></div>
      <div class="q-met hi"><div class="q-met-lbl">Total</div><div class="q-met-val">$${(total || 0).toFixed(2)}</div></div>
    </div>

    ${editPanel}
    ${contractHtml}
  </div>`;
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function qGenerateContract() {
  if (_qS.contract_status === 'generating') return;
  _qS.contract_status = 'generating';
  _qS.contract_error = '';
  qRenderSavedCard();
  try {
    const res = await api({ action: 'generate_contract', token: _s ? _s.token : '', quote_id: _qS.saved_id });
    if (res.ok) {
      _qS.contract_status = 'generated';
      _qS.contract_url = res.contract_url || '';
      _qS.contract_download_url = res.contract_download_url || '';
    } else {
      _qS.contract_status = 'none';
      _qS.contract_error = res.error || 'Contract generation failed.';
    }
  } catch(e) {
    _qS.contract_status = 'none';
    _qS.contract_error = 'Network error — check connection.';
  }
  qRenderSavedCard();
}

async function qSendContract() {
  if (!_qS.saved_id || _qS.send_contract_status === 'sending') return;
  _qS.send_contract_status = 'sending';
  qRenderSavedCard();
  try {
    const res = await api({ action: 'send_contract', token: _s ? _s.token : '', quote_id: _qS.saved_id });
    if (res.ok) {
      _qS.send_contract_status = 'sent';
      _qS.sent_at = res.sent_at || new Date().toISOString();
      // Keep CRM cache in sync
      const idx = _crmCache.findIndex(i => i.quote_id === _qS.saved_id);
      if (idx > -1) { _crmCache[idx].status = 'SENT'; _crmCache[idx].sent_at = _qS.sent_at; }
    } else {
      _qS.send_contract_status = 'error';
      _qS.contract_error = res.error || 'Failed to send contract.';
    }
  } catch(e) {
    _qS.send_contract_status = 'error';
    _qS.contract_error = 'Network error — check connection.';
  }
  qRenderSavedCard();
  const msgEl = document.getElementById('q-send-msg');
  if (msgEl && _qS.send_contract_status === 'error') {
    msgEl.textContent = _qS.contract_error;
    msgEl.style.display = 'block';
  }
}

function qToggleEditPanel(show) {
  const panel = document.getElementById('q-edit-panel');
  if (panel) panel.style.display = show ? '' : 'none';
}

async function qSaveQuoteInfo() {
  const btn = document.querySelector('#q-edit-panel .q-btn-primary');
  const msgEl = document.getElementById('q-edit-msg');
  if (btn) btn.disabled = true;
  if (msgEl) { msgEl.textContent = 'Saving…'; msgEl.className = 'q-edit-msg'; }

  const payload = {
    action: 'update_quote_info',
    token: _s ? _s.token : '',
    quote_id: _qS.saved_id,
    first_name: document.getElementById('qe-fname').value.trim(),
    last_name:  document.getElementById('qe-lname').value.trim(),
    email:      document.getElementById('qe-email').value.trim(),
    phone:      document.getElementById('qe-phone').value.trim(),
    address:    document.getElementById('qe-address').value.trim(),
    city:       document.getElementById('qe-city').value.trim(),
    zip_code:   document.getElementById('qe-zip').value.trim(),
  };

  try {
    const res = await api(payload);
    if (res.ok) {
      _qS.first_name = payload.first_name;
      _qS.last_name  = payload.last_name;
      _qS.email      = payload.email;
      _qS.phone      = payload.phone;
      _qS.address    = payload.address;
      _qS.city       = payload.city;
      _qS.zip_code   = payload.zip_code;
      qRenderSavedCard();
    } else {
      if (btn) btn.disabled = false;
      if (msgEl) { msgEl.textContent = res.error || 'Save failed.'; msgEl.className = 'q-edit-msg err'; }
    }
  } catch(e) {
    if (btn) btn.disabled = false;
    if (msgEl) { msgEl.textContent = 'Network error.'; msgEl.className = 'q-edit-msg err'; }
  }
}


