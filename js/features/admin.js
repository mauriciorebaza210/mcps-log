// ══════════════════════════════════════════════════════════════════════════════
// ADMIN — user CRUD, internal notes, form schema editor, availability grid
// Depends on: constants.js (SEC, ALL_ROLES, ALL_DAYS), api.js (api, apiGet), auth.js (isAdmin)
// Uses globals: _s, _editingUsername, _usersCache, _formSchema, _formItems, _pendingHires, _unassignedPools
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
    renderTutorialControls(_usersCache);
    // If profile tab is open, refresh the grid with fresh data
    if(_activeHubTab === 'profile') renderProfileTab();
  });
}

// ── Tutorial Controls — admin only ────────────────────────────────────────────
function renderTutorialControls(users) {
  const wrap = document.getElementById('adm-tutorial-controls');
  if (!wrap) return;

  // Show only to admins; technicians/leads never see this panel
  if (!isAdmin()) { wrap.style.display = 'none'; return; }

  const eligibleRoles = ['technician', 'lead', 'trainee'];
  const targets = (users || []).filter(u => {
    const roles = Array.isArray(u.roles) ? u.roles : String(u.roles||'').split(',').map(r=>r.trim());
    const active = u.active === true || String(u.active).toUpperCase() === 'TRUE';
    return active && roles.some(r => eligibleRoles.includes(r));
  }).sort((a, b) => String(a.name||'').localeCompare(String(b.name||'')));

  wrap.style.display = 'block';
  wrap.innerHTML =
    '<div class="adm-card" style="border:1px dashed var(--gold);background:#fffbf0">' +
      '<div class="adm-card-title" style="color:var(--gold)">🧪 Tutorial Controls <span style="font-size:.75rem;font-weight:400;color:var(--muted);margin-left:.5rem">Admin only</span></div>' +
      '<p style="font-size:.82rem;color:var(--muted);margin:.25rem 0 1rem">Reset a technician\'s tutorial state so it relaunches on their next login. Does not affect their onboarding data or account permissions.</p>' +
      '<div class="tour-admin-user-list">' +
        (targets.length
          ? targets.map(u => {
              const roles = Array.isArray(u.roles) ? u.roles : String(u.roles||'').split(',').map(r=>r.trim());
              const status = u.tutorial_status || 'not_started';
              const statusLabel = { not_started:'Not started', in_progress:'In progress', completed:'Completed', skipped:'Skipped' }[status] || status;
              const statusClass = { completed:'tour-admin-status-done', skipped:'tour-admin-status-skip', in_progress:'tour-admin-status-prog' }[status] || 'tour-admin-status-none';
              return '<div class="tour-admin-user-row">' +
                '<div class="tour-admin-user-info">' +
                  '<span class="tour-admin-name">' + escHtml(u.name || u.username) + '</span>' +
                  '<span class="tour-admin-role">' + escHtml(roles.join(', ')) + '</span>' +
                '</div>' +
                '<span class="tour-admin-status ' + statusClass + '">' + escHtml(statusLabel) + '</span>' +
                '<button class="tour-admin-reset-btn" data-uname="' + escHtml(u.username) + '" data-name="' + escHtml(u.name||u.username) + '"' +
                  (status === 'not_started' ? ' disabled title="Already not_started"' : '') +
                  '>Reset</button>' +
              '</div>';
            }).join('')
          : '<p style="color:var(--muted);font-size:.85rem">No eligible technicians found.</p>'
        ) +
      '</div>' +
    '</div>';

  wrap.querySelectorAll('.tour-admin-reset-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', function() {
      const uname = this.getAttribute('data-uname');
      const name  = this.getAttribute('data-name');
      if (!uname) return;
      if (!confirm('Reset tutorial state for ' + name + '?\n\nThey will see the welcome tour on their next login. This does not change their onboarding status or role.')) return;

      btn.textContent = 'Saving…';
      btn.disabled    = true;

      api({
        action:           'set_tutorial_state',
        token:            _s.token,
        target_username:  uname,
        tutorial_status:  'not_started',
        tutorial_version: typeof TOUR_VERSION !== 'undefined' ? TOUR_VERSION : 'technician-tour-v1',
        tutorial_started_at:   '',
        tutorial_completed_at: ''
      }).then(res => {
        if (res && res.ok) {
          btn.textContent = '✓ Reset';
          btn.style.color = 'var(--success)';
          // Update local cache and re-render
          const cached = (_usersCache || []).find(u => u.username === uname);
          if (cached) { cached.tutorial_status = 'not_started'; cached.tutorial_version = ''; }
          setTimeout(() => renderTutorialControls(_usersCache), 800);
        } else {
          btn.textContent = 'Retry';
          btn.disabled    = false;
          alert('Could not reset tutorial state: ' + ((res && res.error) || 'Unknown error'));
        }
      }).catch(() => {
        btn.textContent = 'Retry';
        btn.disabled    = false;
        alert('Network error — could not reach server.');
      });
    });
  });
}

// ── Admin Team Availability grid (lives in Profile tab) ───────────────────────
function renderAvailabilityGrid(){
  const body = document.getElementById('profile-avail-grid-body');
  if(!body) return;

  const users = _usersCache.filter(u => {
    const roles = Array.isArray(u.roles) ? u.roles : String(u.roles||'').split(',').map(r=>r.trim());
    const active = u.active === true || String(u.active).toUpperCase() === 'TRUE';
    return active && roles.some(r => ['technician','lead','manager'].includes(r));
  });
  if(!users.length){
    body.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">No technicians found. Users may still be loading.</div>';
    return;
  }

  const dayAbbr = ['Mon','Tue','Wed','Thu','Fri','Sat'];

  let html = '<table class="avail-grid">';
  html += '<thead><tr>';
  html += '<th class="ag-name-col">Technician</th>';
  dayAbbr.forEach(d => { html += `<th>${d}</th>`; });
  html += '</tr></thead><tbody>';

  users.forEach(u => {
    let prefs = {};
    if(u.shift_preferences){
      try{ prefs = JSON.parse(u.shift_preferences); } catch(e){ prefs = {}; }
    }
    const isSelected = u.username === _profileOp;
    html += `<tr onclick="switchProfileOp('${u.username}')" title="Edit ${u.name||u.username}'s availability"${isSelected?' class="ag-row-selected"':''}>`;
    html += `<td class="ag-name-cell">${u.name||u.username}</td>`;
    ALL_DAYS.forEach(day => {
      const val = prefs[day] || null;
      let badge = '<span class="ag-badge off">—</span>';
      if(val === 'am')   badge = '<span class="ag-badge am">AM</span>';
      if(val === 'pm')   badge = '<span class="ag-badge pm">PM</span>';
      if(val === 'full') badge = '<span class="ag-badge full">FULL</span>';
      html += `<td>${badge}</td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table>';
  body.innerHTML = html;
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
  const nhWarn = document.getElementById('new-hire-role-warning');
  const updateNewHireWarn = () => {
    if (!nhWarn || _editingUsername !== null) return;
    const nhChecked = document.querySelector('#role-checkboxes input[value="new_hire"]').checked;
    nhWarn.style.display = nhChecked ? 'none' : 'block';
  };
  if (nhWarn) nhWarn.style.display = 'none';
  if (!window._newHireRoleWarnBound) {
    document.querySelectorAll('#role-checkboxes input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', updateNewHireWarn);
    });
    window._newHireRoleWarnBound = true;
  }

  if (isNew) {
    document.getElementById('drawer-title').textContent = 'Add New User';
    document.getElementById('drawer-sub').textContent   = 'Fill in the details to create an account.';
    document.getElementById('d-uname').disabled         = false;
    document.getElementById('uname-hint').style.display = 'none';
    document.getElementById('d-pass-optional').style.display = 'none';
    // Default: new_hire — required for onboarding paperwork
    document.querySelector('#role-checkboxes input[value="new_hire"]').checked = true;
    document.getElementById('d-worker-type-wrap').style.display = 'block';
    document.getElementById('wt-1099').checked = true;
    updateNewHireWarn();
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
