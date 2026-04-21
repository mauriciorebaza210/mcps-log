// CONFIG — see js/lib/constants.js
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
let _weekOffset = 0;           // week navigation offset from current week (admin only)
let _weatherCache = {};        // keyed by week_start ISO date
let _activeHubTab = 'schedule';
let _profileOp = null;         // username whose profile is shown in the profile tab
let _routeFetchInFlight = null; // { key, promise } — deduplicates concurrent loadRoutes calls
let _daySelectTimer = null;     // debounce timer for selectDay()

// ── Route data cache (localStorage, 15-min TTL) ──────────────────────────────
const ROUTE_CACHE_TTL = 15 * 60 * 1000;
function _routeCacheKey(op, weekOffset){ return `mcps_route_${op||'all'}_${weekOffset||0}`; }
function _getRouteCache(op, weekOffset){
  try{
    const raw = localStorage.getItem(_routeCacheKey(op, weekOffset));
    if(!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if(Date.now() - ts > ROUTE_CACHE_TTL){ localStorage.removeItem(_routeCacheKey(op, weekOffset)); return null; }
    return data;
  }catch(e){ return null; }
}
function _setRouteCache(op, weekOffset, data){
  try{ localStorage.setItem(_routeCacheKey(op, weekOffset), JSON.stringify({ ts: Date.now(), data })); }catch(e){}
}
function _clearRouteCache(){
  Object.keys(localStorage).filter(k=>k.startsWith('mcps_route_')).forEach(k=>localStorage.removeItem(k));
}

// ── Weather cache (in-memory + localStorage, 24h TTL) ────────────────────────
function _weatherLocalKey(k){ return `mcps_weather_${k}`; }
function _getWeatherCache(k){
  if(_weatherCache[k]) return _weatherCache[k];
  try{
    const raw = localStorage.getItem(_weatherLocalKey(k));
    if(!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if(Date.now() - ts > 24*60*60*1000){ localStorage.removeItem(_weatherLocalKey(k)); return null; }
    _weatherCache[k] = data;
    return data;
  }catch(e){ return null; }
}
function _setWeatherCache(k, data){
  _weatherCache[k] = data;
  try{ localStorage.setItem(_weatherLocalKey(k), JSON.stringify({ ts: Date.now(), data })); }catch(e){}
}

// ── Skeleton loader for route content ────────────────────────────────────────
function _showRouteSkeleton(){
  document.getElementById('route-loading').style.display='none';
  const content = document.getElementById('route-content');
  content.style.display='block';
  document.getElementById('day-tabs').innerHTML=`<div class="sk-tabs">${Array(6).fill('<div class="skeleton-block sk-tab"></div>').join('')}</div>`;
  document.getElementById('route-day-card').innerHTML=`
    <div class="skeleton-block sk-header"></div>
    <div class="skeleton-block sk-maps-row"></div>
    <div class="skeleton-block sk-stop"></div>
    <div class="skeleton-block sk-stop"></div>
    <div class="skeleton-block sk-stop" style="opacity:.65"></div>`;
}

// API helpers — see js/lib/api.js

function _appCacheGet(key, ttlMs) {
  try {
    const raw = localStorage.getItem('mcps_' + key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > ttlMs) { 
      localStorage.removeItem('mcps_' + key); 
      return null; 
    }
    return data;
  } catch(e) { return null; }
}

function _appCacheSet(key, data) {
  const fullKey = 'mcps_' + key;
  const payload = JSON.stringify({ ts: Date.now(), data });
  try { 
    localStorage.setItem(fullKey, payload); 
  } catch(e) {
    // If quota exceeded, nuke all old MCPS cache keys and retry
    console.warn('Storage full. Purging MCPS cache...');
    Object.keys(localStorage).forEach(k => { 
      if(k.startsWith('mcps_')) localStorage.removeItem(k); 
    });
    try { localStorage.setItem(fullKey, payload); } catch(e2) { console.error('Cache totally failed'); }
  }
}

window.onload = () => {
  const stored = localStorage.getItem('mcps_s');
  if (stored) {
    try { _s = JSON.parse(stored); showApp(location.hash.replace('#','') || _defaultLandingPage_()); return; } catch(e) { localStorage.removeItem('mcps_s'); }
  }
  const deep = location.hash.replace('#','');
  if (deep) sessionStorage.setItem('mcps_deep', deep);
};

// Auth — see js/lib/auth.js

// ── App shell ─────────────────────────────────────────────────────────────────
function showApp(startPage) {
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').style.display='flex';
  // Sidebar footer — user name & role
  document.getElementById('sb-name').textContent=_s.name;
  const sbRole=document.getElementById('sb-role');
  sbRole.textContent=(_s.roles||[]).join(', '); sbRole.className='r-badge '+(_s.roles||[])[0];
  document.getElementById('home-name').textContent=_s.name.split(' ')[0];
  // Refresh pages list in case ROLE_PAGES was updated
  _s.pages = unionPages_(_s.roles);
  buildNav(); buildHomeCards();
  if((_s.pages||[]).includes('admin')) { loadUsers(); }

  // Safely run prefetch when the browser has free time
  const runIdle = window.requestIdleCallback || ((cb) => setTimeout(cb, 3000));
  runIdle(_prefetchCommon);

  // Configure which hub tabs are visible based on role
  _configureHubTabs();

  const pg = (_s.pages||[]).includes(startPage)?startPage:_defaultLandingPage_();
  navigateTo(pg);

  // Trainees land on the Training tab (no Schedule/Profile access)
  const traineeOnly = hasRole('trainee') && !hasRole('technician') && !hasRole('lead') && !hasRole('admin') && !hasRole('manager');
  if(traineeOnly){
    switchHubTab('training');
  }
}

function _prefetchCommon() {
  if (isAdmin() && !_appCacheGet('crm_data', 15*60*1000)) {
    apiGet({ action: 'get_crm_data', token: _s.token })
      .then(r => { if (r.ok) _appCacheSet('crm_data', r.data); }).catch(()=>{});
  }
  if (hasRole('technician') || hasRole('lead')) {
    api({ action: 'get_metadata' })
      .then(r => { if (r.ok) _appCacheSet('svc_meta', r); }).catch(()=>{});
  }
}

function buildNav() {
  const pages = _s.pages || [];
  const traineeOnly = hasRole('trainee') && !hasRole('technician') && !hasRole('lead') && !hasRole('admin') && !hasRole('manager');
  let html = '';

  // Home — direct link
  if (pages.includes('home')) {
    html += `<button class="sb-item" id="ni-home" onclick="navigateTo('home')">${SVG_HOME}<span>Home</span></button>`;
  }

  // Sales Hub accordion
  const salesChildren = SIDEBAR_GROUPS[0].children.filter(c => pages.includes(c.page));
  if (salesChildren.length) html += _makeSbGroup('sales', 'Sales Hub', salesChildren);

  // Technician Hub accordion
  let techChildren;
  if (!pages.includes('live_map') && pages.includes('inventory')) {
    // Office users: only show Inventory under Tech Hub
    techChildren = SIDEBAR_GROUPS[1].children.filter(c => c.page === 'inventory');
  } else {
    techChildren = SIDEBAR_GROUPS[1].children.filter(c => {
      if (!pages.includes(c.page)) return false;
      if (traineeOnly && c.page === 'live_map' && !c.hubTab) return false;
      if (traineeOnly && c.hubTab === 'profile') return false;
      if (traineeOnly && c.page === 'inventory') return false;
      if (traineeOnly && c.page === 'service_log') return false;
      return true;
    });
  }
  if (techChildren.length) html += _makeSbGroup('tech', 'Technician Hub', techChildren);

  // Financial Hub accordion
  const finChildren = SIDEBAR_GROUPS[2].children.filter(c => pages.includes(c.page));
  if (finChildren.length) html += _makeSbGroup('finance', 'Financial Hub', finChildren);

  // Admin / Onboarding — direct links
  if (pages.includes('admin')) {
    html += `<button class="sb-item" id="ni-admin" onclick="navigateTo('admin')">${SVG_LOCK}<span>Admin</span></button>`;
  }
  if (pages.includes('onboarding')) {
    html += `<button class="sb-item" id="ni-onboarding" onclick="navigateTo('onboarding')">${SVG_STAR}<span>Get Started</span></button>`;
  }

  // Operator Profile — standalone at the bottom
  if (pages.includes('live_map') && !traineeOnly) {
    html += `<button class="sb-item sb-item-bottom" id="sb-child-profile" onclick="navigateTo('live_map');switchHubTab('profile')">${SVG_USER}<span>Operator Profile</span></button>`;
  }

  document.getElementById('sb-nav').innerHTML = html;
}

function _makeSbGroup(id, label, children) {
  const SVG_CHEVRON = `<svg class="sb-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;
  const childrenHtml = children.map(c => {
    const childId = c.id || `ni-${c.page}${c.hubTab ? '-'+c.hubTab : ''}`;
    let onclick;
    if (c.page === 'financial_hub' && c.hubTab) {
      onclick = `navigateTo('financial_hub');switchFinTab('${c.hubTab}')`;
    } else if (c.hubTab) {
      onclick = `navigateTo('${c.page}');switchHubTab('${c.hubTab}')`;
    } else {
      onclick = `navigateTo('${c.page}')`;
    }
    return `<button class="sb-child" id="${childId}" onclick="${onclick}">${c.icon || ''}<span>${c.label}</span></button>`;
  }).join('');
  return `<div class="sb-group" id="sbg-${id}"><div class="sb-group-header" onclick="_toggleAccordion('${id}')"><span>${label}</span>${SVG_CHEVRON}</div><div class="sb-group-children">${childrenHtml}</div></div>`;
}

function _toggleAccordion(id) {
  document.getElementById('sbg-'+id)?.classList.toggle('open');
}

function _setAccordionOpen(id, open) {
  document.getElementById('sbg-'+id)?.classList.toggle('open', open);
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sb-overlay');
  const isOpen = sb.classList.toggle('open');
  ov.classList.toggle('visible', isOpen);
  document.body.style.overflow = isOpen ? 'hidden' : '';
}

function _closeSidebar() {
  const sb = document.getElementById('sidebar');
  if (!sb || !sb.classList.contains('open')) return;
  sb.classList.remove('open');
  document.getElementById('sb-overlay').classList.remove('visible');
  document.body.style.overflow = '';
}

// Show/hide hub tab buttons based on role.
// Trainees see only the Training tab; field roles (tech/lead) also see My Jobs.
function _configureHubTabs(){
  const traineeOnly = hasRole('trainee') && !hasRole('technician') && !hasRole('lead') && !hasRole('admin') && !hasRole('manager');
  const isField = hasRole('technician') || hasRole('lead');
  const schedBtn  = document.getElementById('htab-schedule');
  const profBtn   = document.getElementById('htab-profile');
  const myJobsBtn = document.getElementById('htab-myjobs');
  if(schedBtn)  schedBtn.style.display  = traineeOnly ? 'none' : '';
  if(profBtn)   profBtn.style.display   = traineeOnly ? 'none' : '';
  if(myJobsBtn) myJobsBtn.style.display = isField ? '' : 'none';
  // Also hide the schedule/profile/myjobs tab content for trainees
  if(traineeOnly){
    document.getElementById('hub-tab-schedule').style.display = 'none';
    document.getElementById('hub-tab-profile').style.display  = 'none';
  }
}

function buildHomeCards(){
  const descs={onboarding:'Complete your onboarding to get started',live_map:'View and manage your route assignments',service_log:'Log a pool visit & dosage recs',inventory:'Chemical inventory levels',quotes:'Quote calculator',crm:'Leads, pipeline, and signed contracts',training:'Video training modules',admin:'Manage users & access'};
  document.getElementById('home-grid').innerHTML=(_s.pages||[]).filter(p=>p!=='home').map(p=>{
    const icon = PAGE_ICONS[p] || '❓';
    const label = PAGE_META[p] || p;
    return `<div class="home-card" onclick="navigateTo('${p}')"><span class="hc-icon">${icon}</span><div><div class="hc-name">${label}</div><div class="hc-desc">${descs[p]||''}</div></div><span class="hc-arrow">›</span></div>`;
  }).join('');
}

// navigateTo, _setSidebarActive — see js/lib/router.js

// ROUTES / MAP PAGE — see js/features/routes.js

// SERVICE LOG — see js/features/service-log.js

// ADMIN — see js/features/admin.js

// INVENTORY — see js/features/inventory.js

// QUOTE CALCULATOR — see js/features/quotes.js

// SALES HUB (CRM) — see js/features/crm.js

// TRAINING MODULE (LMS) — see js/features/training.js

// ONBOARDING + GRADUATION — see js/features/onboarding.js
