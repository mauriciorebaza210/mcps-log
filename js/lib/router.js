// ══════════════════════════════════════════════════════════════════════════════
// ROUTER — page navigation and hub tab switching
// Depends on: constants.js, auth.js (hasRole, isAdmin, _closeSidebar)
// Uses globals: _s, _curPage, _routeData, _activeHubTab, _usersCache, _invLoaded
// ══════════════════════════════════════════════════════════════════════════════

function navigateTo(pageWithSub){
  const parts = pageWithSub.split('/');
  const page = parts[0];
  const sub  = parts[1] || null;

  // Training lives inside the hub — redirect for all hub users
  if(page==='training' && (_s&&(_s.pages||[]).includes('live_map'))){
    navigateTo('live_map');
    switchHubTab('training');
    return;
  }
  if(!_s||!(_s.pages||[]).includes(page))return;
  document.querySelectorAll('.pf').forEach(f=>f.classList.remove('active'));
  const frame=document.getElementById('page-'+page);
  if(frame)frame.classList.add('active');
  
  _setSidebarActive(page, sub);
  _curPage = page;
  location.hash = (page === 'home' ? '' : page) + (sub ? '/' + sub : '');
  _closeSidebar();

  // Scroll content area back to top
  const mc = document.querySelector('.main-content');
  if (mc) mc.scrollTop = 0;

  if(page==='home') loadHomeStats();
  if(page==='live_map'){ 
    if(!_routeData) loadRoutes(); 
    switchHubTab(sub || 'schedule'); 
  }
  if(page==='service_log') loadServiceLog(window._pendingSvcPoolId);
  if(page==='inventory'&&!_invLoaded) loadInventory();
  if(page==='quotes') qInit();
  if(page==='crm') loadCRM();
  if(page==='training') loadTraining();
  if(page==='onboarding') loadOnboarding();
  if(page==='admin') { loadPendingHires(); loadInternalNotes(); }
  if(page==='financial_hub') {
    // If we have a sub-path, notify the hub logic
    if (typeof switchFinTab === 'function' && sub) {
      switchFinTab(sub);
    } else {
      loadFinancialHub();
    }
  }
}

function _setSidebarActive(page, hubTab) {
  document.querySelectorAll('.sb-item, .sb-child').forEach(n => n.classList.remove('active'));
  let targetId;
  if (hubTab === 'profile' && page === 'live_map') {
    targetId = 'sb-child-profile';
  } else {
    targetId = hubTab ? `ni-${page}-${hubTab}` : `ni-${page}`;
  }
  const target = document.getElementById(targetId);
  if (target) target.classList.add('active');
  // Auto-expand parent accordion
  if (page === 'crm' || page === 'quotes') _setAccordionOpen('sales', true);
  if (['live_map','service_log','inventory'].includes(page) && hubTab !== 'profile') _setAccordionOpen('tech', true);
  if (page === 'financial_hub') _setAccordionOpen('finance', true);
}

function switchHubTab(tab) {
  _activeHubTab = tab;

  // Update tab button active states (only for buttons that exist / are visible)
  ['schedule','training','profile','myjobs'].forEach(t => {
    const btn = document.getElementById('htab-'+t);
    if(btn) btn.classList.toggle('active', t === tab);
  });

  // Show/hide tab content panels
  document.getElementById('hub-tab-schedule').style.display = tab === 'schedule' ? 'block' : 'none';
  document.getElementById('hub-tab-training').style.display = tab === 'training' ? 'block' : 'none';
  document.getElementById('hub-tab-profile').style.display  = tab === 'profile'  ? 'block' : 'none';
  const myJobsPanel = document.getElementById('hub-tab-myjobs');
  if(myJobsPanel) myJobsPanel.style.display = tab === 'myjobs' ? 'block' : 'none';

  if (tab === 'profile') {
    if(isAdmin() && !_usersCache.length){
      loadUsers();
    }
    renderProfileTab();
  }
  if (tab === 'training') {
    loadTraining();
  }
  if (tab === 'myjobs') {
    loadMyJobsTab();
  }
  // Sync sidebar: schedule maps to the parent live_map item; training/profile map to their child items
  _setSidebarActive('live_map', tab === 'schedule' ? null : tab);
}
