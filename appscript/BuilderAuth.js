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
function baRequireBuilder_(payload) {
  return baValidateBuilderToken_(payload.token || '');
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

function handleBuilderLogout_(payload) {
  baRevokeSession_(payload.token || '');
  return { ok: true };
}
