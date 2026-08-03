// ══════════════════════════════════════════════════════════════════════════════
// BUILDER DASHBOARD — pools list, read-only request detail, account settings
//
// The request detail is deliberately read-only. The startup wizard is the only
// submission surface, and admins are the only post-submit editors; the one
// interactive control here is the existing date-change request.
// ══════════════════════════════════════════════════════════════════════════════

const B_STATUS = {
  pending_review: { label: 'Pending review', cls: 'pending' },
  approved:       { label: 'Approved',       cls: 'approved' },
  rejected:       { label: 'Not approved',   cls: 'rejected' }
};

function bStatusPill(status) {
  const s = B_STATUS[status] || { label: status || 'Unknown', cls: 'pending' };
  return `<span class="b-pill ${s.cls}">${escHtml(s.label)}</span>`;
}

function bWho(r) {
  return [r.first_name, r.last_name].filter(Boolean).join(' ') || r.address || r.request_id;
}

function bDate(value) {
  if (!value) return '—';
  const raw = String(value).split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return escHtml(String(value));
  const d = new Date(raw + 'T12:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function bRenderDashboard() {
  const app = document.getElementById('b-app');
  const { counts, requests, company } = _bData;

  const newRequestBtn = company.request_token
    ? `<a class="b-btn primary" href="/startup-request?t=${encodeURIComponent(company.request_token)}">Submit a new pool</a>`
    : `<span class="b-muted b-small">Ask MCPS for your submission link.</span>`;

  if (!requests.length) {
    app.innerHTML = `
      <div class="b-card b-center">
        <div class="b-eyebrow">No pools yet</div>
        <h2>Submit your first pool</h2>
        <p class="b-muted">Photograph the construction sheet and we'll read the details off it —
           MCPS reviews every request before scheduling.</p>
        ${newRequestBtn}
      </div>`;
    return;
  }

  const tile = (n, label, cls) =>
    `<div class="b-tile ${cls}"><div class="b-tile-n">${n}</div><div class="b-tile-l">${label}</div></div>`;

  const groups = [
    ['Pending review', requests.filter(r => r.status === 'pending_review')],
    ['Approved', requests.filter(r => r.status === 'approved')],
    ['Not approved', requests.filter(r => r.status === 'rejected')]
  ].filter(g => g[1].length);

  app.innerHTML = `
    <div class="b-headrow">
      <div>
        <div class="b-eyebrow">Your pools</div>
        <h2>Welcome back</h2>
      </div>
      ${newRequestBtn}
    </div>

    <div class="b-tiles">
      ${tile(counts.pending, 'Pending review', 'pending')}
      ${tile(counts.approved, 'Approved', 'approved')}
      ${tile(counts.rejected, 'Not approved', 'rejected')}
    </div>

    ${groups.map(([title, rows]) => `
      <div class="b-group">
        <div class="b-group-title">${escHtml(title)}</div>
        ${rows.map(r => `
          <button class="b-row" onclick="location.hash='#request/${encodeURIComponent(r.request_id)}'">
            <div class="b-row-main">
              <div class="b-row-name">${escHtml(bWho(r))}</div>
              <div class="b-row-sub">${escHtml(r.address || 'No address')}${r.city ? ', ' + escHtml(r.city) : ''}</div>
            </div>
            <div class="b-row-side">
              ${bStatusPill(r.status)}
              ${r.status === 'approved' && r.requested_start_date
                ? `<div class="b-row-date">Starts ${bDate(r.requested_start_date)}</div>` : ''}
              ${r.change_requested_at ? `<div class="b-row-flag">Date change under review</div>` : ''}
            </div>
          </button>`).join('')}
      </div>`).join('')}
  `;
}

// ── Request detail (read-only + date change) ─────────────────────────────────

function bFindRequest(requestId) {
  return (_bData.requests || []).find(r => r.request_id === requestId);
}

function bRenderRequestDetail(requestId) {
  const app = document.getElementById('b-app');
  const r = bFindRequest(requestId);
  if (!r) {
    app.innerHTML = `
      <div class="b-card b-center">
        <p class="b-muted">We couldn't find that request.</p>
        <button class="b-btn" onclick="location.hash='#dashboard'">Back to my pools</button>
      </div>`;
    return;
  }

  const spec = [
    ['Phone', r.phone], ['Email', r.email],
    ['Address', [r.address, r.city, r.zip_code].filter(Boolean).join(', ')],
    ['Pool shape', r.pool_shape], ['Dimensions', r.pool_dimensions], ['Depth', r.pool_depth],
    ['Spa', r.spa], ['Water features', r.water_features],
    ['Plaster', r.plaster_type], ['Plaster date', r.plaster_date ? bDate(r.plaster_date) : ''],
    ['Total gallons', r.total_gallons_est],
    ['Filter', r.equip_filter], ['Pump', r.equip_pump], ['Heater', r.equip_heater],
    ['Chlorinator', r.equip_chlorinator], ['Salt system', r.equip_salt_system],
    ['Booster', r.equip_booster],
    ['Notes', r.notes]
  ].filter(([, v]) => String(v || '').trim());

  let photos = [];
  try { photos = JSON.parse(r.photo_urls || '[]'); } catch (e) {}

  const flagged = !!String(r.change_requested_at || '').trim();
  const canRequestChange = (r.status === 'pending_review' || r.status === 'approved') && !flagged;

  app.innerHTML = `
    <button class="b-back" onclick="location.hash='#dashboard'">← My pools</button>

    <div class="b-card">
      <div class="b-detail-head">
        <div>
          <div class="b-eyebrow">${escHtml(r.request_id)}</div>
          <h2>${escHtml(bWho(r))}</h2>
        </div>
        ${bStatusPill(r.status)}
      </div>

      ${r.status === 'approved' ? `
        <div class="b-notice ok">Startup scheduled to begin <b>${bDate(r.requested_start_date)}</b>.</div>` : ''}
      ${r.status === 'pending_review' ? `
        <div class="b-notice">MCPS is reviewing this request${r.requested_start_date
          ? ` — you asked for ${bDate(r.requested_start_date)}` : ''}.</div>` : ''}
      ${r.status === 'rejected' && r.admin_notes ? `
        <div class="b-notice warn">${escHtml(r.admin_notes)}</div>` : ''}
      ${flagged ? `
        <div class="b-notice">You asked to move this to ${bDate(r.change_requested_date)}${
          r.change_requested_note ? ': ' + escHtml(r.change_requested_note) : ''}. MCPS is reviewing it.</div>` : ''}

      ${photos.length ? `
        <div class="b-photos">
          ${photos.map(p => `<a href="${escHtml(p.file || p.thumb)}" target="_blank" rel="noopener">
            <img src="${escHtml(p.thumb || p.file)}" alt="Construction sheet">
          </a>`).join('')}
        </div>` : ''}

      <div class="b-spec">
        ${spec.map(([k, v]) => `
          <div class="b-spec-row"><span class="b-spec-k">${escHtml(k)}</span><span class="b-spec-v">${escHtml(v)}</span></div>
        `).join('')}
      </div>
      <p class="b-muted b-small">Submitted ${bDate(r.submitted_at)}. Need something changed?
         Contact MCPS and we'll update it for you.</p>
    </div>

    ${canRequestChange ? `
      <div class="b-card">
        <div class="b-group-title">Request a different date</div>
        <div class="b-field">
          <label for="b-cr-date">New requested date</label>
          <input id="b-cr-date" type="date">
        </div>
        <div class="b-field">
          <label for="b-cr-note">Note (optional)</label>
          <textarea id="b-cr-note" rows="3"></textarea>
        </div>
        <div class="b-msg" id="b-cr-msg"></div>
        <button class="b-btn primary" id="b-cr-btn" onclick="bSubmitDateChange('${escHtml(r.request_id)}')">Send request</button>
      </div>` : ''}
  `;
}

function bSubmitDateChange(requestId) {
  const dateEl = document.getElementById('b-cr-date');
  const noteEl = document.getElementById('b-cr-note');
  const msg = document.getElementById('b-cr-msg');
  const btn = document.getElementById('b-cr-btn');
  if (!dateEl || !dateEl.value) {
    msg.className = 'b-msg err'; msg.textContent = 'Please pick a date.';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  msg.className = 'b-msg'; msg.textContent = '';

  // Reuses the same public handler the anonymous status page calls — it resolves
  // the company from the request token, so the portal passes it through.
  bapi({
    action: 'startup_request_request_change',
    t: _bData.company.request_token,
    request_id: requestId,
    requested_date: dateEl.value,
    note: (noteEl.value || '').trim()
  }).then(res => {
    if (btn) { btn.disabled = false; btn.textContent = 'Send request'; }
    if (!res.ok) {
      msg.className = 'b-msg err';
      msg.textContent = res.error || 'We couldn\'t send that. Please try again.';
      return;
    }
    bLoadDashboard(true).then(() => bRoute());
  }).catch(() => {
    if (btn) { btn.disabled = false; btn.textContent = 'Send request'; }
    msg.className = 'b-msg err';
    msg.textContent = 'We couldn\'t reach the server. Please try again.';
  });
}

// ── Account ───────────────────────────────────────────────────────────────────

function bRenderAccount() {
  const app = document.getElementById('b-app');
  const c = _bData.company;
  const a = _bData.account;

  app.innerHTML = `
    <div class="b-headrow">
      <div>
        <div class="b-eyebrow">Account</div>
        <h2>${escHtml(c.company_name)}</h2>
      </div>
    </div>

    <div class="b-card">
      <div class="b-group-title">Company details</div>
      <div class="b-field">
        <label for="b-acc-contact">Contact name</label>
        <input id="b-acc-contact" type="text" value="${escHtml(a.contact_name || c.contact_name || '')}">
      </div>
      <div class="b-field">
        <label for="b-acc-phone">Phone</label>
        <input id="b-acc-phone" type="tel" value="${escHtml(c.phone || '')}">
      </div>
      <div class="b-field">
        <label for="b-acc-email">Service report email</label>
        <input id="b-acc-email" type="email" value="${escHtml(c.report_bcc_email || '')}">
        <div class="b-hint">Where we copy service reports for your pools.</div>
      </div>
      <div class="b-field">
        <label>Sign-in email</label>
        <input type="email" value="${escHtml(a.email || '')}" disabled>
        <div class="b-hint">This is your login — contact MCPS to change it.</div>
      </div>
    </div>

    <div class="b-card">
      <div class="b-group-title">Change password</div>
      <div class="b-field">
        <label for="b-acc-pw-cur">Current password</label>
        <input id="b-acc-pw-cur" type="password" autocomplete="current-password">
      </div>
      <div class="b-field">
        <label for="b-acc-pw-new">New password</label>
        <input id="b-acc-pw-new" type="password" autocomplete="new-password" placeholder="At least 8 characters">
      </div>
      <div class="b-hint">Leave both blank to keep your current password.</div>
    </div>

    <div class="b-msg" id="b-acc-msg"></div>
    <button class="b-btn primary" id="b-acc-btn" onclick="bSaveAccount()">Save changes</button>
  `;
}

function bSaveAccount() {
  const msg = document.getElementById('b-acc-msg');
  const btn = document.getElementById('b-acc-btn');
  const val = id => (document.getElementById(id) || {}).value || '';

  const newPw = val('b-acc-pw-new').trim();
  if (newPw && newPw.length < 8) {
    msg.className = 'b-msg err'; msg.textContent = 'New password must be at least 8 characters.';
    return;
  }
  if (newPw && !val('b-acc-pw-cur').trim()) {
    msg.className = 'b-msg err'; msg.textContent = 'Enter your current password to change it.';
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  msg.className = 'b-msg'; msg.textContent = '';

  // No pool_company_id is sent — the server scopes the write to the session.
  bapi({
    action: 'builder_account_update',
    contact_name: val('b-acc-contact').trim(),
    phone: val('b-acc-phone').trim(),
    report_bcc_email: val('b-acc-email').trim(),
    current_password: val('b-acc-pw-cur').trim(),
    new_password: newPw
  }).then(res => {
    if (btn) { btn.disabled = false; btn.textContent = 'Save changes'; }
    if (!res.ok) {
      if (res.expired) { bClearSession(); bRenderLogin('Your session expired. Please sign in again.'); return; }
      msg.className = 'b-msg err'; msg.textContent = res.error || 'We couldn\'t save that.';
      return;
    }
    msg.className = 'b-msg ok'; msg.textContent = 'Saved.';
    bLoadDashboard(true);
  }).catch(() => {
    if (btn) { btn.disabled = false; btn.textContent = 'Save changes'; }
    msg.className = 'b-msg err'; msg.textContent = 'We couldn\'t reach the server. Please try again.';
  });
}
