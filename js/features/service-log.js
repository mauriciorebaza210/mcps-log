// ══════════════════════════════════════════════════════════════════════════════
// SERVICE LOG — pool visit logging, chemical math, photo uploads, drafts
// Depends on: constants.js (SEC), api.js (api, apiGet)
// Uses globals: _s, _curPage
// ══════════════════════════════════════════════════════════════════════════════
// SERVICE LOG
// ══════════════════════════════════════════════════════════════════════════════
const TF={FC:"Chlorine (Cl)",PH:"pH",TA:"Total Alkalinity (TA)",CH:"Calcium Hardness (CH)"};
const SG={small:12000,medium:17500,large:25000};
const SM=[6,7,8,9];

const _SVC_META_TTL = 4 * 60 * 60 * 1000; // 4 hours — force fresh metadata after this

function loadServiceLog(prefillPoolId){
  window._lastLoadedPoolId = null;
  window._svcLoadCounter = (window._svcLoadCounter||0) + 1;
  const thisRequest = window._svcLoadCounter;

  // 1. Try to render INSTANTLY from cache if fresh enough
  const cached   = localStorage.getItem('svc_meta_cache');
  const cachedTs = parseInt(localStorage.getItem('svc_meta_cache_ts') || '0', 10);
  const cacheValid = cached && (Date.now() - cachedTs < _SVC_META_TTL);
  if (cacheValid) {
    try {
      renderSvcForm(JSON.parse(cached), prefillPoolId);
      document.getElementById('svc-loading').style.display = 'none';
      document.getElementById('svc-root').style.display = 'block';
    } catch(e) {}
  }

  // 2. Three parallel requests: form metadata, live pool list, pool context
  const metaReq  = api({ secret:SEC, action:'get_metadata' });
  const poolsReq = api({ secret:SEC, action:'get_pool_list', token:_s.token });
  const ctxReq   = prefillPoolId
    ? api({ secret:SEC, action:'get_pool_context', token:_s.token, pool_id:prefillPoolId })
    : Promise.resolve(null);

  // 3. Fresh form metadata — re-render if stale or changed
  metaReq.then(res => {
    if (thisRequest !== window._svcLoadCounter) return;
    if (res.ok) {
      const fresh = JSON.stringify(res.data);
      const changed = !cacheValid || localStorage.getItem('svc_meta_cache') !== fresh;
      localStorage.setItem('svc_meta_cache', fresh);
      localStorage.setItem('svc_meta_cache_ts', String(Date.now()));
      if (changed) {
        document.getElementById('svc-loading').style.display = 'none';
        document.getElementById('svc-root').style.display = 'block';
        renderSvcForm(res.data, prefillPoolId);
      }
    } else if (!cacheValid) {
      document.getElementById('svc-root').innerHTML = '<div style="color:var(--error);padding:2rem;text-align:center">'+res.error+'</div>';
      document.getElementById('svc-root').style.display = 'block';
    }
  }).catch(e => {
    if (!cacheValid) {
      document.getElementById('svc-loading').style.display = 'none';
      document.getElementById('svc-root').innerHTML = '<div style="color:var(--error);padding:2rem;text-align:center">Failed: '+e.message+'</div>';
      document.getElementById('svc-root').style.display = 'block';
    }
  });

  // 4. Live pool list — replaces dropdown options as soon as it arrives
  poolsReq.then(res => {
    if (thisRequest !== window._svcLoadCounter) return;
    if (res && res.ok && res.pools && res.pools.length) {
      // Give the form a moment to render before swapping options
      setTimeout(() => _applyLivePoolList_(res.pools, prefillPoolId), 60);
    }
  }).catch(() => {}); // Silent fail — form metadata choices are the fallback

  // 5. Pool context (specs/notes/trends) as soon as it arrives
  ctxReq.then(res => {
    if (thisRequest !== window._svcLoadCounter) return;
    if (res && res.ok && res.data && res.data.found) {
      setTimeout(() => applyPoolContext_(res.data, prefillPoolId), 20);
    }
  });
}

// Replace the pool_id select with live data and re-apply any prefill match
function _applyLivePoolList_(pools, prefillPoolId) {
  const sel = document.querySelector('[name="pool_id"]');
  if (!sel) return;
  const normalize = v => (typeof v === 'string' ? v : (v.label || v.id || String(v)));
  sel.innerHTML = '<option value="">Select...</option>' +
    pools.map(p => {
      const v = escHtml(normalize(p));
      return `<option value="${v}">${v}</option>`;
    }).join('');
  if (!prefillPoolId) return;
  // Re-apply prefill match (same logic as renderSvcForm)
  const mcpsId = prefillPoolId.match(/(MCPS-\d{4,})\s*$/i);
  for (let i = 0; i < sel.options.length; i++) {
    const opt = sel.options[i].value;
    if (opt === prefillPoolId || (mcpsId && opt.toUpperCase().includes(mcpsId[1].toUpperCase()))) {
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event('change'));
      break;
    }
  }
}

function renderSvcForm(meta, prefillPoolId){
  _formItems=meta;
  const root=document.getElementById('svc-root');root.innerHTML='';
  window._pendingSvcPoolId = null; // Consume it

  // ── Back Button / Header ──────────────────────────────────────────────────
  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:12px;padding:0 4px';
  hdr.innerHTML = `
    <button onclick="navigateTo('live_map')" style="background:var(--teal);color:#fff;border:none;padding:8px 14px;border-radius:10px;font-family:Oswald;font-size:0.85rem;font-weight:600;display:flex;align-items:center;gap:6px;cursor:pointer">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      BACK TO HUB
    </button>
  `;
  root.appendChild(hdr);

  let card=mkCard('Visit Details');root.appendChild(card);
  meta.forEach(item=>{
    if(item.isSectionBreak){
      card=mkCard(item.title||'Chemical Log');root.appendChild(card);
      if(item.title&&item.title.trim().toLowerCase()==='used'){
        const rb=document.createElement('div');rb.id='rec-box';rb.className='rec-box';
        rb.innerHTML='<div class="rb-hdr">Mr. Chuy Recommends:<span id="rb-vol" class="rb-vol">—</span></div><div id="rb-flags" class="rb-flags"></div><div id="rb-list" class="rb-list"></div>';
        card.appendChild(rb);
      }
      return;
    }
    const grp=document.createElement('div');grp.className='sfg';
    const te=item.title.replace(/"/g,'&quot;');
    const isHardMandatory = (te.toLowerCase() === 'pool_id' || te === 'pH' || te === 'Chlorine (Cl)' || te === 'Total Alkalinity (TA)');
    const lbl=item.title+((item.isRequired || isHardMandatory)?" <span style='color:red'>*</span>":'');
    grp.innerHTML='<label>'+lbl+'</label>'+(item.helpText?'<span class="sh">'+item.helpText+'</span>':'');
    let inp='';
    if(item.type==='LIST'||item.type==='MULTIPLE_CHOICE'){
      const isPoolId = item.title && item.title.trim().toLowerCase() === 'pool_id';
      inp='<select class="si" name="'+te+'" '+(item.isRequired?'required':'')+' onchange="'+(isPoolId?'handlePoolChange()':'runRecs()')+'"><option value="">Select...</option>'+item.choices.map(c=>'<option value="'+c.replace(/"/g,'&quot;')+'">'+c+'</option>').join('')+'</select>';
    }else if(item.type==='CHECKBOX'){
      inp=item.choices.map(c=>'<label class="scb"><input type="checkbox" name="'+te+'" value="'+c.replace(/"/g,'&quot;')+'" onchange="runRecs()"><span style="font-weight:400">'+c+'</span></label>').join('');
    }else if(item.type==='PARAGRAPH_TEXT'){
      inp='<textarea class="si" name="'+te+'" '+(item.isRequired?'required':'')+' oninput="runRecs()"></textarea>';
    }else{
      const isNum=Object.values(TF).indexOf(item.title)!==-1||(item.helpText&&item.helpText.toLowerCase().indexOf('quantity')!==-1);
      inp='<input class="si" type="'+(isNum?'number':'text')+'" step="any" name="'+te+'" '+(item.isRequired?'required':'')+' oninput="runRecs()">';
    }
    grp.innerHTML+=inp;card.appendChild(grp);
    if(item.title === 'Calcium Hardness (CH)') {
      // ── Tablet Level pill selector (portal-only) ────────────────────────────
      const tg=document.createElement('div');tg.className='sfg';
      tg.innerHTML='<label>Tablet Level <span style="color:red">*</span></label><span class="sh">Current chlorine tablet level in the chlorinator.</span><div class="cp" id="tablet-pills" style="flex-wrap:wrap"><div class="cpill tbpill" onclick="tTablet(this,\'low\')" data-val="low">Low (0–2 tabs)</div><div class="cpill tbpill" onclick="tTablet(this,\'medium\')" data-val="medium">Medium (3–4 tabs)</div><div class="cpill tbpill" onclick="tTablet(this,\'full\')" data-val="full">Full (5–6 tabs)</div><div class="cpill tbpill" onclick="tTablet(this,\'none\')" data-val="none">No Chlorinator</div></div>';
      card.appendChild(tg);
    }
    if(item.title&&item.title.trim().toLowerCase()==='pool_id'){
      const pg=document.createElement('div');pg.className='sfg';
      pg.innerHTML='<label>Pool Size</label><span class="sh">Used for chemical dosing calculations.</span><select class="si" id="svc-size" onchange="runRecs()"><option value="small">Small (&lt;15k gal)</option><option value="medium">Medium (15k–20k gal)</option><option value="large">Large (20k+ gal)</option></select>';
      const mg=document.createElement('div');mg.className='sfg';
      mg.innerHTML='<label>Pool Material</label><span class="sh">Affects acid dose — fiberglass gets reduced amount.</span><select class="si" id="svc-mat" onchange="runRecs()"><option value="plaster">Plaster</option><option value="fiberglass">Fiberglass</option><option value="vinyl">Vinyl</option></select>';
      card.appendChild(pg);
      card.appendChild(mg);
      const cg=document.createElement('div');cg.className='sfg';
      cg.innerHTML='<label>Pool Condition on Arrival</label><span class="sh">Changes chlorine protocol if pool is green or algae.</span><div class="cp"><div class="cpill" onclick="tCond(this,\'green\')" data-val="green">Green / Algae</div><div class="cpill" onclick="tCond(this,\'cloudy\')" data-val="cloudy">Cloudy</div><div class="cpill" onclick="tCond(this,\'clear\')" data-val="clear">Clear</div></div>';
      card.appendChild(cg);

      const ng = document.createElement('div'); ng.className = 'sfg';
      ng.innerHTML = '<label>Internal Notes</label><span class="sh">Admin-only notes. These do NOT go to the customer report email.</span><textarea class="si" id="svc-internal-notes" name="Internal Notes" oninput="runRecs()"></textarea>';
      card.appendChild(ng);
    }
  });
  // ── Photo upload card ──────────────────────────────────────────────────────
  window._svcPhotos = [];
  const photoCard = mkCard('📸 Visit Photos');
  photoCard.innerHTML += `
    <p style="font-size:.8rem;color:var(--muted);margin:0 0 .85rem">
      Optional — attach up to 4 photos (before/after, equipment, water).
    </p>
    <div class="photo-upload-area" id="photo-drop-zone"
         ondragover="event.preventDefault();this.classList.add('drag-over')"
         ondragleave="this.classList.remove('drag-over')"
         ondrop="handlePhotoDrop(event)">
      <input type="file" id="photo-file-input" accept="image/*" multiple
             onchange="handlePhotoSelect(this)">
      <div class="pu-icon">📷</div>
      <div class="pu-label">Tap to take photo or choose from library</div>
      <div class="pu-sub">JPEG · PNG · max 4 photos · 10 MB each</div>
    </div>
    <div class="photo-preview-grid" id="photo-preview-grid" style="display:none"></div>
    <div style="text-align:center" id="photo-count-wrap"></div>
  `;
  root.appendChild(photoCard);
  const sc=mkCard('');sc.style.cssText='background:transparent;box-shadow:none;border:none;padding:0';
  sc.innerHTML='<button class="btn-svc" id="btn-svc" onclick="submitSvc()">Submit Log to MCPS</button>';root.appendChild(sc);

  // ── Auto-fill Technician from logged-in user ────────────────────────────
  setTimeout(()=>{
    const techEl = document.querySelector('[name="Technician"]');
    if (techEl && _s && _s.name) {
      // For select dropdowns, try to match the option
      if (techEl.tagName === 'SELECT') {
        for (let i = 0; i < techEl.options.length; i++) {
          if (techEl.options[i].value.toLowerCase().trim() === _s.name.toLowerCase().trim() ||
              techEl.options[i].text.toLowerCase().trim() === _s.name.toLowerCase().trim()) {
            techEl.selectedIndex = i; break;
          }
        }
      } else {
        techEl.value = _s.name;
      }
      techEl.closest('.sfg').style.display = 'none'; // Hide since auto-filled
    }
  }, 100);

  if (prefillPoolId) {
    // Select the pool ID in the dropdown immediately
    setTimeout(() => {
      const poolSel = document.querySelector('[name="pool_id"]');
      if (poolSel) {
        const mcpsId = prefillPoolId.match(/(MCPS-\d{4,})\s*$/i);
        let matched = false;
        for (let i = 0; i < poolSel.options.length; i++) {
          const opt = poolSel.options[i].value;
          if (opt === prefillPoolId || (mcpsId && opt.toUpperCase().includes(mcpsId[1].toUpperCase()))) {
            poolSel.selectedIndex = i;
            matched = true;
            break;
          }
        }
        if (matched) poolSel.dispatchEvent(new Event('change'));
      }
    }, 10);
  }
}

function mkCard(t){const d=document.createElement('div');d.className='svc-card';if(t){const h=document.createElement('div');h.className='svc-stitle';h.textContent=t;d.appendChild(h);}return d;}

// ── Map → Service Log flow ────────────────────────────────────────────────────
function goToSvcLog(poolId, customerName) {
  if (!poolId) return;
  window._pendingSvcPoolId = poolId;
  window._prefillCustomer = customerName || '';
  navigateTo('service_log');
}

function prefillSvcForm_(poolId) {
  // This legacy function is now partially absorbed by loadServiceLog parallel flow
  // but kept for compatibility with other triggers
}

function applyPoolContext_(ctx, poolId) {
  // Prefill pool size
  if (ctx.last_size) {
    const sizeSel = document.getElementById('svc-size');
    if (sizeSel) {
      for (let i = 0; i < sizeSel.options.length; i++) {
        if (sizeSel.options[i].value === ctx.last_size) { sizeSel.selectedIndex = i; break; }
      }
    }
  }

  // Prefill pool material
  if (ctx.last_material) {
    const matSel = document.getElementById('svc-mat');
    if (matSel) {
      for (let i = 0; i < matSel.options.length; i++) {
        if (matSel.options[i].value === ctx.last_material) { matSel.selectedIndex = i; break; }
      }
    }
  }

  // Trigger recs recalc after prefill
  if (typeof runRecs === 'function') runRecs();

  // Show trend banner
  if (ctx.trends && ctx.trends.length) renderTrendBanner_(ctx.trends, ctx.visit_count || 0);

  // Show notes from last visit
  const lastNotes = ctx.internal_notes || ctx.last_notes || null;
  if (lastNotes) {
    const existing = document.getElementById('pool-last-notes-banner');
    if (existing) existing.remove();
    const root = document.getElementById('svc-root');
    if (root) {
      const banner = document.createElement('div');
      banner.id = 'pool-last-notes-banner';
      banner.className = 'pool-trend-banner';
      banner.style.background = '#fffbeb';
      banner.style.color = '#92400e';
      banner.style.borderLeft = '4px solid #f59e0b';
      banner.innerHTML = '<strong>📝 Notes from last visit:</strong> ' + lastNotes;
      root.insertBefore(banner, root.firstChild);
    }
  }
}

function renderTrendBanner_(trends, visitCount) {
  const root = document.getElementById('svc-root');
  if (!root) return;
  const existing = document.getElementById('pool-trend-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'pool-trend-banner';
  banner.className = 'pool-trend-banner';
  const pills = trends.map(t => '<span class="pool-trend-pill">' + t + '</span>').join(' ');
  banner.innerHTML = '<strong>📊 Trend — last ' + visitCount + ' visit' + (visitCount !== 1 ? 's' : '') + '</strong>' + pills;
  root.insertBefore(banner, root.firstChild);
}
function tCond(el,type){const was=el.classList.contains('active')||el.classList.contains('active-ok')||el.classList.contains('active-cloudy');document.querySelectorAll('.cpill:not(.tbpill)').forEach(p=>p.classList.remove('active','active-ok','active-cloudy'));if(!was)el.classList.add(type==='green'?'active':type==='clear'?'active-ok':'active-cloudy');runRecs();}
// Tablet level pill toggle
function tTablet(el,level){const was=el.classList.contains('tactive');document.querySelectorAll('.tbpill').forEach(p=>p.classList.remove('tactive'));if(!was)el.classList.add('tactive');runRecs();}
function getTabletLevel(){const a=document.querySelector('.tbpill.tactive');return a?a.dataset.val:null;}

function gn(t){const el=document.querySelector('[name="'+t+'"]');if(!el||!el.value)return null;const v=parseFloat(el.value);return isNaN(v)?null:v;}
function s2g(v){const s=String(v||'').toLowerCase();if(s.includes('large')||s.includes('>20'))return SG.large;if(s.includes('medium')||s.includes('15,000'))return SG.medium;return SG.small;}

function runRecs(){
  const fc=gn(TF.FC),ph=gn(TF.PH),ta=gn(TF.TA),ch=gn(TF.CH);
  const pe=document.querySelector('[name="pool_id"]');
  const szEl=document.getElementById('svc-size');
  const gal=szEl?SG[szEl.value]||SG.small:s2g(pe?pe.value:'');
  const mat=(document.getElementById('svc-mat')||{value:'plaster'}).value;
  const isG=!!document.querySelector('.cpill.active');
  const isS=SM.indexOf(new Date().getMonth()+1)!==-1;
  const rb=document.getElementById('rec-box');if(!rb)return;
  if(fc===null&&ph===null&&ta===null&&ch===null&&!isG){rb.style.display='none';return;}
  const recs=buildRecs(fc,ph,ta,ch,gal,mat,isG);
  const vb=document.getElementById('rb-vol');if(vb)vb.textContent=(gal/1000).toFixed(0)+'K gal';
  const fe=document.getElementById('rb-flags');if(fe)fe.innerHTML=(isS?'<span class="rf summer">Summer +50% Cl</span>':'')+(isG?'<span class="rf green">Algae Protocol</span>':'')+(mat==='fiberglass'?'<span class="rf fiber">Fiberglass</span>':'')+(mat==='plaster'?'<span class="rf plstr">Plaster</span>':'');
  if(!recs.length){rb.style.display='none';} else {
    rb.style.display='block';
    document.getElementById('rb-list').innerHTML=recs.map(r=>'<div class="ri '+r.status+'"><div class="ri-top"><span class="ri-name">'+r.name+'</span><span class="ri-amt">'+r.amt+'</span></div><div class="ri-why">↳ '+r.reason+'</div></div>').join('');
  }
  
  if (pe && pe.value) {
    saveDraft(pe.value);
  }
}

function saveDraft(poolId) {
  if(!poolId) return;
  const draft = {};
  _formItems.forEach(item => {
    if(!item.title) return;
    let val;
    if(item.type==='CHECKBOX') {
      const bs=document.querySelectorAll('input[name="'+item.title.replace(/"/g,'&quot;')+'"]:checked');
      val=Array.from(bs).map(b=>b.value);
    } else {
      const el=document.querySelector('[name="'+item.title.replace(/"/g,'&quot;')+'"]');
      if(el) val=el.value;
    }
    draft[item.title] = val;
  });
  
  const sizeSel = document.getElementById('svc-size');
  if (sizeSel) draft['svc_size'] = sizeSel.value;
  const matSel = document.getElementById('svc-mat');
  if (matSel) draft['svc_mat'] = matSel.value;
  
  const condPill = document.querySelector('.cpill.active, .cpill.active-cloudy, .cpill.active-ok');
  if(condPill) draft['svc_cond'] = condPill.dataset.val;

  const tabPill = document.querySelector('.tbpill.tactive');
  if(tabPill) draft['svc_tab'] = tabPill.dataset.val;

  localStorage.setItem('svc_draft_' + poolId, JSON.stringify(draft));
}

function loadDraft(poolId) {
  if(!poolId) return;
  const stored = localStorage.getItem('svc_draft_' + poolId);
  if(!stored) return;
  try {
    const draft = JSON.parse(stored);
    _formItems.forEach(item => {
      if(!item.title || draft[item.title] === undefined) return;
      let val = draft[item.title];
      if(val === '' || (Array.isArray(val) && !val.length)) return;
      if(item.title.trim().toLowerCase() === 'pool_id') return; // Do not overwrite pool_id
      
      if(item.type === 'CHECKBOX') {
        const bs = document.querySelectorAll('input[name="'+item.title.replace(/"/g,'&quot;')+'"]');
        bs.forEach(b => b.checked = (val || []).includes(b.value));
      } else {
        const el = document.querySelector('[name="'+item.title.replace(/"/g,'&quot;')+'"]');
        if(el) el.value = val;
      }
    });

    if (draft['svc_size']) { let el = document.getElementById('svc-size'); if (el) el.value = draft['svc_size']; }
    if (draft['svc_mat']) { let el = document.getElementById('svc-mat'); if (el) el.value = draft['svc_mat']; }
    if (draft['svc_cond']) { 
       let pill = document.querySelector(`.cpill:not(.tbpill)[data-val="${draft['svc_cond']}"]`);
       if(pill) tCond(pill, draft['svc_cond']);
    }
    if (draft['svc_tab']) {
       let pill = document.querySelector(`.tbpill[data-val="${draft['svc_tab']}"]`);
       if(pill) tTablet(pill, draft['svc_tab']);
    }
  } catch(e) { console.error('Error loading draft', e); }
}

function handlePoolChange() {
  const pe = document.querySelector('[name="pool_id"]');
  const poolId = pe ? pe.value : null;
  if (poolId && window._lastLoadedPoolId !== poolId) {
    window._lastLoadedPoolId = poolId;
    loadDraft(poolId);
  } else if (!poolId) {
    window._lastLoadedPoolId = null;
  }
  runRecs();
}

function roundQ(v){return v===0?0:Math.round(v*4)/4;}  // nearest 0.25 gal (liquids)
function roundH(v){return v===0?0:Math.round(v*2)/2;}  // nearest 0.5 lbs (solids)

function buildRecs(fc, ph, ta, ch, gal, mat, isG) {
  const res = [], isS = SM.indexOf(new Date().getMonth()+1) !== -1, g = gal/10000;
  const szEl = document.getElementById('svc-size');
  const poolSize = szEl ? szEl.value : 'small';
  const tabLvl = getTabletLevel(); // 'low', 'medium', 'full', or null

  // ── Rule 1 — Tablet × Chlorine Matrix ──────────────────────────────────────
  if (tabLvl && tabLvl !== 'none' && fc !== null) {
    if (tabLvl === 'low') {
      if (fc < 2) {
        // Large pool special: 6 tablets + 3 gal chlorine
        if (poolSize === 'large') {
          res.push({name:'Chlorine Tablets', status:'bad', amt:'6 tablets', reason:'Large pool, low tablets + low chlorine — max tablet load.'});
          let lc = 3;
          if (isS) lc = roundQ(lc * 1.5);
          res.push({name:'Liquid Chlorine', status:'bad', amt:lc.toFixed(2)+' gal', reason:'Large pool shock dose to recover FC'+(isS?' (summer ×1.5)':'')+'.'});
        } else {
          res.push({name:'Chlorine Tablets', status:'bad', amt:'4 tablets', reason:'Low tablets + low chlorine — replenish tablets.'});
          let lc = roundQ(0.5 * g);
          if (isS) lc = roundQ(lc * 1.5);
          // Medium pool: always 2 gal when FC 0-2
          if (poolSize === 'medium' && lc < 2) lc = 2;
          res.push({name:'Liquid Chlorine', status:'bad', amt:lc.toFixed(2)+' gal', reason:'Reduced liquid dose — tablets will raise FC over the week'+(isS?' (summer ×1.5)':'')+'.'});
        }
      } else if (fc <= 5) {
        // Medium or in-range chlorine → add 4 tablets, no liquid
        res.push({name:'Chlorine Tablets', status:'warning', amt:'4 tablets', reason:'Low tablets — replenish. Chlorine level adequate, no liquid needed.'});
      } else {
        // High chlorine → add fewer tablets
        res.push({name:'Chlorine Tablets', status:'good', amt:'2 tablets', reason:'Low tablets but chlorine is high — add fewer tablets to maintain.'});
      }
    } else if (tabLvl === 'medium') {
      if (fc < 2) {
        res.push({name:'Chlorine Tablets', status:'warning', amt:'2 tablets', reason:'Medium tablets + low chlorine — top off tablets.'});
        let lc = 1;
        if (isS) lc = roundQ(lc * 1.5);
        if (poolSize === 'medium') lc = Math.max(lc, 2);
        if (poolSize === 'large') lc = Math.max(lc, 2);
        res.push({name:'Liquid Chlorine', status:'bad', amt:lc.toFixed(2)+' gal', reason:'FC critically low — add liquid chlorine'+(isS?' (summer ×1.5)':'')+'.'});
      } else if (fc <= 5) {
        res.push({name:'Chlorine Tablets', status:'good', amt:'2 tablets', reason:'Medium tablets — top off. Chlorine adequate.'});
      } else {
        // High chlorine, medium tablets → leave as is
        res.push({name:'Chlorine Tablets', status:'good', amt:'Leave as is', reason:'Tablets medium, chlorine high — no changes needed.'});
      }
    } else if (tabLvl === 'full') {
      // Full tablets → only suggest liquid chlorine if needed
      if (fc < 2) {
        let lc = roundQ(1 * g);
        if (isS) lc = roundQ(lc * 1.5);
        if (poolSize === 'medium') lc = Math.max(lc, 2);
        res.push({name:'Liquid Chlorine', status:'bad', amt:lc.toFixed(2)+' gal', reason:'Tablets full but FC low — add liquid chlorine'+(isS?' (summer ×1.5)':'')+'.'});
      } else if (fc < 3) {
        let lc = roundQ(0.5 * g);
        if (isS) lc = roundQ(lc * 1.5);
        res.push({name:'Liquid Chlorine', status:'warning', amt:lc.toFixed(2)+' gal', reason:'Tablets full, FC slightly low — small liquid dose'+(isS?' (summer ×1.5)':'')+'.'});
      }
      res.push({name:'Chlorinator', status:'good', amt:'Adjust chlorinator', reason:'Tablets full — adjust water flow in the chlorinator for optimal dissolve rate.'});
    }
  } else if (fc !== null && (!tabLvl || tabLvl === 'none')) {
    // No tablet level or "none" selected — fall back to original liquid chlorine logic
    let b = 1*g;
    if (isS) b *= 1.5;
    if (isG)       res.push({name:'Liquid Chlorine',status:'bad',    amt:roundQ(b*2).toFixed(2)+' gal',reason:'Green/algae — shock dose. Do NOT adjust pH/TA/CH until chlorine works 24-48 hrs.'});
    else if (fc<2) {
      let dose = roundQ(b*2);
      if (poolSize === 'medium') dose = Math.max(dose, 2);
      res.push({name:'Liquid Chlorine',status:'bad',amt:dose.toFixed(2)+' gal',reason:'FC critically low — double dose'+(isS?' + summer ×1.5':'')});
    }
    else if (fc<3) res.push({name:'Liquid Chlorine',status:'warning',amt:roundQ(b).toFixed(2)+' gal',  reason:'FC below target (3–5 ppm)'+(isS?' (summer ×1.5)':'')});
    else if (fc<=5)res.push({name:'Liquid Chlorine',status:'good',   amt:roundQ(b).toFixed(2)+' gal',  reason:'FC in range — maintenance dose to hold through week'+(isS?' (summer ×1.5)':'')});
  }

  // ── Algae override (always adds liquid chlorine regardless of tablets) ─────
  if (isG && fc !== null) {
    // Remove any existing liquid chlorine recs if algae
    for (let i = res.length - 1; i >= 0; i--) {
      if (res[i].name === 'Liquid Chlorine') res.splice(i, 1);
    }
    let b = 1*g;
    if (isS) b *= 1.5;
    res.push({name:'Liquid Chlorine',status:'bad',amt:roundQ(b*2).toFixed(2)+' gal',reason:'Green/algae — shock dose. Do NOT adjust pH/TA/CH until chlorine works 24-48 hrs.'});
  }

  // ── Rule 2 — pH / Muriatic Acid or Soda Ash ───────────────────────────────
  if (ph !== null) {
    if (ph < 7.2) {
      res.push({name:'Soda Ash',status:'bad',amt:'As needed',reason:'pH below 7.2 — raise carefully, test before adding more.'});
    } else if (!isG && ph > 7.6) {
      let a = 0.5*g;
      if (mat === 'fiberglass') a *= 0.75;
      // Pool-size acid caps
      if (poolSize === 'medium') a = Math.min(a, 0.75);
      else if (poolSize === 'large') a = Math.min(a, 1.0);
      else a = Math.min(a, 0.5); // small pool default cap
      a = Math.max(roundQ(a), 0.25);
      res.push({name:'Muriatic Acid',status:ph>=8?'bad':'warning',amt:a.toFixed(2)+' gal',reason:'Lower pH to 7.2–7.6. One dose max per visit.'+(mat==='fiberglass'?' (reduced — fiberglass)':'')+(poolSize==='medium'?' (cap: 0.75 gal for medium pool)':'')+(poolSize==='large'?' (cap: 1.0 gal for large pool)':'')});
    } else if (isG && ph > 7.6) {
      res.push({name:'Muriatic Acid',status:'warning',amt:'Hold — after shock',reason:'Green pool: shock first, adjust pH after 24-48 hrs.'});
    }
  }

  // ── Rule 3 — Alkalinity ────────────────────────────────────────────────────
  if (ta !== null && ta < 80 && !isG)
    res.push({name:'Alkalinity Increaser (Sodium Bicarb)',status:'warning',amt:roundH(1.4*g*((100-ta)/10)).toFixed(1)+' lbs',reason:'Raise TA to 100 ppm (target 80–120 ppm)'});

  // ── Rule 4 — Calcium Hardness ─────────────────────────────────────────────
  if (ch !== null && !isG) {
    if (ch < 250) res.push({name:'Calcium Hardness Increaser',status:'warning',amt:roundH(1.2*g*((300-ch)/10)).toFixed(1)+' lbs',reason:'Raise CH to 300 ppm (target 250–350 ppm).'+(mat==='plaster'?' Keep CH toward upper range for plaster surfaces.':'')});
    if (ch > 450) res.push({name:'Calcium (Very High)',status:'warning',amt:'Partial drain',reason:'CH above 450 — consider partial drain. Common in SA hard water.'});
  }

  // ── Rule 5 — Algae Protocol banner (always first) ─────────────────────────
  if (isG) res.unshift({name:'ALGAE PROTOCOL',status:'bad',amt:'Shock first',reason:'Brush walls & floor. Double-dose chlorine. Wait 24-48 hrs before adjusting pH, TA, or CH.'});

  return res;
}

function submitSvc(){
  const payload={};let hasErr=false;
  _formItems.forEach(item=>{
    if(!item.title)return;let val;
    if(item.type==='CHECKBOX'){const bs=document.querySelectorAll('input[name="'+item.title.replace(/"/g,'&quot;')+'"]:checked');val=Array.from(bs).map(b=>b.value);if(!val.length)val=null;}
    else{const el=document.querySelector('[name="'+item.title.replace(/"/g,'&quot;')+'"]');if(el)val=el.value.trim();}
    if(item.isRequired&&(!val||(Array.isArray(val)&&!val.length)))hasErr=true;
    if(val)payload[item.title]=val;
  });

  // ── Mandatory test results & pool_id ────────
  const missingFields = [];
  _formItems.forEach(i => {
    if (!i.title) return;
    const t = i.title.trim();
    const tLower = t.toLowerCase();
    
    // Only these 4 are strictly mandatory by code request
    const isMainMandatory = (t === 'pH' || t === 'Chlorine (Cl)' || t === 'Total Alkalinity (TA)' || tLower === 'pool_id');
    
    if (isMainMandatory || i.isRequired) {
      if (!payload[i.title] || (Array.isArray(payload[i.title]) && !payload[i.title].length) || payload[i.title].toString().trim() === '') {
        missingFields.push(i.title);
      }
    }
  });

  if (missingFields.length || hasErr) {
    let errStr = missingFields.length ? ('Please fill in required fields:\n' + missingFields.join(', ')) : 'Fill out all required fields.';
    alert(errStr);
    missingFields.forEach(f => {
      const el = document.querySelector('[name="' + f.replace(/"/g,'&quot;') + '"]');
      if (el) { el.style.borderColor = 'var(--error)'; el.focus(); el.addEventListener('input', () => { el.style.borderColor = ''; }, { once: true }); }
    });
    return;
  }

  // ── Include portal-only fields in payload ──────────────────────────────────
  const sizeSel = document.getElementById('svc-size');
  if (sizeSel && sizeSel.value) payload['Pool Size'] = sizeSel.value;
  const matSel = document.getElementById('svc-mat');
  if (matSel && matSel.value) payload['Pool Material'] = matSel.value;

  const internalNotes = document.getElementById('svc-internal-notes');
  if (internalNotes && internalNotes.value) payload['Internal Notes'] = internalNotes.value;

  const ap = document.querySelector('.cpill.active, .cpill.active-cloudy, .cpill.active-ok');
  if(ap) payload['Notes'] = ((payload['Notes']||'') + ' [Condition: '+ap.dataset.val+']').trim();
  // Inject technician name from portal session
  if(_s && _s.name) payload['Technician'] = _s.name;
  
  showSvcConfirm(payload);
}
function showSvcConfirm(payload){
  window._svcPayload=payload;
  const rows=Object.entries(payload).map(([k,v])=>
    '<div class="conf-row"><span class="conf-key">'+k+'</span><span class="conf-val">'+(Array.isArray(v)?v.join(', '):v)+'</span></div>'
  ).join('');
  const pc=(window._svcPhotos||[]).length;
  const photoRow=pc?'<div class="conf-row"><span class="conf-key">Photos</span><span class="conf-val">'+pc+' attached</span></div>':'';
  document.getElementById('conf-modal-body').innerHTML=rows+photoRow;
  document.getElementById('conf-modal-backdrop').classList.add('open');
}
function closeSvcConfirm(event){
  if(event&&event.target!==document.getElementById('conf-modal-backdrop'))return;
  document.getElementById('conf-modal-backdrop').classList.remove('open');
}
function confirmAndSubmit(){
  document.getElementById('conf-modal-backdrop').classList.remove('open');
  const btn=document.getElementById('btn-svc');
  btn.disabled=true;
  btn.textContent=(window._svcPhotos&&window._svcPhotos.length)
    ?'Uploading '+window._svcPhotos.length+' photo(s)...'
    :'Submitting...';
  api({secret:SEC,action:'submit_form',token:_s.token,data:window._svcPayload,photos:window._svcPhotos||[]}).then(res=>{
    if(res.ok){
      if (window._svcPayload) {
        const poolIdKey = Object.keys(window._svcPayload).find(k => k.trim().toLowerCase() === 'pool_id');
        const pId = poolIdKey ? window._svcPayload[poolIdKey] : null;
        
        if (pId) {
          localStorage.removeItem('svc_draft_' + pId);
          
          // Auto-mark as done in Technician Hub
          if(_activeDay && _routeData && _routeData.week_start){
            const doneKey = `mcps_done_${_routeData.week_start}_${_activeDay}`;
            const done = JSON.parse(localStorage.getItem(doneKey)||'[]');
            if(!done.includes(pId)){
              done.push(pId);
              localStorage.setItem(doneKey, JSON.stringify(done));
              console.log('[hub] Pool', pId, 'auto-marked as done for', _activeDay);
            }
          }
        }
        window._lastLoadedPoolId = null;
      }
      const pc=(window._svcPhotos||[]).length;
      document.getElementById('svc-root').innerHTML='<div style="text-align:center;padding:3rem 1rem">'
        +'<div style="font-size:3.5rem;margin-bottom:1rem">✅</div>'
        +'<div style="font-family:Oswald,sans-serif;font-size:1.8rem;font-weight:700;letter-spacing:.1em;color:#0d4d44;margin-bottom:.5rem">SUBMITTED</div>'
        +'<p style="color:#64748b;margin-bottom:.35rem">Log written, inventory deducted, email sent.</p>'
        +(pc?'<p style="color:#64748b;font-size:.85rem;margin-bottom:1.5rem">📸 '+pc+' photo'+(pc>1?'s':'')+' saved to Drive.</p>':'<br>')
        +'<button onclick="resetSvc()" style="padding:.85rem 1.75rem;background:#0d4d44;color:#fff;border:none;border-radius:12px;font-family:Oswald,sans-serif;font-size:1rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;cursor:pointer">Log Another Pool</button>'
        +'</div>';
    }else{alert('Error: '+res.error);btn.disabled=false;btn.textContent='Submit Log to MCPS';}
  }).catch(e=>{alert('Network error: '+e.message);btn.disabled=false;btn.textContent='Submit Log to MCPS';});
}
// ── Photo handlers ──────────────────────────────────────────────────────────
const MAX_PHOTOS = 4;
const MAX_BYTES  = 10 * 1024 * 1024;

function handlePhotoSelect(input) {
  addPhotos_(Array.from(input.files || []));
  input.value = '';
}

function handlePhotoDrop(event) {
  event.preventDefault();
  document.getElementById('photo-drop-zone').classList.remove('drag-over');
  addPhotos_(Array.from(event.dataTransfer.files || []).filter(f => f.type.startsWith('image/')));
}

function addPhotos_(files) {
  const remaining = MAX_PHOTOS - window._svcPhotos.length;
  const toAdd = files.slice(0, remaining);
  if (files.length > remaining) alert('Max 4 photos per visit. Only the first ' + remaining + ' were added.');
  let pending = toAdd.length;
  if (!pending) return;
  toAdd.forEach(file => {
    if (file.size > MAX_BYTES) { alert(file.name + ' is too large (max 10 MB).'); pending--; if (!pending) renderPhotoPreviews_(); return; }
    const reader = new FileReader();
    reader.onload = function(e) {
      window._svcPhotos.push({ base64: e.target.result.split(',')[1], mimeType: file.type || 'image/jpeg', name: file.name });
      pending--;
      if (!pending) renderPhotoPreviews_();
    };
    reader.readAsDataURL(file);
  });
}

function removePhoto_(idx) {
  window._svcPhotos.splice(idx, 1);
  renderPhotoPreviews_();
}

function renderPhotoPreviews_() {
  const grid      = document.getElementById('photo-preview-grid');
  const countWrap = document.getElementById('photo-count-wrap');
  const dropZone  = document.getElementById('photo-drop-zone');
  if (!grid) return;
  if (!window._svcPhotos.length) {
    grid.style.display = 'none';
    countWrap.innerHTML = '';
    dropZone.style.display = 'block';
    return;
  }
  dropZone.style.display = window._svcPhotos.length >= MAX_PHOTOS ? 'none' : 'block';
  grid.style.display = 'grid';
  countWrap.innerHTML = '<span class="photo-count-badge">' + window._svcPhotos.length + ' / ' + MAX_PHOTOS + ' photos</span>';
  grid.innerHTML = window._svcPhotos.map((p, i) =>
    `<div class="photo-thumb">
      <img src="data:${p.mimeType};base64,${p.base64}" alt="Photo ${i+1}">
      <button class="photo-thumb-remove" onclick="removePhoto_(${i})">✕</button>
    </div>`
  ).join('');
}
function resetSvc(){
  _formItems=[];
  document.getElementById('svc-root').style.display='none';
  document.getElementById('svc-root').innerHTML='';
  document.getElementById('svc-loading').style.display='block';
  loadServiceLog();
}

