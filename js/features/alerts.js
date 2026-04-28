// ── Alerts & Issues page ──────────────────────────────────────────────────────

let _alertsOpenCache = [];
let _alertsHistoryCache = [];

function loadAlertsPage() {
  const openPanel  = document.getElementById('alerts-open-panel');
  const histPanel  = document.getElementById('alerts-history-panel');
  if (!openPanel) return;

  openPanel.innerHTML  = _alertsLoadingHTML();
  histPanel.innerHTML  = '';

  switchAlertTab('open');

  Promise.all([
    apiGet({ action: 'get_issue_alerts',   token: _s.token }),
    apiGet({ action: 'get_alert_history',  token: _s.token })
  ]).then(([openRes, histRes]) => {
    _alertsOpenCache    = (openRes.ok  && openRes.alerts)  ? openRes.alerts  : [];
    _alertsHistoryCache = (histRes.ok  && histRes.alerts)  ? histRes.alerts  : [];

    openPanel.innerHTML = _renderOpenAlerts(_alertsOpenCache);
    histPanel.innerHTML = _renderAlertHistory(_alertsHistoryCache);
  }).catch(() => {
    openPanel.innerHTML = `<div class="alerts-empty">Failed to load alerts.</div>`;
  });
}

function switchAlertTab(tab) {
  const openBtn  = document.getElementById('alert-tab-open');
  const histBtn  = document.getElementById('alert-tab-history');
  const openPanel = document.getElementById('alerts-open-panel');
  const histPanel = document.getElementById('alerts-history-panel');
  if (!openBtn) return;

  const active   = 'background:var(--teal);color:#fff;border-color:var(--teal);';
  const inactive = 'background:transparent;color:var(--muted);border-color:var(--border);';

  if (tab === 'open') {
    openBtn.setAttribute('style', active + openBtn.getAttribute('style').replace(/background:[^;]+;|color:[^;]+;|border-color:[^;]+;/g, ''));
    histBtn.setAttribute('style', inactive + histBtn.getAttribute('style').replace(/background:[^;]+;|color:[^;]+;|border-color:[^;]+;/g, ''));
    openBtn.style.background = 'var(--teal)'; openBtn.style.color = '#fff'; openBtn.style.borderColor = 'var(--teal)';
    histBtn.style.background = 'transparent'; histBtn.style.color = 'var(--muted)'; histBtn.style.borderColor = 'var(--border)';
    openPanel.style.display  = 'block';
    histPanel.style.display  = 'none';
  } else {
    openBtn.style.background = 'transparent'; openBtn.style.color = 'var(--muted)'; openBtn.style.borderColor = 'var(--border)';
    histBtn.style.background = 'var(--teal)'; histBtn.style.color = '#fff'; histBtn.style.borderColor = 'var(--teal)';
    openPanel.style.display  = 'none';
    histPanel.style.display  = 'block';
  }
}

function resolveAlertFromPage(id) {
  api({ action: 'resolve_issue_alert', token: _s.token, default_secret: true, alert_id: id })
    .then(res => {
      if (res.ok) {
        closeAlertDetail();
        loadAlertsPage();
        loadHomeIssues();
        if (typeof loadHomeStats === 'function') loadHomeStats();
      } else {
        alert('Failed to resolve: ' + (res.error || 'Unknown error'));
      }
    })
    .catch(() => alert('Network error'));
}

// ── Private renderers ─────────────────────────────────────────────────────────

function _alertsLoadingHTML() {
  return `<div class="alerts-empty" style="color:var(--muted);">Loading...</div>`;
}

function _alertTypeMeta(type) {
  switch ((type || '').toLowerCase()) {
    case 'kudos':  return { label: 'Kudos',  icon: '🌟', tagBg: '#fef9c3', tagFg: '#854d0e' };
    case 'alert':  return { label: 'Alert',  icon: '📢', tagBg: '#dbeafe', tagFg: '#1d4ed8' };
    default:       return { label: 'Issue',  icon: '⚠️', tagBg: '#fee2e2', tagFg: '#b91c1c' };
  }
}

function _renderOpenAlerts(alerts) {
  if (!alerts.length) {
    return `<div class="alerts-empty">All clear — no open alerts right now.</div>`;
  }

  return alerts.map(a => {
    const meta = _alertTypeMeta(a.type);
    const date = new Date(a.timestamp).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    const canResolve = isAdmin() || (typeof _s !== 'undefined' && a.submitter_username === _s.username);
    const poolTag = a.linked_pool_id ? `<span class="alert-pool-tag">${escHtml(a.linked_pool_id)}</span>` : '';
    const photos  = (a.photo_urls || []).length ? `<span class="alert-photo-count">${a.photo_urls.length} photo${a.photo_urls.length > 1 ? 's' : ''}</span>` : '';

    const resolveBtn = canResolve
      ? `<button class="alert-resolve-btn" onclick="event.stopPropagation(); resolveAlertFromPage('${a.id}')">Mark Done ✓</button>`
      : '';

    return `
      <div class="alert-card" onclick="openAlertDetail(${JSON.stringify(a).replace(/"/g, '&quot;')})">
        <div class="alert-card-left">
          <span class="alert-type-badge" style="background:${meta.tagBg};color:${meta.tagFg};">${meta.icon} ${meta.label}</span>
          <div class="alert-card-msg">${escHtml(a.message)}</div>
          <div class="alert-card-meta">
            ${escHtml(a.submitter_name || a.submitter_username || 'System')} &bull; ${date}
            ${poolTag}${photos}
          </div>
        </div>
        <div class="alert-card-actions">
          ${resolveBtn}
          <span class="alert-detail-arrow">›</span>
        </div>
      </div>
    `;
  }).join('');
}

function _renderAlertHistory(alerts) {
  if (!alerts.length) {
    return `<div class="alerts-empty">No resolved alerts yet.</div>`;
  }

  return `
    <div class="alert-history-timeline">
      ${alerts.map(a => {
        const meta = _alertTypeMeta(a.type);
        const submitted = new Date(a.timestamp).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
        const resolved  = a.resolved_at ? new Date(a.resolved_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
        const poolTag = a.linked_pool_id ? `<span class="alert-pool-tag">${escHtml(a.linked_pool_id)}</span>` : '';
        const photos = (a.photo_urls || []).length ? `<span class="alert-photo-count">${a.photo_urls.length} 📷</span>` : '';

        return `
          <div class="alert-card alert-card--resolved" onclick="openAlertDetail(${JSON.stringify(a).replace(/"/g, '&quot;')})">
            <div class="alert-card-left">
              <span class="alert-type-badge" style="background:${meta.tagBg};color:${meta.tagFg};opacity:0.7;">${meta.icon} ${meta.label}</span>
              <div class="alert-card-msg" style="color:var(--muted);">${escHtml(a.message)}</div>
              <div class="alert-card-meta">
                Submitted by ${escHtml(a.submitter_name || a.submitter_username || 'System')} on ${submitted}
                ${poolTag}${photos}
              </div>
              <div class="alert-resolved-chip">
                ✓ Resolved by <strong>${escHtml(a.resolved_by || '—')}</strong> &bull; ${resolved}
              </div>
            </div>
            <span class="alert-detail-arrow" style="color:var(--muted);">›</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}
