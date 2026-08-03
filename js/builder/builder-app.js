// ══════════════════════════════════════════════════════════════════════════════
// BUILDER APP — shell + hash router
//   #dashboard              (default)
//   #request/<request_id>
//   #account
// ══════════════════════════════════════════════════════════════════════════════

let _bData = null;   // last builder_dashboard_data response

function bStart() {
  const invite = new URLSearchParams(location.search).get('invite');
  if (invite) { bLookupInvite(invite); return; }

  if (!bLoadSession() || !bToken()) { bRenderLogin(); return; }
  bLoadDashboard();
}

function bLoadDashboard(silent) {
  if (!silent) {
    document.getElementById('b-auth').style.display = 'none';
    const app = document.getElementById('b-app');
    app.style.display = 'block';
    app.innerHTML = '<div class="b-card"><div class="b-spinner"></div></div>';
  }

  // This call doubles as session restore — `expired` means the stored token is
  // no longer good, which is a login prompt, not an error to shout about.
  return bapi({ action: 'builder_dashboard_data' })
    .then(res => {
      if (!res.ok) {
        if (res.expired) { bClearSession(); bRenderLogin('Your session expired. Please sign in again.'); return; }
        bRenderAppError(res.error || 'We couldn\'t load your dashboard.');
        return;
      }
      _bData = res;
      bRenderHeader();
      bRoute();
    })
    .catch(() => bRenderAppError('We couldn\'t reach the server. Please check your connection.'));
}

function bRenderAppError(message) {
  document.getElementById('b-auth').style.display = 'none';
  const app = document.getElementById('b-app');
  app.style.display = 'block';
  app.innerHTML = `
    <div class="b-card b-center">
      <div class="b-eyebrow">Something went wrong</div>
      <p class="b-muted">${escHtml(message)}</p>
      <button class="b-btn" onclick="bLoadDashboard()">Try again</button>
    </div>`;
}

function bRenderHeader() {
  const bar = document.getElementById('b-topbar');
  if (!bar || !_bData) return;
  const tab = bCurrentRoute().view;
  const item = (view, label) =>
    `<button class="b-nav-item${tab === view ? ' active' : ''}" onclick="location.hash='#${view}'">${label}</button>`;
  bar.innerHTML = `
    <div class="b-topbar-inner">
      <div class="b-brand">
        <span class="b-brand-name">${escHtml(_bData.company.company_name || 'Builder Portal')}</span>
        <span class="b-brand-sub">Mission Custom Pool Solutions</span>
      </div>
      <nav class="b-nav">
        ${item('dashboard', 'My pools')}
        ${item('account', 'Account')}
        <button class="b-nav-item" onclick="bLogout()">Sign out</button>
      </nav>
    </div>`;
  bar.style.display = 'block';
}

function bCurrentRoute() {
  const raw = (location.hash || '#dashboard').replace(/^#/, '');
  const parts = raw.split('/');
  return { view: parts[0] || 'dashboard', id: parts[1] ? decodeURIComponent(parts[1]) : '' };
}

function bRoute() {
  if (!_bData) return;
  const { view, id } = bCurrentRoute();
  bRenderHeader();
  if (view === 'request' && id) return bRenderRequestDetail(id);
  if (view === 'account') return bRenderAccount();
  return bRenderDashboard();
}

window.addEventListener('hashchange', bRoute);
window.addEventListener('DOMContentLoaded', bStart);
