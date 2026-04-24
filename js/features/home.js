// ══════════════════════════════════════════════════════════════════════════════
// HOME DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════

let _activeClientsView = 'signed'; // 'signed' | 'mcp'
let _crmDataCache = null;

function _parseClientDate_(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (!s) return null;
  const dateOnly = s.includes('T') ? s.split('T')[0] : s;
  const d = new Date(dateOnly);
  return isNaN(d.getTime()) ? null : d;
}

// ─── DASHBOARD ACTIONS ──────────────────────────────────────────────────────────

window.toggleQuickActionMenu = function () {
  const menu = document.getElementById('quick-action-menu');
  if (menu) menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
};

window.requestHomeReport = function (type) {
  toggleQuickActionMenu();
  if (type === 'issue') {
    // Navigate to a "Report Issue" flow - for now show alert or open modal
    Swal.fire({
      title: 'Report New Issue',
      html: '<input id="issue-msg" class="swal2-input" placeholder="Describe the issue...">',
      showCancelButton: true,
      confirmButtonText: 'Submit Alert',
      preConfirm: () => document.getElementById('issue-msg').value
    }).then(res => {
      if (res.isConfirmed && res.value) {
        apiPost({ action: 'submit_issue', message: res.value, token: _s.token }).then(() => {
          Swal.fire('Submitted!', 'The operations team has been notified.', 'success');
          loadHomeStats();
        });
      }
    });
  } else if (type === 'lead') {
    navigateTo('crm'); // Navigate to lead page
  } else {
    Swal.fire('Coming Soon', 'This action will be available shortly.', 'info');
  }
};

window.onclick = function (event) {
  if (!event.target.closest('.quick-action-dropdown')) {
    const menus = document.querySelectorAll('#quick-action-menu');
    menus.forEach(m => m.style.display = 'none');
  }
};

function _computeClientsForView_(data, view) {
  if (!data || !data.length) return { count: 0, history: Array(12).fill(0), vsLastWeek: 0 };
  const isMcp = view === 'mcp';
  const count = data.filter(item => {
    const cs = String(item.contract_status || '').toUpperCase();
    const st = String(item.status || '').toUpperCase();
    if (isMcp) return st === 'ACTIVE_CUSTOMER' && item.sponsored_by_mcp === true;
    return cs === 'SIGNED' && st === 'ACTIVE_CUSTOMER';
  }).length;

  const now = new Date();
  const curWeekStart = new Date(now);
  curWeekStart.setDate(now.getDate() - now.getDay());
  curWeekStart.setHours(0, 0, 0, 0);

  const history = [];
  for (let w = 11; w >= 0; w--) {
    const weekStart = new Date(curWeekStart);
    weekStart.setDate(curWeekStart.getDate() - w * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const weekCount = data.filter(item => {
      const cs = String(item.contract_status || '').toUpperCase();
      if (cs !== 'SIGNED') return false;
      if (isMcp && item.sponsored_by_mcp !== true) return false;
      const signedAt = _parseClientDate_(item.signed_at);
      if (!signedAt || signedAt > weekEnd) return false;
      const serviceEnd = _parseClientDate_(item.service_end);
      if (serviceEnd && serviceEnd < weekStart) return false;
      return true;
    }).length;
    history.push(weekCount);
  }
  const vsLastWeek = history[11] - (history[10] || 0);
  return { count, history, vsLastWeek };
}

function _buildSparklineSVG_(data) {
  if (!data || data.length < 2) return '';
  const W = 200, H = 40;
  const n = data.length;
  const minVal = Math.min(...data);
  const maxVal = Math.max(...data);
  const range = maxVal - minVal;
  const pad = Math.max(Math.ceil((range || 1) * 0.2), 1);
  const lo = minVal - pad;
  const hi = maxVal + pad;
  const span = hi - lo;

  const pts = data.map((v, i) => ({ x: (i / (n - 1)) * W, y: H - ((v - lo) / span) * H }));
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const dots = pts.map((p, i) => {
    const isCurrent = i === n - 1;
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isCurrent ? 3 : 2}" fill="${isCurrent ? 'var(--teal)' : 'var(--card)'}" stroke="var(--teal)" stroke-width="1.5"/>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block;overflow:visible">
    <path d="${path}" fill="none" stroke="var(--teal-mid)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
}

function _buildClientsViewSelect_(view) {
  return `<select class="hs-view-select" onclick="event.stopPropagation()" onchange="_onActiveClientsViewChange_(this.value)" style="background:transparent;border:none;font-family:'Barlow Condensed',sans-serif;font-size:0.75rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);outline:none;cursor:pointer;padding:0;appearance:none;-webkit-appearance:none;position:relative;z-index:2;">
    <option value="signed"${view === 'signed' ? ' selected' : ''}>Active Clients ▼</option>
    <option value="mcp"${view === 'mcp' ? ' selected' : ''}>Active (MCP) ▼</option>
  </select>`;
}

function _onActiveClientsViewChange_(view) {
  _activeClientsView = view;
  if (!_crmDataCache) return;
  const ac = _computeClientsForView_(_crmDataCache, view);

  const card = document.getElementById('kpi-active-clients');
  if (!card) return;

  const deltaSign = ac.vsLastWeek > 0 ? '+' : '';
  const deltaColor = ac.vsLastWeek > 0 ? 'var(--teal)' : ac.vsLastWeek < 0 ? 'var(--warn)' : 'var(--muted)';

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
      <div>
        ${_buildClientsViewSelect_(view)}
        <div style="font-family:'Oswald',sans-serif;font-size:1.8rem;font-weight:700;line-height:1;margin-top:0.3rem;">${ac.count}</div>
        <div style="font-size:0.75rem;color:${deltaColor};margin-top:0.2rem;font-weight:600;">
          ${ac.vsLastWeek !== 0 || ac.history.some(v => v > 0) ? `${deltaSign}${ac.vsLastWeek} vs last week` : 'vs last week'}
        </div>
      </div>
      <div style="width:20px;height:20px;color:var(--teal)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
      </div>
    </div>
    <div style="margin-top:auto;padding-top:1rem;">${_buildSparklineSVG_(ac.history)}</div>
  `;
}

async function loadHomeStats() {
  const ds = document.getElementById('home-dashboard');
  if (!ds) return;
  if (!isAdmin()) {
    ds.style.display = 'none';
    return;
  }
  ds.style.display = 'flex';

  // Update Header Info
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const greetingEl = document.getElementById('greeting-text');
  if (greetingEl) {
  const nameEl = document.getElementById('home-name');
  if (nameEl && _s.user) {
    nameEl.textContent = _s.user.split(' ')[0] || 'Team';
  }
  }

  const dateEl = document.getElementById('current-date-text');
  if (dateEl) {
    dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  try {
    // Inject premium CSS styles
    if (!document.getElementById('mcps-premium-style')) {
      const style = document.createElement('style');
      style.id = 'mcps-premium-style';
      style.innerHTML = `
        @keyframes dashFadeUp {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .dash-card {
          background: #ffffff;
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 1.25rem;
          box-shadow: 0 4px 12px rgba(0,0,0,0.03);
          transition: all 0.2s ease;
          animation: dashFadeUp 0.3s ease-out backwards;
          display: flex;
          flex-direction: column;
        }
        .dash-card:hover {
          box-shadow: 0 8px 24px rgba(0,0,0,0.06);
          border-color: var(--teal-mid);
        }
        .kpi-title {
          font-family: 'Barlow Condensed', sans-serif;
          font-size: 0.85rem;
          font-weight: 700;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .kpi-val {
          font-family: 'Oswald', sans-serif;
          font-size: 2.2rem;
          font-weight: 700;
          color: var(--text);
          margin-top: 0.25rem;
        }
        .snapshot-item {
          display: flex;
          justify-content: space-between;
          padding: 0.6rem 0;
          border-bottom: 1px solid rgba(0,0,0,0.04);
        }
        .snapshot-item:last-child { border-bottom: none; }
        .snapshot-label { font-size: 0.9rem; color: var(--muted); font-weight: 500; }
        .snapshot-val { font-family: 'Oswald', sans-serif; font-weight: 600; color: var(--text); }
        .attention-row {
          display: flex;
          align-items: center;
          gap: 1rem;
          padding: 0.75rem 0;
          border-bottom: 1px solid rgba(0,0,0,0.04);
        }
        .attention-row:last-child { border-bottom: none; }
        .attention-badge {
          font-size: 0.65rem;
          font-weight: 800;
          padding: 0.2rem 0.6rem;
          border-radius: 6px;
          text-transform: uppercase;
          min-width: 60px;
          text-align: center;
        }
      `;
      document.head.appendChild(style);
    }

    const todayStr = new Date().toISOString().split('T')[0];

    // Fetch enriched data for accurate metrics
    const [crmRes, unRes, alertsRes, visitsRes, histRes, routeRes] = await Promise.all([
      apiGet({ action: 'get_crm_data', token: _s.token }),
      apiGet({ action: 'get_unassigned', token: _s.token }),
      apiGet({ action: 'get_issue_alerts', token: _s.token }),
      apiGet({ action: 'scheduled_visits', token: _s.token }),
      apiGet({ action: 'get_visit_history', token: _s.token }),
      apiGet({
        action: 'route_data', token: _s.token, operator: 'all', week_start: (function () {
          const d = new Date(); const day = d.getDay(); const diff = d.getDate() - day + (day === 0 ? -6 : 1);
          const mon = new Date(d.getFullYear(), d.getMonth(), diff);
          return mon.getFullYear() + '-' + String(mon.getMonth() + 1).padStart(2, '0') + '-' + String(mon.getDate()).padStart(2, '0');
        })()
      })
    ]);

    let openOpportunities = 0;
    let ac = { count: 0, history: Array(12).fill(0), vsLastWeek: 0 };

    if (crmRes.ok && crmRes.data) {
      _crmDataCache = crmRes.data;
      ac = _computeClientsForView_(crmRes.data, _activeClientsView);
      openOpportunities = crmRes.data
        .filter(i => ['LEAD', 'QUOTED'].includes((i.status || '').toUpperCase()))
        .reduce((sum, item) => sum + (parseFloat(String(item.price || 0).replace(/[^0-9.]/g, '')) || 0), 0);
    }

    // Accurate calculation for today's volume
    let routeCount = 0;
    if (routeRes.ok && routeRes.days) {
      const dObj = new Date();
      const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dObj.getDay()];
      const todayRouteDay = routeRes.days.find(d => d.day === dayName || d.day === todayStr);
      if (todayRouteDay && todayRouteDay.pools) routeCount = todayRouteDay.pools.length;
    }
    const schedCount = (visitsRes.ok && visitsRes.visits)
      ? visitsRes.visits.filter(v => (v.date || '').startsWith(todayStr)).length
      : 0;
    const todayScheduled = routeCount + schedCount;

    let poolsCompletedToday = 0;
    if (histRes.ok && histRes.rows) {
      poolsCompletedToday = histRes.rows.filter(r => (r.timestamp || '').startsWith(todayStr)).length;
    }

    const unassignedCount = (unRes.ok && unRes.pools)
      ? unRes.pools.filter(p => (p.service || '').toLowerCase().includes('weekly full service')).length
      : 0;

    const criticalAlerts = (alertsRes.ok && alertsRes.alerts) ? alertsRes.alerts.length : 0;

    let crmLeads = 0, crmQuoted = 0, crmSigned = 0;
    if (crmRes.ok && crmRes.data) {
      crmRes.data.forEach(item => {
        const s = (item.status || '').toUpperCase();
        if (s === 'LEAD') crmLeads++;
        else if (s === 'QUOTED') crmQuoted++;
        else if (s === 'SIGNED') crmSigned++;
      });
    }

    // Row 1: KPIs
    const kpiRow = document.getElementById('dash-row-kpi');
    if (kpiRow) {
      const deltaSign = ac.vsLastWeek > 0 ? '+' : '';
      const deltaColor = ac.vsLastWeek > 0 ? 'var(--teal)' : ac.vsLastWeek < 0 ? 'var(--warn)' : 'var(--muted)';

      kpiRow.innerHTML = `
        <div id="kpi-active-clients" class="dash-card" style="cursor:pointer;animation-delay:0.05s" onclick="_onActiveClientsViewChange_(_activeClientsView === 'signed' ? 'mcp' : 'signed')">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              ${_buildClientsViewSelect_(_activeClientsView)}
              <div class="kpi-val">${ac.count}</div>
              <div style="font-size:0.75rem;color:${deltaColor};margin-top:0.2rem;font-weight:700;">
                <span style="background:${ac.vsLastWeek > 0 ? 'rgba(42,157,143,0.1)' : 'rgba(0,0,0,0.05)'}; padding:0.1rem 0.4rem; border-radius:4px">${ac.vsLastWeek !== 0 || ac.history.some(v => v > 0) ? `${deltaSign}${ac.vsLastWeek} vs last week` : 'vs last week'}</span>
              </div>
            </div>
            <div style="color:var(--teal-mid); opacity:0.8;"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg></div>
          </div>
          <div style="margin-top:auto;padding-top:1.5rem;">${_buildSparklineSVG_(ac.history)}</div>
        </div>

        ${renderKPICard('Monthly Revenue', '$0', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"></path><path d="M12 18V6"></path></svg>', 'var(--teal)', '0.1s', Array(12).fill(0))}
        ${renderKPICard('Open Opportunities', openOpportunities > 0 ? '$' + Math.round(openOpportunities).toLocaleString() : '0', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>', 'var(--teal)', '0.15s')}
        ${renderKPICard("Today's Stops", todayScheduled, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>', 'var(--teal-mid)', '0.2s')}
        ${renderKPICard('Needing Routes', unassignedCount, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>', unassignedCount > 0 ? '#b45309' : 'var(--teal)', '0.25s')}
        ${renderKPICard('Alerts', criticalAlerts, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>', criticalAlerts > 0 ? 'var(--warn)' : 'var(--muted)', '0.3s')}
      `;
    }

    // Phase 1B: Snapshots
    let newLeadsThisWeek = 0;
    let quotesSent = 0;
    let lastInboundLeadText = '---';

    if (crmRes.ok && crmRes.data) {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      newLeadsThisWeek = crmRes.data.filter(i => {
        const d = _parseClientDate_(i.timestamp || i.created_at);
        return d && d >= sevenDaysAgo && (i.status || '').toUpperCase() === 'LEAD';
      }).length;

      quotesSent = crmRes.data.filter(i => (i.status || '').toUpperCase() === 'QUOTED').length;

      const timestamps = crmRes.data
        .map(i => _parseClientDate_(i.timestamp || i.created_at))
        .filter(d => d !== null);

      if (timestamps.length > 0) {
        const maxTs = new Date(Math.max(...timestamps));
        const hoursAgo = Math.floor((new Date() - maxTs) / (1000 * 60 * 60));
        if (hoursAgo < 24) lastInboundLeadText = `${hoursAgo}h ago`;
        else lastInboundLeadText = `${Math.floor(hoursAgo / 24)}d ago`;
      }
    }

    poolsCompletedToday = 0;
    if (visitsRes.ok && visitsRes.visits) {
      poolsCompletedToday = visitsRes.visits.filter(v => (v.date || '').startsWith(todayStr) && (v.status || '').toUpperCase() === 'COMPLETED').length;
    }

    const snapsRow = document.getElementById('dash-row-snapshots');
    if (snapsRow) {
      snapsRow.innerHTML = `
        ${renderSnapshotDOM('Sales & Marketing', [
        { label: 'New Leads (This Week)', value: newLeadsThisWeek },
        { label: 'Quotes Sent', value: quotesSent },
        { label: 'Last Inbound Lead', value: lastInboundLeadText },
        { label: 'Conversion Rate', value: '---' },
        { label: 'Pending Follow-Ups', value: '---' }
      ], '0.35s')}
        ${renderSnapshotDOM('Operations', [
        { label: 'Pools Scheduled Today', value: todayScheduled },
        { label: 'Pools Completed Today', value: poolsCompletedToday },
        { label: 'Pools Needing Routing', value: unassignedCount },
        { label: 'Missing Service Logs', value: '---' },
        { label: 'Maintenance Alerts', value: '---' }
      ], '0.4s')}
        ${renderSnapshotDOM('Admin & Finance', [
        { label: 'Invoices Sent', value: '---' },
        { label: 'Collected (This Week)', value: '---' },
        { label: 'Overdue Invoices', value: '---' },
        { label: 'Payroll Status', value: 'On Track' },
        { label: 'Monthly Expenses', value: '---' }
      ], '0.45s')}
      `;
    }

    // Row 4: Attention Widget (as a specialized snapshot in row 2 or standalone row 3)
    const attentionRow = document.getElementById('dash-row-attention');
    if (attentionRow) {
      const activeAlerts = (alertsRes.ok && alertsRes.alerts) ? alertsRes.alerts : [];
      attentionRow.innerHTML = renderAttentionWidget(activeAlerts);
    }

    // Row 5: Charts & Goals
    const chartsRow = document.getElementById('dash-row-charts');
    if (chartsRow) {
      chartsRow.innerHTML = `
        <div id="chart-pipeline" class="dash-card" style="animation-delay:0.5s; min-height:300px">
          <h3 class="kpi-title" style="color:var(--teal); margin-bottom:1.5rem;">Pipeline Overview</h3>
          ${buildFunnelSVG(crmLeads, crmQuoted, crmSigned)}
        </div>
        <div id="chart-revenue" class="dash-card" style="align-items:center; justify-content:center; color:var(--muted); min-height:300px; animation-delay:0.55s; background: repeating-linear-gradient(45deg, #fbfbfb, #fbfbfb 10px, #ffffff 10px, #ffffff 20px);">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40" style="margin-bottom:0.8rem;opacity:0.4;"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
          <div style="font-family:'Oswald',sans-serif; font-size:1.3rem; font-weight:700; color:var(--text); opacity:0.6;">Revenue vs Target</div>
          <div style="font-size:0.8rem; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; margin-top:0.25rem;">Placeholder / Coming Soon</div>
        </div>
        <div id="chart-route-health" class="dash-card" style="align-items:center; justify-content:center; color:var(--muted); min-height:300px; animation-delay:0.6s; background: repeating-linear-gradient(-45deg, #fbfbfb, #fbfbfb 10px, #ffffff 10px, #ffffff 20px);">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40" style="margin-bottom:0.8rem;opacity:0.4;"><circle cx="12" cy="12" r="10"></circle><path d="M16 12a4 4 0 0 0-8 0"></path></svg>
          <div style="font-family:'Oswald',sans-serif; font-size:1.3rem; font-weight:700; color:var(--text); opacity:0.6;">Route Health</div>
          <div style="font-size:0.8rem; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; margin-top:0.25rem;">Placeholder / Coming Soon</div>
        </div>
      `;
    }

    const goalsRow = document.getElementById('dash-row-goals');
    if (goalsRow) {
      goalsRow.innerHTML = `
        <div id="goal-activity" class="dash-card" style="min-height:240px; animation-delay:0.65s">
          <h3 class="kpi-title" style="color:var(--teal); margin-bottom:1rem;">Recent Activity</h3>
          <div style="display:flex; flex-direction:column;">
            <div style="display:flex; gap:1rem; align-items:flex-start; padding: 0.8rem 0; border-bottom: 1px solid rgba(0,0,0,0.04);">
              <div style="width:32px; height:32px; border-radius:50%; background:rgba(42,157,143,0.1); color:var(--teal); display:flex; align-items:center; justify-content:center;"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle></svg></div>
              <div>
                <div style="font-size:0.9rem; font-weight:700; color:var(--text)">New lead from Mission Custom Pools</div>
                <div style="font-size:0.75rem; color:var(--muted); font-weight:500;">2 hours ago</div>
              </div>
            </div>
            <div style="display:flex; gap:1rem; align-items:flex-start; padding: 0.8rem 0;">
              <div style="width:32px; height:32px; border-radius:50%; background:rgba(38,70,83,0.1); color:var(--teal-mid); display:flex; align-items:center; justify-content:center;"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="10" x2="21" y2="10"></line></svg></div>
              <div>
                <div style="font-size:0.9rem; font-weight:700; color:var(--text)">Route 2 completed - 8 pools serviced</div>
                <div style="font-size:0.75rem; color:var(--muted); font-weight:500;">3 hours ago</div>
              </div>
            </div>
          </div>
        </div>
        <div id="goal-company" class="dash-card" style="align-items:center; justify-content:center; color:var(--muted); min-height:240px; animation-delay:0.7s; background: #fafafa;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40" style="margin-bottom:0.8rem;opacity:0.4;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
          <div style="font-family:'Oswald',sans-serif; font-size:1.3rem; font-weight:700; color:var(--text); opacity:0.6;">Company Growth Goals</div>
          <div style="font-size:0.8rem; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; margin-top:0.25rem;">Placeholder / Coming Soon</div>
        </div>
      `;
    }
  } catch (e) {
    console.error("Dashboard error:", e);
  }
}

function buildFunnelSVG(leads, quoted, signed) {
  const max = Math.max(leads, quoted, signed, 1);
  const pL = Math.max((leads / max) * 100, 15);
  const pQ = Math.max((quoted / max) * 100, 10);
  const pS = Math.max((signed / max) * 100, 5);

  const cx = 50;
  const x1 = cx - pL / 2, x2 = cx + pL / 2;
  const x3 = cx + pQ / 2, x4 = cx - pQ / 2;
  const x5 = cx - pQ / 2, x6 = cx + pQ / 2;
  const x7 = cx + pS / 2, x8 = cx - pS / 2;
  const x9 = cx - pS / 2, x10 = cx + pS / 2;
  const x11 = cx - (pS / 2) * 0.6, x12 = cx + (pS / 2) * 0.6;

  return `
    <div style="position:relative; width:100%; height:200px;">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%; height:100%; display:block;">
        <polygon points="${x1},0 ${x2},0 ${x3},30 ${x4},30" fill="rgba(42, 157, 143, 0.2)" stroke="var(--teal)" stroke-width="1" />
        <polygon points="${x5},35 ${x6},35 ${x7},65 ${x8},65" fill="rgba(38, 70, 83, 0.2)" stroke="var(--teal-mid)" stroke-width="1" />
        <polygon points="${x9},70 ${x10},70 ${x12},100 ${x11},100" fill="rgba(8, 114, 21, 0.2)" stroke="var(--green)" stroke-width="1" />
      </svg>
      <div style="position:absolute; top:5%; left:0; right:0; text-align:center; pointer-events:none;">
        <div style="font-weight:700; font-size:1.5rem; color:var(--text); line-height:1;">${leads}</div>
        <div style="font-size:0.7rem; color:var(--muted); font-weight:600; text-transform:uppercase;">Leads</div>
      </div>
      <div style="position:absolute; top:40%; left:0; right:0; text-align:center; pointer-events:none;">
        <div style="font-weight:700; font-size:1.5rem; color:var(--text); line-height:1;">${quoted}</div>
        <div style="font-size:0.7rem; color:var(--muted); font-weight:600; text-transform:uppercase;">Quoted</div>
      </div>
      <div style="position:absolute; top:75%; left:0; right:0; text-align:center; pointer-events:none;">
        <div style="font-weight:700; font-size:1.5rem; color:var(--text); line-height:1;">${signed}</div>
        <div style="font-size:0.7rem; color:var(--muted); font-weight:600; text-transform:uppercase;">Signed</div>
      </div>
    </div>
  `;
}

function renderAttentionWidget(alerts) {
  if (!alerts || alerts.length === 0) {
    return `
      <div id="attention-widget" class="dash-card">
        <div style="padding:1rem; text-align:center; color:var(--muted); font-size:0.9rem; font-weight:500;">
          All caught up! No items need your attention right now. ✅
        </div>
      </div>
    `;
  }

  const rows = alerts.map((a, idx) => {
    let tagColor = '#fee2e2';
    let textColor = '#ef4444';
    let level = 'High';
    const t = (a.type || '').toLowerCase();
    if (t.includes('medium')) { tagColor = '#ffedd5'; textColor = '#f97316'; level = 'Medium'; }
    else if (t.includes('low')) { tagColor = '#ecfdf5'; textColor = '#10b981'; level = 'Low'; }

    return `
      <div class="attention-row">
        <div style="width:28px; height:28px; border-radius:50%; background:rgba(0,0,0,0.03); display:flex; align-items:center; justify-content:center;">
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
        </div>
        <div style="flex:1">
          <div style="font-weight:700; font-size:0.95rem; color:var(--text);">${a.message}</div>
          <div style="font-size:0.75rem; color:var(--muted); font-weight:600; margin-top:0.1rem;">${new Date(a.timestamp).toLocaleDateString()} &bull; ${a.submitter || 'System'}</div>
        </div>
        <div class="attention-badge" style="background:${tagColor}; color:${textColor};">${level}</div>
      </div>
    `;
  }).join('');

  return `
    <div id="attention-widget" class="dash-card" style="padding: 1.5rem;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
        <h3 class="kpi-title" style="color:var(--text); margin:0;">Today Needs Attention</h3>
        <span style="font-size:0.75rem; color:var(--teal); font-weight:700; cursor:pointer;" onclick="navigateTo('crm')">View all tasks &rarr;</span>
      </div>
      <div>
        ${rows}
      </div>
    </div>
  `;
}

function renderSnapshotDOM(title, metrics, animDelay = '0s') {
  const metricsHTML = metrics.map((m, idx) => `
    <div class="snapshot-item">
      <span class="snapshot-label">${m.label}</span>
      <span class="snapshot-val" style="color:${m.value === '0' || m.value === '---' ? 'var(--muted)' : 'var(--text)'}">${m.value}</span>
    </div>
  `).join('');
  return `
    <div class="dash-card" style="animation-delay:${animDelay};">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.8rem;">
        <h3 class="kpi-title" style="color:var(--teal); margin:0;">${title}</h3>
      </div>
      <div style="display:flex; flex-direction:column; flex:1">
        ${metricsHTML}
      </div>
      <div style="margin-top:1rem; pt:0.5rem; border-top:1px solid rgba(0,0,0,0.04); text-align:center;">
         <span style="font-size:0.75rem; color:var(--teal); font-weight:700; cursor:pointer; opacity:0.8;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.8">Go to ${title.split(' ')[0]} Hub &rarr;</span>
      </div>
    </div>
  `;
}

function renderKPICard(title, value, iconHTML, iconColor = 'var(--teal)', animDelay = '0s', sparkHistory = []) {
  return `
    <div class="dash-card" style="animation-delay:${animDelay};">
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <div class="kpi-title">${title}</div>
          <div class="kpi-val">${value}</div>
        </div>
        <div style="width:24px; height:24px; color:${iconColor}; opacity:0.8;">${iconHTML}</div>
      </div>
      ${sparkHistory.length > 0 ? `<div style="margin-top:1.5rem;">${_buildSparklineSVG_(sparkHistory)}</div>` : ''}
    </div>
  `;
}
