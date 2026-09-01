// ══════════════════════════════════════════════════════════════════════════════
// ROUTER — page navigation and hub tab switching
// Depends on: constants.js, auth.js (hasRole, isAdmin, _closeSidebar)
// Uses globals: _s, _curPage, _routeData, _activeHubTab, _usersCache, _invLoaded
// ══════════════════════════════════════════════════════════════════════════════

function _resolvePageFromHash_(hash) {
  if (!hash) return null;
  if (hash === 'technicianhub' || hash.startsWith('technicianhub/')) {
    const sub = hash.split('/')[1] || 'schedule';
    return (sub === 'service_log' || sub === 'inventory') ? sub : 'live_map';
  }
  return hash.split('/')[0];
}

function _pageToHash_(page, sub) {
  if (page === 'home') return '';
  if (page === 'live_map') return 'technicianhub/' + (sub || 'schedule');
  if (page === 'service_log') return 'technicianhub/service_log';
  if (page === 'inventory') return 'technicianhub/inventory';
  return page + (sub ? '/' + sub : '');
}

function navigateTo(pageWithSub){
  // Translate public technicianhub/ URLs to internal page IDs
  if (pageWithSub === 'technicianhub' || pageWithSub.startsWith('technicianhub/')) {
    const thSub = pageWithSub.split('/')[1] || 'schedule';
    pageWithSub = (thSub === 'service_log' || thSub === 'inventory')
      ? thSub
      : (thSub === 'schedule' ? 'live_map' : 'live_map/' + thSub);
  }
  const parts = pageWithSub.split('/');
  const page = parts[0];
  // Jobs supports two-level deep links (jobs/startups/<pool_id>) — keep the full subpath
  const sub  = page === 'jobs' ? (parts.slice(1).join('/') || null) : (parts[1] || null);

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
  location.hash = _pageToHash_(page, sub);
  _closeSidebar();

  // Scroll content area back to top
  const mc = document.querySelector('.main-content');
  if (mc) mc.scrollTop = 0;

  if(page==='home') {
    loadHomeStats();
    loadHomeIssues();
  }
  if(page==='jobs') loadJobsPage(sub);
  if(page==='live_map'){
    loadRoutes();
    switchHubTab(sub || 'schedule');
  }
  if(page==='route_planner') loadRoutePlanner();
  if(page==='service_log') loadServiceLog(window._pendingSvcPoolId);
  if(page==='inventory'&&!_invLoaded) loadInventory();
  if(page==='quotes') qInit();
  if(page==='service_requests') loadServiceRequests();
  if(page==='crm') loadCRM();
  if(page==='comms') loadCommsPage(sub);
  if(page==='training') loadTraining();
  if(page==='onboarding') loadOnboarding();
  if(page==='admin') { loadUsers(); loadStartupRequests(); loadPendingHires(); loadInternalNotes(); if (typeof loadEmployeeInvites === 'function') loadEmployeeInvites(); if (typeof loadScopeLibrary === 'function') loadScopeLibrary(); if (typeof loadServiceAreas === 'function') loadServiceAreas(); }
  if(page==='financial_hub') {
    // If we have a sub-path, notify the hub logic
    if (typeof switchFinTab === 'function' && sub) {
      switchFinTab(sub);
    } else {
      loadFinancialHub();
    }
  }
  if(page==='alerts') loadAlertsPage();
  if(page==='action_queue') loadActionQueue();
  if(page==='contracts') loadContracts();
  if (typeof syncPortalNavigationMode === 'function') syncPortalNavigationMode();
}

function _setSidebarActive(page, hubTab) {
  document.querySelectorAll('.sb-item, .sb-child').forEach(n => n.classList.remove('active'));
  let targetId;
  if (hubTab === 'profile' && page === 'live_map') {
    targetId = 'sb-child-profile';
  } else {
    targetId = hubTab ? `ni-${page}-${hubTab}` : `ni-${page}`;
  }
  let target = document.getElementById(targetId);
  // Fall back to the page itself when a sub-tab has no sidebar entry of its own.
  // Without this the sidebar shows NOTHING as active on any such tab (e.g.
  // comms/audiences), which reads as "you are nowhere".
  if (!target && hubTab) target = document.getElementById(`ni-${page}`);
  if (target) target.classList.add('active');
  // Auto-expand parent accordion
  if (page === 'crm' || page === 'quotes' || page === 'comms' || page === 'contracts' ||
      page === 'action_queue') _setAccordionOpen('sales', true);
  if (['jobs','live_map','route_planner','service_log','inventory'].includes(page) && hubTab !== 'profile') _setAccordionOpen('tech', true);
  if (page === 'financial_hub') _setAccordionOpen('finance', true);
  if (page === 'alerts') _setAccordionOpen('alerts', true);
}

function switchHubTab(tab) {
  _activeHubTab = tab;
  location.hash = 'technicianhub/' + tab;

  // Update tab button active states (only for buttons that exist / are visible)
  ['schedule','training','profile','myjobs','startup_checklists'].forEach(t => {
    const btn = document.getElementById('htab-'+t);
    if(btn) btn.classList.toggle('active', t === tab);
  });

  // Show/hide tab content panels
  document.getElementById('hub-tab-schedule').style.display = tab === 'schedule' ? 'block' : 'none';
  document.getElementById('hub-tab-training').style.display = tab === 'training' ? 'block' : 'none';
  document.getElementById('hub-tab-profile').style.display  = tab === 'profile'  ? 'block' : 'none';
  const myJobsPanel = document.getElementById('hub-tab-myjobs');
  if(myJobsPanel) myJobsPanel.style.display = tab === 'myjobs' ? 'block' : 'none';
  const sclPanel = document.getElementById('hub-tab-startup_checklists');
  if(sclPanel) sclPanel.style.display = tab === 'startup_checklists' ? 'block' : 'none';

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
  if (tab === 'startup_checklists') {
    loadStartupChecklistsTab();
  }
  // Sync sidebar: schedule maps to the parent live_map item; training/profile map to their child items
  _setSidebarActive('live_map', tab === 'schedule' ? null : tab);
  if (typeof syncPortalNavigationMode === 'function') syncPortalNavigationMode();
}
