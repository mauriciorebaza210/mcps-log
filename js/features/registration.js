// Employee invite registration — Sheets-backed first account layer.
// Depends on: api.js, auth.js constants/pages, app.js showApp

let _employeeInviteState = null;

function _registerHashParams_(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw.startsWith('register')) return null;
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  const slashToken = raw.startsWith('register/') ? raw.split('/')[1] : '';
  return { token: params.get('token') || slashToken || '' };
}

function initEmployeeRegistration(hash) {
  const params = _registerHashParams_(hash || location.hash);
  if (!params) return false;
  if (params.token) {
    _showEmployeeRegisterLoading_('Loading invite...');
    api({ action: 'employee_invite_lookup', token: params.token })
      .then(res => {
        if (!res.ok) return _showEmployeeRegisterError_(res.error || 'Invite not found.');
        _employeeInviteState = { mode: 'token', token: params.token, invite: res.invite };
        _renderEmployeeSetup_(res.invite);
      })
      .catch(() => _showEmployeeRegisterError_('Network error.'));
  } else {
    openEmployeeCodeRegistration(false);
  }
  return true;
}

function openEmployeeCodeRegistration(updateHash = true) {
  if (updateHash) location.hash = 'register';
  _employeeInviteState = null;
  document.getElementById('login-card-main').style.display = 'none';
  document.getElementById('employee-register-card').style.display = 'block';
  document.getElementById('employee-register-sub').textContent = 'Enter the code from your invite email';
  document.getElementById('employee-register-msg').style.display = 'none';
  document.getElementById('employee-register-body').innerHTML = `
    <div class="fg">
      <label for="emp-code-email">Email</label>
      <input type="email" id="emp-code-email" autocomplete="email" placeholder="you@example.com">
    </div>
    <div class="fg">
      <label for="emp-code">Employee Code</label>
      <input type="text" id="emp-code" autocomplete="one-time-code" autocapitalize="characters" placeholder="MCPS-123456">
    </div>
    <button class="btn-login" id="btn-verify-employee-code" onclick="verifyEmployeeCode()">Continue</button>
    <button class="btn-register-code" type="button" onclick="showLoginRegistration()">Back to sign in</button>`;
}

function showLoginRegistration() {
  document.getElementById('employee-register-card').style.display = 'none';
  document.getElementById('login-card-main').style.display = 'block';
  location.hash = '';
}

function verifyEmployeeCode() {
  const email = document.getElementById('emp-code-email').value.trim().toLowerCase();
  const code = document.getElementById('emp-code').value.trim().toUpperCase();
  const btn = document.getElementById('btn-verify-employee-code');
  if (!email || !code) return _showEmployeeRegisterError_('Enter email and employee code.');
  btn.disabled = true;
  btn.textContent = 'Checking...';
  api({ action: 'employee_invite_lookup', email, code })
    .then(res => {
      btn.disabled = false;
      btn.textContent = 'Continue';
      if (!res.ok) return _showEmployeeRegisterError_(res.error || 'Invalid code.');
      _employeeInviteState = { mode: 'code', email, code, invite: res.invite };
      _renderEmployeeSetup_(res.invite);
    })
    .catch(() => {
      btn.disabled = false;
      btn.textContent = 'Continue';
      _showEmployeeRegisterError_('Network error.');
    });
}

function _renderEmployeeSetup_(invite) {
  document.getElementById('login-card-main').style.display = 'none';
  document.getElementById('employee-register-card').style.display = 'block';
  document.getElementById('employee-register-sub').textContent = 'Set your password';
  document.getElementById('employee-register-msg').style.display = 'none';
  const fullName = [invite.first_name, invite.last_name].filter(Boolean).join(' ');
  document.getElementById('employee-register-body').innerHTML = `
    <div class="invite-summary">
      <div><span>Name</span><strong>${escHtml(fullName)}</strong></div>
      <div><span>Email</span><strong>${escHtml(invite.email)}</strong></div>
      <div><span>Phone</span><strong>${escHtml(invite.phone || 'Not set')}</strong></div>
      <div><span>Username</span><strong>${escHtml(invite.username)}</strong></div>
    </div>
    <div class="fg">
      <label for="emp-password">Password</label>
      <input type="password" id="emp-password" autocomplete="new-password" placeholder="Create password">
    </div>
    <div class="fg">
      <label for="emp-password2">Confirm Password</label>
      <input type="password" id="emp-password2" autocomplete="new-password" placeholder="Confirm password" onkeydown="if(event.key==='Enter')completeEmployeeRegistration()">
    </div>
    <button class="btn-login" id="btn-complete-employee-registration" onclick="completeEmployeeRegistration()">Create Account</button>
    <button class="btn-register-code" type="button" onclick="showLoginRegistration()">Back to sign in</button>`;
}

function completeEmployeeRegistration() {
  const password = document.getElementById('emp-password').value.trim();
  const confirm = document.getElementById('emp-password2').value.trim();
  const btn = document.getElementById('btn-complete-employee-registration');
  if (!_employeeInviteState) return _showEmployeeRegisterError_('Invite not loaded.');
  if (!password || password.length < 8) return _showEmployeeRegisterError_('Password must be at least 8 characters.');
  if (password !== confirm) return _showEmployeeRegisterError_('Passwords do not match.');

  const payload = { action: 'employee_register', password };
  if (_employeeInviteState.mode === 'token') payload.token = _employeeInviteState.token;
  if (_employeeInviteState.mode === 'code') {
    payload.email = _employeeInviteState.email;
    payload.code = _employeeInviteState.code;
  }

  btn.disabled = true;
  btn.textContent = 'Creating...';
  api(payload)
    .then(res => {
      btn.disabled = false;
      btn.textContent = 'Create Account';
      if (!res.ok) return _showEmployeeRegisterError_(res.error || 'Registration failed.');
      const roles = res.roles || ['new_hire'];
      _s = {
        token: res.token,
        name: res.name,
        roles,
        pages: unionPages_(roles),
        username: res.username,
        avatar_url: res.avatar_url || '',
        email: (_employeeInviteState && _employeeInviteState.invite && _employeeInviteState.invite.email) || ''
      };
      localStorage.setItem('mcps_s', JSON.stringify(_s));
      showApp('onboarding');
    })
    .catch(() => {
      btn.disabled = false;
      btn.textContent = 'Create Account';
      _showEmployeeRegisterError_('Network error.');
    });
}

function _showEmployeeRegisterLoading_(message) {
  document.getElementById('login-card-main').style.display = 'none';
  document.getElementById('employee-register-card').style.display = 'block';
  document.getElementById('employee-register-sub').textContent = message;
  document.getElementById('employee-register-msg').style.display = 'none';
  document.getElementById('employee-register-body').innerHTML = '<div style="text-align:center;color:var(--muted);padding:1rem">Please wait...</div>';
}

function _showEmployeeRegisterError_(message) {
  const el = document.getElementById('employee-register-msg');
  el.textContent = message;
  el.style.display = 'block';
}

function _suggestInviteUsername_() {
  const first = (document.getElementById('inv-first')?.value || '').trim().toLowerCase();
  const last = (document.getElementById('inv-last')?.value || '').trim().toLowerCase();
  const usernameEl = document.getElementById('inv-username');
  if (!usernameEl || usernameEl.dataset.touched === '1') return;
  usernameEl.value = (first.charAt(0) + last).replace(/[^a-z0-9._-]/g, '');
}

function createEmployeeInvite() {
  const msgEl = document.getElementById('employee-invite-msg');
  const resultEl = document.getElementById('employee-invite-result');
  const payload = {
    action: 'admin_create_employee_invite',
    token: _s.token,
    first_name: document.getElementById('inv-first').value.trim(),
    last_name: document.getElementById('inv-last').value.trim(),
    email: document.getElementById('inv-email').value.trim().toLowerCase(),
    phone: document.getElementById('inv-phone').value.trim(),
    username: document.getElementById('inv-username').value.trim().toLowerCase(),
    worker_type: document.getElementById('inv-worker-type').value,
    pay_rate: document.getElementById('inv-pay-rate').value.trim(),
    expires_days: document.getElementById('inv-expires-days').value
  };
  if (!payload.first_name || !payload.last_name || !payload.email || !payload.phone || !payload.username) {
    showMsg(msgEl, 'First name, last name, email, phone, and username are required.', false);
    return;
  }

  msgEl.style.display = 'block';
  msgEl.className = 'im';
  msgEl.textContent = 'Generating invite...';
  resultEl.style.display = 'none';
  api(payload).then(res => {
    if (!res.ok) {
      showMsg(msgEl, res.error || 'Failed to create invite.', false);
      return;
    }
    showMsg(msgEl, 'Invite generated.', true);
    resultEl.style.display = 'block';
    const emailNote = res.email_sent
      ? 'Zapier email triggered.'
      : 'Zapier email was not triggered: ' + (res.email_error || 'not configured') + '.';
    resultEl.innerHTML = `
      <div><span>Magic link</span><button onclick="copyEmployeeInviteText('invite-link')">Copy</button></div>
      <code id="invite-link">${escHtml(res.magic_link)}</code>
      <div><span>Employee code</span><button onclick="copyEmployeeInviteText('invite-code')">Copy</button></div>
      <code id="invite-code">${escHtml(res.employee_code)}</code>
      <p>${escHtml(emailNote)} The account will be created as <strong>new_hire</strong>.</p>`;
    loadEmployeeInvites();
  }).catch(() => showMsg(msgEl, 'Network error.', false));
}

function copyEmployeeInviteText(id) {
  const text = document.getElementById(id)?.textContent || '';
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
}

function loadEmployeeInvites() {
  const list = document.getElementById('employee-invite-list');
  if (!list || !_s || !_s.token) return;
  list.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1rem;font-size:.85rem">Loading invites...</div>';
  api({ action: 'admin_list_employee_invites', token: _s.token })
    .then(res => {
      if (!res.ok) {
        list.innerHTML = `<div style="color:var(--error);text-align:center;padding:1rem;font-size:.85rem">${escHtml(res.error || 'Failed to load invites.')}</div>`;
        return;
      }
      renderEmployeeInviteList(res.invites || []);
    })
    .catch(() => {
      list.innerHTML = '<div style="color:var(--error);text-align:center;padding:1rem;font-size:.85rem">Network error.</div>';
    });
}

function renderEmployeeInviteList(invites) {
  const list = document.getElementById('employee-invite-list');
  if (!list) return;
  if (!invites.length) {
    list.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1rem;font-size:.85rem">No employee invites yet.</div>';
    return;
  }
  list.innerHTML = invites.map(inv => {
    const fullName = [inv.first_name, inv.last_name].filter(Boolean).join(' ') || 'Unnamed';
    const status = inv.status_label || inv.status || 'active';
    const canCancel = status === 'active' || status === 'expired';
    return `
      <div class="employee-invite-row">
        <div class="employee-invite-person">
          <strong>${escHtml(fullName)}</strong>
          <span>${escHtml(inv.email || '')}</span>
          <span>@${escHtml(inv.username || '')}${inv.phone ? ' · ' + escHtml(inv.phone) : ''}</span>
        </div>
        <div class="employee-invite-meta">
          <span class="employee-invite-badge ${escHtml(status)}">${escHtml(status.replace('_', ' '))}</span>
          <span>${escHtml(inv.worker_type === 'w2_employee' ? 'W2' : '1099')}</span>
          <span>Expires ${escHtml(inv.expires_at_display || '—')}</span>
          ${inv.email_sent_at ? `<span class="employee-invite-email-ok">Email sent ${escHtml(inv.email_sent_at_display || '')}</span>` : ''}
          ${inv.email_error ? `<span class="employee-invite-email-err">Email not sent</span>` : ''}
        </div>
        <div class="employee-invite-actions">
          ${canCancel ? `<button type="button" onclick="resendEmployeeInvite('${escHtml(inv.invite_id)}')">Resend</button>` : ''}
          ${canCancel ? `<button type="button" onclick="cancelEmployeeInvite('${escHtml(inv.invite_id)}')">Cancel</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

function resendEmployeeInvite(inviteId) {
  if (!inviteId) return;
  const msgEl = document.getElementById('employee-invite-msg');
  if (msgEl) {
    msgEl.style.display = 'block';
    msgEl.className = 'im';
    msgEl.textContent = 'Resending invite...';
  }
  api({ action: 'admin_resend_employee_invite', token: _s.token, invite_id: inviteId })
    .then(res => {
      if (!res.ok) {
        if (msgEl) showMsg(msgEl, res.error || 'Failed to resend invite.', false);
        return;
      }
      if (msgEl) showMsg(msgEl, res.email_sent ? 'Invite resent.' : (res.email_error || 'Invite regenerated, but email was not sent.'), !!res.email_sent);
      loadEmployeeInvites();
    })
    .catch(() => {
      if (msgEl) showMsg(msgEl, 'Network error.', false);
    });
}

function cancelEmployeeInvite(inviteId) {
  if (!inviteId) return;
  api({ action: 'admin_cancel_employee_invite', token: _s.token, invite_id: inviteId })
    .then(res => {
      if (!res.ok) {
        const msgEl = document.getElementById('employee-invite-msg');
        if (msgEl) showMsg(msgEl, res.error || 'Failed to cancel invite.', false);
        return;
      }
      loadEmployeeInvites();
    })
    .catch(() => {
      const msgEl = document.getElementById('employee-invite-msg');
      if (msgEl) showMsg(msgEl, 'Network error.', false);
    });
}

document.addEventListener('input', e => {
  if (e.target && e.target.id === 'inv-username') e.target.dataset.touched = '1';
  if (e.target && (e.target.id === 'inv-first' || e.target.id === 'inv-last')) _suggestInviteUsername_();
});

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(loadEmployeeInvites, 800);
});
