// UserAuth.gs  — v2: multi-role support
// ─────────────────────────────────────────────────────────────────────────────
// CHANGES FROM v1:
//   - roles stored as comma-separated string in Users sheet (e.g. "admin,technician")
//   - operator_name column added to Users sheet (maps to Routes sheet Operator column)
//   - validateToken returns roles[] array + operator_name
//   - ROLE_ACCESS is additive — user gets union of all their roles' pages
//   - Users sheet schema: username | password_hash | name | roles | operator_name | active | created_at | last_login
// ─────────────────────────────────────────────────────────────────────────────

const AUTH_SHEET_ID    = "1e2XmGuosFSzeDQYMf3TYG3ZFfENYTyne5pqOi3L5m1g";
const USERS_SHEET      = "Users";
const SESSIONS_SHEET   = "Sessions";
const ROLES_SHEET      = "Roles";
const EMPLOYEE_INVITES_SHEET = "Employee_Invites";
const SESSION_TTL_DAYS = 30;
const TOKEN_LENGTH     = 48;

// ─── Role → Page Access Map ───────────────────────────────────────────────────
// Pages: home, service_log, live_map, inventory, quotes, admin
const ROLE_ACCESS = {
  "new_hire"   : ["onboarding"],
  "trainee"    : ["home", "training"],
  "technician" : ["home", "live_map", "service_log"],
  "lead"       : ["home", "live_map", "service_log"],
  "office"     : ["home", "quotes", "inventory"],
  "manager"    : ["home", "live_map", "service_log", "inventory", "quotes"],
  "admin"      : ["home", "live_map", "service_log", "inventory", "quotes", "admin"],
};

// ─── Get pages for a roles array (union of all roles) ────────────────────────
function getPagesForRoles_(rolesArray) {
  const pageSet = new Set();
  rolesArray.forEach(role => {
    const pages = ROLE_ACCESS[role.trim()] || [];
    pages.forEach(p => pageSet.add(p));
  });
  // Preserve a sensible order
  const order = ["home", "onboarding", "live_map", "service_log", "inventory", "quotes", "training", "admin"];
  return order.filter(p => pageSet.has(p));
}

function parseRoles_(raw) {
  if (!raw) return ["technician"];
  return String(raw).split(",").map(r => r.trim().toLowerCase()).filter(Boolean);
}

// ─── Public API ───────────────────────────────────────────────────────────────

function handleLogin(payload) {
  const username = String(payload.username || "").trim().toLowerCase();
  const password = String(payload.password || "").trim();
  if (!username || !password) return { ok: false, error: "Username and password are required." };
  const user = getUserByUsername_(username);
  if (!user)        return { ok: false, error: "Invalid username or password." };
  if (!user.active || String(user.active).toUpperCase() === "FALSE")
    return { ok: false, error: "Account is deactivated. Contact your admin." };
  if (hashPassword_(password) !== user.password_hash)
    return { ok: false, error: "Invalid username or password." };
  const roles        = parseRoles_(user.roles || user.role || "technician");
  const token        = createSession_(user, roles);
  updateLastLogin_(username);
  return {
    ok                   : true,
    token                : token,
    name                 : user.name,
    roles                : roles,
    pages                : getPagesForRoles_(roles),
    pay_rate             : user.pay_rate || '',
    worker_type          : user.worker_type || '1099_contractor',
    shift_preferences    : user.shift_preferences || '{}',
    avatar_url           : user.avatar_url || '',
    email                : user.email || '',
    tutorial_status      : user.tutorial_status      || '',
    tutorial_version     : user.tutorial_version     || '',
    tutorial_started_at  : user.tutorial_started_at  || '',
    tutorial_completed_at: user.tutorial_completed_at || ''
  };
}

function handleLogout(payload) {
  const token = String(payload.token || "").trim();
  if (!token) return { ok: false, error: "No token provided." };
  revokeSession_(token);
  return { ok: true };
}

function validateToken(token) {
  if (!token) return { ok: false, error: "No token provided." };
  const session = getSession_(token);
  if (!session)              return { ok: false, error: "Session not found. Please log in again." };
  if (session.revoked === true || String(session.revoked).toUpperCase() === "TRUE")
    return { ok: false, error: "Session revoked. Please log in again." };
  if (isExpired_(session)) {
    revokeSession_(token);
    return { ok: false, error: "Session expired. Please log in again." };
  }
  const userRow = getUserByUsername_(session.username);
  const roles = parseRoles_((userRow && userRow.roles) || session.roles || session.role || "technician");

  return {
    ok                   : true,
    username             : session.username,
    name                 : session.name,
    roles                : roles,
    pages                : getPagesForRoles_(roles),
    pay_rate             : userRow ? (userRow.pay_rate || '') : '',
    email                : userRow ? (userRow.email || '') : '',
    phone                : userRow ? (userRow.phone || '') : '',
    first_name           : userRow ? (userRow.first_name || '') : '',
    last_name            : userRow ? (userRow.last_name || '') : '',
    worker_type          : userRow ? (userRow.worker_type || '1099_contractor') : '1099_contractor',
    shift_preferences    : userRow ? (userRow.shift_preferences || '{}') : '{}',
    tutorial_status      : userRow ? (userRow.tutorial_status      || '') : '',
    tutorial_version     : userRow ? (userRow.tutorial_version     || '') : '',
    tutorial_started_at  : userRow ? (userRow.tutorial_started_at  || '') : '',
    tutorial_completed_at: userRow ? (userRow.tutorial_completed_at || '') : ''
  };
}

function canAccess(auth, page) {
  if (!auth || !auth.ok) return false;
  return (auth.pages || []).includes(page);
}

function hasRole(auth, role) {
  if (!auth || !auth.ok) return false;
  return (auth.roles || []).includes(role);
}

function handleGetRoles() {
  return { ok: true, roles: ROLE_ACCESS };
}

function handleCreateEmployeeInvite(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin")) return { ok: false, error: "Admin access required." };

  const firstName = String(payload.first_name || "").trim();
  const lastName  = String(payload.last_name || "").trim();
  const email     = String(payload.email || "").trim().toLowerCase();
  const phone     = String(payload.phone || "").trim();
  const username  = normalizeUsername_(payload.username || "");
  const workerType = String(payload.worker_type || "1099_contractor").trim();
  const payRate = String(payload.pay_rate || "").trim();
  const expiresDays = Math.max(1, Math.min(30, Number(payload.expires_days || 7)));

  if (!firstName || !lastName || !email || !phone || !username) {
    return { ok: false, error: "First name, last name, email, phone, and username are required." };
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "Enter a valid email." };
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return { ok: false, error: "Username must be 3-32 letters, numbers, dots, underscores, or hyphens." };
  if (getUserByUsername_(username)) return { ok: false, error: "That username already exists." };

  const sheet = getEmployeeInvitesSheet_();
  const headers = getHeaderMap_(sheet);
  const existing = findOpenInviteByEmailOrUsername_(sheet, headers, email, username);
  if (existing) return { ok: false, error: "An unused invite already exists for that email or username." };

  const magicToken = generateToken_() + generateToken_();
  const employeeCode = "MCPS-" + randomDigits_(6);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresDays * 24 * 60 * 60 * 1000);
  const inviteId = Utilities.getUuid();
  const row = new Array(sheet.getLastColumn()).fill("");
  setRowValue_(row, headers, "invite_id", inviteId);
  setRowValue_(row, headers, "email", email);
  setRowValue_(row, headers, "first_name", firstName);
  setRowValue_(row, headers, "last_name", lastName);
  setRowValue_(row, headers, "phone", phone);
  setRowValue_(row, headers, "username", username);
  setRowValue_(row, headers, "role", "new_hire");
  setRowValue_(row, headers, "worker_type", workerType);
  setRowValue_(row, headers, "pay_rate", payRate);
  setRowValue_(row, headers, "magic_token_hash", hashInviteSecret_(magicToken));
  setRowValue_(row, headers, "employee_code_hash", hashInviteSecret_(employeeCode));
  setRowValue_(row, headers, "expires_at", expiresAt.toISOString());
  setRowValue_(row, headers, "used_at", "");
  setRowValue_(row, headers, "created_by", auth.username || "");
  setRowValue_(row, headers, "created_at", now.toISOString());
  setRowValue_(row, headers, "status", "active");
  sheet.appendRow(row);

  const inviteForEmail = {
    invite_id: inviteId,
    email: email,
    first_name: firstName,
    last_name: lastName,
    phone: phone,
    username: username,
    worker_type: workerType,
    pay_rate: payRate,
    magic_link: getPortalBaseUrl_() + "/#register?token=" + encodeURIComponent(magicToken),
    employee_code: employeeCode,
    expires_at: expiresAt.toISOString()
  };
  const emailResult = sendEmployeeInviteEmail_(inviteForEmail);
  const appendedRow = sheet.getLastRow();
  const updatedHeaders = getHeaderMap_(sheet);
  if (updatedHeaders.email_sent_to !== undefined) sheet.getRange(appendedRow, updatedHeaders.email_sent_to + 1).setValue(emailResult.to || "");
  if (updatedHeaders.email_sent_at !== undefined) sheet.getRange(appendedRow, updatedHeaders.email_sent_at + 1).setValue(emailResult.sent_at || "");
  if (updatedHeaders.email_error !== undefined) sheet.getRange(appendedRow, updatedHeaders.email_error + 1).setValue(emailResult.error || "");

  return {
    ok: true,
    invite_id: inviteId,
    magic_link: inviteForEmail.magic_link,
    employee_code: employeeCode,
    email,
    username,
    role: "new_hire",
    expires_at: expiresAt.toISOString(),
    email_sent: !!emailResult.ok,
    email_error: emailResult.error || ""
  };
}

function handleEmployeeInviteLookup(payload) {
  const found = findValidEmployeeInvite_(payload);
  if (!found.ok) return found;
  return { ok: true, invite: publicInvite_(found.invite) };
}

function handleListEmployeeInvites(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin") && !hasRole(auth, "manager")) return { ok: false, error: "Admin access required." };

  const sheet = getEmployeeInvitesSheet_();
  const headers = getHeaderMap_(sheet);
  if (sheet.getLastRow() < 2) return { ok: true, invites: [] };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const invites = rows.map(row => employeeInviteListItem_(rowToObject_(row, headers)))
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, 30);
  return { ok: true, invites };
}

function handleCancelEmployeeInvite(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin") && !hasRole(auth, "manager")) return { ok: false, error: "Admin access required." };
  const inviteId = String(payload.invite_id || "").trim();
  if (!inviteId) return { ok: false, error: "Invite ID is required." };

  const sheet = getEmployeeInvitesSheet_();
  const headers = getHeaderMap_(sheet);
  if (sheet.getLastRow() < 2) return { ok: false, error: "Invite not found." };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (let i = 0; i < rows.length; i++) {
    const inv = rowToObject_(rows[i], headers);
    if (String(inv.invite_id || "") !== inviteId) continue;
    if (inv.used_at) return { ok: false, error: "Used invites cannot be cancelled." };
    sheet.getRange(i + 2, headers.status + 1).setValue("cancelled");
    return { ok: true };
  }
  return { ok: false, error: "Invite not found." };
}

function handleResendEmployeeInvite(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin") && !hasRole(auth, "manager")) return { ok: false, error: "Admin access required." };
  const inviteId = String(payload.invite_id || "").trim();
  if (!inviteId) return { ok: false, error: "Invite ID is required." };

  const sheet = getEmployeeInvitesSheet_();
  const headers = getHeaderMap_(sheet);
  if (sheet.getLastRow() < 2) return { ok: false, error: "Invite not found." };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (let i = 0; i < rows.length; i++) {
    const rowIndex = i + 2;
    const inv = rowToObject_(rows[i], headers);
    if (String(inv.invite_id || "") !== inviteId) continue;
    if (inv.used_at) return { ok: false, error: "Used invites cannot be resent." };
    if (String(inv.status || "").toLowerCase() === "cancelled") return { ok: false, error: "Cancelled invites cannot be resent." };

    const magicToken = generateToken_() + generateToken_();
    const employeeCode = "MCPS-" + randomDigits_(6);
    const expiresAt = new Date(new Date().getTime() + 7 * 24 * 60 * 60 * 1000);
    const inviteForEmail = {
      invite_id: inviteId,
      email: inv.email || "",
      first_name: inv.first_name || "",
      last_name: inv.last_name || "",
      phone: inv.phone || "",
      username: inv.username || "",
      worker_type: inv.worker_type || "1099_contractor",
      pay_rate: inv.pay_rate || "",
      magic_link: getPortalBaseUrl_() + "/#register?token=" + encodeURIComponent(magicToken),
      employee_code: employeeCode,
      expires_at: expiresAt.toISOString()
    };

    sheet.getRange(rowIndex, headers.magic_token_hash + 1).setValue(hashInviteSecret_(magicToken));
    sheet.getRange(rowIndex, headers.employee_code_hash + 1).setValue(hashInviteSecret_(employeeCode));
    sheet.getRange(rowIndex, headers.expires_at + 1).setValue(expiresAt.toISOString());
    sheet.getRange(rowIndex, headers.status + 1).setValue("active");
    if (headers.email_error !== undefined) sheet.getRange(rowIndex, headers.email_error + 1).setValue("");

    const emailResult = sendEmployeeInviteEmail_(inviteForEmail);
    const updatedHeaders = getHeaderMap_(sheet);
    if (updatedHeaders.email_sent_to !== undefined) sheet.getRange(rowIndex, updatedHeaders.email_sent_to + 1).setValue(emailResult.to || "");
    if (updatedHeaders.email_sent_at !== undefined) sheet.getRange(rowIndex, updatedHeaders.email_sent_at + 1).setValue(emailResult.sent_at || "");
    if (updatedHeaders.email_error !== undefined) sheet.getRange(rowIndex, updatedHeaders.email_error + 1).setValue(emailResult.error || "");

    return {
      ok: true,
      magic_link: inviteForEmail.magic_link,
      employee_code: employeeCode,
      expires_at: expiresAt.toISOString(),
      email_sent: !!emailResult.ok,
      email_error: emailResult.error || ""
    };
  }
  return { ok: false, error: "Invite not found." };
}

function handleEmployeeRegister(payload) {
  const found = findValidEmployeeInvite_(payload);
  if (!found.ok) return found;
  const password = String(payload.password || "").trim();
  if (password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };

  const invite = found.invite;
  const username = normalizeUsername_(invite.username);
  if (getUserByUsername_(username)) return { ok: false, error: "That username already exists." };

  const user = appendNewHireUserFromInvite_(invite, password);
  seedOnboardingFromInvite_(invite);
  markInviteUsed_(found.sheet, found.headers, found.rowIndex);

  const roles = ["new_hire"];
  const token = createSession_(user, roles);
  updateLastLogin_(username);
  return {
    ok: true,
    token,
    username,
    name: user.name,
    roles,
    pages: getPagesForRoles_(roles),
    worker_type: invite.worker_type || "1099_contractor",
    avatar_url: ""
  };
}

function handleCreateUser(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok)                return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin")) return { ok: false, error: "Admin access required." };
 
  const username      = String(payload.username      || "").trim().toLowerCase();
  const password      = String(payload.password      || "").trim();
  const name          = String(payload.name          || "").trim();
  const rolesRaw      = String(payload.roles || payload.role || "technician");
  const availableDays = String(payload.available_days || "").trim();
  const workerType    = String(payload.worker_type || "1099_contractor").trim();
  const payRate       = String(payload.pay_rate || "").trim();
  const shiftPrefs    = String(payload.shift_preferences || "{}").trim(); // NEW
 
  if (!username || !password || !name)
    return { ok: false, error: "username, password, and name are required." };
 
  if (getUserByUsername_(username))
    return { ok: false, error: `Username '${username}' already exists.` };
 
  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(USERS_SHEET);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h).trim().toLowerCase().replace(/ /g,"_"));

  // Build row matching header order
  const row = new Array(headers.length).fill("");
  const set = (colName, val) => {
    const i = headers.indexOf(colName);
    if (i !== -1) row[i] = val;
  };
 
  set("username",          username);
  set("password_hash",     hashPassword_(password));
  set("name",              name);
  set("roles",             parseRoles_(rolesRaw).join(","));
  set("available_days",    availableDays);
  set("active",            true);
  set("created_at",        new Date().toISOString());
  set("worker_type",       workerType);
  set("pay_rate",          payRate);
  set("shift_preferences", shiftPrefs); // NEW
 
  sheet.appendRow(row);
  
  // Invalidate Cache
  CacheService.getScriptCache().remove('admin_users_list');
 
  return { ok: true, message: `User '${username}' created.` };
}


/**
 * Updates an existing user's fields.
 * Direct replacement for your current handleUpdateUser.
 */
function handleUpdateUser(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };

  const username = String(payload.username || "").trim().toLowerCase();
  const fields   = payload.fields || {};
  const isSelf   = auth.username === username;
  const isAdminUser = hasRole(auth, "admin");

  // Non-admins may only update their own avatar
  const onlyAvatar = Object.keys(fields).length === 1 && "avatar_base64" in fields;
  if (!isAdminUser && !(isSelf && onlyAvatar)) {
    return { ok: false, error: "Admin access required." };
  }

  const ss      = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet   = ss.getSheetByName(USERS_SHEET);
  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase().replace(/ /g,"_"));

  const rowIdx = data.findIndex((r, i) => i > 0 && String(r[0]).trim().toLowerCase() === username);
  if (rowIdx === -1) return { ok: false, error: `User '${username}' not found.` };

  const setCol = (colName, val) => {
    let i = headers.indexOf(colName);
    if (i === -1) {
      // Auto-add column if it doesn't exist yet
      i = headers.length;
      headers.push(colName);
      sheet.getRange(1, i + 1).setValue(colName);
    }
    sheet.getRange(rowIdx + 1, i + 1).setValue(val);
  };

  let avatarUrl = null;
  if ("avatar_base64" in fields) {
    avatarUrl = saveAvatarToDrive_(fields.avatar_base64, username);
    setCol("avatar_url", avatarUrl);
  }

  if (isAdminUser) {
    if ("name"              in fields) setCol("name",              fields.name);
    if ("roles"             in fields) setCol("roles",             fields.roles);
    if ("available_days"    in fields) setCol("available_days",    fields.available_days);
    if ("active"            in fields) setCol("active",            fields.active === true || fields.active === "true");
    if ("password"          in fields) setCol("password_hash",     hashPassword_(fields.password));
    if ("worker_type"       in fields) setCol("worker_type",       fields.worker_type);
    if ("pay_rate"          in fields) setCol("pay_rate",          fields.pay_rate);
    if ("shift_preferences" in fields) setCol("shift_preferences", fields.shift_preferences);
    if ("active" in fields && !fields.active) revokeAllSessionsForUser_(username);
  }

  const cache = CacheService.getScriptCache();
  cache.remove('admin_users_list');
  cache.remove('usr:' + username);

  const result = { ok: true, message: `User '${username}' updated.` };
  if (avatarUrl) result.avatar_url = avatarUrl;
  return result;
}


function handleSetTutorialState(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok) return { ok: false, error: auth.error };

  const targetUsername = String(payload.target_username || "").trim().toLowerCase();
  if (!targetUsername) return { ok: false, error: "target_username is required." };

  const isSelf    = auth.username === targetUsername;
  const isAdminUser = hasRole(auth, "admin");

  if (!isSelf && !isAdminUser) return { ok: false, error: "Admin access required to modify another user's tutorial state." };

  const allowed = ["not_started", "in_progress", "completed", "skipped"];
  const status  = String(payload.tutorial_status || "").trim();
  if (!allowed.includes(status)) return { ok: false, error: "Invalid tutorial_status value." };

  const version      = String(payload.tutorial_version      || "").trim();
  const startedAt    = String(payload.tutorial_started_at   || "").trim();
  const completedAt  = String(payload.tutorial_completed_at || "").trim();

  const ss      = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet   = ss.getSheetByName(USERS_SHEET);
  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase().replace(/ /g, "_"));

  const rowIdx = data.findIndex((r, i) => i > 0 && String(r[0]).trim().toLowerCase() === targetUsername);
  if (rowIdx === -1) return { ok: false, error: "User '" + targetUsername + "' not found." };

  const setCol = (colName, val) => {
    let i = headers.indexOf(colName);
    if (i === -1) {
      i = headers.length;
      headers.push(colName);
      sheet.getRange(1, i + 1).setValue(colName);
    }
    sheet.getRange(rowIdx + 1, i + 1).setValue(val);
  };

  setCol("tutorial_status",       status);
  setCol("tutorial_version",      version);
  setCol("tutorial_started_at",   startedAt);
  setCol("tutorial_completed_at", completedAt);

  const cache = CacheService.getScriptCache();
  cache.remove("usr:" + targetUsername);
  if (isAdminUser && !isSelf) cache.remove("admin_users_list");

  return { ok: true };
}

function saveAvatarToDrive_(base64DataUrl, username) {
  const FOLDER_NAME = "MCPS_Avatars";
  let folder;
  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(FOLDER_NAME);

  // Remove old avatar for this user
  const old = folder.getFilesByName(username + "_avatar");
  while (old.hasNext()) old.next().setTrashed(true);

  const matches = base64DataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (!matches) return null;
  const mimeType = matches[1];
  const blob = Utilities.newBlob(Utilities.base64Decode(matches[2]), mimeType, username + "_avatar");

  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return "https://lh3.googleusercontent.com/d/" + file.getId();
}



function handleListUsers(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok)                return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin")) return { ok: false, error: "Admin access required." };

  // Check Cache
  const cache = CacheService.getScriptCache();
  const cached = cache.get('admin_users_list');
  if (cached) return { ok: true, users: JSON.parse(cached) };

  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(USERS_SHEET);
  const data  = sheet.getDataRange().getValues();
  if (data.length < 2) return { ok: true, users: [] };

  const headers = data[0].map(h => String(h).trim().toLowerCase().replace(/ /g,"_"));
  const users = data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    delete obj.password_hash;
    if (obj.roles) obj.roles = parseRoles_(obj.roles);
    return obj;
  });

  // Save to Cache (300 seconds = 5 mins)
  cache.put('admin_users_list', JSON.stringify(users), 300);

  return { ok: true, users };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function hashPassword_(password) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + "mcps_salt_2026");
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function generateToken_() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let t = '';
  for (let i = 0; i < TOKEN_LENGTH; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
  return t;
}

function randomDigits_(len) {
  let out = "";
  for (let i = 0; i < len; i++) out += String(Math.floor(Math.random() * 10));
  return out;
}

function normalizeUsername_(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
}

function hashInviteSecret_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value || "") + "mcps_invite_salt_2026");
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function getPortalBaseUrl_() {
  return PropertiesService.getScriptProperties().getProperty("PORTAL_BASE_URL") || "https://mcps-log.vercel.app";
}

function getEmployeeInvitesSheet_() {
  const ss = SpreadsheetApp.openById(AUTH_SHEET_ID);
  let sheet = ss.getSheetByName(EMPLOYEE_INVITES_SHEET);
  const required = [
    "invite_id", "email", "first_name", "last_name", "phone", "username", "role",
    "worker_type", "pay_rate", "magic_token_hash", "employee_code_hash",
    "expires_at", "used_at", "created_by", "created_at", "status",
    "email_sent_to", "email_sent_at", "email_error"
  ];
  if (!sheet) {
    sheet = ss.insertSheet(EMPLOYEE_INVITES_SHEET);
    sheet.appendRow(required);
    sheet.setFrozenRows(1);
    return sheet;
  }
  const headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0]
    .map(h => String(h).trim().toLowerCase().replace(/ /g, "_"));
  required.forEach(col => {
    if (!headers.includes(col)) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(col);
      headers.push(col);
    }
  });
  return sheet;
}

function getHeaderMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h).trim().toLowerCase().replace(/ /g, "_"));
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i; });
  return map;
}

function setRowValue_(row, headers, key, value) {
  if (headers[key] !== undefined) row[headers[key]] = value;
}

function rowToObject_(row, headers) {
  const obj = {};
  Object.keys(headers).forEach(k => { obj[k] = row[headers[k]]; });
  return obj;
}

function findOpenInviteByEmailOrUsername_(sheet, headers, email, username) {
  if (sheet.getLastRow() < 2) return null;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const now = new Date();
  for (let i = 0; i < rows.length; i++) {
    const inv = rowToObject_(rows[i], headers);
    const status = String(inv.status || "").toLowerCase();
    const used = !!inv.used_at;
    const expired = new Date(inv.expires_at) <= now;
    if (!used && !expired && status === "active" &&
        (String(inv.email || "").toLowerCase() === email || String(inv.username || "").toLowerCase() === username)) {
      return inv;
    }
  }
  return null;
}

function findValidEmployeeInvite_(payload) {
  const sheet = getEmployeeInvitesSheet_();
  const headers = getHeaderMap_(sheet);
  if (sheet.getLastRow() < 2) return { ok: false, error: "Invite not found." };
  const tokenHash = payload.token ? hashInviteSecret_(payload.token) : "";
  const codeHash = payload.code ? hashInviteSecret_(String(payload.code).trim().toUpperCase()) : "";
  const email = String(payload.email || "").trim().toLowerCase();
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (let i = 0; i < rows.length; i++) {
    const inv = rowToObject_(rows[i], headers);
    const tokenMatch = tokenHash && String(inv.magic_token_hash || "") === tokenHash;
    const codeMatch = codeHash && String(inv.employee_code_hash || "") === codeHash && String(inv.email || "").toLowerCase() === email;
    if (!tokenMatch && !codeMatch) continue;
    if (inv.used_at) return { ok: false, error: "This invite has already been used." };
    if (String(inv.status || "").toLowerCase() !== "active") return { ok: false, error: "This invite is no longer active." };
    if (new Date(inv.expires_at) <= new Date()) return { ok: false, error: "This invite has expired." };
    return { ok: true, invite: inv, sheet, headers, rowIndex: i + 2 };
  }
  return { ok: false, error: "Invite not found." };
}

function publicInvite_(invite) {
  return {
    email: invite.email || "",
    first_name: invite.first_name || "",
    last_name: invite.last_name || "",
    phone: invite.phone || "",
    username: invite.username || "",
    worker_type: invite.worker_type || "1099_contractor",
    role: "new_hire",
    expires_at: invite.expires_at || ""
  };
}

function employeeInviteListItem_(invite) {
  const statusLabel = employeeInviteStatus_(invite);
  return {
    invite_id: invite.invite_id || "",
    email: invite.email || "",
    first_name: invite.first_name || "",
    last_name: invite.last_name || "",
    phone: invite.phone || "",
    username: invite.username || "",
    worker_type: invite.worker_type || "1099_contractor",
    pay_rate: invite.pay_rate || "",
    status: invite.status || "",
    status_label: statusLabel,
    created_at: invite.created_at || "",
    expires_at: invite.expires_at || "",
    used_at: invite.used_at || "",
    email_sent_to: invite.email_sent_to || "",
    email_sent_at: invite.email_sent_at || "",
    email_error: invite.email_error || "",
    expires_at_display: formatInviteDate_(invite.expires_at),
    created_at_display: formatInviteDate_(invite.created_at),
    used_at_display: formatInviteDate_(invite.used_at),
    email_sent_at_display: formatInviteDate_(invite.email_sent_at)
  };
}

function employeeInviteStatus_(invite) {
  const status = String(invite.status || "active").toLowerCase();
  if (invite.used_at || status === "used") return "used";
  if (status === "cancelled") return "cancelled";
  if (invite.expires_at && new Date(invite.expires_at) <= new Date()) return "expired";
  return "active";
}

function formatInviteDate_(value) {
  if (!value) return "";
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return Utilities.formatDate(d, "America/Chicago", "MMM d, h:mm a");
  } catch(e) {
    return String(value);
  }
}

function sendEmployeeInviteEmail_(invite) {
  const props = PropertiesService.getScriptProperties();
  const webhookUrl = props.getProperty("ZAPIER_EMPLOYEE_INVITE_WEBHOOK") || props.getProperty("EMPLOYEE_INVITE_ZAPIER_WEBHOOK");
  if (!webhookUrl) {
    return { ok: false, to: invite.email || "", sent_at: "", error: "ZAPIER_EMPLOYEE_INVITE_WEBHOOK not set" };
  }

  const fullName = [invite.first_name, invite.last_name].filter(Boolean).join(" ").trim() || "New Team Member";
  const subject = "Welcome to MCPS — set up your employee portal";
  const sentAt = new Date().toISOString();
  const payload = {
    to: invite.email || "",
    bcc: "mauricio@mcpoolsolutions.org,antonio@mcpoolsolutions.org",
    from: typeof VISIT_REPORT_FROM !== "undefined" ? VISIT_REPORT_FROM : "antonio@mcpoolsolutions.org",
    from_name: typeof VISIT_REPORT_FROM_NAME !== "undefined" ? VISIT_REPORT_FROM_NAME : "Mission Custom Pool Solutions",
    subject: subject,
    html_body: buildEmployeeInviteEmailHtml_(invite),
    text_body: buildEmployeeInviteEmailText_(invite),
    invite_id: invite.invite_id || "",
    first_name: invite.first_name || "",
    last_name: invite.last_name || "",
    full_name: fullName,
    email: invite.email || "",
    phone: invite.phone || "",
    username: invite.username || "",
    worker_type: invite.worker_type || "",
    magic_link: invite.magic_link || "",
    employee_code: invite.employee_code || "",
    expires_at: invite.expires_at || ""
  };

  try {
    const res = UrlFetchApp.fetch(webhookUrl, {
      method: "POST",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      return { ok: false, to: invite.email || "", sent_at: "", error: "Zapier returned HTTP " + code };
    }
    return { ok: true, to: invite.email || "", sent_at: sentAt, error: "" };
  } catch (err) {
    Logger.log("Employee invite Zapier webhook failed: " + err);
    return { ok: false, to: invite.email || "", sent_at: "", error: String(err) };
  }
}

function buildEmployeeInviteEmailHtml_(d) {
  const fullName = [d.first_name, d.last_name].filter(Boolean).join(" ").trim() || "there";
  const rows = [
    ["Name", fullName],
    ["Username", d.username],
    ["Phone", d.phone],
    ["Worker Type", d.worker_type === "w2_employee" ? "W2 Employee" : "1099 Contractor"],
    ["Employee Code", d.employee_code],
    ["Expires", formatInviteDate_(d.expires_at)]
  ].filter(function(r) { return r[1]; }).map(function(r) {
    return '<tr><td style="padding:8px 12px;color:#64748b;border-bottom:1px solid #e5e7eb">' + employeeInviteEsc_(r[0]) + '</td>' +
      '<td style="padding:8px 12px;color:#111827;font-weight:600;border-bottom:1px solid #e5e7eb">' + employeeInviteEsc_(r[1]) + '</td></tr>';
  }).join("");

  return [
    '<div style="margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif;color:#111827">',
    '<div style="max-width:640px;margin:0 auto;padding:28px 16px">',
    '<div style="background:#064e3b;color:#fff;border-radius:12px 12px 0 0;padding:24px 28px">',
    '<div style="font-size:20px;font-weight:700">Mission Custom Pool Solutions</div>',
    '<div style="font-size:13px;color:#ccfbf1;margin-top:4px">Employee Portal Invite</div>',
    '</div>',
    '<div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:26px 28px">',
    '<p style="margin:0 0 14px;font-size:15px">Hello ' + employeeInviteEsc_(fullName) + ',</p>',
    '<p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#334155">Welcome to MCPS. Use the button below to create your employee portal account. This account starts in onboarding so you can complete your paperwork before accessing the technician portal.</p>',
    d.magic_link ? '<p style="margin:18px 0"><a href="' + employeeInviteEsc_(d.magic_link) + '" style="display:inline-block;padding:11px 20px;background:#064e3b;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:700">Set Up My Account</a></p>' : '',
    '<table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:13px"><tbody>',
    rows,
    '</tbody></table>',
    '<div style="margin-top:18px;padding:14px 16px;background:#f8fafc;border-left:4px solid #0f766e;border-radius:0 8px 8px 0">',
    '<div style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;color:#0f766e;margin-bottom:8px">Manual option</div>',
    '<p style="margin:0;color:#334155;font-size:13px;line-height:1.5">If the button does not work, go to <strong>https://mcps-log.vercel.app/#</strong>, choose <strong>Register with employee code</strong>, and enter your email plus the employee code above.</p>',
    '</div>',
    '<p style="margin:22px 0 0;font-size:13px;color:#64748b">Thank you,<br><strong>Mission Custom Pool Solutions</strong></p>',
    '</div></div></div>'
  ].join("");
}

function buildEmployeeInviteEmailText_(d) {
  const fullName = [d.first_name, d.last_name].filter(Boolean).join(" ").trim() || "there";
  return [
    "Mission Custom Pool Solutions",
    "Employee Portal Invite",
    "",
    "Hello " + fullName + ",",
    "",
    "Welcome to MCPS. Use this link to create your employee portal account:",
    d.magic_link || "",
    "",
    "Username: " + (d.username || ""),
    "Employee Code: " + (d.employee_code || ""),
    "Expires: " + (formatInviteDate_(d.expires_at) || ""),
    "",
    "Manual option: go to https://mcps-log.vercel.app/#, choose Register with employee code, and enter your email plus the employee code.",
    "",
    "Thank you,",
    "Mission Custom Pool Solutions"
  ].filter(Boolean).join("\n");
}

function employeeInviteEsc_(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function markInviteUsed_(sheet, headers, rowIndex) {
  sheet.getRange(rowIndex, headers.used_at + 1).setValue(new Date().toISOString());
  sheet.getRange(rowIndex, headers.status + 1).setValue("used");
}

function appendNewHireUserFromInvite_(invite, password) {
  const ss = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(USERS_SHEET);
  const required = ["email", "phone", "first_name", "last_name", "worker_type", "pay_rate"];
  let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h).trim().toLowerCase().replace(/ /g, "_"));
  required.forEach(col => {
    if (!headers.includes(col)) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(col);
      headers.push(col);
    }
  });
  headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h).trim().toLowerCase().replace(/ /g, "_"));
  const row = new Array(headers.length).fill("");
  const set = (col, val) => {
    const i = headers.indexOf(col);
    if (i !== -1) row[i] = val;
  };
  const username = normalizeUsername_(invite.username);
  const name = [invite.first_name, invite.last_name].filter(Boolean).join(" ").trim();
  set("username", username);
  set("password_hash", hashPassword_(password));
  set("name", name);
  set("roles", "new_hire");
  set("operator_name", "");
  set("active", true);
  set("created_at", new Date().toISOString());
  set("last_login", "");
  set("email", invite.email || "");
  set("phone", invite.phone || "");
  set("first_name", invite.first_name || "");
  set("last_name", invite.last_name || "");
  set("worker_type", invite.worker_type || "1099_contractor");
  set("pay_rate", invite.pay_rate || "");
  sheet.appendRow(row);
  CacheService.getScriptCache().remove('admin_users_list');
  CacheService.getScriptCache().remove('usr:' + username);
  return {
    username,
    name,
    roles: "new_hire",
    worker_type: invite.worker_type || "1099_contractor",
    pay_rate: invite.pay_rate || ""
  };
}

function seedOnboardingFromInvite_(invite) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Onboarding_Submissions");
  const headersList = ["info_submitted_at", "username", "full_name", "phone", "tax_type", "tax_id_last4", "w9_url", "contract_signed_at", "contract_signed_name", "approved_by", "approved_at", "status", "admin_notes", "dob", "address_line1", "address_city", "address_state", "address_zip", "emergency_name", "emergency_phone", "w4_url", "worker_type"];
  if (!sheet) {
    sheet = ss.insertSheet("Onboarding_Submissions");
    sheet.appendRow(headersList);
    sheet.setFrozenRows(1);
  }
  let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h).trim().toLowerCase().replace(/ /g, "_"));
  headersList.forEach(col => {
    if (!headers.includes(col)) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(col);
      headers.push(col);
    }
  });
  if (sheet.getLastRow() >= 2) {
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    const usernameCol = headers.indexOf("username");
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][usernameCol]).trim().toLowerCase() === normalizeUsername_(invite.username)) return;
    }
  }
  headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h).trim().toLowerCase().replace(/ /g, "_"));
  const row = new Array(headers.length).fill("");
  const set = (col, val) => {
    const i = headers.indexOf(col);
    if (i !== -1) row[i] = val;
  };
  set("username", normalizeUsername_(invite.username));
  set("full_name", [invite.first_name, invite.last_name].filter(Boolean).join(" ").trim());
  set("phone", invite.phone || "");
  set("status", "in_progress");
  set("worker_type", invite.worker_type || "1099_contractor");
  sheet.appendRow(row);
}

function getUserByUsername_(username) {
  const cache    = CacheService.getScriptCache();
  const cacheKey = 'usr:' + username;
  const cached   = cache.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch(e) {} }

  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase());

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === username) {
      const obj = {};
      headers.forEach((h, j) => { obj[h] = data[i][j]; });
      // 60s TTL: role changes take effect within 1 minute
      try { cache.put(cacheKey, JSON.stringify(obj), 60); } catch(e) {}
      return obj;
    }
  }
  return null;
}

function createSession_(user, roles) {
  const token     = generateToken_();
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(SESSIONS_SHEET);

  sheet.appendRow([
    token,
    user.username,
    user.name,
    roles.join(","),
    "",
    now.toISOString(),
    expiresAt.toISOString(),
    false
  ]);

  return token;
}

function getSession_(token) {
  const cache    = CacheService.getScriptCache();
  const cacheKey = 'sess:' + token;
  const cached   = cache.get(cacheKey);
  if (cached) {
    try {
      const obj = JSON.parse(cached);
      // Verify session hasn't expired (cache TTL may not align with session expiry)
      if (obj.expires_at) {
        const exp = obj.expires_at instanceof Date
          ? obj.expires_at.getTime()
          : new Date(obj.expires_at).getTime();
        if (!isNaN(exp) && exp <= Date.now()) return null;
      }
      return obj;
    } catch(e) {}
  }

  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(SESSIONS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase());

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === token) {
      const obj = {};
      headers.forEach((h, j) => { obj[h] = data[i][j]; });
      try { cache.put(cacheKey, JSON.stringify(obj), 300); } catch(e) {}
      return obj;
    }
  }
  return null;
}

function revokeSession_(token) {
  CacheService.getScriptCache().remove('sess:' + token);

  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(SESSIONS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return;

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === token) {
      const headers = data[0].map(h => String(h).trim().toLowerCase());
      const revokedCol = headers.indexOf("revoked") + 1;
      if (revokedCol > 0) sheet.getRange(i + 1, revokedCol).setValue(true);
      return;
    }
  }
}

function revokeAllSessionsForUser_(username) {
  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(SESSIONS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return;

  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const tokenCol   = headers.indexOf("token");
  const userCol    = headers.indexOf("username") + 1;
  const revokedCol = headers.indexOf("revoked") + 1;
  if (userCol < 1 || revokedCol < 1) return;

  const cache = CacheService.getScriptCache();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][userCol - 1]).trim().toLowerCase() === username) {
      sheet.getRange(i + 1, revokedCol).setValue(true);
      if (tokenCol >= 0) cache.remove('sess:' + data[i][tokenCol]);
    }
  }
}

function isExpired_(session) {
  const exp = new Date(session.expires_at);
  return isNaN(exp.getTime()) || new Date() > exp;
}

function updateLastLogin_(username) {
  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return;

  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const col     = headers.indexOf("last_login") + 1;
  if (col < 1) return;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === username) {
      sheet.getRange(i + 1, col).setValue(new Date().toISOString());
      return;
    }
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

function setupAuthSheets() {
  const ss = SpreadsheetApp.openById(AUTH_SHEET_ID);

  let users = ss.getSheetByName(USERS_SHEET);
  if (!users) {
    users = ss.insertSheet(USERS_SHEET);
    // v2 schema: operator_name column added, role→roles
    users.appendRow(["username","password_hash","name","roles","operator_name","active","created_at","last_login"]);
    users.setFrozenRows(1);
    Logger.log("Created Users sheet (v2 schema).");
  } else {
    // Migrate: add operator_name column if missing
    const headers = users.getRange(1, 1, 1, users.getLastColumn()).getValues()[0].map(h => String(h).trim().toLowerCase());
    if (!headers.includes("operator_name")) {
      users.getRange(1, headers.length + 1).setValue("operator_name");
      Logger.log("Added operator_name column to Users sheet.");
    }
    // Migrate: rename role→roles if needed
    const roleIdx = headers.indexOf("role");
    if (roleIdx !== -1 && !headers.includes("roles")) {
      users.getRange(1, roleIdx + 1).setValue("roles");
      Logger.log("Renamed role→roles column in Users sheet.");
    }
  }

  let sessions = ss.getSheetByName(SESSIONS_SHEET);
  if (!sessions) {
    sessions = ss.insertSheet(SESSIONS_SHEET);
    // v2 schema: operator_name added
    sessions.appendRow(["token","username","name","roles","operator_name","created_at","expires_at","revoked"]);
    sessions.setFrozenRows(1);
    Logger.log("Created Sessions sheet (v2 schema).");
  }

  let roles = ss.getSheetByName(ROLES_SHEET);
  if (!roles) {
    roles = ss.insertSheet(ROLES_SHEET);
    roles.appendRow(["role","pages","description"]);
    Object.entries(ROLE_ACCESS).forEach(([role, pages]) => {
      roles.appendRow([role, pages.join(", "), ""]);
    });
    roles.setFrozenRows(1);
    Logger.log("Created Roles sheet.");
  }

  try { SpreadsheetApp.getActiveSpreadsheet().toast("Auth sheets ready (v2).", "MCPS Auth"); } catch(e) {}
}

// ─── Seed initial users ───────────────────────────────────────────────────────
// Run once, then comment out or delete. NOTE: a second seedMCPSUsers() also
// exists in SeedUsers.js — duplicate global names collide in GAS (last-loaded
// wins); consolidate to one when convenient. Passwords are not stored in source:
// set SEED_DEFAULT_PW in Script Properties before re-running (existing users are
// skipped, so this is a no-op on the live project).
function seedMCPSUsers() {
  const seedPw = PropertiesService.getScriptProperties().getProperty("SEED_DEFAULT_PW") || "CHANGE_ME_BEFORE_SEEDING";
  const users = [
    { username: "mau",   password: seedPw, name: "Mauricio Rebaza", roles: "admin,technician"},
    { username: "tony",  password: seedPw, name: "Tony Siller",     roles: "technician"},
    { username: "chuy",  password: seedPw, name: "Chuy Silva",      roles: "technician"},
  ];

  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet) { Logger.log("Run setupAuthSheets() first."); return; }

  let created = 0, skipped = 0;
  users.forEach(u => {
    if (getUserByUsername_(u.username)) { Logger.log("Skipping (exists): " + u.username); skipped++; return; }
    sheet.appendRow([u.username, hashPassword_(u.password), u.name, u.roles, "", true, new Date().toISOString(), ""]);
    Logger.log("Created: " + u.username);
    created++;
  });

  const msg = `Done. Created: ${created}, Skipped: ${skipped}`;
  Logger.log(msg);
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, "MCPS Seed Users"); } catch(e) {}
}

function cleanupExpiredSessions() {
  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(SESSIONS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return;

  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const revokedIdx = headers.indexOf("revoked");
  const expiresIdx = headers.indexOf("expires_at");
  const now = new Date();
  const toDelete = [];

  for (let i = data.length - 1; i >= 1; i--) {
    const revoked   = data[i][revokedIdx];
    const expiresAt = new Date(data[i][expiresIdx]);
    if (revoked === true || String(revoked).toUpperCase() === "TRUE" || (!isNaN(expiresAt) && now > expiresAt)) {
      toDelete.push(i + 1);
    }
  }

  toDelete.forEach(r => sheet.deleteRow(r));
  Logger.log("cleanupExpiredSessions: removed " + toDelete.length + " rows.");
}
