// BuilderAuth.gs
// Authentication for the external Builder Portal (pool-building companies).
// Invite-first, mirroring the employee invite/register pattern in UserAuth.js
// (handleCreateEmployeeInvite/handleEmployeeRegister) but fully isolated:
// separate sheets (Builder_Invites/Builder_Accounts/Builder_Sessions, all on
// the CRM SS via the shared ensureSheet_ helper), separate session cache
// prefix, separate validator — a bug here cannot touch employee auth.

const BUILDER_INVITE_HEADERS = [
  'invite_id', 'pool_company_id', 'company_name', 'email', 'invite_token_hash',
  'expires_at', 'used_at', 'created_by', 'created_at', 'status',
  'email_sent_to', 'email_sent_at', 'email_error'
];

const BUILDER_ACCOUNT_HEADERS = [
  'builder_account_id', 'email', 'password_hash', 'pool_company_id', 'company_name',
  'contact_name', 'phone', 'status', 'created_at', 'updated_at', 'last_login'
];

const BUILDER_SESSION_HEADERS = [
  'token', 'builder_account_id', 'email', 'pool_company_id',
  'created_at', 'expires_at', 'revoked'
];

// External, lower-trust, infrequent-use surface — shorter than the 30-day employee default.
const BA_SESSION_TTL_DAYS = 7;

function getBuilderInvitesSheet_() { return ensureSheet_('Builder_Invites', BUILDER_INVITE_HEADERS); }
function getBuilderAccountsSheet_() { return ensureSheet_('Builder_Accounts', BUILDER_ACCOUNT_HEADERS); }
function getBuilderSessionsSheet_() { return ensureSheet_('Builder_Sessions', BUILDER_SESSION_HEADERS); }

// ─── Lookups ──────────────────────────────────────────────────────────────────

function baFindInviteByTokenHash_(tokenHash) {
  const sheet = getBuilderInvitesSheet_();
  const parsed = sheetToObjects_(sheet);
  const row = parsed.rows.find(function(r) { return String(r.invite_token_hash || '').trim() === tokenHash; });
  return { sheet: sheet, headers: parsed.headers, row: row || null };
}

function baFindOpenInviteByCompany_(poolCompanyId) {
  const sheet = getBuilderInvitesSheet_();
  const parsed = sheetToObjects_(sheet);
  const row = parsed.rows.find(function(r) {
    return String(r.pool_company_id || '').trim() === String(poolCompanyId || '').trim() &&
      String(r.status || '') === 'active';
  });
  return { sheet: sheet, headers: parsed.headers, row: row || null };
}

function baFindAccountByEmail_(email) {
  const sheet = getBuilderAccountsSheet_();
  const parsed = sheetToObjects_(sheet);
  const target = String(email || '').trim().toLowerCase();
  const row = parsed.rows.find(function(r) { return String(r.email || '').trim().toLowerCase() === target; });
  return { sheet: sheet, headers: parsed.headers, row: row || null };
}

function baFindAccountByCompanyId_(poolCompanyId) {
  const sheet = getBuilderAccountsSheet_();
  const parsed = sheetToObjects_(sheet);
  const row = parsed.rows.find(function(r) {
    return String(r.pool_company_id || '').trim() === String(poolCompanyId || '').trim() &&
      String(r.status || '') === 'active';
  });
  return { sheet: sheet, headers: parsed.headers, row: row || null };
}

function baFindCompanyById_(poolCompanyId) {
  const sheet = ensureSheet_('Pool_Companies', MCPS_POOL_COMPANY_HEADERS);
  return findRowByValue_(sheet, 'pool_company_id', poolCompanyId);
}

// ─── Session model (isolated parallel of UserAuth.js's Sessions pattern) ─────

function baCreateSession_(account) {
  const token = generateToken_();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + BA_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const sheet = getBuilderSessionsSheet_();
  appendObject_(sheet, {
    token: token,
    builder_account_id: account.builder_account_id,
    email: account.email,
    pool_company_id: account.pool_company_id,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    revoked: false
  }, BUILDER_SESSION_HEADERS);
  return token;
}

function baGetSession_(token) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'bsess:' + token;
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  const sheet = getBuilderSessionsSheet_();
  const parsed = sheetToObjects_(sheet);
  const row = parsed.rows.find(function(r) { return String(r.token || '').trim() === token; });
  if (!row) return null;
  try { cache.put(cacheKey, JSON.stringify(row), 300); } catch (e) {}
  return row;
}

function baValidateBuilderToken_(token) {
  if (!token) return { ok: false, error: 'No token provided.' };
  const session = baGetSession_(token);
  if (!session) return { ok: false, error: 'Session not found. Please log in again.' };
  if (session.revoked === true || String(session.revoked).toUpperCase() === 'TRUE') {
    return { ok: false, error: 'Session revoked. Please log in again.' };
  }
  if (isExpired_(session)) {
    baRevokeSession_(token);
    return { ok: false, error: 'Session expired. Please log in again.' };
  }
  return {
    ok: true,
    account: {
      builder_account_id: session.builder_account_id,
      email: session.email,
      pool_company_id: session.pool_company_id
    }
  };
}

// Builder analogue of srRequireAdmin_ — used to gate every builder-session action.
//
// The portal sends the session as `builder_token`, deliberately NOT `token`:
// js/lib/api.js auto-injects a STAFF token from localStorage into any payload
// that omits `token`, and the portal shares an origin with the staff SPA. Keeping
// the two in separate keys means neither side can ever be mistaken for the other.
// `token` stays accepted as a back-compat fallback for anything already deployed.
function baRequireBuilder_(payload) {
  return baValidateBuilderToken_(payload.builder_token || payload.token || '');
}

function baRevokeSession_(token) {
  if (!token) return;
  CacheService.getScriptCache().remove('bsess:' + token);
  const sheet = getBuilderSessionsSheet_();
  const parsed = sheetToObjects_(sheet);
  const row = parsed.rows.find(function(r) { return String(r.token || '').trim() === token; });
  if (row) srSetRowValues_(sheet, parsed.headers, row._rowNum, { revoked: true });
}

// ─── Admin: create + send an invite ──────────────────────────────────────────

function handleCreateBuilderInvite_(payload) {
  const gate = srRequireAdmin_(payload.token);
  if (!gate.ok) return gate;
  const auth = gate.auth;

  let poolCompanyId = String(payload.pool_company_id || '').trim();
  let companyName = '';

  if (poolCompanyId) {
    const company = baFindCompanyById_(poolCompanyId);
    if (!company) return { ok: false, error: 'Company not found.' };
    companyName = company.company_name;
  } else {
    const typedName = String(payload.company_name || '').trim();
    if (!typedName) return { ok: false, error: 'pool_company_id or company_name is required.' };
    const res = upsertPoolCompany_({
      company_name: typedName,
      report_bcc_email: payload.report_bcc_email || payload.email || '',
      contact_name: payload.contact_name || '',
      phone: payload.phone || ''
    });
    if (!res.ok) return res;
    poolCompanyId = res.pool_company_id;
    companyName = typedName;
  }

  const existingAccount = baFindAccountByCompanyId_(poolCompanyId);
  if (existingAccount.row) return { ok: false, error: 'This company already has an active Builder Portal account.' };

  const openInvite = baFindOpenInviteByCompany_(poolCompanyId);
  if (openInvite.row) return { ok: false, error: 'An unclaimed invite already exists for this company.' };

  const email = String(payload.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Enter a valid email.' };

  const expiresDays = Math.max(1, Math.min(30, Number(payload.expires_days || 7)));
  const token = generateToken_() + generateToken_();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresDays * 24 * 60 * 60 * 1000);
  const inviteId = 'BIN-' + Utilities.getUuid().substring(0, 8).toUpperCase();

  const sheet = getBuilderInvitesSheet_();
  appendObject_(sheet, {
    invite_id: inviteId,
    pool_company_id: poolCompanyId,
    company_name: companyName,
    email: email,
    invite_token_hash: hashInviteSecret_(token),
    expires_at: expiresAt.toISOString(),
    used_at: '',
    created_by: auth.user ? auth.user.username : auth.username,
    created_at: now.toISOString(),
    status: 'active'
  }, BUILDER_INVITE_HEADERS);

  const link = getPortalBaseUrl_() + '/builder-portal?invite=' + encodeURIComponent(token);
  srSendBuilderEmail_(
    email,
    'You\'re invited to the MCPS Builder Portal',
    'Hi,\n\n' +
    'Mission Custom Pool Solutions has set up a Builder Portal account for ' + companyName + '.\n\n' +
    'Set up your account here: ' + link + '\n\n' +
    'This link expires in ' + expiresDays + ' day' + (expiresDays === 1 ? '' : 's') + '.\n\n' +
    '— Mission Custom Pool Solutions'
  );

  return { ok: true, invite_id: inviteId, pool_company_id: poolCompanyId, company_name: companyName, email: email, expires_at: expiresAt.toISOString() };
}

// ─── Public: claim the invite ─────────────────────────────────────────────────

function handleBuilderInviteLookup_(payload) {
  const token = String(payload.invite || payload.token || '').trim();
  if (!token) return { ok: false, error: 'Missing invite token.' };
  if (srRateLimitExceeded_('bilu', token.slice(0, 24), 30)) {
    return { ok: false, error: 'Too many attempts — please try again in a few minutes.' };
  }
  const found = baFindInviteByTokenHash_(hashInviteSecret_(token));
  if (!found.row) return { ok: false, error: 'This invite link is invalid.' };
  if (String(found.row.status || '') !== 'active') return { ok: false, error: 'This invite has already been used or was revoked.' };
  if (isExpired_({ expires_at: found.row.expires_at })) return { ok: false, error: 'This invite link has expired. Please ask MCPS to send a new one.' };
  return { ok: true, company_name: found.row.company_name };
}

function handleBuilderInviteRegister_(payload) {
  const token = String(payload.invite || payload.token || '').trim();
  if (srRateLimitExceeded_('bireg', token.slice(0, 24), 10)) {
    return { ok: false, error: 'Too many attempts — please try again in a few minutes.' };
  }

  const password = String(payload.password || '').trim();
  if (password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const found = baFindInviteByTokenHash_(hashInviteSecret_(token));
    if (!found.row) return { ok: false, error: 'This invite link is invalid.' };
    if (String(found.row.status || '') !== 'active') return { ok: false, error: 'This invite has already been used or was revoked.' };
    if (isExpired_({ expires_at: found.row.expires_at })) return { ok: false, error: 'This invite link has expired. Please ask MCPS to send a new one.' };

    const existingAccount = baFindAccountByCompanyId_(found.row.pool_company_id);
    if (existingAccount.row) return { ok: false, error: 'This company already has an active Builder Portal account.' };

    const now = new Date().toISOString();
    const accountId = 'BAC-' + Utilities.getUuid().substring(0, 8).toUpperCase();
    appendObject_(getBuilderAccountsSheet_(), {
      builder_account_id: accountId,
      email: found.row.email,
      password_hash: hashPassword_(password),
      pool_company_id: found.row.pool_company_id,
      company_name: found.row.company_name,
      contact_name: String(payload.contact_name || '').trim(),
      phone: String(payload.phone || '').trim(),
      status: 'active',
      created_at: now,
      updated_at: now,
      last_login: now
    }, BUILDER_ACCOUNT_HEADERS);

    srSetRowValues_(found.sheet, found.headers, found.row._rowNum, {
      status: 'claimed',
      used_at: now
    });

    const sessionToken = baCreateSession_({
      builder_account_id: accountId,
      email: found.row.email,
      pool_company_id: found.row.pool_company_id
    });

    return {
      ok: true,
      token: sessionToken,
      company_name: found.row.company_name,
      pool_company_id: found.row.pool_company_id
    };
  } finally {
    lock.releaseLock();
  }
}

// ─── Returning builder: login / logout ───────────────────────────────────────

function handleBuilderLogin_(payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '').trim();
  if (!email || !password) return { ok: false, error: 'Email and password are required.' };
  if (srRateLimitExceeded_('blogin', email, 10)) {
    return { ok: false, error: 'Too many attempts — please try again in a few minutes.' };
  }
  const found = baFindAccountByEmail_(email);
  if (!found.row || String(found.row.status || '') !== 'active') return { ok: false, error: 'Invalid email or password.' };
  if (hashPassword_(password) !== found.row.password_hash) return { ok: false, error: 'Invalid email or password.' };

  srSetRowValues_(found.sheet, found.headers, found.row._rowNum, { last_login: new Date().toISOString() });

  const token = baCreateSession_({
    builder_account_id: found.row.builder_account_id,
    email: found.row.email,
    pool_company_id: found.row.pool_company_id
  });
  return { ok: true, token: token, company_name: found.row.company_name, pool_company_id: found.row.pool_company_id };
}

// Must read the same key baRequireBuilder_ does. If it only looked at `token`,
// logout would return ok:true, the portal would clear its local session, and the
// row would stay live in Builder_Sessions for its full 7-day TTL — a silent no-op
// that looks exactly like success.
function handleBuilderLogout_(payload) {
  baRevokeSession_(payload.builder_token || payload.token || '');
  return { ok: true };
}

// ─── Portal: dashboard + session restore ─────────────────────────────────────
//
// Doubles as the session-restore call: the portal fires this on load and treats
// `expired` as "clear mcps_builder_s and show the login card" rather than an error.
function handleBuilderDashboardData_(payload) {
  const gate = baRequireBuilder_(payload);
  if (!gate.ok) return { ok: false, expired: true, error: gate.error };

  const companyId = String(gate.account.pool_company_id || '').trim();
  const company = baFindCompanyById_(companyId);
  if (!company) return { ok: false, error: 'Company not found.' };

  const account = baFindAccountByEmail_(gate.account.email);
  const rows = sheetToObjects_(getStartupRequestsSheet_()).rows.filter(function(r) {
    return String(r.pool_company_id || '').trim() === companyId;
  });

  // Only what the builder submitted or needs to see — raw_extraction is internal
  // AI noise, and approved_by is staff detail that doesn't belong to the tenant.
  const BA_REQUEST_FIELDS = [
    'request_id', 'status', 'first_name', 'last_name', 'email', 'phone',
    'address', 'city', 'zip_code', 'pool_shape', 'pool_dimensions', 'pool_depth',
    'spa', 'water_features', 'plaster_type', 'plaster_date',
    'equip_filter', 'equip_pump', 'equip_heater', 'equip_chlorinator',
    'equip_salt_system', 'equip_booster', 'total_gallons_est',
    'requested_start_date', 'notes', 'photo_urls', 'admin_notes',
    'change_requested_date', 'change_requested_note', 'change_requested_at',
    'submitted_at', 'approved_at', 'pool_id'
  ];
  const requests = rows.map(function(r) {
    const out = {};
    BA_REQUEST_FIELDS.forEach(function(f) { out[f] = String(r[f] === undefined || r[f] === null ? '' : r[f]); });
    // Rejection reasons are shown to the builder; other admin notes are not.
    if (String(r.status || '') !== 'rejected') out.admin_notes = '';
    return out;
  }).reverse(); // newest first

  const counts = { pending: 0, approved: 0, rejected: 0 };
  requests.forEach(function(r) {
    if (r.status === 'pending_review') counts.pending++;
    else if (r.status === 'approved') counts.approved++;
    else if (r.status === 'rejected') counts.rejected++;
  });

  return {
    ok: true,
    company: {
      pool_company_id: companyId,
      company_name: company.company_name || '',
      contact_name: company.contact_name || '',
      phone: company.phone || '',
      report_bcc_email: company.report_bcc_email || '',
      // Lets "Submit a new pool" hand off to the existing wizard pre-identified.
      request_token: String(company.request_token || '')
    },
    account: {
      email: gate.account.email,
      contact_name: account.row ? String(account.row.contact_name || '') : ''
    },
    counts: counts,
    requests: requests
  };
}

// ─── Portal: update the company profile / password ───────────────────────────
function handleBuilderAccountUpdate_(payload) {
  const gate = baRequireBuilder_(payload);
  if (!gate.ok) return { ok: false, expired: true, error: gate.error };

  // Tenant scoping is derived from the session, never from the request. A
  // pool_company_id in the payload is ignored outright — not read, not compared.
  const companyId = String(gate.account.pool_company_id || '').trim();
  const company = baFindCompanyById_(companyId);
  if (!company) return { ok: false, error: 'Company not found.' };

  const contactName = String(payload.contact_name || '').trim().slice(0, 120);
  const phone = String(payload.phone || '').trim().slice(0, 40);
  const reportEmail = String(payload.report_bcc_email || '').trim().toLowerCase().slice(0, 160);
  if (reportEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(reportEmail)) {
    return { ok: false, error: 'Enter a valid report email.' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // Pool_Companies is the profile of record — it is what the intake resolves and
    // what report emails BCC. Builder_Accounts gets the same values mirrored back so
    // the login record can't drift out of sync with it.
    const companySheet = ensureSheet_('Pool_Companies', MCPS_POOL_COMPANY_HEADERS);
    const companyParsed = sheetToObjects_(companySheet);
    const companyRow = companyParsed.rows.find(function(r) {
      return String(r.pool_company_id || '').trim() === companyId;
    });
    if (!companyRow) return { ok: false, error: 'Company not found.' };
    srSetRowValues_(companySheet, companyParsed.headers, companyRow._rowNum, {
      contact_name: contactName,
      phone: phone,
      report_bcc_email: reportEmail,
      updated_at: new Date().toISOString()
    });

    const found = baFindAccountByEmail_(gate.account.email);
    if (found.row) {
      const updates = {
        contact_name: contactName,
        phone: phone,
        updated_at: new Date().toISOString()
      };
      const newPassword = String(payload.new_password || '').trim();
      if (newPassword) {
        if (newPassword.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
        const currentPassword = String(payload.current_password || '').trim();
        if (hashPassword_(currentPassword) !== found.row.password_hash) {
          return { ok: false, error: 'Current password is incorrect.' };
        }
        updates.password_hash = hashPassword_(newPassword);
      }
      srSetRowValues_(found.sheet, found.headers, found.row._rowNum, updates);
    }

    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
