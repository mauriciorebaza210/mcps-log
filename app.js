// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════
const AS = 'https://script.google.com/macros/s/AKfycbzcCh5WVhiCZglMFQ_BaHHRD_QbsOFzpf5KgKyFWReAv7aJp2Z6_oYIUYBMLwzTIy_v/exec';
const SEC = 'mcps_webhook_2026';

const PAGE_META = {
  home:'🏠|Home', live_map:'🛟|Technician Hub', service_log:'📝|Service Log',
  inventory:'📦|Inventory', quotes:'📄|Quotes', training:'🎓|Training', admin:'🔒|Admin',
  onboarding:'📋|Get Started'
};

// Pages per role — additive
const ROLE_PAGES = {
  technician:['home','live_map','service_log','training'],
  lead:['home','live_map','service_log','training'],
  trainee:['home','training'],
  new_hire:['onboarding'],
  office:['home','quotes','inventory'],
  manager:['home','live_map','service_log','inventory','quotes','training'],
  admin:['home','live_map','service_log','inventory','quotes','training','admin'],
};

const ALL_ROLES = ['technician','lead','office','manager','admin','trainee','new_hire'];
const ALL_DAYS  = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
let _editingUsername = null;
let _usersCache = [];

// ══════════════════════════════════════════════════════════════════════════════
// SESSION
// ══════════════════════════════════════════════════════════════════════════════
let _s = null; // { token, name, roles[], pages[] }
let _curPage = 'home';
let _routeData = null;
let _unassignedPools = null;
let _pasState = null; // { pool_id, day, operator, pinned, newDay, newOp, newPinned }
let _activeDay = null;
let _activeOp = 'all';
let _formItems = [];
let _mapLoaded = false;
let _leafMap = null;
let _mapMarkers = [];

function api(payload){ return fetch(AS,{method:'POST',body:JSON.stringify(payload)}).then(r=>r.json()); }
function apiGet(params){ return fetch(AS+'?'+new URLSearchParams(params)).then(r=>r.json()); }

window.onload = () => {
  const stored = localStorage.getItem('mcps_s');
  if (stored) {
    try { _s = JSON.parse(stored); showApp(location.hash.replace('#','') || 'home'); return; } catch(e) { localStorage.removeItem('mcps_s'); }
  }
  const deep = location.hash.replace('#','');
  if (deep) sessionStorage.setItem('mcps_deep', deep);
};

// ── Auth ──────────────────────────────────────────────────────────────────────
function doLogin() {
  const u = document.getElementById('u').value.trim();
  const p = document.getElementById('p').value.trim();
  const btn = document.getElementById('btn-login');
  const err = document.getElementById('lerr');
  if (!u||!p){showLErr('Enter username and password.');return;}
  btn.disabled=true; btn.textContent='Signing in...'; err.style.display='none';
  api({action:'login',username:u,password:p}).then(res=>{
    if(res.ok){
      const roles = res.roles || [res.role || 'technician'];
      const pages = unionPages_(roles);
      _s = {token:res.token,name:res.name,roles,pages};
      localStorage.setItem('mcps_s',JSON.stringify(_s));
      const deep = sessionStorage.getItem('mcps_deep')||'home';
      sessionStorage.removeItem('mcps_deep');
      showApp(deep);
    } else {
      showLErr(res.error||'Login failed.');
      btn.disabled=false; btn.textContent='Sign In';
    }
  }).catch(()=>{showLErr('Network error.');btn.disabled=false;btn.textContent='Sign In';});
}
function showLErr(m){const el=document.getElementById('lerr');el.textContent=m;el.style.display='block';}
function doLogout(){if(_s)api({action:'logout',secret:SEC,token:_s.token}).catch(()=>{});_s=null;localStorage.removeItem('mcps_s');location.hash='';location.reload();}

function unionPages_(roles) {
  const set = new Set();
  const order = ['home','onboarding','live_map','service_log','inventory','quotes','training','admin'];
  roles.forEach(r=>{(ROLE_PAGES[r]||[]).forEach(p=>set.add(p));});
  return order.filter(p=>set.has(p));
}

function hasRole(role){return _s&&(_s.roles||[]).includes(role);}
function isAdmin(){return hasRole('admin')||hasRole('manager');}

// ── App shell ─────────────────────────────────────────────────────────────────
function showApp(startPage) {
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').style.display='flex';
  document.getElementById('tp-name').textContent=_s.name;
  const rb=document.getElementById('tp-role');
  rb.textContent=(_s.roles||[]).join(', '); rb.className='r-badge '+(_s.roles||[])[0];
  document.getElementById('home-name').textContent=_s.name.split(' ')[0];
  buildNav(); buildHomeCards();
  if((_s.pages||[]).includes('admin')) { loadUsers(); loadPendingHires(); loadInternalNotes(); }
  const pg = (_s.pages||[]).includes(startPage)?startPage:'home';
  navigateTo(pg);
}

function buildNav(){
  document.getElementById('bnav').innerHTML=(_s.pages||[]).filter(p => p !== 'service_log').map(p=>{
    const [icon,label]=(PAGE_META[p]||'❓|?').split('|');
    return `<button class="ni" id="ni-${p}" onclick="navigateTo('${p}')"><span class="ni-icon">${icon}</span><span class="ni-label">${label}</span></button>`;
  }).join('');
}

function buildHomeCards(){
  const descs={onboarding:'Complete your onboarding to get started',live_map:'View and manage your route assignments',service_log:'Log a pool visit & dosage recs',inventory:'Chemical inventory levels',quotes:'Quote calculator',training:'Video training modules',admin:'Manage users & access'};
  document.getElementById('home-grid').innerHTML=(_s.pages||[]).filter(p=>p!=='home').map(p=>{
    const [icon,label]=(PAGE_META[p]||'❓|?').split('|');
    return `<div class="home-card" onclick="navigateTo('${p}')"><span class="hc-icon">${icon}</span><div><div class="hc-name">${label}</div><div class="hc-desc">${descs[p]||''}</div></div><span class="hc-arrow">›</span></div>`;
  }).join('');
}

function navigateTo(page){
  if(!_s||!(_s.pages||[]).includes(page))return;
  document.querySelectorAll('.pf').forEach(f=>f.classList.remove('active'));
  document.querySelectorAll('.ni').forEach(n=>n.classList.remove('active'));
  const frame=document.getElementById('page-'+page);
  if(frame)frame.classList.add('active');
  const nb=document.getElementById('ni-'+page);
  if(nb)nb.classList.add('active');
  _curPage=page;
  location.hash=page==='home'?'':page;
  if(page==='live_map'&&!_routeData) loadRoutes();
  // Always reload service log state. Pass any pending prefill ID if applicable.
  if(page==='service_log') loadServiceLog(window._pendingSvcPoolId);
  if(page==='inventory'&&!_invLoaded) loadInventory();
  if(page==='quotes') qInit();
  if(page==='training') loadTraining();
  if(page==='onboarding') loadOnboarding();
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES / MAP PAGE
// ══════════════════════════════════════════════════════════════════════════════
function loadRoutes(opOverride) {
  document.getElementById('route-loading').style.display='block';
  document.getElementById('route-content').style.display='none';
  const op = opOverride || _activeOp;
  apiGet({action:'route_data', token:_s.token, operator:op})
    .then(res=>{
      document.getElementById('route-loading').style.display='none';
      if(!res.ok){
        document.getElementById('route-content').innerHTML=`<div class="route-empty"><div class="route-empty-icon">⚠️</div><div class="route-empty-text">${res.error}</div></div>`;
        document.getElementById('route-content').style.display='block';
        return;
      }
      _routeData = res;
      document.getElementById('route-content').style.display='block';
      renderRoutePage();
      // Load unassigned pools for admins
      if(isAdmin()) loadUnassigned();
    })
    .catch(e=>{
      document.getElementById('route-loading').style.display='none';
      document.getElementById('route-content').innerHTML=`<div class="route-empty"><div class="route-empty-icon">⚠️</div><div class="route-empty-text">Network error: ${e.message}</div></div>`;
      document.getElementById('route-content').style.display='block';
    });
}

// ── Map Calendar Logic ──
let _currentMapView = 'week';
let _calData = null;
let _calMonth = new Date().getMonth() + 1;
let _calYear = new Date().getFullYear();

function switchMapView(view) {
  _currentMapView = view;
  document.getElementById('btn-view-week').classList.toggle('active', view === 'week');
  document.getElementById('btn-view-month').classList.toggle('active', view === 'month');
  
  if (view === 'week') {
    document.getElementById('map-week-view').style.display = 'block';
    document.getElementById('map-month-view').style.display = 'none';
    const addBtn = document.getElementById('btn-add-adhoc');
    if(addBtn) addBtn.style.display = 'none';
    if (!_routeData) loadRoutes();
  } else {
    document.getElementById('map-week-view').style.display = 'none';
    document.getElementById('map-month-view').style.display = 'block';
    if(isAdmin()) {
      const addBtn = document.getElementById('btn-add-adhoc');
      if(addBtn) addBtn.style.display = 'block';
    }
    loadCalendarData(_calMonth, _calYear);
  }
}

function navMonth(dir) {
  _calMonth += dir;
  if (_calMonth > 12) { _calMonth = 1; _calYear++; }
  else if (_calMonth < 1) { _calMonth = 12; _calYear--; }
  loadCalendarData(_calMonth, _calYear);
}

function loadCalendarData(m, y) {
  document.getElementById('route-loading').style.display = 'block';
  document.getElementById('route-content').style.display = 'none';
  
  const t = new Date(y, m-1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  const titleEl = document.getElementById('cal-month-title');
  if(titleEl) titleEl.textContent = t;

  apiGet({action:'calendar_data', token:_s.token, month:m, year:y, operator:_activeOp})
    .then(res => {
      document.getElementById('route-loading').style.display = 'none';
      document.getElementById('route-content').style.display = 'block';
      if(!res.ok) {
        document.getElementById('cal-cells').innerHTML = `<div style="grid-column: span 7; padding: 2rem; text-align: center;">Error: ${res.error}</div>`;
        return;
      }
      _calData = res.days || [];
      if (res.all_operators) _calOperatorList = res.all_operators;
      
      // Update Op Filter Data
      if(isAdmin() && res.all_operators && res.all_operators.length > 1) {
        const opRow = document.getElementById('op-filter-row');
        opRow.style.display='flex';
        opRow.innerHTML='<button class="op-filter-btn'+((_activeOp==='all')?' active':'')+'" onclick="switchOp(\'all\')">All</button>'+
          res.all_operators.map(op=>`<button class="op-filter-btn${_activeOp===op?' active':''}" onclick="switchOp('${op}')">${op.split(' ')[0]}</button>`).join('');
      }

      renderMapCalendar();
    })
    .catch(e => {
      document.getElementById('route-loading').style.display = 'none';
      document.getElementById('route-content').style.display = 'block';
      document.getElementById('cal-cells').innerHTML = `<div style="grid-column: span 7; padding: 2rem; text-align: center;">Network Error: ${e.message}</div>`;
    });
}

function renderMapCalendar() {
  const wrap = document.getElementById('cal-cells');
  if(!wrap) return;
  if(!_calData || !_calData.length) { wrap.innerHTML = ''; return; }

  const todayStr = new Date().toLocaleDateString('en-CA', {year:'numeric', month:'2-digit', day:'2-digit'}); // yyyy-mm-dd
  
  let html = '';
  _calData.forEach((day, idx) => {
    let pillsHtml = '';
    
    // Summarize weeklies
    if(day.weeklies && day.weeklies.length > 0) {
       pillsHtml += `<div class="cal-pill weekly">${day.weeklies.length} Weeklies</div>`;
    }
    
    // Adhocs (already filtered softly by backend for technicians, though we enforce admin only on adHoc sheet)
    if(day.adhocs && day.adhocs.length > 0) {
       day.adhocs.forEach(a => {
          let pcls = 'onetime';
          if(a.type === 'Proposal') pcls = 'proposal';
          if(a.type === 'Green to Clean') pcls = 'green';
          pillsHtml += `<div class="cal-pill ${pcls}">${a.type}: ${a.customer_name||a.city||'Unknown'}</div>`;
       });
    }

    const cls = [];
    if(!day.isCurrentMonth) cls.push('out-month');
    if(day.date === todayStr) cls.push('today');
    
    html += `<div class="cal-cell ${cls.join(' ')}" onclick="showCalDayDetails(${idx})">
               <div class="cal-cell-date">${day.dayNum}</div>
               ${pillsHtml}
             </div>`;
  });
  
  wrap.innerHTML = html;
  document.getElementById('cal-detail-card').style.display = 'none';
}

function showCalDayDetails(idx) {
  const day = _calData[idx];
  if(!day) return;
  const c = document.getElementById('cal-detail-card');
  c.style.display = 'block';
  
  let html = `<div style="font-family:'Oswald',sans-serif;font-size:1.1rem;color:var(--teal);border-bottom:1px solid var(--border);padding-bottom:0.5rem;margin-bottom:1rem;">Details for ${day.date}</div>`;
  
  if((!day.weeklies || !day.weeklies.length) && (!day.adhocs || !day.adhocs.length)) {
    html += `<div style="color:var(--muted);font-size:0.9rem;">No services scheduled.</div>`;
  } else {
    // Adhocs First
    if(day.adhocs && day.adhocs.length > 0) {
      html += `<div style="font-weight:600;margin-bottom:0.5rem;font-size:0.85rem;color:var(--muted);text-transform:uppercase;">Special Services & Proposals</div>`;
      day.adhocs.forEach(a => {
        let pcls = 'onetime';
        if(a.type === 'Proposal') pcls = 'proposal';
        if(a.type === 'Green to Clean') pcls = 'green';
        
        html += `<div style="margin-bottom:0.75rem;padding:0.75rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);">
          <div style="display:flex;justify-content:space-between;align-items:center;">
             <span style="font-weight:600;font-size:0.9rem;">${a.customer_name || 'No Name'}</span>
             <span class="cal-pill ${pcls}">${a.type}</span>
          </div>
          <div style="font-size:0.8rem;color:var(--muted);margin-top:0.25rem;">
            📍 ${a.address || 'No Address'} <br>
            👤 Op: ${a.operator || 'Unassigned'} <br>
            ${a.notes ? `📝 ${a.notes}`:''}
          </div>
        </div>`;
      });
    }
    
    // Weeklies
    if(day.weeklies && day.weeklies.length > 0) {
      html += `<div style="font-weight:600;margin:1rem 0 0.5rem;font-size:0.85rem;color:var(--muted);text-transform:uppercase;">Recurring Routes (${day.weeklies.length})</div>`;
      html += `<div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(250px, 1fr));gap:0.5rem;">`;
      day.weeklies.forEach(w => {
         html += `<div style="padding:0.6rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:0.85rem;">
            <div style="font-weight:600;">${w.customer_name || w.pool_id}</div>
            <div style="color:var(--muted);font-size:0.75rem;">${w.address}, ${w.city}</div>
            <div style="color:var(--teal-mid);font-size:0.75rem;margin-top:0.2rem;font-weight:600;">Op: ${w.operator || 'Unassigned'}</div>
         </div>`;
      });
      html += `</div>`;
    }
  }
  
  c.innerHTML = html;
  c.scrollIntoView({behavior: 'smooth', block: 'end'});
}

// ── AdHoc Modal ──
function openAdHocModal() {
  document.getElementById('adhoc-date').value = new Date().toLocaleDateString('en-CA');
  document.getElementById('adhoc-type').value = 'Proposal';
  document.getElementById('adhoc-customer').value = '';
  document.getElementById('adhoc-address').value = '';
  document.getElementById('adhoc-notes').value = '';
  
  const opSel = document.getElementById('adhoc-operator');
  if(opSel) {
    opSel.innerHTML = '<option value="">Unassigned</option>';
    if(window._calOperatorList) {
        _calOperatorList.forEach(op => {
             opSel.innerHTML += `<option value="${op}">${op}</option>`;
        });
    } else if(_routeData && _routeData.all_operators) {
         _routeData.all_operators.forEach(op => {
             opSel.innerHTML += `<option value="${op}">${op}</option>`;
         });
    }
  }

  document.getElementById('adhoc-modal-backdrop').classList.add('open');
}

function closeAdHocModal() {
  document.getElementById('adhoc-modal-backdrop').classList.remove('open');
}

function saveAdHocEvent() {
  const btn = document.getElementById('btn-save-adhoc');
  const evt = {
    date: document.getElementById('adhoc-date').value,
    type: document.getElementById('adhoc-type').value,
    customer_name: document.getElementById('adhoc-customer').value.trim(),
    address: document.getElementById('adhoc-address').value.trim(),
    operator: document.getElementById('adhoc-operator').value,
    notes: document.getElementById('adhoc-notes').value.trim(),
  };
  
  if(!evt.date) { alert("Date is required"); return; }
  
  btn.disabled = true; btn.textContent = 'Saving...';
  api({action: 'add_adhoc_event', token: _s.token, event: evt})
    .then(res => {
       btn.disabled = false; btn.textContent = 'Save Event';
       if(!res.ok) { alert(res.error || "Failed to save event"); return; }
       closeAdHocModal();
       loadCalendarData(_calMonth, _calYear); // reload
    })
    .catch(e => {
       btn.disabled = false; btn.textContent = 'Save Event';
       alert("Network error: " + e.message);
    });
}


// ── Form Editor (Admin) ──────────────────────────────────────────────────────
let _formSchema = [];

function toggleFormEditor(btn) {
  const wrap = document.getElementById('form-editor-wrap');
  const open = wrap.style.display === 'none';
  wrap.style.display = open ? 'block' : 'none';
  btn.textContent = open ? '✕ Close' : '✏️ Edit Form';
  if (open && _formSchema.length === 0) adminLoadFormEditor();
}

function adminLoadFormEditor() {
  const list = document.getElementById('form-field-list');
  list.innerHTML = '<div style="text-align:center;padding:1.5rem"><div class="spinner" style="margin:0 auto"></div></div>';
  api({ secret: SEC, action: 'get_portal_schema', token: _s.token }).then(res => {
    if (!res.ok) { list.innerHTML = '<div style="color:var(--error);padding:1rem">Error: ' + res.error + '</div>'; return; }
    _formSchema = res.data;
    renderFormFieldList();
  }).catch(e => { list.innerHTML = '<div style="color:var(--error);padding:1rem">Network error: ' + e.message + '</div>'; });
}

function renderFormFieldList() {
  const el = document.getElementById('form-field-list');
  if (!_formSchema.length) { el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">No fields. Add one below.</div>'; return; }
  el.innerHTML = _formSchema.map((item, idx) => {
    const type = String(item.type || '').trim();
    if (type === 'PAGE_BREAK') {
      return `<div class="fe-break">
        <span class="fe-break-label">── ${item.title || 'Section Break'} ──</span>
        <div style="display:flex;gap:.25rem">
          <button class="fe-btn" onclick="feMoveUp(${idx})" title="Move up">↑</button>
          <button class="fe-btn" onclick="feMoveDown(${idx})" title="Move down">↓</button>
          <button class="fe-btn fe-del" onclick="feDelete(${idx})" title="Delete">✕</button>
        </div>
      </div>`;
    }
    const hasChoices = type === 'LIST' || type === 'CHECKBOX';
    let choicesText = '';
    if (hasChoices && item.choices) {
      try { const c = JSON.parse(item.choices); choicesText = c.length + ' choices'; } catch(e) {}
    }
    return `<div class="fe-row" id="fe-row-${idx}">
        <div class="fe-row-left">
          <div class="fe-row-title">${item.title || '—'}</div>
          <div class="fe-row-meta">${type}${item.section ? ' · ' + item.section : ''}${item.helpText ? ' · ' + String(item.helpText).slice(0,45) + (item.helpText.length>45?'…':'') : ''}${choicesText ? ' · ' + choicesText : ''}</div>
        </div>
        <div style="display:flex;gap:.25rem;flex-shrink:0;margin-left:.5rem">
          <button class="fe-btn" onclick="feMoveUp(${idx})" title="Move up">↑</button>
          <button class="fe-btn" onclick="feMoveDown(${idx})" title="Move down">↓</button>
          <button class="fe-btn" onclick="feToggleEdit(${idx})" title="Edit">✏️</button>
          <button class="fe-btn fe-del" onclick="feDelete(${idx})" title="Delete">✕</button>
        </div>
      </div>
      <div class="fe-edit-panel" id="fe-edit-${idx}" style="display:none">
        <div class="fe-edit-grid">
          <div class="dfg" style="margin:0"><label>Title</label><input class="si" id="fe-t-${idx}" value="${(item.title||'').replace(/"/g,'&quot;')}"></div>
          <div class="dfg" style="margin:0"><label>Help Text</label><input class="si" id="fe-h-${idx}" value="${(item.helpText||'').replace(/"/g,'&quot;')}"></div>
          ${hasChoices ? `<div class="dfg" style="margin:0;grid-column:span 2"><label>Choices (one per line)</label><textarea class="si" id="fe-c-${idx}" rows="4" style="resize:vertical">${item.choices?JSON.parse(item.choices||'[]').join('\n'):''}</textarea></div>` : ''}
          <div class="dfg" style="margin:0;display:flex;align-items:center;gap:.4rem;padding-top:.5rem">
            <label style="display:flex;align-items:center;gap:.35rem;font-size:.83rem;cursor:pointer">
              <input type="checkbox" id="fe-r-${idx}" ${(item.required===true||item.required==='TRUE')?'checked':''}> Required
            </label>
          </div>
          <div style="display:flex;justify-content:flex-end;align-items:flex-end">
            <button class="adm-new-btn" style="padding:.38rem .85rem;font-size:.78rem" onclick="feApplyEdit(${idx})">Apply</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function feMoveUp(idx) {
  if (idx === 0) return;
  [_formSchema[idx-1], _formSchema[idx]] = [_formSchema[idx], _formSchema[idx-1]];
  _feReorder(); renderFormFieldList();
}
function feMoveDown(idx) {
  if (idx >= _formSchema.length - 1) return;
  [_formSchema[idx+1], _formSchema[idx]] = [_formSchema[idx], _formSchema[idx+1]];
  _feReorder(); renderFormFieldList();
}
function _feReorder() { _formSchema.forEach((item, i) => { item.order = i + 1; }); }

function feToggleEdit(idx) {
  const el = document.getElementById('fe-edit-' + idx);
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function feApplyEdit(idx) {
  const item = _formSchema[idx];
  item.title    = document.getElementById('fe-t-' + idx).value.trim();
  item.helpText = document.getElementById('fe-h-' + idx).value.trim();
  item.required = document.getElementById('fe-r-' + idx).checked;
  const choicesEl = document.getElementById('fe-c-' + idx);
  if (choicesEl) {
    item.choices = JSON.stringify(choicesEl.value.split('\n').map(s => s.trim()).filter(Boolean));
  }
  document.getElementById('fe-edit-' + idx).style.display = 'none';
  renderFormFieldList();
}

function feDelete(idx) {
  if (!confirm('Delete "' + (_formSchema[idx].title || 'this field') + '"?')) return;
  _formSchema.splice(idx, 1);
  _feReorder(); renderFormFieldList();
}

function adminAddFormField() {
  const title = document.getElementById('new-field-title').value.trim();
  const type  = document.getElementById('new-field-type').value;
  if (!title && type !== 'PAGE_BREAK') { alert('Title is required.'); return; }
  const maxOrder = _formSchema.reduce((m, i) => Math.max(m, Number(i.order||0)), 0);
  _formSchema.push({ order: maxOrder + 1, section: '', title, type, helpText: '', required: false, choices: '' });
  document.getElementById('new-field-title').value = '';
  renderFormFieldList();
  document.getElementById('form-field-list').lastElementChild.scrollIntoView({ behavior: 'smooth' });
}

function adminSaveFormSchema() {
  const btn = document.getElementById('fe-save-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  api({ secret: SEC, action: 'save_portal_schema', token: _s.token, schema: _formSchema })
    .then(res => {
      btn.disabled = false;
      if (res.ok) { btn.textContent = '✅ Saved!'; setTimeout(() => { btn.textContent = '💾 Save Changes'; }, 2500); }
      else { btn.textContent = '💾 Save Changes'; alert('Error: ' + res.error); }
    })
    .catch(e => { btn.disabled = false; btn.textContent = '💾 Save Changes'; alert('Network error: ' + e.message); });
}

function adminSyncPoolDropdown() {
  if (!confirm('Rebuild pool dropdown from Signed Customers?')) return;
  api({ secret: SEC, action: 'sync_pool_dropdown', token: _s.token }).then(res => {
    if (res.ok) { alert('✅ Pool dropdown synced.'); adminLoadFormEditor(); }
    else alert('Error: ' + res.error);
  }).catch(e => alert('Network error: ' + e.message));
}

function adminSyncChemicals() {
  if (!confirm('Sync chemical fields from Chem Costs?')) return;
  api({ secret: SEC, action: 'sync_chemicals', token: _s.token }).then(res => {
    if (res.ok) { alert('✅ Chemicals synced.'); adminLoadFormEditor(); }
    else alert('Error: ' + res.error);
  }).catch(e => alert('Network error: ' + e.message));
}

function recalculateRoutes() {
  if (!confirm('⚠️ Recalculate ALL routes?\n\nThis will reassign every un-pinned pool. Pinned pools stay put. Locked days are not affected.\n\nContinue?')) return;
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Recalculating...';
  api({ secret: SEC, action: 'recalculate_routes', token: _s.token })
    .then(res => {
      btn.disabled = false; btn.textContent = '🔄 Recalculate All Routes';
      if (res.ok) {
        _routeData = null;
        alert('✅ Routes recalculated successfully!');
        if (_curPage === 'live_map') loadRoutes();
      } else {
        alert('Error: ' + (res.error || 'Unknown'));
      }
    })
    .catch(e => {
      btn.disabled = false; btn.textContent = '🔄 Recalculate All Routes';
      alert('Network error: ' + e.message);
    });
}

function loadUnassigned() {
  apiGet({action:'get_unassigned', token:_s.token}).then(res=>{
    if(res.ok && res.pools && res.pools.length){
      _unassignedPools = res.pools;
      renderNewPoolsBanner();
    } else {
      _unassignedPools = [];
      const existing = document.getElementById('new-pools-banner');
      if(existing) existing.remove();
    }
  }).catch(()=>{});
}

function renderNewPoolsBanner() {
  let banner = document.getElementById('new-pools-banner');
  if(!_unassignedPools || !_unassignedPools.length) {
    if(banner) banner.remove();
    return;
  }
  const html = `<div class="new-pools-banner" id="new-pools-banner">
    <div class="npb-header" onclick="document.getElementById('npb-body').classList.toggle('open')">
      <span class="npb-title">⚠️ ${_unassignedPools.length} new pool${_unassignedPools.length>1?'s':''} need${_unassignedPools.length===1?'s':''} routing</span>
      <span class="npb-count">▼</span>
    </div>
    <div class="npb-body" id="npb-body">
      ${_unassignedPools.map(p=>`<div class="npb-pool">
        <div class="npb-pool-info">
          <div class="npb-pool-name">${p.customer_name||p.pool_id}</div>
          <div class="npb-pool-addr">${p.address||''}, ${p.city||''}</div>
        </div>
        <button class="npb-place-btn" onclick="openPlacePool('${p.pool_id}')">Place ▸</button>
      </div>`).join('')}
      <button class="npb-auto-btn" onclick="autoPlaceAll()">⚡ Auto-place all new pools</button>
    </div>
  </div>`;
  if(!banner) {
    const content = document.getElementById('route-content');
    content.insertAdjacentHTML('afterbegin', html);
  } else {
    banner.outerHTML = html;
  }
}

function renderRoutePage(){
  if(!_routeData) return;

  // Admin op filter
  const opRow = document.getElementById('op-filter-row');
  if(isAdmin() && _routeData.all_operators && _routeData.all_operators.length > 1){
    opRow.style.display='flex';
    opRow.innerHTML='<button class="op-filter-btn'+((_activeOp==='all')?' active':'')+'" onclick="switchOp(\'all\')">All</button>'+
      _routeData.all_operators.map(op=>`<button class="op-filter-btn${_activeOp===op?' active':''}" onclick="switchOp('${op}')">${op.split(' ')[0]}</button>`).join('');
  } else {
    opRow.style.display='none';
  }

  // Build day tabs
  const tabsEl = document.getElementById('day-tabs');
  const days = _routeData.days || [];
  const today = _routeData.today;

  tabsEl.innerHTML = days.map(d=>{
    const isToday = d.day === today;
    const count   = (d.pools || []).length;
    const locked  = d.locked;
    const dateStr = d.date ? (() => {
      const [y,mo,dy] = d.date.split('-').map(Number);
      return new Date(y, mo-1, dy).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
    })() : d.day;
    return `<div class="day-tab${isToday?' today':''}${locked?' locked':''}" id="tab-${d.day}" onclick="selectDay('${d.day}')">
      <span class="dt-day">${d.day.slice(0,3)}${locked?'<span class="dt-lock">🔒</span>':''}</span>
      <span class="dt-date">${dateStr}</span>
      <span class="dt-count">${count} pool${count!==1?'s':''}</span>
    </div>`;
  }).join('');

  // Load the current weekday locally, fallback to Monday if Sunday
  const jsDays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  let autoDay = jsDays[new Date().getDay()];
  if (autoDay === 'Sunday') autoDay = 'Monday';

  selectDay(autoDay);
}

function switchOp(op){
  _activeOp = op;
  _routeData = null;
  loadRoutes(op);
}

function selectDay(dayName){
  _activeDay = dayName;

  // Update tab active state
  document.querySelectorAll('.day-tab').forEach(t=>t.classList.remove('active'));
  const tab = document.getElementById('tab-'+dayName);
  if(tab) tab.classList.add('active');

  const dayData = (_routeData&&_routeData.days||[]).find(d=>d.day===dayName);
  renderDayCard(dayData);
}

function renderDayCard(dayData){
  const card = document.getElementById('route-day-card');
  if(!dayData){
    card.innerHTML='<div class="route-empty"><div class="route-empty-icon">📅</div><div class="route-empty-text">No data for this day.</div></div>';
    return;
  }

  const today   = _routeData.today;
  const isToday = dayData.day === today;
  const locked  = dayData.locked;
  const pools   = dayData.pools || [];
  const dateStr = dayData.date ? new Date(dayData.date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}) : dayData.day;

  // Load done state from localStorage
  const doneKey = `mcps_done_${_routeData.week_start}_${dayData.day}`;
  const doneSet = new Set(JSON.parse(localStorage.getItem(doneKey)||'[]'));

  let html = '';

  // Header
  html += `<div class="rdc-header${locked?' locked-day':''}">
    <div>
      <div class="rdc-day-name">${dayData.day}</div>
      <div class="rdc-meta">${dateStr} · ${pools.length} pool${pools.length!==1?'s':''}</div>
    </div>
    <div class="rdc-badges">
      ${isToday?'<span class="rdc-badge today-badge">Today</span>':''}
      ${locked?'<span class="rdc-badge locked">Locked 🔒</span>':''}
      ${isAdmin()?'<button class="pin-all-btn" onclick="pinAllDay(\''+dayData.day+'\')" title="Pin all pools on this day">📌 Pin All</button>':''}
    </div>
  </div>`;

  if(!pools.length){
    html += '<div class="route-empty" style="padding:2.5rem 1rem"><div class="route-empty-icon">😎</div><div class="route-empty-text">No pools scheduled for this day.</div></div>';
    card.innerHTML = html;
    return;
  }

  // Locked notice
  if(locked){
    html += `<div class="locked-notice">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      Route locked — no changes will be made to today's schedule. See you next week!
    </div>`;
  }

  // Maps launch buttons
  const gmapsUrl = dayData.maps_url || '';
  const amapsUrl = gmapsUrl.replace('https://www.google.com/maps/dir/','https://maps.apple.com/?daddr=').replace(/\//g,'&daddr=');

  html += `<div class="maps-btn-row">
    <a class="maps-btn gmaps${!gmapsUrl?' disabled-btn':''}" href="${gmapsUrl}" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
      Google Maps Route
    </a>
    <a class="maps-btn amaps${!gmapsUrl?' disabled-btn':''}" href="${buildAppleMapsUrl_(pools)}" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
      Apple Maps Route
    </a>
  </div>`;

  // Pool stop list
  html += '<div class="pool-stops">';
  pools.forEach((pool, idx) => {
    const done = doneSet.has(pool.pool_id || String(idx));
    const svcClass = getSvcClass_(pool.service);
    const svcLabel = getSvcLabel_(pool.service);
    const indivMaps = 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(pool.address+', '+pool.city+', TX');
    const isPinned = pool.pinned === true || pool.pinned === 'TRUE';
    const pinIcon = isPinned ? '📌' : '○';
    const pinClass = isPinned ? 'stop-pinned' : 'stop-unpinned';
    const adminTap = isAdmin() ? ` onclick="openPoolAction('${pool.pool_id||idx}','${dayData.day}','${pool.operator||''}',${isPinned})"` : '';

    html += `<div class="pool-stop${done?' done-stop':''}" id="stop-${idx}" style="${isAdmin()?'cursor:pointer':''}"${adminTap}>
      <div class="stop-num-wrap">
        <div class="stop-num">${idx+1}</div>
        <input type="checkbox" class="stop-check" ${done?'checked':''} onchange="event.stopPropagation();toggleDone(this,${idx},'${pool.pool_id||idx}','${doneKey}')">
      </div>
      <div class="stop-body">
        <div class="stop-name">${pool.customer_name||'—'}<span class="stop-pin ${pinClass}" title="${isPinned?'Pinned':'Not pinned'}">${pinIcon}</span></div>
        <div class="stop-addr">${pool.address}${pool.city?', '+pool.city:''}</div>
        <span class="stop-svc ${svcClass}">${svcLabel}</span>
        ${pool.operator && isAdmin()?`<span class="stop-svc svc-other" style="margin-left:.3rem">${pool.operator}</span>`:''}
        ${pool.notes?`<div class="stop-notes">📋 ${pool.notes}</div>`:''}
      </div>
      <div class="stop-actions" onclick="event.stopPropagation()">
        <button class="stop-log-btn" onclick="goToSvcLog('${escHtml(pool.pool_id||'')}','${escHtml(pool.customer_name||'')}')">
          📋 Log
        </button>
        <button class="stop-headsup-btn" data-pool-id="${escHtml(pool.pool_id||String(idx))}" data-cust-name="${escHtml(pool.customer_name||'')}" onclick="headsUp(event,this)" title="Send heads up SMS">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          On the way!
        </button>
        <a class="stop-nav-btn" href="${indivMaps}" target="_blank" rel="noopener" title="Navigate to this pool">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
        </a>
      </div>
    </div>`;
  });
  html += '</div>';

  // Expandable map panel
  html += `<button class="map-toggle-btn" id="map-toggle-btn" onclick="toggleMapPanel()">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 20l-5.447-2.724A1 1 0 0 1 3 16.382V5.618a1 1 0 0 1 1.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0 0 21 18.382V7.618a1 1 0 0 0-.553-.894L15 4m0 13V4m0 0L9 7"/></svg>
    Show on Map
  </button>
  <div class="map-panel" id="map-panel"><div id="leaflet-map"></div></div>`;

  card.innerHTML = html;

  // Init/update map
  initOrUpdateMap_(pools);
}

function toggleMapPanel(){
  const panel = document.getElementById('map-panel');
  const btn   = document.getElementById('map-toggle-btn');
  const open  = panel.classList.toggle('open');
  btn.textContent = open ? '▲ Hide Map' : '▼ Show on Map';
  if(open && _leafMap) setTimeout(()=>_leafMap.invalidateSize(), 50);
}

function initOrUpdateMap_(pools) {
  // Defer until panel is opened
  const valid = pools.filter(p=>p.lat&&p.lng&&p.lat!==0&&p.lng!==0);
  if(!valid.length) return;

  // We reinitialize when the day changes
  if(_leafMap){_leafMap.remove();_leafMap=null;_mapMarkers=[];}

  setTimeout(()=>{
    const el = document.getElementById('leaflet-map');
    if(!el) return;
    _leafMap = L.map(el,{zoomControl:true});
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:18}).addTo(_leafMap);

    const bounds = [];
    valid.forEach((pool,i)=>{
      const icon = L.divIcon({
        className:'',
        html:`<div style="width:26px;height:26px;border-radius:50%;background:var(--teal);color:#fff;display:flex;align-items:center;justify-content:center;font-family:'Oswald',sans-serif;font-size:13px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.25)">${i+1}</div>`,
        iconSize:[26,26],iconAnchor:[13,13]
      });
      const m = L.marker([pool.lat,pool.lng],{icon}).addTo(_leafMap)
        .bindPopup(`<b>${pool.customer_name}</b><br>${pool.address}<br><small>${pool.service}</small>`);
      _mapMarkers.push(m);
      bounds.push([pool.lat,pool.lng]);
    });
    if(bounds.length) _leafMap.fitBounds(bounds,{padding:[20,20]});
  },100);
}

function toggleDone(cb, idx, poolId, doneKey){
  const row = document.getElementById('stop-'+idx);
  const done = JSON.parse(localStorage.getItem(doneKey)||'[]');
  if(cb.checked){ if(!done.includes(poolId))done.push(poolId); }
  else { const i=done.indexOf(poolId); if(i!==-1)done.splice(i,1); }
  localStorage.setItem(doneKey, JSON.stringify(done));
  if(row) row.classList.toggle('done-stop', cb.checked);
  const numEl = row&&row.querySelector('.stop-num');
  if(numEl) numEl.style.background = cb.checked ? 'var(--success)' : 'var(--teal)';
}

function buildAppleMapsUrl_(pools){
  if(!pools.length) return '#';
  const last = pools[pools.length-1];
  const dest = encodeURIComponent(last.address+', '+last.city+', TX');
  if(pools.length===1) return 'https://maps.apple.com/?daddr='+dest;
  // Apple Maps doesn't support true multi-stop — deep link to last destination
  return 'https://maps.apple.com/?daddr='+dest+'&dirflg=d';
}

function getSvcClass_(svc){
  const s=(svc||'').toLowerCase();
  if(s.includes('weekly'))return 'svc-weekly';
  if(s.includes('startup'))return 'svc-startup';
  if(s.includes('monthly'))return 'svc-monthly';
  if(s.includes('green')||s.includes('clean'))return 'svc-gtc';
  return 'svc-other';
}
function getSvcLabel_(svc){
  const s=(svc||'').toLowerCase();
  if(s.includes('weekly full'))return 'Weekly';
  if(s.includes('bi-weekly')||s.includes('biweekly'))return 'Bi-Weekly';
  if(s.includes('startup'))return 'Startup';
  if(s.includes('monthly'))return 'Monthly';
  if(s.includes('green'))return 'Green-to-Clean';
  return svc||'Service';
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE MANAGEMENT (Admin portal controls)
// ══════════════════════════════════════════════════════════════════════════════

function openPoolAction(poolId, day, operator, pinned) {
  if(!isAdmin()) return;
  _pasState = { pool_id: poolId, day, operator, pinned, newDay: day, newOp: operator, newPinned: pinned };
  // Fill title
  const pool = findPool_(poolId);
  document.getElementById('pas-title').textContent = pool ? pool.customer_name : poolId;
  document.getElementById('pas-sub').textContent = pool ? `${pool.address}, ${pool.city} · ${pool.service}` : '';
  // Day grid
  const dayGrid = document.getElementById('pas-day-grid');
  dayGrid.innerHTML = ALL_DAYS.map(d =>
    `<button class="pas-day-btn${d===day?' active':''}" onclick="pasSelectDay(this,'${d}')">${d.slice(0,3)}</button>`
  ).join('');
  // Operator select
  const opSel = document.getElementById('pas-op-select');
  const ops = _routeData && _routeData.all_operators ? _routeData.all_operators : [];
  opSel.innerHTML = ops.map(op => `<option value="${op}"${op===operator?' selected':''}>${op}</option>`).join('');
  // Pin toggle
  updatePasPin_(pinned);
  // Show
  document.getElementById('pas-backdrop').classList.add('open');
  document.getElementById('pas-sheet').classList.add('open');
}

function closePoolAction() {
  document.getElementById('pas-backdrop').classList.remove('open');
  document.getElementById('pas-sheet').classList.remove('open');
  _pasState = null;
}

function pasSelectDay(btn, day) {
  document.querySelectorAll('.pas-day-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if(_pasState) _pasState.newDay = day;
}

function togglePasPin() {
  if(!_pasState) return;
  _pasState.newPinned = !_pasState.newPinned;
  updatePasPin_(_pasState.newPinned);
}

function updatePasPin_(pinned) {
  const toggle = document.getElementById('pas-pin-toggle');
  const icon = document.getElementById('pas-pin-icon');
  const text = document.getElementById('pas-pin-text');
  toggle.classList.toggle('pinned', pinned);
  icon.textContent = pinned ? '📌' : '○';
  text.textContent = pinned ? 'Pinned — won\'t be moved by auto-placement' : 'Unpinned — can be auto-reassigned';
}

function applyPoolAction() {
  if(!_pasState) return;
  const btn = document.getElementById('pas-apply-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  const newOp = document.getElementById('pas-op-select').value;
  _pasState.newOp = newOp;
  api({
    secret: SEC, action: 'move_pool', token: _s.token,
    pool_id: _pasState.pool_id,
    new_day: _pasState.newDay,
    new_operator: _pasState.newOp,
    pinned: _pasState.newPinned
  }).then(res => {
    btn.disabled = false; btn.textContent = 'Apply Changes';
    if(res.ok) {
      closePoolAction();
      _routeData = null;
      loadRoutes();
    } else {
      alert('Error: ' + (res.error || 'Unknown'));
    }
  }).catch(e => {
    btn.disabled = false; btn.textContent = 'Apply Changes';
    alert('Network error: ' + e.message);
  });
}

function pinAllDay(day) {
  if(!isAdmin() || !confirm('Pin all pools on ' + day + '?')) return;
  api({
    secret: SEC, action: 'pin_day', token: _s.token, day: day, pinned: true
  }).then(res => {
    if(res.ok) { _routeData = null; loadRoutes(); }
    else alert('Error: ' + (res.error || 'Unknown'));
  }).catch(e => alert('Network error: ' + e.message));
}

function autoPlaceAll() {
  if(!isAdmin() || !confirm('Auto-place all new pools using the route algorithm?')) return;
  const btn = document.querySelector('.npb-auto-btn');
  if(btn) { btn.disabled = true; btn.textContent = 'Placing...'; }
  api({
    secret: SEC, action: 'recalculate_new', token: _s.token
  }).then(res => {
    if(btn) { btn.disabled = false; btn.textContent = '⚡ Auto-place all new pools'; }
    if(res.ok) {
      _routeData = null;
      _unassignedPools = null;
      loadRoutes();
    } else {
      alert('Error: ' + (res.error || 'Unknown'));
    }
  }).catch(e => {
    if(btn) { btn.disabled = false; btn.textContent = '⚡ Auto-place all new pools'; }
    alert('Network error: ' + e.message);
  });
}

function openPlacePool(poolId) {
  // Open pool action sheet in "place" mode for an unassigned pool
  const pool = _unassignedPools ? _unassignedPools.find(p => p.pool_id === poolId) : null;
  _pasState = { pool_id: poolId, day: 'Monday', operator: '', pinned: true, newDay: 'Monday', newOp: '', newPinned: true };
  document.getElementById('pas-title').textContent = pool ? pool.customer_name : poolId;
  document.getElementById('pas-sub').textContent = pool ? `${pool.address||''}, ${pool.city||''} · ${pool.service||''}` : 'New pool — choose a day and operator';
  const dayGrid = document.getElementById('pas-day-grid');
  dayGrid.innerHTML = ALL_DAYS.map(d =>
    `<button class="pas-day-btn${d==='Monday'?' active':''}" onclick="pasSelectDay(this,'${d}')">${d.slice(0,3)}</button>`
  ).join('');
  const opSel = document.getElementById('pas-op-select');
  const ops = _routeData && _routeData.all_operators ? _routeData.all_operators : [];
  opSel.innerHTML = ops.map((op,i) => `<option value="${op}"${i===0?' selected':''}>${op}</option>`).join('');
  updatePasPin_(true);
  document.getElementById('pas-backdrop').classList.add('open');
  document.getElementById('pas-sheet').classList.add('open');
}

function findPool_(poolId) {
  if(!_routeData || !_routeData.days) return null;
  for(const d of _routeData.days) {
    const p = (d.pools||[]).find(p => p.pool_id === poolId);
    if(p) return p;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVICE LOG
// ══════════════════════════════════════════════════════════════════════════════
const TF={FC:"Chlorine (Cl)",PH:"pH",TA:"Total Alkalinity (TA)",CH:"Calcium Hardness (CH)"};
const SG={small:12000,medium:17500,large:25000};
const SM=[6,7,8,9];

function loadServiceLog(prefillPoolId){
  window._lastLoadedPoolId = null; 
  window._svcLoadCounter = (window._svcLoadCounter||0) + 1;
  const thisRequest = window._svcLoadCounter;

  // 1. Try to render INSTANTLY from cache if we have it
  const cached = localStorage.getItem('svc_meta_cache');
  if (cached) {
    try {
      const meta = JSON.parse(cached);
      document.getElementById('svc-loading').style.display = 'none';
      document.getElementById('svc-root').style.display = 'block';
      renderSvcForm(meta, prefillPoolId);
    } catch(e) {}
  }
  
  // 2. Start both requests in parallel for maximum speed
  const metaReq = api({secret:SEC,action:'get_metadata'});
  const ctxReq  = prefillPoolId ? api({ secret: SEC, action: 'get_pool_context', token: _s.token, pool_id: prefillPoolId }) : Promise.resolve(null);

  metaReq.then(res=>{
    if (thisRequest !== window._svcLoadCounter) return;
    if(res.ok){
      localStorage.setItem('svc_meta_cache', JSON.stringify(res.data));
      // Only re-render if we didn't have a cache or if metadata is different
      if (!cached || JSON.stringify(JSON.parse(cached)) !== JSON.stringify(res.data)) {
        document.getElementById('svc-loading').style.display='none';
        document.getElementById('svc-root').style.display='block';
        renderSvcForm(res.data, prefillPoolId);
      }
    } else if (!cached) {
      document.getElementById('svc-root').innerHTML='<div style="color:var(--error);padding:2rem;text-align:center">'+res.error+'</div>';
      document.getElementById('svc-root').style.display='block';
    }
  }).catch(e=>{
    if (!cached) {
      document.getElementById('svc-loading').style.display='none';
      document.getElementById('svc-root').innerHTML='<div style="color:var(--error);padding:2rem;text-align:center">Failed: '+e.message+'</div>';
      document.getElementById('svc-root').style.display='block';
    }
  });

  // 3. Handle the context (specs/notes) as soon as it arrives
  ctxReq.then(res => {
    if (thisRequest !== window._svcLoadCounter) return;
    if (res && res.ok && res.data && res.data.found) {
      // Use a small delay to ensure the form has been rendered by the metaReq
      setTimeout(() => applyPoolContext_(res.data, prefillPoolId), 20);
    }
  });
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
        if (poolIdKey && window._svcPayload[poolIdKey]) {
          localStorage.removeItem('svc_draft_' + window._svcPayload[poolIdKey]);
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

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════════════════════
function loadInternalNotes() {
  const list = document.getElementById('internal-notes-list');
  if(!list) return;
  list.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">Loading...</div>';
  apiGet({ action:'get_internal_notes', token:_s.token }).then(res => {
    if(res.ok) {
      if(!res.notes || !res.notes.length) {
        list.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">No internal notes found.</div>';
        return;
      }
      list.innerHTML = res.notes.map(n => `
        <div style="border:1px solid var(--border);border-radius:8px;padding:1rem;margin-bottom:.5rem;background:#fff">
          <div style="font-weight:600;margin-bottom:.25rem">${n.pool_id || n.customer} <span style="float:right;color:var(--muted);font-weight:400;font-size:.8rem">${n.date}</span></div>
          <div style="font-size:.85rem;color:var(--text);margin-bottom:.25rem"><strong>Tech:</strong> ${n.tech || '—'}</div>
          <div style="font-size:.9rem;color:var(--teal)">${n.note}</div>
        </div>
      `).join('');
    } else {
      list.innerHTML = '<div style="color:var(--error);text-align:center;padding:1.5rem;font-size:.85rem">Error: ' + res.error + ' (Requires backend endpoint get_internal_notes)</div>';
    }
  }).catch(e => {
    list.innerHTML = '<div style="color:var(--error);text-align:center;padding:1.5rem;font-size:.85rem">Network error: ' + e.message + '</div>';
  });
}

function loadUsers() {
  api({ secret:SEC, action:'list_users', token:_s.token }).then(res => {
    if (!res.ok) return;
    _usersCache = res.users || [];
    renderUserTable(_usersCache);
  });
}
 
function renderUserTable(users) {
  const tb = document.getElementById('user-tbody');
  if (!tb) return;
  if (!users.length) {
    tb.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:1.5rem;color:var(--muted)">No users yet.</td></tr>';
    return;
  }
  tb.innerHTML = users.map(u => {
    const roles = Array.isArray(u.roles) ? u.roles : String(u.roles||'').split(',').map(r=>r.trim());
    const days  = u.available_days
      ? String(u.available_days).split(',').map(d=>d.trim().slice(0,3)).join(', ')
      : '<span class="no-days">Not set</span>';
    const active = u.active === true || String(u.active).toUpperCase() === 'TRUE';
    return `<tr onclick="openUserDrawer('${u.username}')" style="cursor:pointer">
      <td style="font-weight:600">${u.name||'—'}</td>
      <td style="color:var(--muted)">${u.username}</td>
      <td>${roles.join(', ')}</td>
      <td>${days}</td>
      <td><span class="dot ${active?'on':'off'}"></span>${active?'Active':'Inactive'}</td>
    </tr>`;
  }).join('');
}
 
// ─── Open drawer ──────────────────────────────────────────────────────────────
function openUserDrawer(username) {
  _editingUsername = username;
  const isNew = username === null;
 
  // Reset form
  document.getElementById('d-name').value    = '';
  document.getElementById('d-uname').value   = '';
  document.getElementById('d-pass').value    = '';

  document.getElementById('drawer-msg').style.display = 'none';
 
  // Uncheck all roles and days
  document.querySelectorAll('#role-checkboxes input').forEach(cb => cb.checked = false);
  document.querySelectorAll('#day-checkboxes input').forEach(cb => cb.checked = false);
  document.querySelector('input[name="d-active"][value="true"]').checked = true;
 
  document.getElementById('usr-pay-rate').value = '';

  if (isNew) {
    document.getElementById('drawer-title').textContent = 'Add New User';
    document.getElementById('drawer-sub').textContent   = 'Fill in the details to create an account.';
    document.getElementById('d-uname').disabled         = false;
    document.getElementById('uname-hint').style.display = 'none';
    document.getElementById('d-pass-optional').style.display = 'none';
    // Default: new_hire
    document.querySelector('#role-checkboxes input[value="new_hire"]').checked = true;
    document.getElementById('d-worker-type-wrap').style.display = 'block';
    document.getElementById('wt-1099').checked = true;
    ALL_DAYS.forEach(day => {
      const cb = document.querySelector(`#day-checkboxes input[value="${day}"]`);
      if (cb) cb.checked = true;
    });
  } else {
    // Load existing user data
    const user = _usersCache.find(u => u.username === username);
    if (!user) return;

    document.getElementById('drawer-title').textContent = 'Edit User';
    document.getElementById('drawer-sub').textContent   = '@' + username;
    document.getElementById('d-name').value             = user.name || '';
    document.getElementById('d-uname').value            = username;
    document.getElementById('d-uname').disabled         = true; // username immutable
    document.getElementById('uname-hint').style.display = 'block';
    document.getElementById('d-pass-optional').style.display = 'inline';
    document.getElementById('usr-pay-rate').value       = user.pay_rate || '';
    
    // Hide worker type for existing non-new-hire users
    const rolesStr = String(user.roles||'');
    if (!rolesStr.includes('new_hire')) {
      document.getElementById('d-worker-type-wrap').style.display = 'none';
    } else {
      document.getElementById('d-worker-type-wrap').style.display = 'block';
      const wt = user.worker_type || '1099_contractor';
      const wtRadio = document.querySelector(`input[name="worker-type"][value="${wt}"]`);
      if (wtRadio) wtRadio.checked = true;
    }



    // Set roles
    const roles = Array.isArray(user.roles) ? user.roles : String(user.roles||'').split(',').map(r=>r.trim());
    roles.forEach(role => {
      const cb = document.querySelector(`#role-checkboxes input[value="${role}"]`);
      if (cb) cb.checked = true;
    });

    // Set available days
    if (user.available_days) {
      const days = String(user.available_days).split(',').map(d=>d.trim());
      days.forEach(day => {
        const cb = document.querySelector(`#day-checkboxes input[value="${day}"]`);
        if (cb) cb.checked = true;
      });
    }

    // Set active status
    const active = user.active === true || String(user.active).toUpperCase() === 'TRUE';
    document.querySelector(`input[name="d-active"][value="${active}"]`).checked = true;
  }
 
  document.getElementById('user-backdrop').classList.add('open');
  document.getElementById('user-drawer').classList.add('open');
}
 
function closeUserDrawer() {
  document.getElementById('user-backdrop').classList.remove('open');
  document.getElementById('user-drawer').classList.remove('open');
  _editingUsername = null;
}
 
// ─── Save (create or update) ──────────────────────────────────────────────────
function saveUser() {
  const btn      = document.getElementById('drawer-save-btn');
  const msgEl    = document.getElementById('drawer-msg');
  const isNew    = _editingUsername === null;
 
  const name     = document.getElementById('d-name').value.trim();
  const username = isNew
    ? document.getElementById('d-uname').value.trim().toLowerCase()
    : _editingUsername;
  const password = document.getElementById('d-pass').value.trim();
  const payRate  = document.getElementById('usr-pay-rate').value.trim();
  const workerType = (document.querySelector('input[name="worker-type"]:checked') || {}).value || '1099_contractor';

 
  // Collect roles
  const roles = Array.from(document.querySelectorAll('#role-checkboxes input:checked'))
    .map(cb => cb.value);
 
  // Collect available days
  const days = Array.from(document.querySelectorAll('#day-checkboxes input:checked'))
    .map(cb => cb.value);
 
  // Active status
  const activeVal = document.querySelector('input[name="d-active"]:checked').value;
  const active    = activeVal === 'true';
 
  // Validation
  if (!name) { showDrawerMsg('Full name is required.', false); return; }
  if (isNew && !username) { showDrawerMsg('Username is required.', false); return; }
  if (isNew && !password) { showDrawerMsg('Password is required for new users.', false); return; }
  if (!roles.length) { showDrawerMsg('Select at least one role.', false); return; }
 
  btn.disabled = true;
  btn.textContent = 'Saving...';
 
  if (isNew) {
    api({
      secret  : SEC,
      action  : 'create_user',
      token   : _s.token,
      username,
      password,
      name,
      roles   : roles.join(','),
      available_days : days.join(','),
      pay_rate: payRate,
      worker_type: workerType,
    }).then(res => {
      btn.disabled = false; btn.textContent = 'Save User';
      if (res.ok) {
        showDrawerMsg('User created!', true);
        loadUsers();
        setTimeout(closeUserDrawer, 1200);
      } else {
        showDrawerMsg(res.error || 'Failed to create user.', false);
      }
    }).catch(() => { btn.disabled=false; btn.textContent='Save User'; showDrawerMsg('Network error.',false); });
 
  } else {
    const fields = {
      name,
      roles          : roles.join(','),
      available_days : days.join(','),
      active,
      pay_rate       : payRate,
    };
    if (roles.join(',').includes('new_hire')) {
      fields.worker_type = workerType;
    }
    if (password) fields.password = password;
 
    api({
      secret  : SEC,
      action  : 'update_user',
      token   : _s.token,
      username,
      fields,
    }).then(res => {
      btn.disabled = false; btn.textContent = 'Save User';
      if (res.ok) {
        showDrawerMsg('Saved!', true);
        loadUsers();
        setTimeout(closeUserDrawer, 1200);
      } else {
        showDrawerMsg(res.error || 'Failed to save.', false);
      }
    }).catch(() => { btn.disabled=false; btn.textContent='Save User'; showDrawerMsg('Network error.',false); });
  }
}
 
function showDrawerMsg(text, ok) {
  const el = document.getElementById('drawer-msg');
  el.textContent  = text;
  el.className    = 'im ' + (ok ? 'ok' : 'err');
  el.style.display = 'block';
}
 
// Keep the generic showMsg for other uses
function showMsg(el, text, ok) {
  el.textContent = text;
  el.className   = 'im ' + (ok ? 'ok' : 'err');
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ══════════════════════════════════════════════════════════════════════════════
// INVENTORY
// ══════════════════════════════════════════════════════════════════════════════
let _invLoaded = false;
let _invData   = null;
let _invTab    = 'stock';

function loadInventory() {
  _invLoaded = true;
  document.getElementById('inv-loading').style.display = 'block';
  document.getElementById('inv-root').style.display    = 'none';
  apiGet({ action:'get_inventory', token:_s.token })
    .then(res => {
      document.getElementById('inv-loading').style.display = 'none';
      document.getElementById('inv-root').style.display    = 'block';
      if (!res.ok) {
        document.getElementById('inv-root').innerHTML =
          `<div class="route-empty"><div class="route-empty-icon">⚠️</div><div class="route-empty-text">${res.error||'Failed to load inventory.'}</div></div>`;
        return;
      }
      _invData = res.data;
      renderInventoryPage();
    })
    .catch(e => {
      document.getElementById('inv-loading').style.display = 'none';
      document.getElementById('inv-root').style.display    = 'block';
      document.getElementById('inv-root').innerHTML =
        `<div class="route-empty"><div class="route-empty-icon">⚠️</div><div class="route-empty-text">Network error: ${e.message}</div></div>`;
    });
}

function renderInventoryPage() {
  const root    = document.getElementById('inv-root');
  const mgr     = isAdmin();
  const items   = _invData || [];
  const outCount= items.filter(i=>i.status==='OUT').length;
  const lowCount= items.filter(i=>i.status==='LOW').length;
  const okCount = items.filter(i=>i.status==='OK').length;

  let html = '';

  // Stats row
  html += `<div class="inv-stat-row">
    <div class="inv-stat out-stat"><div class="inv-stat-num">${outCount}</div><div class="inv-stat-lbl">Out</div></div>
    <div class="inv-stat low-stat"><div class="inv-stat-num">${lowCount}</div><div class="inv-stat-lbl">Low</div></div>
    <div class="inv-stat ok-stat"><div class="inv-stat-num">${okCount}</div><div class="inv-stat-lbl">OK</div></div>
  </div>`;

  // Manager/admin action buttons
  if (mgr) {
    html += `<div class="inv-action-row">
      <button class="inv-action-btn" id="inv-btn-refresh" onclick="invRefreshData()">↻ Refresh</button>
      <button class="inv-action-btn" id="inv-btn-apply"   onclick="invApplyPurchases()">✓ Apply Purchases</button>
      <button class="inv-action-btn" id="inv-btn-csv"     onclick="invOpenOrderCsv()">⬇ Order CSV</button>
    </div>`;
  }

  // Tab bar
  html += `<div class="inv-tab-bar">
    <button class="inv-tab${_invTab==='stock'    ?' active':''}" onclick="invTab('stock')">Inventory</button>
    <button class="inv-tab${_invTab==='purchases'?' active':''}" onclick="invTab('purchases')">Purchases</button>
    ${mgr ? `<button class="inv-tab${_invTab==='review'?' active':''}" onclick="invTab('review')">Review</button>` : ''}
  </div>`;

  html += `<div id="inv-tab-content">${renderInvTabContent_()}</div>`;
  root.innerHTML = html;
}

function renderInvTabContent_() {
  if (_invTab === 'stock')     return renderStockTab_();
  if (_invTab === 'purchases') return renderPurchasesTab_();
  if (_invTab === 'review')    return renderReviewTab_();
  return '';
}

function renderStockTab_() {
  const items = _invData || [];
  const mgr   = isAdmin();
  if (!items.length) return `<div class="inv-empty">No inventory data found.</div>`;
  let html = `<div class="adm-card"><div style="overflow-x:auto"><table class="inv-tbl">
    <thead><tr>
      <th>Chemical</th><th>On Hand</th><th>Status</th><th>Reorder At</th><th>Target</th>${mgr ? '<th></th>' : ''}
    </tr></thead><tbody>`;
  items.forEach((item, idx) => {
    const rc  = item.status==='OUT'?'row-out':item.status==='LOW'?'row-low':'';
    const bdg = `<span class="status-badge ${item.status.toLowerCase()}">${item.status}</span>`;
    const qty = fmtQty_(item.qty);
    const ro  = item.reorder_level>0 ? `${fmtQty_(item.reorder_level)} <span style="font-size:.72rem;color:var(--muted)">${item.unit}</span>` : '—';
    const tg  = item.target_level >0 ? `${fmtQty_(item.target_level)}  <span style="font-size:.72rem;color:var(--muted)">${item.unit}</span>` : '—';
    html += `<tr class="${rc}" id="inv-row-${idx}">
      <td style="font-weight:600">${item.name}</td>
      <td id="inv-qty-cell-${idx}">${qty} <span style="font-size:.75rem;color:var(--muted)">${item.unit}</span></td>
      <td id="inv-status-cell-${idx}">${bdg}</td><td>${ro}</td><td>${tg}</td>
      ${mgr ? `<td style="width:28px;padding:.4rem .5rem"><button class="inv-edit-btn" onclick="invEditQty(${idx})" title="Edit quantity">✏</button></td>` : ''}
    </tr>`;
  });
  html += `</tbody></table></div></div>`;
  return html;
}

function renderPurchasesTab_() {
  if (window._invPurchases) return `<div id="inv-purchases-content">${buildPurchaseTable_(window._invPurchases)}</div>`;
  apiGet({ action:'get_purchase_log', token:_s.token })
    .then(res => {
      window._invPurchases = res.ok ? res.data : [];
      const el = document.getElementById('inv-purchases-content');
      if (el) el.innerHTML = buildPurchaseTable_(window._invPurchases);
    })
    .catch(() => {
      const el = document.getElementById('inv-purchases-content');
      if (el) el.innerHTML = `<div class="inv-empty">Failed to load purchase log.</div>`;
    });
  return `<div id="inv-purchases-content"><div class="route-loading"><div class="spinner"></div></div></div>`;
}

function buildPurchaseTable_(rows) {
  if (!rows||!rows.length) return `<div class="inv-empty">No purchases found.</div>`;
  let html = `<div class="adm-card"><div style="overflow-x:auto"><table class="inv-tbl">
    <thead><tr>
      <th>Date</th><th>Invoice</th><th>Chemical</th><th>Qty</th><th>Applied</th>
    </tr></thead><tbody>`;
  rows.forEach(r => {
    const applied = r.applied==='yes'
      ? `<span class="status-badge ok">Applied</span>`
      : r.applied==='superseded'
        ? `<span class="status-badge" style="background:#f1f5f9;color:var(--muted)">Superseded</span>`
        : `<span class="status-badge low">Pending</span>`;
    const name = r.display_name||r.description||r.sku||'—';
    const qty  = r.qty_shipped>0 ? `${r.qty_shipped} ${r.uom}` : '—';
    html += `<tr>
      <td style="white-space:nowrap">${r.invoice_date||'—'}</td>
      <td style="font-family:'Barlow Condensed',sans-serif;font-size:.78rem;color:var(--muted)">${r.invoice_id||'—'}</td>
      <td style="font-weight:600;max-width:180px">${name}</td>
      <td style="white-space:nowrap">${qty}</td>
      <td>${applied}</td>
    </tr>`;
  });
  html += `</tbody></table></div></div>`;
  return html;
}

function renderReviewTab_() {
  if (window._invPending) return `<div id="inv-review-content">${buildPendingCards_(window._invPending)}</div>`;
  apiGet({ action:'get_pending_skus', token:_s.token })
    .then(res => {
      window._invPending = res.ok ? res.data : [];
      const el = document.getElementById('inv-review-content');
      if (el) el.innerHTML = buildPendingCards_(window._invPending);
    })
    .catch(() => {
      const el = document.getElementById('inv-review-content');
      if (el) el.innerHTML = `<div class="inv-empty">Failed to load pending SKUs.</div>`;
    });
  return `<div id="inv-review-content"><div class="route-loading"><div class="spinner"></div></div></div>`;
}

function buildPendingCards_(items) {
  if (!items||!items.length) return `<div class="inv-empty">No SKUs pending review. 🎉</div>`;
  return items.map(item => {
    const cc = item.ai_confidence==='high'?'conf-high':item.ai_confidence==='medium'?'conf-medium':'conf-low';
    return `<div class="pend-card" id="pend-row-${item.rowIndex}">
      <div class="pend-sku">${item.sku}</div>
      <div class="pend-desc">${item.description||'—'}</div>
      <div class="pend-ai">
        ${item.ai_display_name?`<span class="pend-ai-pill">${item.ai_display_name}</span>`:''}
        ${item.ai_category   ?`<span class="pend-ai-pill">${item.ai_category}</span>`:''}
        ${item.ai_confidence ?`<span class="pend-ai-pill ${cc}">${item.ai_confidence} confidence</span>`:''}
        ${item.qty_shipped   ?`<span class="pend-ai-pill">Qty: ${item.qty_shipped} ${item.uom}</span>`:''}
      </div>
      ${item.ai_reason?`<div style="font-size:.78rem;color:var(--muted);margin-bottom:.75rem">${item.ai_reason}</div>`:''}
      <div class="pend-btns">
        <button class="pend-approve" onclick="invApproveSku(${item.rowIndex})">Approve</button>
        <button class="pend-reject"  onclick="invRejectSku(${item.rowIndex})">Reject</button>
      </div>
    </div>`;
  }).join('');
}

function invTab(tab) {
  _invTab = tab;
  document.querySelectorAll('.inv-tab').forEach(t => {
    t.classList.toggle('active', t.textContent.trim().toLowerCase()===tab);
  });
  document.getElementById('inv-tab-content').innerHTML = renderInvTabContent_();
}

function invRefreshData() {
  const btn = document.getElementById('inv-btn-refresh');
  if (btn) { btn.disabled=true; btn.textContent='Refreshing…'; }
  _invLoaded = false; _invData = null;
  window._invPurchases = null; window._invPending = null;
  loadInventory();
}

function invApplyPurchases() {
  const btn = document.getElementById('inv-btn-apply');
  if (btn) { btn.disabled=true; btn.textContent='Applying…'; }
  api({ secret:SEC, action:'manual_apply_purchases', token:_s.token })
    .then(res => {
      if (btn) { btn.disabled=false; btn.textContent='✓ Apply Purchases'; }
      if (res.ok) {
        const r = res.result||{};
        const msg = `Applied: ${r.applied||0}  |  Reversed: ${r.reversed||0}`
          + (r.unmapped&&r.unmapped.length ? `\nUnmapped: ${r.unmapped.join(', ')}` : '');
        alert(msg);
        invRefreshData();
      } else { alert('Error: '+(res.error||'Unknown')); }
    })
    .catch(e => { if (btn) { btn.disabled=false; btn.textContent='✓ Apply Purchases'; } alert('Network error: '+e.message); });
}

function invApproveSku(rowIndex) {
  const card = document.getElementById('pend-row-'+rowIndex);
  if (!card) return;
  const btn = card.querySelector('.pend-approve');
  if (btn) { btn.disabled=true; btn.textContent='Approving…'; }
  api({ secret:SEC, action:'approve_pending_sku', token:_s.token, rowIndex, overrides:{} })
    .then(res => {
      if (res.ok) {
        card.style.opacity='0.4'; card.style.pointerEvents='none';
        card.querySelector('.pend-btns').innerHTML =
          `<span style="font-family:'Barlow Condensed',sans-serif;font-size:.82rem;color:var(--success);font-weight:700">✓ Approved — ${res.displayName||''}</span>`;
        window._invPending = null;
      } else {
        if (btn) { btn.disabled=false; btn.textContent='Approve'; }
        alert('Error: '+(res.error||'Unknown'));
      }
    })
    .catch(e => { if (btn) { btn.disabled=false; btn.textContent='Approve'; } alert('Network error: '+e.message); });
}

function invRejectSku(rowIndex) {
  if (!confirm('Reject this SKU?')) return;
  const card = document.getElementById('pend-row-'+rowIndex);
  api({ secret:SEC, action:'reject_pending_sku', token:_s.token, rowIndex })
    .then(res => {
      if (res.ok && card) {
        card.style.opacity='0.4'; card.style.pointerEvents='none';
        card.querySelector('.pend-btns').innerHTML =
          `<span style="font-family:'Barlow Condensed',sans-serif;font-size:.82rem;color:var(--error);font-weight:700">✕ Rejected</span>`;
        window._invPending = null;
      }
    });
}

function fmtQty_(n) {
  const num = Number(n||0);
  return Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/\.?0+$/,'');
}

// ── Inline qty editing ──────────────────────────────────────────────────────

function invEditQty(idx) {
  const item = (_invData||[])[idx];
  if (!item) return;
  const cell = document.getElementById('inv-qty-cell-'+idx);
  if (!cell) return;
  const cur = Number(item.qty||0);
  const disp = Number.isInteger(cur) ? String(cur) : cur.toFixed(2).replace(/\.?0+$/,'');
  cell.innerHTML = `<span class="inv-qty-wrap">
    <input class="inv-qty-input" id="inv-qty-input-${idx}" type="number" min="0" step="any" value="${disp}">
    <button class="inv-qty-save" onclick="invSaveQty(${idx})">Save</button>
    <button class="inv-qty-cancel" onclick="invCancelEdit(${idx})">✕</button>
  </span>`;
  const inp = document.getElementById('inv-qty-input-'+idx);
  if (inp) { inp.focus(); inp.select(); inp.addEventListener('keydown', e => { if (e.key==='Enter') invSaveQty(idx); if (e.key==='Escape') invCancelEdit(idx); }); }
}

function invCancelEdit(idx) {
  const item = (_invData||[])[idx];
  if (!item) return;
  const cell = document.getElementById('inv-qty-cell-'+idx);
  if (!cell) return;
  cell.innerHTML = `${fmtQty_(item.qty)} <span style="font-size:.75rem;color:var(--muted)">${item.unit}</span>`;
}

function invSaveQty(idx) {
  const item = (_invData||[])[idx];
  if (!item) return;
  const inp = document.getElementById('inv-qty-input-'+idx);
  if (!inp) return;
  const newQty = parseFloat(inp.value);
  if (isNaN(newQty) || newQty < 0) { inp.focus(); return; }
  const saveBtn = inp.closest('.inv-qty-wrap').querySelector('.inv-qty-save');
  if (saveBtn) { saveBtn.disabled=true; saveBtn.textContent='Saving…'; }
  api({ secret:SEC, action:'set_inventory_qty', token:_s.token, chemical:item.name, qty:newQty })
    .then(res => {
      if (res.ok) {
        item.qty = newQty;
        // Recompute status
        if (newQty <= 0) item.status = 'OUT';
        else if (item.reorder_level > 0 && newQty <= item.reorder_level) item.status = 'LOW';
        else item.status = 'OK';
        invCancelEdit(idx);
        // Update row class
        const row = document.getElementById('inv-row-'+idx);
        if (row) row.className = item.status==='OUT'?'row-out':item.status==='LOW'?'row-low':'';
        // Update status badge
        const sc = document.getElementById('inv-status-cell-'+idx);
        if (sc) sc.innerHTML = `<span class="status-badge ${item.status.toLowerCase()}">${item.status}</span>`;
        // Update summary counters
        const items = _invData||[];
        const outN = items.filter(i=>i.status==='OUT').length;
        const lowN = items.filter(i=>i.status==='LOW').length;
        const okN  = items.filter(i=>i.status==='OK').length;
        const el = s => document.querySelector(s);
        if (el('.out-stat .inv-stat-num')) el('.out-stat .inv-stat-num').textContent = outN;
        if (el('.low-stat .inv-stat-num')) el('.low-stat .inv-stat-num').textContent = lowN;
        if (el('.ok-stat  .inv-stat-num')) el('.ok-stat  .inv-stat-num').textContent = okN;
      } else {
        if (saveBtn) { saveBtn.disabled=false; saveBtn.textContent='Save'; }
        alert('Error: '+(res.error||'Unknown'));
      }
    })
    .catch(e => {
      if (saveBtn) { saveBtn.disabled=false; saveBtn.textContent='Save'; }
      alert('Network error: '+e.message);
    });
}

// ── Order CSV export ────────────────────────────────────────────────────────

function invOpenOrderCsv() {
  const backdrop = document.getElementById('csv-modal-backdrop');
  if (!backdrop) return;
  document.getElementById('csv-modal-body').innerHTML = '<div class="route-loading"><div class="spinner"></div></div>';
  backdrop.classList.add('open');
  document.body.style.overflow = 'hidden';
  invBuildCsvModal_();
}

function invCloseCsvModal(e) {
  if (e && e.target !== document.getElementById('csv-modal-backdrop')) return;
  const backdrop = document.getElementById('csv-modal-backdrop');
  if (backdrop) backdrop.classList.remove('open');
  document.body.style.overflow = '';
}

function invBuildCsvModal_() {
  const body = document.getElementById('csv-modal-body');
  if (!body) return;

  const buildTable = () => {
    const items    = _invData || [];
    const purchases = window._invPurchases || [];

    // Build latest-purchase map keyed by display_name
    const latestPurch = {};
    for (const p of purchases) {
      const key = (p.display_name || p.description || p.sku || '').trim();
      if (!key) continue;
      latestPurch[key] = { sku: p.sku||'', description: p.description||'', uom: p.uom||'' };
    }

    const orderItems = items.filter(i => i.status==='OUT' || i.status==='LOW');
    if (!orderItems.length) {
      body.innerHTML = `<div class="inv-empty" style="padding:2rem 0">No items need ordering right now. 🎉</div>`;
      return;
    }

    let html = `<p style="font-size:.82rem;color:var(--muted);margin-bottom:.85rem">Adjust order quantities as needed, then download. Items without a SKU are excluded from the CSV.</p>`;
    html += `<table class="csv-tbl"><thead><tr>
      <th>Chemical</th><th>SKU</th><th>Status</th><th>Stock</th><th>Target</th><th style="text-align:right">Order Qty</th><th>UOM</th>
    </tr></thead><tbody>`;

    orderItems.forEach(item => {
      const purch   = latestPurch[item.name] || {};
      const gap     = Math.max(0, (item.target_level||0) - (item.qty||0));
      const defQty  = Math.ceil(gap) || 1;
      const sku     = purch.sku || '';
      const uom     = purch.uom || item.unit || '';
      const desc    = purch.description || '';
      const badge   = `<span class="status-badge ${item.status.toLowerCase()}">${item.status}</span>`;
      const skuCell = sku
        ? `<span style="font-family:'Barlow Condensed',sans-serif;font-size:.78rem;">${sku}</span>`
        : `<span class="csv-no-sku">—</span>`;
      // escape for data attrs
      const safeDesc = desc.replace(/"/g, '&quot;');
      const safeSku  = sku.replace(/"/g, '&quot;');
      const safeUom  = uom.replace(/"/g, '&quot;');
      html += `<tr>
        <td style="font-weight:600">${item.name}</td>
        <td>${skuCell}</td>
        <td>${badge}</td>
        <td>${fmtQty_(item.qty)} <span style="font-size:.72rem;color:var(--muted)">${item.unit}</span></td>
        <td>${fmtQty_(item.target_level)} <span style="font-size:.72rem;color:var(--muted)">${item.unit}</span></td>
        <td style="text-align:right"><input class="csv-order-qty" type="number" min="0" step="any" value="${defQty}"
          data-sku="${safeSku}" data-uom="${safeUom}" data-desc="${safeDesc}"></td>
        <td style="font-size:.78rem;color:var(--muted)">${uom}</td>
      </tr>`;
    });

    html += `</tbody></table>`;
    body.innerHTML = html;
  };

  if (window._invPurchases) {
    buildTable();
  } else {
    apiGet({ action:'get_purchase_log', token:_s.token })
      .then(res => { window._invPurchases = res.ok ? res.data : []; buildTable(); })
      .catch(() => { window._invPurchases = []; buildTable(); });
  }
}

function invDownloadOrderCsv() {
  const inputs = document.querySelectorAll('#csv-modal-body .csv-order-qty');
  const rows = ['ITEM #,Qty,Product Name,MFG #,Price,UOM,ExtendedPrice'];
  let hasRows = false;

  inputs.forEach(inp => {
    const qty = parseFloat(inp.value);
    if (!qty || qty <= 0) return;
    const sku  = inp.dataset.sku  || '';
    const uom  = inp.dataset.uom  || '';
    let   desc = inp.dataset.desc || '';
    if (!sku) return; // skip items without a SKU
    if (desc.includes(',') || desc.includes('"') || desc.includes('\n')) {
      desc = `"${desc.replace(/"/g, '""')}"`;
    }
    rows.push(`${sku},${qty},${desc},,,,${uom},`);
    hasRows = true;
  });

  if (!hasRows) {
    alert('No items with SKUs and qty > 0. Items need purchase history to have a SKU.');
    return;
  }

  const csv  = rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const d    = new Date();
  const pad  = n => String(n).padStart(2, '0');
  a.href     = url;
  a.download = `Heritage_Order_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

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
  first_name:'', last_name:'', email:'', phone:'', address:'', zip_code:'', city:'',
  _calc:null, saved_id:null, saving:false
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
  ['q-fname','q-lname','q-email','q-phone','q-address','q-zip','q-city',
   'q-startup-co','q-startup-date','q-rep-co','q-rep-sku','q-rep-addr','q-rep-desc','q-rep-amt'
  ].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('q-disc-type').value = 'none';
  document.getElementById('q-disc-val-wrap').style.display = 'none';
  document.getElementById('q-disc-val').value = '';
  const msg = document.getElementById('q-save-msg'); msg.className='q-msg'; msg.textContent='';
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
    address:_qS.address, city:_qS.city, zip_code:_qS.zip_code,
    service:eng.service_label, pool_type:eng.pool_type, size:eng.size, material:eng.material,
    spa:eng.spa, finish:eng.finish, debris:eng.debris,
    has_robot:_qS.has_robot, high_sun_exposure:_qS.high_sun_exposure, has_pets:_qS.has_pets,
    startup_chemical_work:_qS.startup_chemical, startup_programming:_qS.startup_programming,
    startup_pool_school:_qS.startup_pool_school, startup_company:_qS.startup_company,
    sponsored_by_mcp:_qS.sponsored_by_mcp, startup_start_date:_qS.startup_start_date,
    startup_total_days:_qS.sponsored_by_mcp ? 3 : 0,
    repair_job_type:_qS.repair_type, repair_company_name:_qS.repair_company,
    repair_company_address:_qS.repair_address, repair_job_description:_qS.repair_desc,
    repair_invoice_amount:_qS.repair_amount, repair_sku:_qS.repair_sku,
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


// ══════════════════════════════════════════════════════════════════════════════
// TRAINING MODULE (LMS)
// ══════════════════════════════════════════════════════════════════════════════
let _trLoaded = false;
let _trModules = [];
let _trProgress = {};
let _trOpenModules = new Set();
let _trOpenSubmodules = new Set();
let _activeContentType = 'video';
let _quizQuestions = [];
let _quizCurrentStep = 0;        // which question the technician is on
let _quizShuffledData = null;    // shuffled copy of questions for the current attempt
const TR_SUBMODULE_URL_MARKER = 'submodule://container';

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Returns a stable string key for a question based on its content.
// Includes type and normalized correct answer(s) so questions with the same
// text/options but different answers or types don't collide.
function questionKey_(q) {
  const text = String(q.question || '').trim().toLowerCase();
  const opts = (q.options || []).map(o => String(o || '').trim().toLowerCase()).sort().join('|');
  const type = String(q.type || 'single');
  const correct = Array.isArray(q.correct)
    ? q.correct.slice().sort().join(',')
    : String(q.correct ?? '');
  return text + '\x00' + opts + '\x00' + type + '\x00' + correct;
}

// Build a shuffled copy of quiz questions (shuffles question order and each
// question's options while keeping the correct-answer mapping intact).
function buildShuffledQuiz(questions) {
  // Tag each question with a stable content-based key before shuffling.
  // This key is used for wrong-answer tracking and survives question reordering.
  const indexed = questions.map(q => ({ ...q, _qkey: q._qkey || questionKey_(q) }));
  const shuffledQs = shuffleArray(indexed).map(q => {
    const indices = q.options.map((_, i) => i);
    const newOrder = shuffleArray(indices);
    const newOptions = newOrder.map(i => q.options[i]);
    const newCorrect = Array.isArray(q.correct)
      ? q.correct.map(c => newOrder.indexOf(c))
      : newOrder.indexOf(q.correct);
    return { ...q, options: newOptions, correct: newCorrect, _originalOrder: newOrder };
  });
  return shuffledQs;
}
const TR_PARENT_META_RE = /\n?\[\[parent:([a-zA-Z0-9_-]+)\]\]\s*$/;

function trExtractParentMeta_(item) {
  const explicitParent = String(item && item.parent_content_id || '').trim();
  const rawDesc = String(item && item.description || '');
  const metaMatch = rawDesc.match(TR_PARENT_META_RE);
  const metaParent = metaMatch ? String(metaMatch[1] || '').trim() : '';
  return {
    parent_content_id: explicitParent || metaParent,
    description: rawDesc.replace(TR_PARENT_META_RE, '').trim()
  };
}

function trComposeDescriptionWithParent_(description, parentContentId) {
  const clean = String(description || '').replace(TR_PARENT_META_RE, '').trim();
  const parent = String(parentContentId || '').trim();
  if (!parent) return clean;
  return clean ? `${clean}\n[[parent:${parent}]]` : `[[parent:${parent}]]`;
}

function trNormalizeItem_(item) {
  const rawType = String(item && item.content_type || '').toLowerCase();
  const rawUrl = String((item && (item.content_url || item.drive_url || item.url)) || '');
  const isMarkedSubmodule = rawType === 'document' && rawUrl.startsWith(TR_SUBMODULE_URL_MARKER);
  const parentMeta = trExtractParentMeta_(item);
  const normalized = {
    ...item,
    parent_content_id: parentMeta.parent_content_id,
    description: parentMeta.description
  };
  if (isMarkedSubmodule) return { ...normalized, content_type: 'submodule', content_url: '' };
  // If quiz_data flags this as a final quiz, expose it with its own content_type
  if (normalized.content_type === 'quiz' && normalized.quiz_data && normalized.quiz_data.is_final_quiz) {
    return { ...normalized, content_type: 'final_quiz' };
  }
  return normalized;
}

function trNormalizeModules_(modules) {
  return (modules || []).map(mod => ({
    ...mod,
    items: (mod.items || []).map(trNormalizeItem_)
  }));
}

function loadTraining() {
  if (_trLoaded) { renderTraining(); return; }
  document.getElementById('tr-loading').style.display = 'block';
  document.getElementById('tr-root').innerHTML = '';
  Promise.all([
    apiGet({action:'get_modules', token:_s.token}),
    apiGet({action:'get_training_progress', token:_s.token}).catch(() => ({ok:false}))
  ])
    .then(([res, progRes]) => {
      document.getElementById('tr-loading').style.display = 'none';
      if (res.ok) {
        _trModules = trNormalizeModules_(res.modules || []);
        _trProgress = (progRes && progRes.ok && progRes.progress) ? progRes.progress : {};
        _trLoaded = true;
        renderTraining();
      } else {
        document.getElementById('tr-root').innerHTML = `<div class="tr-empty"><div class="tr-empty-icon">⚠️</div><div class="tr-empty-text">${res.error||'Failed to load modules'}</div></div>`;
      }
    })
    .catch(e => {
      document.getElementById('tr-loading').style.display = 'none';
      document.getElementById('tr-root').innerHTML = `<div class="tr-empty"><div class="tr-empty-icon">⚠️</div><div class="tr-empty-text">Network error: ${e.message}</div></div>`;
    });
}

function isModuleFullyCompleted(modId) {
  const mod = _trModules.find(m => m.id === modId);
  if (!mod || !mod.items || mod.items.length === 0) return true;
  return mod.items.every(item => isItemCompleted(modId, item.id));
}

function renderTraining() {
  const isAdm = isAdmin();
  const addBtn = document.getElementById('tr-add-mod-btn');
  if (addBtn) addBtn.style.display = isAdm ? 'inline-block' : 'none';

  const root = document.getElementById('tr-root');
  if (!_trModules.length) {
    root.innerHTML = `<div class="tr-empty"><div class="tr-empty-icon">🎓</div><div class="tr-empty-text">No modules yet</div><div class="tr-empty-sub">${isAdm ? 'Click "+ Module" to create the first one.' : 'Check back soon!'}</div></div>`;
    return;
  }

  let html = '';
  let prevModuleComplete = true; // used for gating

  _trModules.forEach((mod, idx) => {
    const items = mod.items || mod.videos || [];
    const completedCount = items.filter(v => isItemCompleted(mod.id, v.id)).length;
    const progressPct = items.length ? Math.round((completedCount / items.length) * 100) : 0;
    const isOpen = _trOpenModules.has(mod.id);

    // Module Gating
    let locked = false;
    if (mod.require_prev_module && !isAdm && !prevModuleComplete) {
      locked = true;
    }

    const adminActions = isAdm ? `
      <div class="tr-mod-actions">
        <button class="mod-act-btn" onclick="event.stopPropagation();openModuleDrawer('${mod.id}')">✏️ Edit</button>
        <button class="mod-act-btn danger" onclick="event.stopPropagation();deleteModule('${mod.id}')">🗑</button>
      </div>` : '';

    const childrenByParent = {};
    items.forEach(v => {
      const pid = v.parent_content_id || '';
      if (!childrenByParent[pid]) childrenByParent[pid] = [];
      childrenByParent[pid].push(v);
    });

    let prevItemComplete = true; // used for item gating
    const renderItemRow = (v, depth = 0) => {
      const completed = isItemCompleted(mod.id, v.id);
      const isSubmodule = v.content_type === 'submodule';
      let itemLocked = false;
      if (v.pass_required && !isAdm && !prevItemComplete) {
        itemLocked = true;
      }
      if (v.pass_required) prevItemComplete = completed; // for next item in loop

      const adminVBtns = isAdm ? `
        <div class="tr-item-admin">
          <button class="v-act-btn" onclick="event.stopPropagation();openVideoDrawer('${mod.id}','${v.id}')">✏️</button>
          <button class="v-act-btn danger" onclick="event.stopPropagation();deleteVideo('${mod.id}','${v.id}')">🗑</button>
        </div>` : '';

      let icon = '▶';
      if (v.content_type === 'quiz') icon = '📝';
      if (v.content_type === 'final_quiz') icon = '🏁';
      if (v.content_type === 'document') icon = '📄';
      if (isSubmodule) icon = _trOpenSubmodules.has(v.id) ? '▼' : '▶';

      if (locked || itemLocked) {
        return `
          <div class="tr-item-row locked">
            <span class="tr-item-icon">🔒</span>
            <div class="tr-item-info">
              <div class="tr-item-title">${escHtml(v.title)}</div>
              <div class="tr-item-desc">Finish previous required items to unlock.</div>
            </div>
          </div>`;
      }

      const children = childrenByParent[v.id] || [];
      const nestedRows = children.map(child => renderItemRow(child, depth + 1)).join('');
      const nestedWrap = children.length && _trOpenSubmodules.has(v.id)
        ? `<div class="tr-sub-items">${nestedRows}</div>`
        : '';
      const clickAction = isSubmodule
        ? `toggleSubmodule('${v.id}')`
        : `openItemDetail('${mod.id}','${v.id}')`;

      return `
        <div class="tr-item-row${completed ? ' done' : ''}${isSubmodule ? ' submodule-row' : ''}" onclick="${clickAction}" style="${depth ? `padding-left:${(depth*1.2)+1}rem` : ''}">
          <span class="tr-item-icon">${icon}</span>
          <div class="tr-item-info">
            <div class="tr-item-title">${escHtml(v.title)}</div>
            ${v.description ? `<div class="tr-item-desc">${escHtml(v.description)}</div>` : ''}
          </div>
          ${completed ? `<span class="tr-item-badge">✓ Done</span>` : ''}
          ${adminVBtns}
        </div>
        ${nestedWrap}`;
    };
    const itemRows = (childrenByParent[''] || []).map(v => renderItemRow(v)).join('');

    const addVideoBtn = isAdm ? `
      <div class="tr-add-video-row">
        <div class="tr-add-menu-wrap">
          <button class="tr-add-video-btn" onclick="toggleAddContentMenu('${mod.id}', event)">+ Add Content</button>
          <div class="tr-add-menu" id="tr-add-menu-${mod.id}" style="display:none">
            <button onclick="openVideoDrawerWithType('${mod.id}','video')">🎬 Video</button>
            <button onclick="openVideoDrawerWithType('${mod.id}','document')">📄 Document</button>
            <button onclick="openVideoDrawerWithType('${mod.id}','quiz')">📝 Quiz</button>
            <button onclick="openVideoDrawerWithType('${mod.id}','final_quiz')">🏁 Final Quiz</button>
            <button onclick="openVideoDrawerWithType('${mod.id}','submodule')">📂 Submodule</button>
          </div>
        </div>
      </div>` : '';

    const bodyContent = items.length ? itemRows : '';
    const footerContent = isAdm ? `<div class="tr-mod-footer">${addVideoBtn}</div>` : '';

    if (locked) {
      html += `
        <div class="tr-module-row locked" id="tr-mod-${mod.id}">
          <div class="tr-mod-hdr">
            <span class="tr-mod-arrow">🔒</span>
            <span class="tr-mod-num">${String(idx+1).padStart(2,'0')}</span>
            <div class="tr-mod-info">
              <div class="tr-mod-title">${escHtml(mod.title)}</div>
              <div class="tr-mod-meta">Complete previous module to unlock</div>
            </div>
            ${adminActions}
          </div>
        </div>`;
    } else {
      html += `
        <div class="tr-module-row${isOpen ? ' open' : ''}" id="tr-mod-${mod.id}">
          <div class="tr-mod-hdr" onclick="toggleModule('${mod.id}')">
            <span class="tr-mod-arrow">▶</span>
            <span class="tr-mod-num">${String(idx+1).padStart(2,'0')}</span>
            <div class="tr-mod-info">
              <div class="tr-mod-title">${escHtml(mod.title)}</div>
              <div class="tr-mod-meta">
                <span class="tr-mod-count">${items.length} item${items.length!==1?'s':''}</span>
                ${items.length ? `<span class="tr-mod-progress">${completedCount}/${items.length} complete (${progressPct}%)</span>` : ''}
              </div>
            </div>
            ${adminActions}
          </div>
          ${bodyContent ? `<div class="tr-mod-body">${bodyContent}</div>` : ''}
          ${footerContent}
        </div>`;
    }

    prevModuleComplete = isModuleFullyCompleted(mod.id);
  });

  root.innerHTML = html;
}

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toggleModule(moduleId) {
  if (_trOpenModules.has(moduleId)) _trOpenModules.delete(moduleId);
  else _trOpenModules.add(moduleId);
  const row = document.getElementById('tr-mod-' + moduleId);
  if (row) row.classList.toggle('open', _trOpenModules.has(moduleId));
}

function toggleSubmodule(contentId) {
  if (_trOpenSubmodules.has(contentId)) _trOpenSubmodules.delete(contentId);
  else _trOpenSubmodules.add(contentId);
  renderTraining();
}

function toggleAddContentMenu(moduleId, ev) {
  ev.stopPropagation();
  document.querySelectorAll('.tr-add-menu').forEach(el => {
    if (el.id !== `tr-add-menu-${moduleId}`) el.style.display = 'none';
  });
  const menu = document.getElementById(`tr-add-menu-${moduleId}`);
  if (!menu) return;
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function openVideoDrawerWithType(moduleId, type) {
  document.querySelectorAll('.tr-add-menu').forEach(el => { el.style.display = 'none'; });
  openVideoDrawer(moduleId, null);
  selectContentType(type);
}

document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.tr-add-menu-wrap')) {
    document.querySelectorAll('.tr-add-menu').forEach(el => { el.style.display = 'none'; });
  }
});

// ── Final Quiz generation helpers ────────────────────────────────────────────

// Returns array of question objects for the given final quiz item, personalized
// for the current user. Returns null if the user hasn't attempted any source quiz yet.
function buildFinalQuizQuestions(finalQuizItem) {
  const qd = finalQuizItem.quiz_data || {};
  const sourceIds = qd.source_quiz_ids || [];
  const targetCount = qd.question_count || 20;

  const allSourceQuestions = [];
  const wrongQuestions = [];
  let hasAnyAttempt = false;

  for (const mod of (_trModules || [])) {
    for (const it of (mod.items || [])) {
      if (!sourceIds.includes(it.id)) continue;
      if (!it.quiz_data || !it.quiz_data.questions) continue;
      const progressKey = `${mod.id}::${it.id}`;
      const prog = _trProgress[progressKey] || {};
      if ((prog.quiz_attempts || 0) > 0) hasAnyAttempt = true;
      // wrong_question_ids are stable content-based string keys; filter out any
      // legacy numeric values from before the stable-key migration.
      const wrongKeys = new Set((prog.wrong_question_ids || []).filter(k => typeof k === 'string'));
      it.quiz_data.questions.forEach(q => {
        const key = questionKey_(q);
        const tagged = { ...q, _qkey: key, _sourceQuizId: it.id };
        allSourceQuestions.push(tagged);
        if (wrongKeys.has(key)) wrongQuestions.push(tagged);
      });
    }
  }

  if (!hasAnyAttempt) return null; // block access

  // Deduplicate by stable content key (handles the same question appearing in multiple source quizzes)
  const uniqueWrong = deduplicateByKey_(wrongQuestions);
  const wrongKeySet = new Set(uniqueWrong.map(q => q._qkey));
  const remainingPool = shuffleArray(allSourceQuestions.filter(q => !wrongKeySet.has(q._qkey)));
  const fillCount = Math.max(0, targetCount - uniqueWrong.length);
  const fillQuestions = remainingPool.slice(0, fillCount);
  const combined = uniqueWrong.length > targetCount
    ? shuffleArray(uniqueWrong).slice(0, targetCount)
    : [...uniqueWrong, ...fillQuestions];
  return combined.slice(0, targetCount);
}

function deduplicateByKey_(questions) {
  const seen = new Set();
  return questions.filter(q => {
    const k = q._qkey || questionKey_(q);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── Item Detail View (Video/Document/Quiz) ───────────────────────────────────
let _currentQuizAnswers = {};

function openItemDetail(moduleId, itemId) {
  const mod = _trModules.find(m => m.id === moduleId);
  if (!mod) return;
  const item = (mod.items || []).find(v => v.id === itemId);
  if (!item) return;
  const navigableItems = (mod.items || []).filter(v => v.content_type !== 'submodule');
  const currentIndex = navigableItems.findIndex(v => v.id === itemId);
  const prevItem = currentIndex > 0 ? navigableItems[currentIndex - 1] : null;
  const nextItem = currentIndex >= 0 && currentIndex < navigableItems.length - 1 ? navigableItems[currentIndex + 1] : null;

  if (item.content_type !== 'quiz' && item.content_type !== 'final_quiz') {
    markItemInProgress(moduleId, itemId);
  }

  const completed = isItemCompleted(moduleId, itemId);
  let completeAction = '';
  if (item.content_type !== 'quiz' && item.content_type !== 'final_quiz') {
    completeAction = completed
      ? `<span class="tr-complete-tag">✓ Completed</span>`
      : `<button class="tr-complete-btn" id="tr-detail-complete-btn" onclick="markItemCompleteDetail('${moduleId}','${itemId}')">✓ Mark Complete</button>`;
  }

  const isAdm = isAdmin();
  const adminActions = isAdm ? `
    <button class="mod-act-btn" onclick="openVideoDrawer('${moduleId}','${itemId}')">✏️ Edit</button>
    <button class="mod-act-btn danger" onclick="deleteVideo('${moduleId}','${itemId}')">🗑 Delete</button>` : '';

  let viewerHtml = '';

  if (item.content_type === 'video' || item.content_type === 'document' || !item.content_type) {
    const driveId = extractDriveId(item.content_url || item.drive_url || item.url || '');
    const embedSrc = driveId ? `https://drive.google.com/file/d/${driveId}/preview` : (item.content_url || item.drive_url || item.url || '');
    viewerHtml = `<div class="tr-detail-frame-wrap"><iframe src="${embedSrc}" allow="autoplay" allowfullscreen></iframe></div>`;
  } else if (item.content_type === 'quiz' || item.content_type === 'final_quiz') {
    _currentQuizAnswers = {}; // reset
    _quizCurrentStep = 0;

    let quizQuestions = null;

    if (item.content_type === 'final_quiz') {
      const generated = buildFinalQuizQuestions(item);
      if (generated === null) {
        // User hasn't attempted any source quiz yet — list which ones are needed
        const sourceIds = (item.quiz_data && item.quiz_data.source_quiz_ids) || [];
        const notAttempted = [];
        for (const mod of (_trModules || [])) {
          for (const it of (mod.items || [])) {
            if (!sourceIds.includes(it.id)) continue;
            const prog = _trProgress[`${mod.id}::${it.id}`] || {};
            if ((prog.quiz_attempts || 0) === 0) notAttempted.push(it.title);
          }
        }
        const listHtml = notAttempted.map(t => `<li>${escHtml(t)}</li>`).join('');
        viewerHtml = `<div class="tr-empty fq-blocked">
          <div style="font-size:1.5rem;margin-bottom:.5rem">🏁</div>
          <strong>Complete the required quizzes first before taking this Final Quiz.</strong>
          ${notAttempted.length ? `<ul style="margin-top:.75rem;text-align:left">${listHtml}</ul>` : ''}
        </div>`;
      } else if (!generated.length) {
        viewerHtml = `<div class="tr-empty">No questions available in the selected source quizzes.</div>`;
      } else {
        quizQuestions = generated;
      }
    } else {
      const quizData = typeof item.quiz_data === 'string' ? null : item.quiz_data; // JSON parsed in get_modules
      if (quizData && quizData.questions && quizData.questions.length) {
        quizQuestions = quizData.questions;
      }
    }

    if (quizQuestions) {
      _quizShuffledData = buildShuffledQuiz(quizQuestions);

      let progressHtml = '';
      const key = `${moduleId}::${itemId}`;
      const prog = _trProgress[key];
      if (prog && prog.quiz_attempts > 0) {
        progressHtml = `<div class="mod-drawer-msg ${prog.status==='completed' ? 'ok' : 'warn'}" style="margin-bottom:1rem">
          Previous Score: ${prog.quiz_score}% (Attempts: ${prog.quiz_attempts})
          ${prog.status==='completed' ? ' — Passed!' : ''}
        </div>`;
      }

      viewerHtml = `
        <div class="qz-viewer" id="qz-viewer-wrap">
          ${progressHtml}
          <div id="qz-step-content"></div>
          <div id="quiz-result-msg" style="margin-top:10px;font-weight:bold;"></div>
        </div>`;

      window._qzPendingRender = { moduleId, itemId };
    } else if (!viewerHtml) {
      viewerHtml = `<div class="tr-empty">No questions found in this quiz.</div>`;
    }
  }

  document.getElementById('tr-mod-list').style.display = 'none';
  const detail = document.getElementById('tr-detail');
  detail.style.display = 'block';
  detail.innerHTML = `
    <button class="tr-detail-back" onclick="closeVideoDetail()">← Back to Modules</button>
    <div class="tr-detail-breadcrumb">${escHtml(mod.title)}</div>
    <div class="tr-detail-title">${escHtml(item.title)}</div>
    ${item.content_type === 'final_quiz' ? `<div class="tr-detail-desc fq-subtitle">🏁 Final Quiz — personalized for you based on your previous answers.</div>` : ''}
    ${item.description ? `<div class="tr-detail-desc">${escHtml(item.description)}</div>` : ''}
    ${viewerHtml}
    <div class="tr-detail-nav">
      <button class="tr-detail-nav-btn" ${prevItem ? `onclick="openItemDetail('${moduleId}','${prevItem.id}')"` : 'disabled'}>← Previous</button>
      <button class="tr-detail-nav-btn" ${nextItem ? `onclick="openItemDetail('${moduleId}','${nextItem.id}')"` : 'disabled'}>Next →</button>
    </div>
    <div class="tr-detail-actions">${completeAction}${adminActions}</div>`;

  // If we have a pending quiz step render, execute it now that the DOM is ready
  if (window._qzPendingRender) {
    const { moduleId: mid, itemId: iid } = window._qzPendingRender;
    window._qzPendingRender = null;
    renderQuizStep(mid, iid);
  }
}

function setQuizAnswer(qIdx, optIdx, isMulti) {
  const key = 'q' + qIdx;
  if (isMulti) {
    if (!Array.isArray(_currentQuizAnswers[key])) _currentQuizAnswers[key] = [];
    const arr = _currentQuizAnswers[key];
    const pos = arr.indexOf(optIdx);
    if (pos === -1) arr.push(optIdx); else arr.splice(pos, 1);
    if (arr.length === 0) delete _currentQuizAnswers[key];
  } else {
    _currentQuizAnswers[key] = optIdx;
  }
  // Refresh option highlight states without re-rendering the whole step
  const stepEl = document.getElementById('qz-step-content');
  if (stepEl) {
    stepEl.querySelectorAll('.qz-option-label').forEach(lbl => {
      const inp = lbl.querySelector('input');
      if (!inp) return;
      const selected = Array.isArray(_currentQuizAnswers[key])
        ? _currentQuizAnswers[key].includes(parseInt(inp.value))
        : _currentQuizAnswers[key] === parseInt(inp.value);
      lbl.classList.toggle('qz-selected', selected);
    });
  }
}

// Render the current step of the step-by-step quiz.
function renderQuizStep(moduleId, itemId) {
  const questions = _quizShuffledData;
  if (!questions) return;
  const total = questions.length;
  const step = _quizCurrentStep;
  const q = questions[step];
  const isMulti = q.type === 'multi';
  const pct = Math.round(((step) / total) * 100);

  const answerKey = 'q' + step;
  const currentAns = _currentQuizAnswers[answerKey];

  const optionsHtml = q.options.map((opt, oIdx) => {
    const isSelected = isMulti
      ? (Array.isArray(currentAns) && currentAns.includes(oIdx))
      : (currentAns === oIdx);
    const inputType = isMulti ? 'checkbox' : 'radio';
    return `<label class="qz-option-label${isSelected ? ' qz-selected' : ''}">
      <input type="${inputType}" name="qz_${step}" value="${oIdx}"
        ${isSelected ? 'checked' : ''}
        onchange="setQuizAnswer(${step}, ${oIdx}, ${isMulti})">
      <span>${escHtml(opt)}</span>
    </label>`;
  }).join('');

  const isLast = step === total - 1;
  const navHtml = `
    <div class="qz-step-nav">
      <button class="qz-nav-btn" onclick="quizStepBack('${moduleId}','${itemId}')" ${step === 0 ? 'disabled' : ''}>← Back</button>
      <span style="font-size:13px;color:#5f6368">${step + 1} / ${total}</span>
      ${isLast
        ? `<button class="qz-nav-btn primary" onclick="submitQuizTaking('${moduleId}','${itemId}')">Submit Quiz</button>`
        : `<button class="qz-nav-btn primary" onclick="quizStepNext('${moduleId}','${itemId}')">Next →</button>`}
    </div>`;

  const typeBadge = isMulti ? `<span class="qz-type-badge">Select all that apply</span>` : '';
  const imageSrc = getQuizImageSrc(q.image_url || '');
  const imageHtml = imageSrc ? `<div class="qz-question-image-wrap"><img class="qz-question-image" src="${escHtml(imageSrc)}" alt="Quiz question image"></div>` : '';

  document.getElementById('qz-step-content').innerHTML = `
    <div class="qz-progress-bar-wrap">
      <div class="qz-progress-label">
        <span>Question ${step + 1} of ${total}</span>
        <span>${pct}% complete</span>
      </div>
      <div class="qz-progress-track"><div class="qz-progress-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="qz-step-card">
      <div class="qz-question">
        <div class="qz-qtext">${escHtml(q.question)}${typeBadge}</div>
        ${imageHtml}
        <div class="qz-options">${optionsHtml}</div>
      </div>
    </div>
    ${navHtml}`;
}

function quizStepNext(moduleId, itemId) {
  const questions = _quizShuffledData;
  if (!questions) return;
  const ansKey = 'q' + _quizCurrentStep;
  const ans = _currentQuizAnswers[ansKey];
  const hasAnswer = ans !== undefined && !(Array.isArray(ans) && ans.length === 0);
  if (!hasAnswer) {
    document.getElementById('quiz-result-msg').innerHTML =
      '<span style="color:red">Please select an answer before continuing.</span>';
    return;
  }
  document.getElementById('quiz-result-msg').innerHTML = '';
  _quizCurrentStep++;
  renderQuizStep(moduleId, itemId);
}

function quizStepBack(moduleId, itemId) {
  if (_quizCurrentStep === 0) return;
  document.getElementById('quiz-result-msg').innerHTML = '';
  _quizCurrentStep--;
  renderQuizStep(moduleId, itemId);
}

// Grade answer for one question. Returns true if correct.
function gradeAnswer(q, answer) {
  const correct = q.correct;
  if (q.type === 'multi') {
    const correctSet = Array.isArray(correct) ? correct.slice().sort() : [correct];
    const givenSet = Array.isArray(answer) ? answer.slice().sort() : [];
    return correctSet.length === givenSet.length && correctSet.every((v, i) => v === givenSet[i]);
  }
  return parseInt(answer) === correct;
}

function submitQuizTaking(moduleId, itemId) {
  const mod = _trModules.find(m => m.id === moduleId);
  if (!mod) return;
  const item = (mod.items || []).find(v => v.id === itemId);
  if (!item || !item.quiz_data || !item.quiz_data.questions) return;

  const questions = _quizShuffledData || item.quiz_data.questions;

  // Validate last question is answered
  const lastKey = 'q' + (questions.length - 1);
  const lastAns = _currentQuizAnswers[lastKey];
  const lastAnswered = lastAns !== undefined && !(Array.isArray(lastAns) && lastAns.length === 0);
  if (!lastAnswered) {
    document.getElementById('quiz-result-msg').innerHTML =
      '<span style="color:red">Please select an answer before submitting.</span>';
    return;
  }

  // Client-side grading (correct answers are already in the loaded quiz data)
  let numCorrect = 0;
  const reviewItems = questions.map((q, qIdx) => {
    const answer = _currentQuizAnswers['q' + qIdx];
    const correct = gradeAnswer(q, answer);
    if (correct) numCorrect++;
    return { q, answer, correct };
  });
  const total = questions.length;
  const score = Math.round((numCorrect / total) * 100);
  const passThreshold = item.pass_threshold || 80;
  const passed = score >= passThreshold;

  // Collect stable content-based keys for wrong answers so Final Quiz tracking
  // survives admin edits or question reordering in the source quiz.
  const wrongSourceIndices = reviewItems
    .filter(ri => !ri.correct)
    .map(ri => ri.q._qkey || questionKey_(ri.q))
    .filter(Boolean);

  // Update local progress
  const key = `${moduleId}::${itemId}`;
  const prevAttempts = _trProgress[key] ? (_trProgress[key].quiz_attempts || 0) : 0;
  // Merge (union) wrong indices across all attempts so Final Quiz targets all-time weak spots
  // Filter out legacy numeric indices (pre-stable-key era) — they can't be
  // matched to questions anymore and will be replaced by string keys on this attempt.
  const prevWrong = (_trProgress[key] ? (_trProgress[key].wrong_question_ids || []) : [])
    .filter(k => typeof k === 'string');
  const mergedWrong = [...new Set([...prevWrong, ...wrongSourceIndices])];
  _trProgress[key] = {
    status: passed ? 'completed' : 'in_progress',
    quiz_score: score,
    quiz_attempts: prevAttempts + 1,
    wrong_question_ids: mergedWrong,
    updated_at: new Date().toISOString()
  };

  // Persist completion to backend
  const newAttempts = prevAttempts + 1;
  if (passed) {
    api({ action: 'upsert_training_progress', secret: SEC, token: _s.token,
          module_id: moduleId, content_id: itemId, status: 'completed',
          quiz_score: score, quiz_attempts: newAttempts,
          wrong_question_ids: mergedWrong }).catch(() => {});
    checkGraduation(moduleId);
  } else {
    api({ action: 'upsert_training_progress', secret: SEC, token: _s.token,
          module_id: moduleId, content_id: itemId, status: 'in_progress',
          quiz_score: score, quiz_attempts: newAttempts,
          wrong_question_ids: mergedWrong }).catch(() => {});
  }

  // Build review HTML
  const reviewHtml = reviewItems.map((ri, i) => {
    const q = ri.q;
    const isMulti = q.type === 'multi';
    const correctAnswers = Array.isArray(q.correct) ? q.correct : [q.correct];
    const correctLabels = correctAnswers.map(c => escHtml(q.options[c])).join(', ');
    const givenIndices = Array.isArray(ri.answer) ? ri.answer : (ri.answer !== undefined ? [ri.answer] : []);
    const givenLabels = givenIndices.map(c => escHtml(q.options[c])).join(', ') || '(no answer)';
    const expHtml = q.explanation
      ? `<div class="qz-explanation"><span class="exp-label">Why?</span>${escHtml(q.explanation)}</div>` : '';
    const imageSrc = getQuizImageSrc(q.image_url || '');
    const imageHtml = imageSrc ? `<div class="qz-question-image-wrap"><img class="qz-question-image" src="${escHtml(imageSrc)}" alt="Question ${i + 1} image"></div>` : '';
    return `
      <div class="qz-review-item ${ri.correct ? 'correct' : 'incorrect'}">
        <div class="qz-review-qnum">${ri.correct ? '✓ Correct' : '✗ Incorrect'} — Q${i + 1}</div>
        <div class="qz-review-qtext">${escHtml(q.question)}</div>
        ${imageHtml}
        ${!ri.correct ? `<div class="qz-review-answer"><span class="lbl">Your answer: </span><span class="val-wrong">${givenLabels}</span></div>` : ''}
        <div class="qz-review-answer"><span class="lbl">Correct answer: </span><span class="val-correct">${correctLabels}</span></div>
        ${expHtml}
      </div>`;
  }).join('');

  const resultColor = passed ? 'var(--ok)' : 'var(--severe)';
  const resultIcon = passed ? '✓ Passed!' : '✗ Failed.';

  document.getElementById('qz-step-content').innerHTML = `
    <div class="qz-review">
      <div class="qz-review-header">
        <span style="color:${resultColor};font-size:18px">${resultIcon}</span>
        &nbsp; You scored <strong>${score}%</strong> (${numCorrect}/${total} correct).
        ${!passed ? `<div style="font-size:13px;color:#5f6368;font-weight:400;margin-top:.3rem">Pass threshold is ${passThreshold}%. Please review and try again.</div>` : ''}
      </div>
      ${reviewHtml}
      ${!passed ? `<div style="text-align:center;margin-top:1rem">
        <button class="qz-nav-btn primary" onclick="retryQuizTaking('${moduleId}','${itemId}')">Try Again</button>
      </div>` : ''}
    </div>`;
  document.getElementById('quiz-result-msg').innerHTML = '';

  if (passed) setTimeout(() => closeVideoDetail(), 3500);
}

function retryQuizTaking(moduleId, itemId) {
  const mod = _trModules.find(m => m.id === moduleId);
  if (!mod) return;
  const item = (mod.items || []).find(v => v.id === itemId);
  if (!item || !item.quiz_data) return;
  _currentQuizAnswers = {};
  _quizCurrentStep = 0;
  // For final quizzes, regenerate the personalized question set on retry
  if (item.content_type === 'final_quiz') {
    const generated = buildFinalQuizQuestions(item);
    if (!generated || !generated.length) return;
    _quizShuffledData = buildShuffledQuiz(generated);
  } else {
    _quizShuffledData = buildShuffledQuiz(item.quiz_data.questions);
  }
  renderQuizStep(moduleId, itemId);
}

function closeVideoDetail() {
  document.getElementById('tr-detail').style.display = 'none';
  document.getElementById('tr-detail').innerHTML = '';
  document.getElementById('tr-mod-list').style.display = 'block';
  renderTraining();
}

function markItemCompleteDetail(moduleId, itemId) {
  api({
    action: 'upsert_training_progress', secret: SEC, token: _s.token,
    module_id: moduleId, content_id: itemId, status: 'completed'
  }).then(res => {
    if (!res.ok) { alert('Error: ' + (res.error || 'Unable to save progress.')); return; }
    const key = `${moduleId}::${itemId}`;
    _trProgress[key] = { status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const btn = document.getElementById('tr-detail-complete-btn');
    if (btn) {
      const span = document.createElement('span');
      span.className = 'tr-complete-tag';
      span.textContent = '✓ Completed';
      btn.replaceWith(span);
    }
    checkGraduation(moduleId);
  }).catch(() => alert('Network error while saving progress.'));
}

function isItemCompleted(moduleId, itemId) {
  const key = `${moduleId}::${itemId}`;
  return !!(_trProgress[key] && _trProgress[key].status === 'completed');
}

function markItemInProgress(moduleId, itemId) {
  if (!moduleId || !itemId) return;
  const key = `${moduleId}::${itemId}`;
  if (_trProgress[key] && _trProgress[key].status === 'completed') return;
  _trProgress[key] = Object.assign({}, _trProgress[key]||{}, { status: 'in_progress', updated_at: new Date().toISOString() });
  api({
    action: 'upsert_training_progress', secret: SEC, token: _s.token,
    module_id: moduleId, content_id: itemId, status: 'in_progress'
  }).catch(() => {});
}

function extractDriveId(url) {
  if (!url) return null;
  const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function getQuizImageSrc(url) {
  const clean = String(url || '').trim();
  if (!clean) return '';
  const driveId = extractDriveId(clean);
  return driveId ? `https://drive.google.com/uc?export=view&id=${driveId}` : clean;
}

// ── Module Drawer ─────────────────────────────────────────────────────────────
function openModuleDrawer(moduleId) {
  const isEdit = !!moduleId;
  document.getElementById('mod-drawer-title').textContent = isEdit ? 'Edit Module' : 'Add Module';
  document.getElementById('mod-id').value = moduleId || '';
  document.getElementById('mod-drawer-msg').className = 'mod-drawer-msg';
  document.getElementById('mod-drawer-msg').textContent = '';
  if (isEdit) {
    const mod = _trModules.find(m => m.id === moduleId);
    document.getElementById('mod-title').value = mod ? mod.title : '';
    document.getElementById('mod-desc').value = mod ? (mod.description || '') : '';
    document.getElementById('mod-order').value = mod ? (mod.order || '') : '';
    document.getElementById('mod-require-prev').checked = mod ? !!mod.require_prev_module : false;
    document.getElementById('mod-is-graduation').checked = mod ? !!mod.is_graduation_module : false;
  } else {
    document.getElementById('mod-title').value = '';
    document.getElementById('mod-desc').value = '';
    document.getElementById('mod-order').value = (_trModules.length + 1);
    document.getElementById('mod-require-prev').checked = false;
    document.getElementById('mod-is-graduation').checked = false;
  }
  document.getElementById('mod-backdrop').classList.add('open');
  document.getElementById('mod-drawer').classList.add('open');
}

function closeModuleDrawer() {
  document.getElementById('mod-backdrop').classList.remove('open');
  document.getElementById('mod-drawer').classList.remove('open');
}

function saveModule() {
  const btn = document.getElementById('mod-save-btn');
  const msgEl = document.getElementById('mod-drawer-msg');
  const modId = document.getElementById('mod-id').value;
  const title = document.getElementById('mod-title').value.trim();
  const desc = document.getElementById('mod-desc').value.trim();
  const order = parseInt(document.getElementById('mod-order').value) || (_trModules.length + 1);
  const reqPrev = document.getElementById('mod-require-prev').checked;
  const isGrad  = document.getElementById('mod-is-graduation').checked;
  if (!title) { showDrawerMsg(msgEl, 'err', 'Title is required.'); return; }
  btn.disabled = true; btn.textContent = 'Saving...';
  msgEl.className = 'mod-drawer-msg'; msgEl.textContent = '';

  api({
    action: modId ? 'update_module' : 'create_module', token: _s.token,
    module_id: modId, title, description: desc, order, require_prev_module: reqPrev,
    is_graduation_module: isGrad
  }).then(res => {
    btn.disabled = false; btn.textContent = 'Save Module';
    if (res.ok) { _trLoaded = false; closeModuleDrawer(); loadTraining(); }
    else showDrawerMsg(msgEl, 'err', res.error || 'Error saving module.');
  }).catch(() => { btn.disabled=false; btn.textContent='Save Module'; showDrawerMsg(msgEl,'err','Network error.'); });
}

function deleteModule(moduleId) {
  const mod = _trModules.find(m => m.id === moduleId);
  if (!confirm(`Delete module "${mod ? mod.title : moduleId}"?\n\nThis will also delete all items inside it.`)) return;
  api({action:'delete_module', token:_s.token, module_id:moduleId})
    .then(res => { if (res.ok) { _trLoaded=false; loadTraining(); } else alert('Error: '+(res.error||'Unknown')); })
    .catch(() => alert('Network error.'));
}

// ── Content Drawer (Video/Doc/Quiz) ─────────────────────────────────────────
function selectContentType(type) {
  _activeContentType = type;
  document.querySelectorAll('.ct-pill').forEach(el => el.classList.remove('ct-active'));
  const pill = document.querySelector(`.ct-pill[data-type="${type}"]`);
  if (pill) pill.classList.add('ct-active');

  const urlGroup = document.getElementById('content-url-group');
  const quizGroup = document.getElementById('quiz-builder-group');
  const finalQuizGroup = document.getElementById('final-quiz-config-group');
  const passReqCheck = document.getElementById('content-pass-required');
  const gateGroup = document.getElementById('content-gate-group');
  const urlLabel = document.getElementById('content-url-label');
  const urlHint = document.getElementById('content-url-hint');

  // Hide all type-specific groups first, then show the relevant one
  urlGroup.style.display = 'none';
  quizGroup.style.display = 'none';
  finalQuizGroup.style.display = 'none';

  if (type === 'quiz') {
    quizGroup.style.display = 'flex';
    gateGroup.style.display = 'flex';
    passReqCheck.checked = true;
  } else if (type === 'final_quiz') {
    finalQuizGroup.style.display = 'flex';
    gateGroup.style.display = 'flex';
    passReqCheck.checked = true;
    renderFinalQuizSourceList();
  } else if (type === 'submodule') {
    gateGroup.style.display = 'none';
    passReqCheck.checked = false;
  } else {
    urlGroup.style.display = 'flex';
    gateGroup.style.display = 'flex';
    if (type === 'document') {
      urlLabel.textContent = 'Document/File URL';
      urlHint.textContent = 'Paste a Google Drive share link for PDF, Docs, Excel, etc.';
    } else {
      urlLabel.textContent = 'Video URL';
      urlHint.textContent = 'Paste a Google Drive video share link.';
    }
  }
  toggleThresholdVisibility();
}

function toggleThresholdVisibility() {
  const showThres = document.getElementById('content-pass-required').checked &&
    (_activeContentType === 'quiz' || _activeContentType === 'final_quiz');
  document.getElementById('content-threshold-group').style.display = showThres ? 'flex' : 'none';
}

// Render a grouped checklist of all available quizzes (from all modules) for the Final Quiz source selector.
// preSelected is an array of content IDs that should be pre-checked (for editing).
// Automatically excludes the item currently being edited (self-reference guard) and
// any final_quiz items (prevents nested final quizzes).
function renderFinalQuizSourceList(preSelected) {
  const container = document.getElementById('final-quiz-source-list');
  if (!container) return;
  const selected = preSelected || getSelectedFinalQuizSourceIds();
  // Exclude the item being edited to prevent self-reference
  const selfId = document.getElementById('vid-id') ? document.getElementById('vid-id').value : '';

  let html = '';
  (_trModules || []).forEach(mod => {
    // Only regular quizzes — final_quiz items are excluded to prevent nesting
    const quizItems = (mod.items || []).filter(it => it.content_type === 'quiz' && it.id !== selfId);
    if (!quizItems.length) return;
    html += `<div class="fq-module-group">
      <div class="fq-module-label">${escHtml(mod.title)}</div>`;
    quizItems.forEach(it => {
      const checked = selected.includes(it.id) ? 'checked' : '';
      html += `<label class="fq-source-item">
        <input type="checkbox" class="fq-source-cb" value="${escHtml(it.id)}" ${checked}>
        <span>${escHtml(it.title)}</span>
      </label>`;
    });
    html += `</div>`;
  });

  if (!html) html = '<div class="hint">No quizzes found. Create regular quizzes first.</div>';
  container.innerHTML = html;
}

// Returns array of currently checked source quiz IDs from the Final Quiz config group.
function getSelectedFinalQuizSourceIds() {
  return Array.from(document.querySelectorAll('#final-quiz-source-list .fq-source-cb:checked'))
    .map(cb => cb.value);
}

function openVideoDrawer(moduleId, itemId) {
  const isEdit = !!itemId;
  document.getElementById('vid-drawer-title').textContent = isEdit ? 'Edit Content' : 'Add Content';
  document.getElementById('vid-id').value = itemId || '';
  document.getElementById('vid-module-id').value = moduleId || '';
  document.getElementById('vid-drawer-msg').className = 'mod-drawer-msg';
  document.getElementById('vid-drawer-msg').textContent = '';
  populateParentSubmoduleOptions(moduleId, itemId);
  
  if (isEdit) {
    const mod = _trModules.find(m => m.id === moduleId);
    const item = mod ? (mod.items||[]).find(v => v.id === itemId) : null;
    document.getElementById('vid-title').value = item ? item.title : '';
    document.getElementById('vid-url').value = item ? (item.content_url || item.drive_url || item.url || '') : '';
    document.getElementById('vid-desc').value = item ? (item.description || '') : '';
    document.getElementById('vid-order').value = item ? (item.order || '') : '';
    document.getElementById('content-pass-required').checked = item ? !!item.pass_required : false;
    document.getElementById('content-pass-threshold').value = item ? (item.pass_threshold || 80) : 80;
    document.getElementById('content-parent-id').value = item ? (item.parent_content_id || '') : '';
    
    _quizQuestions = [];
    if (item && item.content_type === 'quiz' && item.quiz_data && item.quiz_data.questions) {
      _quizQuestions = JSON.parse(JSON.stringify(item.quiz_data.questions));
    }
    updateQuizSummary();
    selectContentType(item ? (item.content_type || 'video') : 'video');
    // For final quiz editing: pre-populate source IDs and question count after the type is selected
    if (item && item.content_type === 'final_quiz' && item.quiz_data) {
      const preSelected = item.quiz_data.source_quiz_ids || [];
      renderFinalQuizSourceList(preSelected);
      document.getElementById('final-quiz-question-count').value = item.quiz_data.question_count || 20;
    }
  } else {
    document.getElementById('vid-title').value = '';
    document.getElementById('vid-url').value = '';
    document.getElementById('vid-desc').value = '';
    const mod = _trModules.find(m => m.id === moduleId);
    document.getElementById('vid-order').value = mod ? ((mod.items||[]).length + 1) : 1;
    document.getElementById('content-pass-required').checked = false;
    document.getElementById('content-pass-threshold').value = 80;
    document.getElementById('content-parent-id').value = '';
    _quizQuestions = [];
    updateQuizSummary();
    selectContentType('video');
  }
  
  document.getElementById('vid-backdrop').classList.add('open');
  document.getElementById('vid-drawer').classList.add('open');
}

function populateParentSubmoduleOptions(moduleId, currentItemId) {
  const sel = document.getElementById('content-parent-id');
  const mod = _trModules.find(m => m.id === moduleId);
  const items = mod ? (mod.items || []) : [];

  const childrenByParent = {};
  items.forEach((item, idx) => {
    const parentId = item.parent_content_id || '';
    if (!childrenByParent[parentId]) childrenByParent[parentId] = [];
    childrenByParent[parentId].push({ item, idx });
  });

  const sortSiblings = (a, b) => {
    const aOrder = Number(a.item.order);
    const bOrder = Number(b.item.order);
    const aOrderValid = Number.isFinite(aOrder);
    const bOrderValid = Number.isFinite(bOrder);
    if (aOrderValid && bOrderValid && aOrder !== bOrder) return aOrder - bOrder;
    if (aOrderValid !== bOrderValid) return aOrderValid ? -1 : 1;

    const aTitle = (a.item.title || '').toLowerCase();
    const bTitle = (b.item.title || '').toLowerCase();
    if (aTitle !== bTitle) return aTitle.localeCompare(bTitle);

    return a.idx - b.idx;
  };

  const orderedSubmodules = [];
  const seen = new Set();
  const walk = (parentId = '', depth = 0) => {
    const children = (childrenByParent[parentId] || []).slice().sort(sortSiblings);
    children.forEach(({ item }) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);

      if (item.content_type === 'submodule' && item.id !== currentItemId) {
        orderedSubmodules.push({ item, depth });
      }

      walk(item.id, depth + 1);
    });
  };

  walk('');

  sel.innerHTML = `<option value="">${escHtml('Top level (no parent)')}</option>` +
    orderedSubmodules
      .map(({ item, depth }) => {
        const indent = depth > 0 ? `${'— '.repeat(depth)}↳ ` : '';
        return `<option value="${item.id}">${escHtml(`${indent}${item.title || ''}`)}</option>`;
      })
      .join('');
}

function closeVideoDrawer() {
  document.getElementById('vid-backdrop').classList.remove('open');
  document.getElementById('vid-drawer').classList.remove('open');
}

function saveVideo() {
  const btn = document.getElementById('vid-save-btn');
  const msgEl = document.getElementById('vid-drawer-msg');
  const itemId = document.getElementById('vid-id').value;
  const moduleId = document.getElementById('vid-module-id').value;
  const title = document.getElementById('vid-title').value.trim();
  const url = document.getElementById('vid-url').value.trim();
  const desc = document.getElementById('vid-desc').value.trim();
  const order = parseInt(document.getElementById('vid-order').value) || 1;
  const passReq = document.getElementById('content-pass-required').checked;
  const passThres = parseInt(document.getElementById('content-pass-threshold').value) || 80;
  const parentContentId = document.getElementById('content-parent-id').value || '';
  
  if (!title) { showDrawerMsg(msgEl, 'err', 'Title is required.'); return; }
  
  if (_activeContentType === 'video' || _activeContentType === 'document') {
    if (!url) { showDrawerMsg(msgEl, 'err', 'URL is required.'); return; }
    if (!extractDriveId(url)) { showDrawerMsg(msgEl, 'err', 'Could not parse a Google Drive file ID from this URL.'); return; }
  } else if (_activeContentType === 'quiz') {
    if (_quizQuestions.length === 0) { showDrawerMsg(msgEl, 'err', 'Add at least one quiz question.'); return; }
  } else if (_activeContentType === 'final_quiz') {
    if (getSelectedFinalQuizSourceIds().length === 0) { showDrawerMsg(msgEl, 'err', 'Select at least one source quiz.'); return; }
  }

  btn.disabled = true; btn.textContent = 'Saving...';
  msgEl.className = 'mod-drawer-msg'; msgEl.textContent = '';

  // final_quiz is stored as 'quiz' in the backend; the is_final_quiz flag inside quiz_data distinguishes it
  const backendContentType = _activeContentType === 'final_quiz' ? 'quiz'
    : _activeContentType === 'submodule' ? 'document'
    : _activeContentType;
  const backendContentUrl = _activeContentType === 'submodule' ? TR_SUBMODULE_URL_MARKER : url;

  let quizDataPayload = '';
  if (_activeContentType === 'quiz') {
    quizDataPayload = JSON.stringify({ questions: _quizQuestions });
  } else if (_activeContentType === 'final_quiz') {
    const sourceIds = getSelectedFinalQuizSourceIds();
    const questionCount = parseInt(document.getElementById('final-quiz-question-count').value) || 20;
    quizDataPayload = JSON.stringify({ is_final_quiz: true, source_quiz_ids: sourceIds, question_count: questionCount });
  }

  const payload = {
    action: itemId ? 'update_content' : 'create_content', token: _s.token,
    content_id: itemId, module_id: moduleId, title, content_url: backendContentUrl,
    description: trComposeDescriptionWithParent_(desc, parentContentId), order, content_type: backendContentType,
    pass_required: passReq, pass_threshold: passThres,
    parent_content_id: parentContentId,
    quiz_data: quizDataPayload
  };
  
  api(payload).then(res => {
    btn.disabled = false; btn.textContent = 'Save Content';
    if (res.ok) { _trLoaded = false; closeVideoDrawer(); loadTraining(); }
    else showDrawerMsg(msgEl, 'err', res.error || 'Error saving content.');
  }).catch(() => { btn.disabled=false; btn.textContent='Save Content'; showDrawerMsg(msgEl,'err','Network error.'); });
}

function deleteVideo(moduleId, itemId) {
  const mod = _trModules.find(m => m.id === moduleId);
  const item = mod ? (mod.items||[]).find(v => v.id === itemId) : null;
  if (!confirm(`Delete item "${item ? item.title : itemId}"?`)) return;
  api({action:'delete_content', token:_s.token, content_id:itemId, module_id:moduleId})
    .then(res => { if (res.ok) { _trLoaded=false; loadTraining(); } else alert('Error: '+(res.error||'Unknown')); })
    .catch(() => alert('Network error.'));
}

function showDrawerMsg(el, type, text) { el.textContent = text; el.className = 'mod-drawer-msg ' + type; }

// ── Quiz Wizard ───────────────────────────────────────────────────────────────
function updateQuizSummary() {
  document.getElementById('quiz-summary').textContent = _quizQuestions.length ? `${_quizQuestions.length} question(s) configured.` : 'No questions added yet.';
}

function openQuizWizard() {
  document.getElementById('quiz-wizard-overlay').style.display = 'flex';
  renderQuizWizard();
}

function closeQuizWizard() {
  document.getElementById('quiz-wizard-overlay').style.display = 'none';
  updateQuizSummary();
}

function saveQuizFromWizard() {
  // Save current dynamic inputs to array
  const qDivs = document.querySelectorAll('.qw-q-card');
  const tempArr = [];
  let valid = true;
  qDivs.forEach((div, idx) => {
    const qText = div.querySelector('.qw-q-text').value.trim();
    if (!qText) return;
    const imageUrl = div.querySelector('.qw-img-input') ? div.querySelector('.qw-img-input').value.trim() : '';
    const isMulti = _quizQuestions[idx] && _quizQuestions[idx].type === 'multi';
    const opts = [];
    let correct = isMulti ? [] : 0;
    let optOrigIdx = 0;  // track which option index in the final opts[] list
    div.querySelectorAll('.qw-o-text').forEach((inp, oIdx) => {
      const txt = inp.value.trim();
      if (!txt) return;
      const inpChecked = div.querySelector(`input[name="qw-r-${idx}"][value="${oIdx}"]`);
      if (isMulti) {
        if (inpChecked && inpChecked.checked) correct.push(optOrigIdx);
      } else {
        if (inpChecked && inpChecked.checked) correct = optOrigIdx;
      }
      opts.push(txt);
      optOrigIdx++;
    });
    if (opts.length < 2) { valid = false; return; }
    const explanation = div.querySelector('.qw-exp-input') ? div.querySelector('.qw-exp-input').value.trim() : '';
    const type = isMulti ? 'multi' : 'single';
    tempArr.push({ question: qText, image_url: imageUrl, options: opts, correct: correct, type: type, explanation: explanation });
  });

  if (!valid) { alert('Each question needs at least 2 options.'); return; }
  _quizQuestions = tempArr;
  closeQuizWizard();
}

function renderQuizWizard() {
  const cont = document.getElementById('qw-questions');
  if (!_quizQuestions.length) _quizQuestions.push({ question: '', image_url: '', options: ['',''], correct: 0 }); // init with 1 blank
  
  cont.innerHTML = _quizQuestions.map((q, qIdx) => {
    const qType = q.type || 'single';
    const isMulti = qType === 'multi';
    const correctArr = Array.isArray(q.correct) ? q.correct : [q.correct];
    return `
    <div class="qw-q-card">
      <div style="display:flex;justify-content:space-between;margin-bottom:.5rem;">
        <strong>Question ${qIdx + 1}</strong>
        <button class="v-act-btn danger" onclick="removeQuizQuestion(${qIdx})">🗑</button>
      </div>
      <input type="text" class="qw-q-text" value="${escHtml(q.question)}" placeholder="Enter your question here..." style="width:100%;padding:.5rem;margin-bottom:.5rem;">
      <input type="text" class="qw-img-input" value="${escHtml(q.image_url || '')}" placeholder="Optional image URL (Google Drive or direct image link)">
      <div class="qw-type-row">
        <span class="qw-type-label">Answer type:</span>
        <div class="qw-type-toggle">
          <button class="qw-type-btn${!isMulti ? ' active' : ''}" onclick="setQwType(${qIdx},'single')">Single choice</button>
          <button class="qw-type-btn${isMulti ? ' active' : ''}" onclick="setQwType(${qIdx},'multi')">Multiple choice</button>
        </div>
      </div>
      <div style="font-size:.8rem;color:#666;margin-bottom:.25rem;">${isMulti ? 'Check all correct answers:' : 'Select the radio button next to the correct answer:'}</div>
      <div id="qw-opts-${qIdx}">
        ${q.options.map((opt, oIdx) => {
          const isCorrect = isMulti ? correctArr.includes(oIdx) : q.correct == oIdx;
          return `
          <div style="display:flex;align-items:center;margin-bottom:.25rem;gap:.5rem;">
            <input type="${isMulti ? 'checkbox' : 'radio'}" name="qw-r-${qIdx}" value="${oIdx}" ${isCorrect ? 'checked' : ''}>
            <input type="text" class="qw-o-text" value="${escHtml(opt)}" placeholder="Option ${oIdx+1}" style="flex:1;padding:.4rem;">
            <button class="v-act-btn" onclick="removeQuizOption(${qIdx}, ${oIdx})">✕</button>
          </div>`;
        }).join('')}
      </div>
      <button class="mod-act-btn" style="margin-top:.5rem" onclick="addQuizOption(${qIdx})">+ Add Option</button>
      <textarea class="qw-exp-input" rows="2" placeholder="Optional: Explain why the correct answer is right (shown to technicians after they complete the quiz)...">${escHtml(q.explanation || '')}</textarea>
    </div>`;
  }).join('');
}

function setQwType(qIdx, type) {
  savePartialQuizState();
  _quizQuestions[qIdx].type = type;
  // Reset correct to appropriate default when switching types
  if (type === 'multi') {
    if (!Array.isArray(_quizQuestions[qIdx].correct)) _quizQuestions[qIdx].correct = [0];
  } else {
    if (Array.isArray(_quizQuestions[qIdx].correct)) _quizQuestions[qIdx].correct = _quizQuestions[qIdx].correct[0] || 0;
  }
  renderQuizWizard();
}

function addQuizQuestion() {
  savePartialQuizState();
  _quizQuestions.push({ question: '', image_url: '', options: ['',''], correct: 0, type: 'single', explanation: '' });
  renderQuizWizard();
}

function removeQuizQuestion(qIdx) {
  savePartialQuizState();
  _quizQuestions.splice(qIdx, 1);
  renderQuizWizard();
}

function addQuizOption(qIdx) {
  savePartialQuizState();
  _quizQuestions[qIdx].options.push('');
  renderQuizWizard();
}

function removeQuizOption(qIdx, oIdx) {
  savePartialQuizState();
  if (_quizQuestions[qIdx].options.length <= 2) return; // need 2 min
  _quizQuestions[qIdx].options.splice(oIdx, 1);
  if (_quizQuestions[qIdx].correct == oIdx) _quizQuestions[qIdx].correct = 0;
  else if (_quizQuestions[qIdx].correct > oIdx) _quizQuestions[qIdx].correct--;
  renderQuizWizard();
}

function savePartialQuizState() {
  const tempArr = [];
  const qDivs = document.querySelectorAll('.qw-q-card');
  qDivs.forEach((div, idx) => {
    const qText = div.querySelector('.qw-q-text').value;
    const imageUrl = div.querySelector('.qw-img-input') ? div.querySelector('.qw-img-input').value : '';
    const isMulti = _quizQuestions[idx] && _quizQuestions[idx].type === 'multi';
    const opts = [];
    let correct = isMulti ? [] : 0;
    div.querySelectorAll('.qw-o-text').forEach((inp, oIdx) => {
      opts.push(inp.value);
      const inpChecked = div.querySelector(`input[name="qw-r-${idx}"][value="${oIdx}"]`);
      if (isMulti) {
        if (inpChecked && inpChecked.checked) correct.push(oIdx);
      } else {
        if (inpChecked && inpChecked.checked) correct = oIdx;
      }
    });
    const explanation = div.querySelector('.qw-exp-input') ? div.querySelector('.qw-exp-input').value : '';
    tempArr.push({ question: qText, image_url: imageUrl, options: opts, correct: correct,
                   type: isMulti ? 'multi' : 'single', explanation: explanation });
  });
  _quizQuestions = tempArr;
}

function toggleQuizPreview() {
  const btn = document.getElementById('qw-preview-btn');
  const pre = document.getElementById('qw-preview');
  const bdy = document.getElementById('qw-body');
  savePartialQuizState();
  
  if (pre.style.display === 'none') { // Show preview
    btn.innerHTML = '✎ Edit Quiz';
    bdy.style.display = 'none';
    pre.style.display = 'block';
    pre.innerHTML = `
      <div style="font-weight:600;margin-bottom:1rem;color:var(--mcps-blue);">Student Preview (correct answers highlighted):</div>
      ${_quizQuestions.map((q, qIdx) => {
        const isMulti = q.type === 'multi';
        const correctArr = Array.isArray(q.correct) ? q.correct : [q.correct];
        const typeBadge = isMulti ? `<span class="qz-type-badge">Select all that apply</span>` : '';
        const expHtml = q.explanation ? `<div class="qz-explanation"><span class="exp-label">Why?</span>${escHtml(q.explanation)}</div>` : '';
        const imgSrc = getQuizImageSrc(q.image_url || '');
        const imgHtml = imgSrc ? `<div class="qz-question-image-wrap"><img class="qz-question-image" src="${escHtml(imgSrc)}" alt="Question ${qIdx + 1} reference image"></div>` : '';
        return `
        <div class="qz-question" style="background:#f1f3f4;padding:1rem;border-radius:4px;margin-bottom:1rem;">
          <div class="qz-qtext">${qIdx + 1}. ${escHtml(q.question) || '<i>[Empty Question]</i>'}${typeBadge}</div>
          ${imgHtml}
          <div class="qz-options">
            ${q.options.map((opt, oIdx) => {
              const isCorrect = correctArr.includes(oIdx);
              return `<label class="qz-option-label${isCorrect ? ' qz-selected' : ''}">
                <input type="${isMulti ? 'checkbox' : 'radio'}" disabled ${isCorrect ? 'checked' : ''}>
                <span style="${isCorrect ? 'color:var(--ok);font-weight:bold;' : ''}">${escHtml(opt) || '<i>[Empty Option]</i>'}</span>
              </label>`;
            }).join('')}
          </div>
          ${expHtml}
        </div>`;
      }).join('')}
    `;
  } else {
    btn.innerHTML = '👁 Preview Quiz';
    pre.style.display = 'none';
    bdy.style.display = 'block';
  }
}

// ── Heads-up SMS ──────────────────────────────────────────────────────────────
function headsUp(e, btn) {
  e.stopPropagation();
  if (btn.classList.contains('sending') || btn.classList.contains('sent')) return;
  const poolId = btn.dataset.poolId;
  const custName = btn.dataset.custName;
  btn.classList.add('sending');
  api({ action: 'send_heads_up', token: _s.token, pool_id: poolId, customer_name: custName })
    .then(function(res) {
      btn.classList.remove('sending');
      if (res.ok) {
        btn.classList.add('sent');
        btn.title = 'Heads up sent!';
        huToast('\u2705 Heads up sent to ' + res.customer + '!');
        setTimeout(function() {
          btn.classList.remove('sent');
          btn.title = 'Send heads up SMS';
        }, 5000);
      } else {
        huToast('\u26a0\ufe0f ' + (res.error || 'Could not send heads up'), true);
      }
    })
    .catch(function() {
      btn.classList.remove('sending');
      huToast('\u26a0\ufe0f Network error — could not send heads up', true);
    });
}

function huToast(msg, isErr) {
  var t = document.getElementById('hu-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'hu-toast';
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(20px);'
      + 'background:#1a1a1a;color:#fff;padding:.6rem 1.1rem;border-radius:10px;font-size:.85rem;'
      + 'font-family:Barlow,sans-serif;z-index:9999;opacity:0;transition:all .25s;pointer-events:none;'
      + 'white-space:nowrap;max-width:90vw;text-align:center;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.background = isErr ? '#7f1d1d' : '#1a1a1a';
  t.style.opacity = '1';
  t.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(t._timer);
  t._timer = setTimeout(function() {
    t.style.opacity = '0';
    t.style.transform = 'translateX(-50%) translateY(20px)';
  }, 4000);
}

// ══════════════════════════════════════════════════════════════════════════════
// ONBOARDING
// ══════════════════════════════════════════════════════════════════════════════
function loadOnboarding() {
  const nameEl = document.getElementById('onb-welcome-name');
  if (nameEl) nameEl.textContent = 'Welcome, ' + (_s.name ? _s.name.split(' ')[0] : '') + '!';

  const authHdr = { 'Authorization': 'Bearer ' + _s.token, 'Content-Type': 'application/json' };

  // Fetch status and contract context in parallel
  Promise.all([
    apiGet({ action: 'onboarding_get_status', token: _s.token }).then(r => r),
    apiGet({ action: 'onboarding_get_context', token: _s.token }).then(r => r)
  ]).then(([status, ctx]) => {
    // Render contract HTML
    if (ctx && ctx.contract_html) {
      document.getElementById('onb-contract-html').innerHTML = ctx.contract_html;
    }
    
    // Branch on worker type
    const isW2 = status && status.worker_type === 'w2_employee';
    if (isW2) {
      document.getElementById('onb-w9-module').style.display = 'none';
      document.getElementById('onb-w4-module').style.display = 'block';
      document.querySelector('#onb-task-contract .onb-task-hdr div div').textContent = 'Employment Agreement';
      document.querySelector('#onb-task-contract .onb-task-hdr div div:nth-child(2)').textContent = 'Read and sign your W2 employment agreement';
      document.querySelector('#onb-task-info .onb-task-hdr div div:nth-child(2)').textContent = 'Legal name, address, tax info & W-4';
    } else {
      document.getElementById('onb-w9-module').style.display = 'block';
      document.getElementById('onb-w4-module').style.display = 'none';
      document.querySelector('#onb-task-contract .onb-task-hdr div div').textContent = 'Contractor Agreement';
      document.querySelector('#onb-task-contract .onb-task-hdr div div:nth-child(2)').textContent = 'Read and sign your independent contractor agreement';
      document.querySelector('#onb-task-info .onb-task-hdr div div:nth-child(2)').textContent = 'Legal name, address, tax info & W-9';
    }

    // Pre-fill signed date
    const dateEl = document.getElementById('onb-signed-date');
    if (dateEl) dateEl.value = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

    updateOnbProgress(status || {});

    // Update task icons based on completion
    if (status && status.info_done) {
      document.getElementById('onb-icon-info').textContent = '✅';
    }
    if (status && status.contract_done) {
      document.getElementById('onb-icon-contract').textContent = '✅';
    }
  }).catch(() => {
    const dateEl = document.getElementById('onb-signed-date');
    if (dateEl) dateEl.value = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  });
}

function toggleOnbTask(task) {
  const body = document.getElementById('onb-body-' + task);
  const chev = document.getElementById('onb-chev-' + task);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chev) chev.style.transform = isOpen ? '' : 'rotate(90deg)';
}

function submitPersonalInfo() {
  const msgEl = document.getElementById('onb-info-msg');
  const fields = {
    legal_name     : document.getElementById('onb-legal-name').value.trim(),
    dob            : document.getElementById('onb-dob').value,
    phone          : document.getElementById('onb-phone').value.trim(),
    address_line1  : document.getElementById('onb-addr1').value.trim(),
    address_city   : document.getElementById('onb-city').value.trim(),
    address_state  : document.getElementById('onb-state').value.trim(),
    address_zip    : document.getElementById('onb-zip').value.trim(),
    emergency_name : document.getElementById('onb-ec-name').value.trim(),
    emergency_phone: document.getElementById('onb-ec-phone').value.trim(),
    tax_type       : (document.querySelector('input[name="onb-tax-type"]:checked') || {}).value || '',
    tax_ein_type   : document.getElementById('onb-ein-type').value,
    tax_id_full    : document.getElementById('onb-tax-full').value.trim(),
  };

  if (!fields.legal_name) { showMsg(msgEl, 'Legal name is required.', false); return; }
  if (!fields.dob) { showMsg(msgEl, 'Date of birth is required.', false); return; }
  if (!fields.phone) { showMsg(msgEl, 'Phone number is required.', false); return; }
  if (!fields.address_line1 || !fields.address_city || !fields.address_state || !fields.address_zip) {
    showMsg(msgEl, 'Complete address is required.', false); return;
  }
  if (!fields.emergency_name || !fields.emergency_phone) { showMsg(msgEl, 'Emergency contact is required.', false); return; }
  const isW2 = document.getElementById('onb-w4-module').style.display !== 'none';
  if (!isW2) {
    if (!fields.tax_type) { showMsg(msgEl, 'Select SSN or EIN.', false); return; }
    if (!fields.tax_id_full || fields.tax_id_full.length < 10) { showMsg(msgEl, 'Enter full Tax ID.', false); return; }
  } else {
    fields.tax_type = 'SSN';
    fields.tax_id_full = document.getElementById('onb-w4-ssn').value.replace(/\D/g, '');
    if (fields.tax_id_full.length < 9) { showMsg(msgEl, 'Enter full SSN.', false); return; }
    fields.w4_filing_status = (document.querySelector('input[name="onb-w4-status"]:checked') || {}).value;
    fields.w4_multiple_jobs = document.getElementById('onb-w4-step2').checked;
    fields.w4_dependents_1 = document.getElementById('onb-w4-dep1').value || '0';
    fields.w4_dependents_2 = document.getElementById('onb-w4-dep2').value || '0';
    fields.w4_other_income = document.getElementById('onb-w4-4a').value || '0';
    fields.w4_deductions = document.getElementById('onb-w4-4b').value || '0';
    fields.w4_extra_withholding = document.getElementById('onb-w4-4c').value || '0';
  }

  const w9b64 = document.getElementById('onb-w9-base64').value;
  const w4b64 = document.getElementById('onb-w4-base64').value;
  
  const doSave = (b64Key, b64Val) => {
    const body = Object.assign({ action: 'save_info' }, fields);
    if (b64Val) body[b64Key] = b64Val;

    body.token = _s.token;
    body.secret = SEC;
    
    api(body).then(res => {
      if (res.ok) {
        showMsg(msgEl, 'Saved!', true);
        document.getElementById('onb-icon-info').textContent = '✅';
        updateOnbProgress({ info_done: true, contract_done: !!res.contract_done });
      } else {
        showMsg(msgEl, res.error || 'Failed to save.', false);
      }
    }).catch(() => showMsg(msgEl, 'Network error.', false));
  };

  if (!isW2) {
    if (w9b64) {
      doSave('w9_base64', w9b64);
    } else {
      showMsg(msgEl, 'Please generate and review your W-9 Form before saving.', false);
    }
  } else {
    if (w4b64) {
      doSave('w4_base64', w4b64);
    } else {
      showMsg(msgEl, 'Please generate and review your W-4 Form before saving.', false);
    }
  }
}

function onbTaxTypeChanged() {
  const type = (document.querySelector('input[name="onb-tax-type"]:checked') || {}).value;
  const inp = document.getElementById('onb-tax-full');
  const einTypeDiv = document.getElementById('onb-ein-type-fg');
  inp.disabled = false;
  inp.value = '';
  
  if (type === 'SSN') {
    inp.placeholder = '___-__-____';
    inp.maxLength = 11;
    einTypeDiv.style.display = 'none';
  } else if (type === 'EIN') {
    inp.placeholder = '__-_______';
    inp.maxLength = 10;
    einTypeDiv.style.display = 'block';
  }
}

function onbFormatTaxId(inp) {
  const type = (document.querySelector('input[name="onb-tax-type"]:checked') || {}).value;
  let val = inp.value.replace(/\D/g, '');
  if (type === 'SSN') {
    let formatted = '';
    if (val.length > 0) formatted += val.substring(0, 3);
    if (val.length > 3) formatted += '-' + val.substring(3, 5);
    if (val.length > 5) formatted += '-' + val.substring(5, 9);
    inp.value = formatted;
  } else if (type === 'EIN') {
    let formatted = '';
    if (val.length > 0) formatted += val.substring(0, 2);
    if (val.length > 2) formatted += '-' + val.substring(2, 9);
    inp.value = formatted;
  }
}

let _pendingW9PdfBytes = null;

async function generateAndReviewW9() {
  const btn = document.getElementById('btn-gen-w9');
  btn.textContent = 'Generating...';
  btn.disabled = true;

  try {
    const rawForm = await fetch('/fw9.pdf').then(res => res.arrayBuffer());
    const pdfDoc = await PDFLib.PDFDocument.load(rawForm);
    const form = pdfDoc.getForm();
    
    // Fill fields
    const nameStr = document.getElementById('onb-legal-name').value.trim();
    const addr1 = document.getElementById('onb-addr1').value.trim();
    const city = document.getElementById('onb-city').value.trim();
    const state = document.getElementById('onb-state').value.trim();
    const zip = document.getElementById('onb-zip').value.trim();
    const taxType = (document.querySelector('input[name="onb-tax-type"]:checked') || {}).value;
    const einType = document.getElementById('onb-ein-type').value;
    const taxIdFilled = document.getElementById('onb-tax-full').value.replace(/\D/g, '');

    if (!nameStr || !addr1 || !city || !state || !zip || !taxType || taxIdFilled.length < 9) {
      alert("Please completely fill out your Personal Information, Home Address, and Full Tax ID before generating the W-9.");
      btn.textContent = 'Review & Sign W-9 Form';
      btn.disabled = false;
      return;
    }

    // Name and address mapping
    try { form.getField('topmostSubform[0].Page1[0].f1_01[0]').setText(nameStr); } catch(e){}
    try { form.getField('topmostSubform[0].Page1[0].Address_ReadOrder[0].f1_07[0]').setText(addr1); } catch(e){}
    try { form.getField('topmostSubform[0].Page1[0].Address_ReadOrder[0].f1_08[0]').setText(city + ', ' + state + ' ' + zip); } catch(e){}
    
    // Checkboxes
    // c1_1[0] = Individual/Sole prop
    // c1_1[1] = C Corp
    // c1_1[2] = S Corp
    // c1_1[3] = Partnership
    // c1_1[4] = Trust/estate
    // c1_1[5] = LLC (with text field f1_03 for type: C/S/P)
    let c1 = form.getField('topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[0]'); // Individual
    
    if (taxType === 'EIN') {
      try {
        if (einType === 'ccorp') c1 = form.getField('topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[1]');
        else if (einType === 'scorp') c1 = form.getField('topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[2]');
        else if (einType === 'partnership') c1 = form.getField('topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[3]');
        else if (einType === 'trust') c1 = form.getField('topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[4]');
        else if (einType.startsWith('llc_')) {
          c1 = form.getField('topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[5]');
          const subtype = einType.split('_')[1].toUpperCase();
          form.getField('topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].f1_03[0]').setText(subtype);
        }
      } catch(e) {}
    }
    if (c1) { try { c1.check(); } catch(e){} }
    
    // Tax ID mapping
    if (taxType === 'SSN') {
      try { form.getField('topmostSubform[0].Page1[0].f1_11[0]').setText(taxIdFilled.slice(0,3)); } catch(e){}
      try { form.getField('topmostSubform[0].Page1[0].f1_12[0]').setText(taxIdFilled.slice(3,5)); } catch(e){}
      try { form.getField('topmostSubform[0].Page1[0].f1_13[0]').setText(taxIdFilled.slice(5,9)); } catch(e){}
    } else if (taxType === 'EIN') {
      try { form.getField('topmostSubform[0].Page1[0].f1_14[0]').setText(taxIdFilled.slice(0,2)); } catch(e){}
      try { form.getField('topmostSubform[0].Page1[0].f1_15[0]').setText(taxIdFilled.slice(2,9)); } catch(e){}
    }
    
    // E-Signature and Date (drawn onto the PDF since signature fields might be locked forms)
    const pages = pdfDoc.getPages();
    const page = pages[0];
    const signatureText = nameStr + ' (e-signed)';
    const dateText = new Date().toLocaleDateString();
    
    page.drawText(signatureText, { x: 140, y: 198, size: 14 });
    page.drawText(dateText, { x: 450, y: 198, size: 14 });

    const helveticaFont = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    form.updateFieldAppearances(helveticaFont);
    
    // Do not form.flatten(); as IRS W-9 Acroform appearances break upon flattening with pdf-lib
    const pdfBytes = await pdfDoc.save();
    
    _pendingW9PdfBytes = pdfBytes;
    
    // Convert to ObjectURL to view in iframe
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    document.getElementById('w9-preview-frame').src = url;
    document.getElementById('w9-modal-backdrop').style.display = 'flex';
  } catch (err) {
    console.error(err);
    alert('Failed to generate W-9: ' + err.message);
  } finally {
    btn.textContent = 'Review & Sign W-9 Form';
    btn.disabled = false;
  }
}

function closeW9Modal() {
  document.getElementById('w9-modal-backdrop').style.display = 'none';
  document.getElementById('w9-preview-frame').src = '';
  _pendingW9PdfBytes = null;
}

function confirmW9() {
  if (!_pendingW9PdfBytes) return;
  // Convert bytes to base64
  let binary = '';
  for (let i = 0; i < _pendingW9PdfBytes.byteLength; i++) {
    binary += String.fromCharCode(_pendingW9PdfBytes[i]);
  }
  const base64 = btoa(binary);
  document.getElementById('onb-w9-base64').value = base64;
  document.getElementById('w9-status-msg').style.display = 'block';
  closeW9Modal();
}

function onbFormatW4Ssn(inp) {
  let val = inp.value.replace(/\D/g, '');
  let formatted = '';
  if (val.length > 0) formatted += val.substring(0, 3);
  if (val.length > 3) formatted += '-' + val.substring(3, 5);
  if (val.length > 5) formatted += '-' + val.substring(5, 9);
  inp.value = formatted;
}

let _pendingW4PdfBytes = null;

async function generateAndReviewW4() {
  const btn = document.getElementById('btn-gen-w4');
  btn.textContent = 'Generating...';
  btn.disabled = true;

  try {
    const rawForm = await fetch('/fw4.pdf').then(res => res.arrayBuffer());
    const pdfDoc = await PDFLib.PDFDocument.load(rawForm);
    const form = pdfDoc.getForm();
    
    // Fill fields
    const fullName = document.getElementById('onb-legal-name').value.trim();
    const addr1 = document.getElementById('onb-addr1').value.trim();
    const city = document.getElementById('onb-city').value.trim();
    const state = document.getElementById('onb-state').value.trim();
    const zip = document.getElementById('onb-zip').value.trim();
    const ssn = document.getElementById('onb-w4-ssn').value.replace(/\D/g, '');

    if (!fullName || !addr1 || !city || !state || !zip || ssn.length < 9) {
      alert("Please check that Personal Information, Address, and SSN are fully entered.");
      btn.textContent = 'Review & Sign W-4 Form';
      btn.disabled = false;
      return;
    }

    const parts = fullName.split(' ');
    const lastName = parts.pop();
    const firstMiddle = parts.join(' ');

    const filingStatus = (document.querySelector('input[name="onb-w4-status"]:checked') || {}).value;
    const step2 = document.getElementById('onb-w4-step2').checked;
    
    // Convert dependent values
    let dep1Raw = parseFloat(document.getElementById('onb-w4-dep1').value) || 0;
    let dep2Raw = parseFloat(document.getElementById('onb-w4-dep2').value) || 0;
    let dep1 = dep1Raw * 2000;
    let dep2 = dep2Raw * 500;
    let depTotal = dep1 + dep2;

    const v4a = document.getElementById('onb-w4-4a').value.trim();
    const v4b = document.getElementById('onb-w4-4b').value.trim();
    const v4c = document.getElementById('onb-w4-4c').value.trim();

    try { form.getField('topmostSubform[0].Page1[0].Step1a[0].f1_01[0]').setText(firstMiddle); } catch(e){}
    try { form.getField('topmostSubform[0].Page1[0].Step1a[0].f1_02[0]').setText(lastName); } catch(e){}
    try { form.getField('topmostSubform[0].Page1[0].Step1a[0].f1_03[0]').setText(addr1); } catch(e){}
    try { form.getField('topmostSubform[0].Page1[0].Step1a[0].f1_04[0]').setText(city + ', ' + state + ' ' + zip); } catch(e){}
    try { form.getField('topmostSubform[0].Page1[0].f1_05[0]').setText(ssn.substring(0,3) + '-' + ssn.substring(3,5) + '-' + ssn.substring(5,9)); } catch(e){}

    // Filing status checkboxes
    if (filingStatus === 'single') {
      try { form.getField('topmostSubform[0].Page1[0].c1_1[0]').check(); } catch(e){}
    } else if (filingStatus === 'married') {
      try { form.getField('topmostSubform[0].Page1[0].c1_1[1]').check(); } catch(e){}
    } else if (filingStatus === 'head') {
      try { form.getField('topmostSubform[0].Page1[0].c1_1[2]').check(); } catch(e){}
    }

    if (step2) {
      try { form.getField('topmostSubform[0].Page1[0].c1_2[0]').check(); } catch(e){}
    }

    try { if (dep1 > 0) form.getField('topmostSubform[0].Page1[0].Step3_ReadOrder[0].f1_06[0]').setText(dep1.toString()); } catch(e){}
    try { if (dep2 > 0) form.getField('topmostSubform[0].Page1[0].Step3_ReadOrder[0].f1_07[0]').setText(dep2.toString()); } catch(e){}
    try { if (depTotal > 0) form.getField('topmostSubform[0].Page1[0].f1_08[0]').setText(depTotal.toString()); } catch(e){}

    try { if (v4a) form.getField('topmostSubform[0].Page1[0].f1_09[0]').setText(v4a.toString()); } catch(e){}
    try { if (v4b) form.getField('topmostSubform[0].Page1[0].f1_10[0]').setText(v4b.toString()); } catch(e){}
    try { if (v4c) form.getField('topmostSubform[0].Page1[0].f1_11[0]').setText(v4c.toString()); } catch(e){}

    // E-Signature and Date (drawn onto the PDF)
    const pages = pdfDoc.getPages();
    const page = pages[0];
    const signatureText = fullName + ' (e-signed)';
    const dateText = new Date().toLocaleDateString();
    
    page.drawText(signatureText, { x: 80, y: 153, size: 14 });
    page.drawText(dateText, { x: 440, y: 153, size: 14 });

    const helveticaFont = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    form.updateFieldAppearances(helveticaFont);
    
    const pdfBytes = await pdfDoc.save();
    
    _pendingW4PdfBytes = pdfBytes;
    
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    document.getElementById('w4-preview-frame').src = url;
    document.getElementById('w4-modal-backdrop').style.display = 'flex';
  } catch (err) {
    console.error(err);
    alert('Failed to generate W-4: ' + err.message);
  } finally {
    btn.textContent = 'Review & Sign W-4 Form';
    btn.disabled = false;
  }
}

function closeW4Modal() {
  document.getElementById('w4-modal-backdrop').style.display = 'none';
  document.getElementById('w4-preview-frame').src = '';
  _pendingW4PdfBytes = null;
}

function confirmW4() {
  if (!_pendingW4PdfBytes) return;
  let binary = '';
  for (let i = 0; i < _pendingW4PdfBytes.byteLength; i++) {
    binary += String.fromCharCode(_pendingW4PdfBytes[i]);
  }
  const base64 = btoa(binary);
  document.getElementById('onb-w4-base64').value = base64;
  document.getElementById('w4-status-msg').style.display = 'block';
  closeW4Modal();
}


function submitContract() {
  const msgEl = document.getElementById('onb-contract-msg');
  const agreed = document.getElementById('onb-agree-cb').checked;
  const signedName = document.getElementById('onb-signed-name').value.trim();

  if (!agreed) { showMsg(msgEl, 'You must check the agreement box.', false); return; }
  if (!signedName) { showMsg(msgEl, 'Type your full name to sign.', false); return; }

  api({ action: 'onboarding_save_contract', signed_name: signedName, signed_at: new Date().toISOString(), token: _s.token, secret: SEC })
  .then(res => {
    if (res.ok) {
      showMsg(msgEl, 'Signature saved!', true);
      document.getElementById('onb-icon-contract').textContent = '✅';
      updateOnbProgress({ info_done: !!res.info_done, contract_done: true });
    } else {
      showMsg(msgEl, res.error || 'Failed to save signature.', false);
    }
  }).catch(() => showMsg(msgEl, 'Network error.', false));
}

function updateOnbProgress(status) {
  const done = (status.info_done ? 1 : 0) + (status.contract_done ? 1 : 0);
  const pct  = (done / 2) * 100;
  const fill = document.getElementById('onb-fill');
  const label = document.getElementById('onb-progress-label');
  if (fill) fill.style.width = pct + '%';
  if (label) label.textContent = done + ' of 2 steps complete';

  if (status.info_done && status.contract_done) {
    const pending = document.getElementById('onb-pending-state');
    if (pending) pending.style.display = 'block';
  }
}

// ── Admin: New Hire Applications ──────────────────────────────────────────────
function loadPendingHires() {
  const container = document.getElementById('pending-hires-list');
  if (!container) return;
  container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">Loading…</div>';

  apiGet({ action: 'onboarding_list_pending', token: _s.token }).then(res => {
    if (!res.ok || !res.applications || !res.applications.length) {
      container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">' +
        (res.error || 'No pending applications.') + '</div>';
      return;
    }
    container.innerHTML = res.applications.map(a => `
      <div class="pend-card" id="hire-card-${a.username}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div class="pend-sku">${a.username}</div>
          ${a.worker_type === 'w2_employee' ? '<span style="font-size:.65rem;background:var(--accent);color:#fff;padding:.1rem .4rem;border-radius:4px;font-weight:700">W-2</span>' : '<span style="font-size:.65rem;background:#475569;color:#fff;padding:.1rem .4rem;border-radius:4px;font-weight:700">1099</span>'}
        </div>
        <div class="pend-desc">${a.full_name || '—'}</div>
        <div style="font-size:.78rem;color:var(--muted);margin-bottom:.5rem">
          Submitted: ${a.info_submitted_at ? new Date(a.info_submitted_at).toLocaleDateString() : '—'}
        </div>
        <div class="pend-ai" style="margin-bottom:.65rem">
          <span class="pend-ai-pill ${a.info_done ? 'conf-high' : 'conf-low'}">${a.info_done ? '✓ Info' : '✗ Info'}</span>
          <span class="pend-ai-pill ${a.contract_done ? 'conf-high' : 'conf-low'}">${a.contract_done ? '✓ Contract' : '✗ Contract'}</span>
        </div>
        <div class="pend-btns" style="flex-wrap:wrap;gap:.4rem">
          <button class="pend-approve" onclick="approveNewHire('${a.username}')">Approve → Trainee</button>
          <button class="pend-reject" onclick="rejectNewHire('${a.username}')">Request Changes</button>
          <button class="pend-reject" style="border-color:var(--teal-light);color:var(--teal-mid)" onclick="viewHireDocs('${a.username}')">📄 View Docs</button>
        </div>
      </div>`).join('');
  }).catch(() => {
    container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">Network error.</div>';
  });
}

function approveNewHire(username) {
  api({ action: 'onboarding_approve', username, token: _s.token, secret: SEC }).then(res => {
    if (!res.ok) { alert(res.error || 'Failed to approve.'); return; }
    // Promote role to trainee via GAS
    api({ action: 'update_user', secret: SEC, token: _s.token, username, fields: { roles: 'trainee', active: true } })
      .then(() => {
        const card = document.getElementById('hire-card-' + username);
        if (card) card.innerHTML = `<div style="padding:.5rem 0;color:var(--success);font-weight:600">✓ ${username} approved as Trainee</div>`;
      });
  }).catch(() => alert('Network error.'));
}

let _allRecordsCache = [];

function loadAllApplications() {
  const container = document.getElementById('all-records-list');
  container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1rem;font-size:.85rem">Loading…</div>';

  apiGet({ action: 'onboarding_list_all', token: _s.token }).then(res => {
    if (!res.ok) { container.innerHTML = `<div style="color:var(--muted);text-align:center;padding:1rem;font-size:.85rem">${res.error || 'Failed to load.'}</div>`; return; }
    _allRecordsCache = res.applications || [];
    renderRecords(_allRecordsCache);
  }).catch(() => {
    container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1rem;font-size:.85rem">Network error.</div>';
  });
}

function filterRecords(q) {
  const lower = q.toLowerCase();
  const filtered = _allRecordsCache.filter(a =>
    (a.username || '').toLowerCase().includes(lower) ||
    (a.full_name || '').toLowerCase().includes(lower)
  );
  renderRecords(filtered);
}

function renderRecords(list) {
  const container = document.getElementById('all-records-list');
  if (!list.length) { container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1rem;font-size:.85rem">No records found.</div>'; return; }

  const statusColor = { approved:'#dcfce7|#15803d', pending_review:'#fef3c7|#92400e', rejected:'#fee2e2|#b91c1c', in_progress:'#f1f5f9|#475569' };
  container.innerHTML = list.map(a => {
    const [bg, color] = (statusColor[a.status] || '#f1f5f9|#475569').split('|');
    const approvedLine = a.approved_at ? `<span style="font-size:.75rem;color:var(--muted)">Approved: ${new Date(a.approved_at).toLocaleDateString()}</span>` : '';
    return `<div class="pend-card" style="margin-bottom:.5rem">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.25rem">
        <div>
          <div style="display:flex;align-items:center;gap:.5rem">
            <div class="pend-sku">${a.username}</div>
            ${a.worker_type === 'w2_employee' ? '<span style="font-size:.65rem;background:var(--accent);color:#fff;padding:.1rem .4rem;border-radius:4px;font-weight:700">W-2</span>' : '<span style="font-size:.65rem;background:#475569;color:#fff;padding:.1rem .4rem;border-radius:4px;font-weight:700">1099</span>'}
          </div>
          <div class="pend-desc" style="margin:.1rem 0 0">${a.full_name || '—'}</div>
          ${approvedLine}
        </div>
        <span style="font-family:'Barlow Condensed',sans-serif;font-size:.72rem;font-weight:700;padding:.2rem .6rem;border-radius:99px;background:${bg};color:${color};text-transform:capitalize;letter-spacing:.04em">${(a.status||'').replace('_',' ')}</span>
      </div>
      <div class="pend-ai" style="margin-bottom:.5rem">
        <span class="pend-ai-pill ${a.info_done?'conf-high':'conf-low'}">${a.info_done?'✓ Info':'✗ Info'}</span>
        <span class="pend-ai-pill ${a.contract_done?'conf-high':'conf-low'}">${a.contract_done?'✓ Contract':'✗ Contract'}</span>
      </div>
      <button class="pend-reject" style="border-color:var(--teal-light);color:var(--teal-mid);width:100%" onclick="viewHireDocs('${a.username}')">📄 View Docs & Tax Form</button>
    </div>`;
  }).join('');
}

function viewHireDocs(username) {
  const modal = document.getElementById('docs-modal');
  const body  = document.getElementById('docs-modal-body');
  body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--muted)"><div class="spinner"></div></div>';
  modal.classList.add('open');

  apiGet({ action: 'onboarding_get_documents', username, token: _s.token }).then(d => {
    if (!d.ok) { body.innerHTML = `<p style="color:var(--error)">${d.error}</p>`; return; }
    body.innerHTML = `
      <div style="margin-bottom:1.25rem">
        <div class="docs-section-title">Personal Information</div>
        <div class="docs-row"><span>Full Name</span><span>${d.full_name || '—'}</span></div>
        <div class="docs-row"><span>Date of Birth</span><span>${d.dob || '—'}</span></div>
        <div class="docs-row"><span>Phone</span><span>${d.phone || '—'}</span></div>
        <div class="docs-row"><span>Address</span><span>${[d.address_line1, d.address_city, d.address_state, d.address_zip].filter(Boolean).join(', ') || '—'}</span></div>
        <div class="docs-row"><span>Emergency Contact</span><span>${d.emergency_name || '—'} ${d.emergency_phone ? '· ' + d.emergency_phone : ''}</span></div>
        <div class="docs-row"><span>Type</span><span style="font-weight:700;color:var(--accent)">${d.worker_type === 'w2_employee' ? 'W-2 Employee' : '1099 Contractor'}</span></div>
        <div class="docs-row"><span>Tax ID Type</span><span>${d.tax_type || '—'}</span></div>
        <div class="docs-row"><span>Last 4 Digits</span><span>${d.tax_id_last4 ? '••••' + d.tax_id_last4 : '—'}</span></div>
      </div>
      <div style="margin-bottom:1.25rem">
        <div class="docs-section-title">Contract Signature</div>
        <div class="docs-row"><span>Signed Name</span><span>${d.contract_signed_name || '—'}</span></div>
        <div class="docs-row"><span>Signed At</span><span>${d.contract_signed_at ? new Date(d.contract_signed_at).toLocaleString() : '—'}</span></div>
      </div>
      <div>
        <div class="docs-section-title">Tax Document</div>
        ${d.worker_type === 'w2_employee' ?
          (d.w4_signed_url
            ? `<a href="${d.w4_signed_url}" target="_blank" class="docs-w9-btn">⬇ Open W-4 PDF</a><div style="font-size:.72rem;color:var(--muted);margin-top:.3rem">Link expires in 1 hour</div>`
            : '<span style="color:var(--muted);font-size:.85rem">No W-4 uploaded</span>') :
          (d.w9_signed_url
            ? `<a href="${d.w9_signed_url}" target="_blank" class="docs-w9-btn">⬇ Open W-9 PDF</a><div style="font-size:.72rem;color:var(--muted);margin-top:.3rem">Link expires in 1 hour</div>`
            : '<span style="color:var(--muted);font-size:.85rem">No W-9 uploaded</span>')
        }
      </div>`;
  }).catch(() => { body.innerHTML = '<p style="color:var(--error)">Network error.</p>'; });
}

function closeDocsModal() {
  document.getElementById('docs-modal').classList.remove('open');
}

function rejectNewHire(username) {
  const note = prompt('Enter a note for the applicant (required):');
  if (!note) return;
  api({ action: 'onboarding_reject', username, note, token: _s.token, secret: SEC }).then(res => {
    if (!res.ok) { alert(res.error || 'Failed.'); return; }
    const card = document.getElementById('hire-card-' + username);
    if (card) card.innerHTML = `<div style="padding:.5rem 0;color:var(--warn);font-weight:600">⚠ Changes requested for ${username}</div>`;
  }).catch(() => alert('Network error.'));
}

// ══════════════════════════════════════════════════════════════════════════════
// GRADUATION
// ══════════════════════════════════════════════════════════════════════════════
function checkGraduation(moduleId) {
  if (!moduleId || !_s) return;
  if (!(_s.roles || []).includes('trainee')) return;

  const mod = (_trModules || []).find(m => m.id === moduleId);
  if (!mod || !mod.is_graduation_module) return;

  const items = (mod.items || []).filter(i => i.type !== 'submodule');
  if (!items.length) return;

  const allDone = items.every(i => {
    const key = `${moduleId}::${i.id}`;
    return _trProgress[key] && _trProgress[key].status === 'completed';
  });

  if (allDone) triggerGraduation();
}

function triggerGraduation() {
  api({ action: 'update_user', secret: SEC, token: _s.token, username: _s.username || _s.name,
        fields: { roles: 'technician', active: true } })
    .then(res => {
      if (!res.ok) return;
      _s.roles = ['technician'];
      _s.pages = unionPages_(['technician']);
      localStorage.setItem('mcps_s', JSON.stringify(_s));
      showGraduationModal();
      setTimeout(() => { buildNav(); navigateTo('home'); }, 3000);
    }).catch(() => {});
}

function showGraduationModal() {
  let el = document.getElementById('grad-modal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'grad-modal';
    el.className = 'grad-modal';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="grad-modal-inner">
    <div style="font-size:3.5rem;margin-bottom:.75rem">🎉</div>
    <div style="font-family:'Oswald',sans-serif;font-size:1.75rem;font-weight:700;letter-spacing:.02em">You're now a Technician!</div>
    <div style="font-size:.95rem;color:rgba(255,255,255,.75);margin-top:.5rem">Your account has been upgraded. Redirecting…</div>
  </div>`;
  el.style.display = 'flex';
  setTimeout(() => { el.style.display = 'none'; }, 3200);
}

