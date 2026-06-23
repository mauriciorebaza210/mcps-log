// ══════════════════════════════════════════════════════════════════════════════
// SERVICE LOG — pool visit logging, chemical math, photo uploads, drafts
// Depends on: constants.js (SEC), api.js (api, apiGet)
// Uses globals: _s, _curPage
// ══════════════════════════════════════════════════════════════════════════════
// SERVICE LOG
// ══════════════════════════════════════════════════════════════════════════════
const TF={FC:"Free Chlorine (FC)",PH:"pH",TA:"Total Alkalinity (TA)",CH:"Calcium Hardness (CH)"};
// Extra (non-mandatory) water-test fields that should use a numeric input but are
// NOT part of the chemical-dosing recommendation engine.
const TF_EXTRA=["Cyanuric Acid (CYA)","Salt Level"];
const SG={small:12000,medium:17500,large:25000};
const SM=[6,7,8,9];

let _svcContextReqId = 0;

// ── Static form schema — edit this array to change the form ──────────────────
// Cards are created per PAGE_BREAK. First card is always "Visit Details".
// The PAGE_BREAK titled "Used" also gets the rec box (Mr. Chuy Recommends).
// To add a chemical: append a TEXT entry after the "Used" PAGE_BREAK.
// To reorder fields: move the object. IDs are just for reference.
const FORM_SCHEMA = [
  // ── Visit Details ─────────────────────────────────────────────────────────
  { id:1,  title:'pool_id',                          type:'LIST',           isRequired:false, helpText:'',                                                                              choices:['Bullock - Weekly Full Service - 24102 Shelton Spring - MCPS-0017','Casarez - Weekly Full Service - 25 Inwood Ridge Drive - MCPS-0020','Chapa - Green-to-Clean Cleaning Service - 1090 North Trail - MCPS-0026','Libby - Weekly Full Service - 27121 Highland Crest - MCPS-0007','Lopez - Monthly Full Service - 307 Parkside Dr - MCPS-0021','Mendoza - Weekly Full Service - 22088 Mathis Rd - MCPS-0012','Menezes - Weekly Full Service - 4202 Coriander - MCPS-0026','Moczygemba - Weekly Full Service - 108 Elk Run - MCPS-0023','Murray - Weekly Full Service - 452 CR 257 - MCPS-0025','Pompa - Weekly Full Service - 18538 Shadow Canyon Dr - MCPS-0001','Robbins - Weekly Full Service - 2144 County Road 419 - MCPS-0018','Saldaña - Weekly Full Service - 306 Sligo St - MCPS-0024','Startz - Green-to-Clean Cleaning Service - 3431 County Rd 136 - MCPS-0019','Valdez - Weekly Full Service - 13355 Leeward Lane - MCPS-0009','Other / Pool not listed'] },
  // renderSvcForm injects Pool Size, Pool Material, Condition on Arrival, Internal Notes after pool_id
  { id:2,  title:'Pool description (if Other selected)', type:'TEXT',       isRequired:false, helpText:"Only fill this in if you selected 'Other / Pool not listed' above. Enter client name, address, or any info to identify the pool." },
  { id:3,  title:'Technician',                       type:'LIST',           isRequired:false, helpText:'',                                                                              choices:['Mauricio Rebaza','Tony Siller','Chuy Silva','Ryan Willford'] },
  { id:4,  title:'Notes',                            type:'PARAGRAPH_TEXT', isRequired:false, helpText:''                                                                              },
  // ── Test Results ──────────────────────────────────────────────────────────
  { id:5,  title:'Test Results',                     type:'PAGE_BREAK',     isSectionBreak:true                                                                                        },
  { id:6,  title:'Free Chlorine (FC)',               type:'TEXT',           isRequired:false, helpText:''                                                                              },
  { id:7,  title:'pH',                               type:'TEXT',           isRequired:false, helpText:''                                                                              },
  { id:8,  title:'Total Alkalinity (TA)',            type:'TEXT',           isRequired:false, helpText:''                                                                              },
  { id:9,  title:'Calcium Hardness (CH)',            type:'TEXT',           isRequired:false, helpText:''                                                                              },
  { id:9.1,title:'Cyanuric Acid (CYA)',              type:'TEXT',           isRequired:false, helpText:''                          },
  { id:9.2,title:'Salt Level',                       type:'TEXT',           isRequired:false, helpText:'Optional — enter ppm if tested (leave blank if not).'                          },
  // renderSvcForm injects Tablet Level pills after Salt Level (last field in Test Results)
  // ── Used ──────────────────────────────────────────────────────────────────
  { id:11, title:'Used',                             type:'PAGE_BREAK',     isSectionBreak:true                                                                                        },
  { id:12, title:'Liquid Chlorine',                  type:'TEXT',           isRequired:false, helpText:'Enter gallons used (leave blank if none).'                                     },
  { id:13, title:'Muriatic Acid',                    type:'TEXT',           isRequired:false, helpText:'Enter gallons used (leave blank if none).'                                     },
  { id:14, title:'Alkalinity Increaser',             type:'TEXT',           isRequired:false, helpText:'Enter lbs used (leave blank if none).'                                        },
  { id:15, title:'Calcium Hardness Increaser',       type:'TEXT',           isRequired:false, helpText:'Enter lbs used (leave blank if none).'                                        },
  { id:16, title:'Chlorine Tablets (3")',            type:'TEXT',           isRequired:false, helpText:'Enter tablets used (leave blank if none).'                                    },
  { id:17, title:'Startup-Tec',                      type:'TEXT',           isRequired:false, helpText:'Enter bottles used (leave blank if none).'                                    },
  { id:18, title:'ScaleTec (Calcium Remover)',       type:'TEXT',           isRequired:false, helpText:'Enter bottles used (leave blank if none).'                                    },
  { id:19, title:'Algaecide',                        type:'TEXT',           isRequired:false, helpText:'Enter bottles used (leave blank if none).'                                    },
  { id:20, title:'Cyanuric Acid (Stabilizer)',       type:'TEXT',           isRequired:false, helpText:'Enter lbs used (leave blank if none).'                                        },
  { id:21, title:'Diatomaceous Earth (DE)',          type:'TEXT',           isRequired:false, helpText:'Enter lbs used (leave blank if none).'                                        },
  { id:22, title:'Salt',                             type:'TEXT',           isRequired:false, helpText:'Enter lbs used (leave blank if none).'                                        },
  { id:23, title:'Cal Hypo',                         type:'TEXT',           isRequired:false, helpText:'Enter lbs used (leave blank if none).'                                        },
  // ── Actions ───────────────────────────────────────────────────────────────
  { id:24, title:'Actions',                          type:'PAGE_BREAK',     isSectionBreak:true                                                                                        },
  { id:25, title:'Technician Actions',               type:'CHECKBOX',       isRequired:false, helpText:'Check the tasks you performed on this visit.',
    choices:['Netted','Vacuumed','Brushed','Backwashed','Cleaned pump basket','Cleaned skimmer basket','Cleaned cartridges','Cleaned automatic cleaner','Cleaned deck/coping'] },
];

function loadServiceLog(prefillPoolId){
  window._lastLoadedPoolId = null;
  window._svcLoadCounter = (window._svcLoadCounter||0) + 1;
  const thisRequest = window._svcLoadCounter;

  // Render immediately from static schema — no network wait
  renderSvcForm(FORM_SCHEMA, prefillPoolId);
  document.getElementById('svc-loading').style.display = 'none';
  document.getElementById('svc-root').style.display = 'block';

  // Show recovery banner if there's an unsent log from a previous session
  const _queued = localStorage.getItem('svc_queued_submit');
  if (_queued) {
    try {
      const _q = JSON.parse(_queued);
      const _pk = _q.payload && Object.keys(_q.payload).find(k => k.trim().toLowerCase() === 'pool_id');
      const _pl = _pk ? _q.payload[_pk] : 'Unknown pool';
      const _age = _q.ts ? Math.round((Date.now() - _q.ts) / 60000) : 0;
      setTimeout(() => {
        const root = document.getElementById('svc-root');
        if (!root) return;
        const b = document.createElement('div');
        b.id = 'svc-retry-banner';
        b.className = 'svc-retry-banner';
        b.innerHTML = '<div class="svc-retry-msg">⚠️ Unsent log for <strong>' + escHtml(_pl) + '</strong> (' + _age + 'm ago)</div><button class="svc-retry-btn" onclick="_retrySvcNow_()">Send Now</button>';
        root.insertBefore(b, root.firstChild);
      }, 100);
    } catch(e) {}
  }

  // Live pool list — populates the pool_id dropdown when it arrives
  api({ secret:SEC, action:'get_pool_list', token:_s.token }).then(res => {
    if (thisRequest !== window._svcLoadCounter) return;
    if (res && res.ok && res.pools && res.pools.length) _applyLivePoolList_(res.pools, prefillPoolId);
  }).catch(() => {});

  // Pool context — prefills size/material/tablet + shows trend and notes banners
  if (prefillPoolId) {
    api({ secret:SEC, action:'get_pool_context', token:_s.token, pool_id:prefillPoolId }).then(res => {
      if (thisRequest !== window._svcLoadCounter) return;
      if (res && res.ok && res.data && res.data.found) applyPoolContext_(res.data, prefillPoolId);
    });
  }
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
      if(item.title&&item.title.trim().toLowerCase()==='test results') card.setAttribute('data-tour','svc-test-results');
      if(item.title&&item.title.trim().toLowerCase()==='actions') card.setAttribute('data-tour','svc-actions');
      if(item.title&&item.title.trim().toLowerCase()==='used'){ card.setAttribute('data-tour','svc-chemicals-used');
        const rb=document.createElement('div');rb.id='rec-box';rb.className='rec-box';rb.setAttribute('data-tour','svc-recommendations');
        rb.innerHTML='<div class="rb-hdr">Mr. Chuy Recommends:<span id="rb-vol" class="rb-vol">—</span></div><div id="rb-flags" class="rb-flags"></div><div id="rb-list" class="rb-list"></div>';
        card.appendChild(rb);
      }
      return;
    }
    const grp=document.createElement('div');grp.className='sfg';
    if(item.title&&item.title.trim().toLowerCase()==='pool_id') grp.setAttribute('data-tour','svc-pool-select');
    if(item.title==='Notes') grp.setAttribute('data-tour','svc-notes');
    const te=item.title.replace(/"/g,'&quot;');
    const isHardMandatory = (te.toLowerCase() === 'pool_id' || te === 'pH' || te === 'Free Chlorine (FC)' || te === 'Total Alkalinity (TA)');
    const isSoftOptional = (te === 'Calcium Hardness (CH)');
    const lbl=item.title+((isHardMandatory || (item.isRequired && !isSoftOptional))?" <span style='color:red'>*</span>":'');
    grp.innerHTML='<label>'+lbl+'</label>'+(item.helpText?'<span class="sh">'+item.helpText+'</span>':'');
    let inp='';
    if(item.type==='LIST'||item.type==='MULTIPLE_CHOICE'){
      const isPoolId = item.title && item.title.trim().toLowerCase() === 'pool_id';
      inp='<select class="si" name="'+te+'" '+(item.isRequired?'required':'')+' onchange="'+(isPoolId?'handlePoolChange()':'runRecs()')+'"><option value="">Select...</option>'+item.choices.map(c=>'<option value="'+c.replace(/"/g,'&quot;')+'">'+c+'</option>').join('')+'</select>';
    }else if(item.type==='CHECKBOX'){
      inp='<div class="scb-grid">'+item.choices.map(c=>'<label class="scb"><input type="checkbox" name="'+te+'" value="'+c.replace(/"/g,'&quot;')+'" onchange="runRecs()"><span>'+c+'</span></label>').join('')+'</div>';
    }else if(item.type==='PARAGRAPH_TEXT'){
      inp='<textarea class="si" name="'+te+'" '+(item.isRequired?'required':'')+' oninput="runRecs()"></textarea>';
    }else{
      const isNum=Object.values(TF).indexOf(item.title)!==-1||TF_EXTRA.indexOf(item.title)!==-1||(item.helpText&&item.helpText.toLowerCase().indexOf('quantity')!==-1);
      inp='<input class="si" type="'+(isNum?'number':'text')+'" step="any" name="'+te+'" '+(item.isRequired?'required':'')+' oninput="runRecs()">';
    }
    grp.innerHTML+=inp;card.appendChild(grp);
    if(item.title === 'Technician Actions') {
      // ── Adjusted chlorinator power → reveals Increased/Decreased ────────────
      const chg=document.createElement('div');chg.className='sfg scb-chlor';
      chg.innerHTML='<label class="scb"><input type="checkbox" id="svc-chlor-adj" onchange="toggleChlorAdj(this)"><span>Adjusted chlorinator power</span></label><div id="svc-chlor-dir" class="cp" style="display:none;margin-top:.55rem"><div class="cpill chpill" onclick="tChlor(this)" data-val="Increased">↑ Increased</div><div class="cpill chpill" onclick="tChlor(this)" data-val="Decreased">↓ Decreased</div></div>';
      card.appendChild(chg);
    }
    if(item.title === 'Salt Level') {
      // ── Tablet Level pill selector (portal-only) — last item in Test Results ──
      const tg=document.createElement('div');tg.className='sfg';
      tg.innerHTML='<label>Tablet Level</label><span class="sh">Current chlorine tablet level in the chlorinator.</span><div class="cp" id="tablet-pills" style="flex-wrap:wrap"><div class="cpill tbpill" onclick="tTablet(this,\'low\')" data-val="low">Low (0–2 tabs)</div><div class="cpill tbpill" onclick="tTablet(this,\'medium\')" data-val="medium">Medium (3–4 tabs)</div><div class="cpill tbpill" onclick="tTablet(this,\'full\')" data-val="full">Full (5–6 tabs)</div><div class="cpill tbpill" onclick="tTablet(this,\'none\')" data-val="none">No Chlorinator</div></div>';
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

      const ng = document.createElement('div'); ng.className = 'sfg'; ng.setAttribute('data-tour','svc-internal-notes');
      ng.innerHTML = '<label>Internal Notes</label><span class="sh">Admin-only notes. These do NOT go to the customer report email.</span><textarea class="si" id="svc-internal-notes" name="Internal Notes"></textarea>';
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
function goToSvcLog(poolId, customerName, scheduledVisitId, visitType) {
  if (!poolId) return;
  window._pendingSvcPoolId = poolId;
  window._prefillCustomer = customerName || '';
  window._pendingSvcMeta = {
    pool_id: poolId || '',
    scheduled_visit_id: scheduledVisitId || '',
    visit_type: visitType || ''
  };
  navigateTo('service_log');
}

function prefillSvcForm_(poolId) {
  // This legacy function is now partially absorbed by loadServiceLog parallel flow
  // but kept for compatibility with other triggers
}

function clearPoolContextBanners_() {
  const oldNotes = document.getElementById('pool-last-notes-banner');
  if (oldNotes) oldNotes.remove();
  const oldTrend = document.getElementById('pool-trend-banner');
  if (oldTrend) oldTrend.remove();
}

function applyPoolContext_(ctx, poolId) {
  clearPoolContextBanners_();

  // Prefill pool size (case-insensitive, first-word match covers "Large (20k+)" → "large")
  if (ctx.last_size) {
    const sizeKey = ctx.last_size.toString().toLowerCase().split(/[^a-z]/)[0];
    const sizeSel = document.getElementById('svc-size');
    if (sizeSel) {
      for (let i = 0; i < sizeSel.options.length; i++) {
        if (sizeSel.options[i].value === sizeKey) { sizeSel.selectedIndex = i; break; }
      }
    }
  }

  // Prefill pool material (case-insensitive)
  if (ctx.last_material) {
    const matKey = ctx.last_material.toString().toLowerCase().split(/[^a-z]/)[0];
    const matSel = document.getElementById('svc-mat');
    if (matSel) {
      for (let i = 0; i < matSel.options.length; i++) {
        if (matSel.options[i].value === matKey) { matSel.selectedIndex = i; break; }
      }
    }
  }

  // Prefill last known tablet level
  if (ctx.last_tablet) {
    const tablet = String(ctx.last_tablet).toLowerCase();
    const pill = document.querySelector(`.tbpill[data-val="${tablet}"]`);
    if (pill && !pill.classList.contains('tactive')) tTablet(pill, tablet);
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
      banner.innerHTML = '<strong>Notes from last visit:</strong> ' + escHtml(lastNotes);
      root.insertBefore(banner, root.firstChild);
    }
  }
}

function loadPoolContextForSelection_(poolId) {
  if (!poolId || poolId === 'Other / Pool not listed') {
    clearPoolContextBanners_();
    return Promise.resolve();
  }
  const reqId = ++_svcContextReqId;
  return api({ secret:SEC, action:'get_pool_context', token:_s.token, pool_id:poolId })
    .then(res => {
      if (reqId !== _svcContextReqId) return;
      if (res && res.ok && res.data && res.data.found) applyPoolContext_(res.data, poolId);
      else clearPoolContextBanners_();
    })
    .catch(e => console.warn('Pool context load failed', e));
}

function renderTrendBanner_(trends, visitCount) {
  const root = document.getElementById('svc-root');
  if (!root) return;

  const banner = document.createElement('div');
  banner.id = 'pool-trend-banner';
  banner.className = 'pool-trend-banner';
  const pills = trends.map(t => '<span class="pool-trend-pill">' + t + '</span>').join(' ');
  banner.innerHTML = '<strong>📊 Trend — last ' + visitCount + ' visit' + (visitCount !== 1 ? 's' : '') + '</strong>' + pills;
  root.insertBefore(banner, root.firstChild);
}
function tCond(el,type){const was=el.classList.contains('active')||el.classList.contains('active-ok')||el.classList.contains('active-cloudy');document.querySelectorAll('.cpill:not(.tbpill):not(.chpill)').forEach(p=>p.classList.remove('active','active-ok','active-cloudy'));if(!was)el.classList.add(type==='green'?'active':type==='clear'?'active-ok':'active-cloudy');runRecs();}
// Tablet level pill toggle
function tTablet(el,level){const was=el.classList.contains('tactive');document.querySelectorAll('.tbpill').forEach(p=>p.classList.remove('tactive'));if(!was)el.classList.add('tactive');runRecs();}
// Chlorinator power adjustment: checkbox reveals Increased/Decreased pills
function toggleChlorAdj(cb){const dir=document.getElementById('svc-chlor-dir');if(dir)dir.style.display=cb.checked?'flex':'none';if(!cb.checked)document.querySelectorAll('#svc-chlor-dir .chpill').forEach(p=>p.classList.remove('active-ok'));}
function tChlor(el){document.querySelectorAll('#svc-chlor-dir .chpill').forEach(p=>p.classList.remove('active-ok'));el.classList.add('active-ok');}
function getTabletLevel(){const a=document.querySelector('.tbpill.tactive');return a?a.dataset.val:null;}

function gn(t){const el=document.querySelector('[name="'+t+'"]');if(!el||!el.value)return null;const v=parseFloat(el.value);return isNaN(v)?null:v;}
function s2g(v){const s=String(v||'').toLowerCase();if(s.includes('large')||s.includes('>20'))return SG.large;if(s.includes('medium')||s.includes('15,000'))return SG.medium;return SG.small;}

function runRecs(){
  const fc=gn(TF.FC),ph=gn(TF.PH),ta=gn(TF.TA),ch=gn(TF.CH),salt=gn('Salt Level');
  const pe=document.querySelector('[name="pool_id"]');
  const szEl=document.getElementById('svc-size');
  const gal=szEl?SG[szEl.value]||SG.small:s2g(pe?pe.value:'');
  const mat=(document.getElementById('svc-mat')||{value:'plaster'}).value;
  const isG=!!document.querySelector('.cpill.active');
  const isS=SM.indexOf(new Date().getMonth()+1)!==-1;
  const rb=document.getElementById('rec-box');if(!rb)return;
  if(fc===null&&ph===null&&ta===null&&ch===null&&salt===null&&!isG){rb.style.display='none';return;}
  const recs=buildRecs(fc,ph,ta,ch,gal,mat,isG,salt);
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
  if (window._tourActive) return;
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
    loadPoolContextForSelection_(poolId).then(() => loadDraft(poolId));
  } else if (!poolId) {
    window._lastLoadedPoolId = null;
  }
  runRecs();
}

function roundQ(v){return v===0?0:Math.round(v*4)/4;}  // nearest 0.25 gal (liquids)
function roundH(v){return v===0?0:Math.round(v*2)/2;}  // nearest 0.5 lbs (solids)

// ── Smart scoop conversion ──────────────────────────────────────────────────
// Lbs in one full smart scoop, per chemical. Used to show techs how many
// scoops a recommended lb amount equals so they can measure without a scale.
const SCOOP_LB = {
  'sodium bicarb':3.9, 'alkalinity increaser':3.9,
  'salt':3.8,
  'calcium chloride':3.0, 'calcium hardness increaser':3.0,
  'cal hypo':2.9,
  'cyanuric acid':2.4, 'stabilizer':2.4,
  'diatomaceous earth':1.0
};
function scoopHint(name, lbs){
  if(!(lbs>0)) return '';
  const n=(name||'').toLowerCase();
  let w=null;
  for(const k in SCOOP_LB){ if(n.indexOf(k)!==-1){ w=SCOOP_LB[k]; break; } }
  if(!w) return '';
  const scoops=Math.round((lbs/w)*4)/4;  // nearest 1/4 scoop
  if(scoops<=0) return '';
  return ' ('+scoops+' smart scoop'+(scoops===1?'':'s')+')';
}

const SALT_TARGET = 3200;  // ppm — target for saltwater chlorine generators (per salt chart)
function buildRecs(fc, ph, ta, ch, gal, mat, isG, salt) {
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
  if (ta !== null && ta < 80 && !isG) {
    const lbs=roundH(1.4*g*((100-ta)/10));
    res.push({name:'Alkalinity Increaser (Sodium Bicarb)',status:'warning',amt:lbs.toFixed(1)+' lbs'+scoopHint('sodium bicarb',lbs),reason:'Raise TA to 100 ppm (target 80–120 ppm)'});
  }

  // ── Rule 4 — Calcium Hardness ─────────────────────────────────────────────
  if (ch !== null && !isG) {
    if (ch < 250) {
      const lbs=roundH(1.2*g*((280-ch)/10));
      res.push({name:'Calcium Hardness Increaser',status:'warning',amt:lbs.toFixed(1)+' lbs'+scoopHint('calcium hardness increaser',lbs),reason:'Raise CH to 280 ppm (target 250–350 ppm).'+(mat==='plaster'?' Keep CH toward upper range for plaster surfaces.':'')});
    }
  }

  // ── Rule 5 — Salt (saltwater pools — target 3200 ppm, per salt chart) ─────
  if (salt !== null && salt < SALT_TARGET) {
    // lbs = gallons × (target − current) ppm × 8.34 / 1,000,000
    const lbs = Math.round(gal * (SALT_TARGET - salt) * 8.34 / 1000000);
    if (lbs > 0) {
      res.push({name:'Salt',status:'warning',amt:lbs+' lbs'+scoopHint('salt',lbs),reason:'Raise salt from '+salt+' to '+SALT_TARGET+' ppm for the chlorine generator.'});
    }
  }

  // ── Rule 6 — Algae Protocol banner (always first) ─────────────────────────
  if (isG) res.unshift({name:'ALGAE PROTOCOL',status:'bad',amt:'Shock first',reason:'Brush walls & floor. Double-dose chlorine. Wait 24-48 hrs before adjusting pH, TA, or CH.'});

  return res;
}

function submitSvc(){
  if(window._tourActive) return; // tour in progress — do not submit real service log
  const payload={};let hasErr=false;
  _formItems.forEach(item=>{
    if(!item.title)return;let val;
    if(item.type==='CHECKBOX'){const bs=document.querySelectorAll('input[name="'+item.title.replace(/"/g,'&quot;')+'"]:checked');val=Array.from(bs).map(b=>b.value);if(!val.length)val=null;}
    else{const el=document.querySelector('[name="'+item.title.replace(/"/g,'&quot;')+'"]');if(el)val=el.value.trim();}
    const _softOpt = (item.title === 'Calcium Hardness (CH)');
    if(item.isRequired && !_softOpt &&(!val||(Array.isArray(val)&&!val.length)))hasErr=true;
    if(val)payload[item.title]=val;
  });

  // ── Mandatory test results & pool_id ────────
  const missingFields = [];
  _formItems.forEach(i => {
    if (!i.title) return;
    const t = i.title.trim();
    const tLower = t.toLowerCase();
    
    // Only these 4 are strictly mandatory by code request
    const isMainMandatory = (t === 'pH' || t === 'Free Chlorine (FC)' || t === 'Total Alkalinity (TA)' || tLower === 'pool_id');
    
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

  const tabletLevel = getTabletLevel();
  if (tabletLevel) payload['Tablet Level'] = tabletLevel;

  const internalNotes = document.getElementById('svc-internal-notes');
  if (internalNotes && internalNotes.value) payload['Internal Notes'] = internalNotes.value;

  const ap = document.querySelector('.cpill:not(.chpill).active, .cpill:not(.chpill).active-cloudy, .cpill:not(.chpill).active-ok');
  if(ap) payload['Notes'] = ((payload['Notes']||'') + ' [Condition: '+ap.dataset.val+']').trim();

  // ── Chlorinator power adjustment (Adjusted checkbox + direction) ───────────
  const chlorCb = document.getElementById('svc-chlor-adj');
  if (chlorCb && chlorCb.checked) {
    const dir = document.querySelector('#svc-chlor-dir .chpill.active-ok');
    payload['Chlorinator Adjustment'] = dir ? dir.dataset.val : 'Adjusted';
  }

  // Inject technician name from portal session
  if(_s && _s.name) payload['Technician'] = _s.name;

  // Preserve the exact scheduled service identity when the log was launched
  // from the route card. This lets admin completion checks distinguish a
  // one-time/startup/GTC visit from the same pool's recurring service.
  if (window._pendingSvcMeta && window._pendingSvcMeta.scheduled_visit_id) {
    payload['_scheduled_visit_id'] = window._pendingSvcMeta.scheduled_visit_id;
    payload['_service_visit_id'] = window._pendingSvcMeta.scheduled_visit_id;
  }
  if (window._pendingSvcMeta && window._pendingSvcMeta.visit_type) {
    payload['_visit_type'] = window._pendingSvcMeta.visit_type;
  }

  // ── Chemical range validation ─────────────────────────────────────────────
  const CHEM_RANGES = {
    'pH':                    { min: 6.8,  max: 8.5,   label: 'pH'                    },
    'Free Chlorine (FC)':    { min: 0,    max: 15,    label: 'Free Chlorine (FC)'    },
    'Total Alkalinity (TA)': { min: 50,   max: 350,   label: 'Total Alkalinity (TA)' },
    'Calcium Hardness (CH)': { min: 0,    max: 2000,  label: 'Calcium Hardness (CH)' },
  };
  const outOfRange = [];
  Object.entries(CHEM_RANGES).forEach(([field, r]) => {
    const raw = payload[field];
    if (raw === undefined || raw === '') return;
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    if (val < r.min || val > r.max) {
      outOfRange.push(`${r.label}: ${val} (valid range ${r.min}–${r.max})`);
    }
  });
  if (outOfRange.length) {
    const msg = 'These readings look unusual — double-check before submitting:\n\n' + outOfRange.join('\n') + '\n\nTap OK to submit anyway, or Cancel to go back and correct.';
    if (!confirm(msg)) return;
  }

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
  _doSvcSubmit_(window._svcPayload, window._svcPhotos || []);
}

function _doSvcSubmit_(payload, photos) {
  const btn = document.getElementById('btn-svc');
  if (btn) { btn.disabled = true; btn.textContent = photos.length ? 'Uploading ' + photos.length + ' photo(s)...' : 'Submitting...'; }

  if (!navigator.onLine) {
    _svcQueueAndBail_(payload, photos);
    return;
  }

  api({ secret:SEC, action:'submit_form', token:_s.token, data:payload, photos:photos }).then(res => {
    if (res.ok) {
      _onSvcSuccess_(payload, photos.length);
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Submit Log to MCPS'; }
      if (document.getElementById('svc-root')) alert('Error: ' + res.error);
    }
  }).catch(() => {
    _svcQueueAndBail_(payload, photos);
  });
}

function _svcQueueAndBail_(payload, photos) {
  try {
    localStorage.setItem('svc_queued_submit', JSON.stringify({ payload, photos, ts: Date.now() }));
  } catch(e) {
    try { localStorage.setItem('svc_queued_submit', JSON.stringify({ payload, photos: [], ts: Date.now() })); } catch(_) {}
  }
  window._svcPayload = payload;
  window._svcPhotos = photos;
  window.addEventListener('online', _onSvcOnline_, { once: true });

  // Show saved screen so tech can move to next pool immediately
  const root = document.getElementById('svc-root');
  if (root) {
    root.innerHTML = '<div style="text-align:center;padding:3rem 1rem">'
      + '<div style="font-size:3.5rem;margin-bottom:1rem">💾</div>'
      + '<div style="font-family:Oswald,sans-serif;font-size:1.8rem;font-weight:700;letter-spacing:.1em;color:#0d4d44;margin-bottom:.5rem">LOG SAVED</div>'
      + '<p style="color:#64748b;margin-bottom:1.5rem">No signal — your log is saved and will send automatically when you\'re back online.</p>'
      + '<button onclick="resetSvc()" style="display:block;width:100%;padding:.85rem 1.75rem;background:#0d4d44;color:#fff;border:none;border-radius:12px;font-family:Oswald,sans-serif;font-size:1rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;margin-bottom:.75rem">Log Another Pool</button>'
      + '<button onclick="navigateTo(\'live_map\')" style="display:block;width:100%;padding:.85rem 1.75rem;background:transparent;color:#0d4d44;border:2px solid #0d4d44;border-radius:12px;font-family:Oswald,sans-serif;font-size:1rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;cursor:pointer">Back to Hub</button>'
      + '</div>';
  }
}

function _showSvcRetryBanner_(msg) {
  const root = document.getElementById('svc-root');
  if (!root) return;
  let b = document.getElementById('svc-retry-banner');
  if (!b) { b = document.createElement('div'); b.id = 'svc-retry-banner'; b.className = 'svc-retry-banner'; root.insertBefore(b, root.firstChild); }
  b.innerHTML = '<div class="svc-retry-msg">⚠️ ' + msg + '</div><button class="svc-retry-btn" onclick="_retrySvcNow_()">Retry</button>';
}

function _retrySvcNow_() {
  const raw = localStorage.getItem('svc_queued_submit');
  if (!raw) return;
  try {
    const { payload, photos } = JSON.parse(raw);
    window._svcPayload = payload;
    window._svcPhotos = photos || [];
    const b = document.getElementById('svc-retry-banner');
    if (b) b.remove();
    _doSvcSubmit_(payload, photos || []);
  } catch(e) {}
}

function _onSvcOnline_() {
  const raw = localStorage.getItem('svc_queued_submit');
  if (!raw) return;
  try {
    const { payload, photos } = JSON.parse(raw);
    window._svcPayload = payload;
    window._svcPhotos = photos || [];
    _showSvcRetryBanner_('Signal back — sending now...');
    _doSvcSubmit_(payload, photos || []);
  } catch(e) {}
}

function _onSvcSuccess_(payload, photoCount) {
  localStorage.removeItem('svc_queued_submit');
  window.removeEventListener('online', _onSvcOnline_);
  const poolIdKey = Object.keys(payload).find(k => k.trim().toLowerCase() === 'pool_id');
  const pId = poolIdKey ? payload[poolIdKey] : null;
  const scheduledVisitId = payload['_scheduled_visit_id'] || payload['_service_visit_id'] || '';
  const routeMeta = Object.assign({}, window._pendingSvcMeta || {});
  if (typeof markSvcSubmittedInRoute_ === 'function') {
    markSvcSubmittedInRoute_(payload, routeMeta);
  }
  if (pId) {
    localStorage.removeItem('svc_draft_' + pId);
    if (_activeDay && _routeData && _routeData.week_start) {
      const doneKey = `mcps_done_${_routeData.week_start}_${_activeDay}`;
      const done = JSON.parse(localStorage.getItem(doneKey) || '[]');
      if (!done.includes(pId)) { done.push(pId); localStorage.setItem(doneKey, JSON.stringify(done)); }
      if (routeMeta.pool_id && !done.includes(routeMeta.pool_id)) {
        done.push(routeMeta.pool_id);
        localStorage.setItem(doneKey, JSON.stringify(done));
      }
      if (scheduledVisitId && !done.includes(scheduledVisitId)) {
        done.push(scheduledVisitId);
        localStorage.setItem(doneKey, JSON.stringify(done));
      }
    }
  }
  window._lastLoadedPoolId = null;
  window._pendingSvcMeta = null;
  const _successRoot = document.getElementById('svc-root');
  if (!_successRoot) return; // background send — DOM not visible, nothing to update
  _successRoot.innerHTML = '<div style="text-align:center;padding:3rem 1rem">'
    + '<div style="font-size:3.5rem;margin-bottom:1rem">✅</div>'
    + '<div style="font-family:Oswald,sans-serif;font-size:1.8rem;font-weight:700;letter-spacing:.1em;color:#0d4d44;margin-bottom:.5rem">SUBMITTED</div>'
    + '<p style="color:#64748b;margin-bottom:.35rem">Log written, inventory deducted, email sent.</p>'
    + (photoCount ? '<p style="color:#64748b;font-size:.85rem;margin-bottom:1.5rem">📸 ' + photoCount + ' photo' + (photoCount > 1 ? 's' : '') + ' saved to Drive.</p>' : '<br>')
    + '<button onclick="returnToScheduleAfterSubmit()" style="display:block;width:100%;padding:.85rem 1.75rem;background:#0d4d44;color:#fff;border:none;border-radius:12px;font-family:Oswald,sans-serif;font-size:1rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;margin-bottom:.75rem">Back to Schedule</button>'
    + '<button onclick="resetSvc()" style="display:block;width:100%;padding:.85rem 1.75rem;background:transparent;color:#0d4d44;border:2px solid #0d4d44;border-radius:12px;font-family:Oswald,sans-serif;font-size:1rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;cursor:pointer">Log Another Pool</button>'
    + '</div>';
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

function compressPhoto_(file) {
  return new Promise(resolve => {
    const MAX_DIM = 1200;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width, h = img.height;
      if (w > MAX_DIM || h > MAX_DIM) {
        if (w >= h) { h = Math.round(h * MAX_DIM / w); w = MAX_DIM; }
        else { w = Math.round(w * MAX_DIM / h); h = MAX_DIM; }
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      c.toBlob(blob => {
        const r = new FileReader();
        r.onload = e => resolve({ base64: e.target.result.split(',')[1], mimeType: 'image/jpeg', name: file.name.replace(/\.\w+$/, '.jpg') });
        r.readAsDataURL(blob);
      }, 'image/jpeg', 0.72);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

async function addPhotos_(files) {
  const remaining = MAX_PHOTOS - window._svcPhotos.length;
  const toAdd = files.slice(0, remaining);
  if (files.length > remaining) alert('Max 4 photos per visit. Only the first ' + remaining + ' were added.');
  if (!toAdd.length) return;
  const zone = document.getElementById('photo-drop-zone');
  const label = zone && zone.querySelector('.pu-label');
  if (label) label.textContent = 'Compressing...';
  for (const file of toAdd) {
    if (file.size > MAX_BYTES) { alert(file.name + ' is too large (max 10 MB).'); continue; }
    const compressed = await compressPhoto_(file);
    if (compressed) window._svcPhotos.push(compressed);
  }
  if (label) label.textContent = 'Tap to take photo or choose from library';
  renderPhotoPreviews_();
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
  document.getElementById('svc-root').style.display='none';
  document.getElementById('svc-root').innerHTML='';
  loadServiceLog();
}
