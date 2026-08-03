// ══════════════════════════════════════════════════════════════════════════════
// BUILDER AUTH — invite claim (?invite=…), login, logout
// Backed by appscript/BuilderAuth.js. One account per pool company.
// ══════════════════════════════════════════════════════════════════════════════

let _bInviteToken = '';

function bAuthCard(html) {
  document.getElementById('b-app').style.display = 'none';
  const shell = document.getElementById('b-auth');
  shell.style.display = 'block';
  shell.innerHTML = html;
}

function bAuthError(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message || '';
  el.style.display = message ? 'block' : 'none';
}

// ── Invite claim ──────────────────────────────────────────────────────────────

function bRenderInviteLoading() {
  bAuthCard(`
    <div class="b-eyebrow">Checking your invite</div>
    <h2>One moment…</h2>
    <div class="b-spinner"></div>
  `);
}

function bRenderInviteClaim(companyName) {
  bAuthCard(`
    <div class="b-eyebrow">Set up your account</div>
    <h2>Welcome, ${escHtml(companyName)}</h2>
    <p class="b-muted">Choose a password to finish setting up your Builder Portal account.
       You'll use it with this email from now on.</p>
    <div class="b-field">
      <label for="b-inv-contact">Your name</label>
      <input id="b-inv-contact" type="text" autocomplete="name" placeholder="e.g. Jane Smith">
    </div>
    <div class="b-field">
      <label for="b-inv-phone">Phone (optional)</label>
      <input id="b-inv-phone" type="tel" autocomplete="tel">
    </div>
    <div class="b-field">
      <label for="b-inv-pw">Password</label>
      <input id="b-inv-pw" type="password" autocomplete="new-password" placeholder="At least 8 characters">
    </div>
    <div class="b-field">
      <label for="b-inv-pw2">Confirm password</label>
      <input id="b-inv-pw2" type="password" autocomplete="new-password">
    </div>
    <div class="b-msg err" id="b-inv-err"></div>
    <button class="b-btn primary" id="b-inv-btn" onclick="bSubmitInvite()">Create my account</button>
  `);
  const pw2 = document.getElementById('b-inv-pw2');
  if (pw2) pw2.addEventListener('keydown', e => { if (e.key === 'Enter') bSubmitInvite(); });
}

function bLookupInvite(token) {
  _bInviteToken = token;
  bRenderInviteLoading();
  bapiPublic({ action: 'builder_invite_lookup', invite: token })
    .then(res => {
      if (!res.ok) { bRenderLogin(res.error || 'This invite link is not valid.'); return; }
      bRenderInviteClaim(res.company_name || 'there');
    })
    .catch(() => bRenderLogin('We couldn\'t reach the server. Please reload the page.'));
}

function bSubmitInvite() {
  const contact = (document.getElementById('b-inv-contact') || {}).value || '';
  const phone = (document.getElementById('b-inv-phone') || {}).value || '';
  const pw = (document.getElementById('b-inv-pw') || {}).value || '';
  const pw2 = (document.getElementById('b-inv-pw2') || {}).value || '';
  const btn = document.getElementById('b-inv-btn');

  if (pw.length < 8) { bAuthError('b-inv-err', 'Password must be at least 8 characters.'); return; }
  if (pw !== pw2) { bAuthError('b-inv-err', 'The two passwords don\'t match.'); return; }

  bAuthError('b-inv-err', '');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

  bapiPublic({
    action: 'builder_invite_register',
    invite: _bInviteToken,
    password: pw,
    contact_name: contact.trim(),
    phone: phone.trim()
  }).then(res => {
    if (btn) { btn.disabled = false; btn.textContent = 'Create my account'; }
    if (!res.ok) { bAuthError('b-inv-err', res.error || 'We couldn\'t create the account.'); return; }
    bSaveSession({
      token: res.token,
      company_name: res.company_name,
      pool_company_id: res.pool_company_id
    });
    // Drop ?invite= so a refresh doesn't re-run a now-claimed invite.
    history.replaceState({}, '', location.pathname);
    bStart();
  }).catch(() => {
    if (btn) { btn.disabled = false; btn.textContent = 'Create my account'; }
    bAuthError('b-inv-err', 'We couldn\'t reach the server. Please try again.');
  });
}

// ── Login ─────────────────────────────────────────────────────────────────────

function bRenderLogin(notice) {
  bAuthCard(`
    <div class="b-eyebrow">Builder Portal</div>
    <h2>Sign in</h2>
    ${notice ? `<div class="b-notice">${escHtml(notice)}</div>` : ''}
    <div class="b-field">
      <label for="b-login-email">Email</label>
      <input id="b-login-email" type="email" autocomplete="username">
    </div>
    <div class="b-field">
      <label for="b-login-pw">Password</label>
      <input id="b-login-pw" type="password" autocomplete="current-password">
    </div>
    <div class="b-msg err" id="b-login-err"></div>
    <button class="b-btn primary" id="b-login-btn" onclick="bSubmitLogin()">Sign in</button>
    <p class="b-muted b-small">Need an account? Ask Mission Custom Pool Solutions to send you an invite.</p>
  `);
  const pw = document.getElementById('b-login-pw');
  if (pw) pw.addEventListener('keydown', e => { if (e.key === 'Enter') bSubmitLogin(); });
}

function bSubmitLogin() {
  const email = (document.getElementById('b-login-email') || {}).value || '';
  const pw = (document.getElementById('b-login-pw') || {}).value || '';
  const btn = document.getElementById('b-login-btn');
  if (!email.trim() || !pw) { bAuthError('b-login-err', 'Enter your email and password.'); return; }

  bAuthError('b-login-err', '');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }

  bapiPublic({ action: 'builder_login', email: email.trim(), password: pw })
    .then(res => {
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
      if (!res.ok) { bAuthError('b-login-err', res.error || 'Invalid email or password.'); return; }
      bSaveSession({
        token: res.token,
        company_name: res.company_name,
        pool_company_id: res.pool_company_id,
        email: email.trim()
      });
      bStart();
    })
    .catch(() => {
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
      bAuthError('b-login-err', 'We couldn\'t reach the server. Please try again.');
    });
}

// ── Logout ────────────────────────────────────────────────────────────────────

function bLogout() {
  // Fire and forget — the local session is cleared either way, but the server
  // revoke is what actually kills the row in Builder_Sessions.
  bapi({ action: 'builder_logout' }).catch(() => {});
  bClearSession();
  _bData = null;
  location.hash = '';
  bRenderLogin('You\'ve been signed out.');
}
