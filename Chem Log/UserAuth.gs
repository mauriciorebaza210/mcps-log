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
const SESSION_TTL_DAYS = 30;
const TOKEN_LENGTH     = 48;

// ─── Role → Page Access Map ───────────────────────────────────────────────────
// Pages: home, service_log, live_map, inventory, quotes, admin
const ROLE_ACCESS = {
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
  const order = ["home", "live_map", "service_log", "inventory", "quotes", "admin"];
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
    ok           : true,
    token        : token,
    name         : user.name,
    roles        : roles,
    pages        : getPagesForRoles_(roles),
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

  const roles = parseRoles_(session.roles || session.role || "technician");
  return {
    ok           : true,
    username     : session.username,
    name         : session.name,
    roles        : roles,
    pages        : getPagesForRoles_(roles),
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

function handleCreateUser(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok)                return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin")) return { ok: false, error: "Admin access required." };
 
  const username      = String(payload.username      || "").trim().toLowerCase();
  const password      = String(payload.password      || "").trim();
  const name          = String(payload.name          || "").trim();
  const rolesRaw      = String(payload.roles || payload.role || "technician");
  const availableDays = String(payload.available_days || "").trim();
 
  if (!username || !password || !name)
    return { ok: false, error: "username, password, and name are required." };
 
  const roles = parseRoles_(rolesRaw);
  const invalidRoles = roles.filter(r => !ROLE_ACCESS[r]);
  if (invalidRoles.length)
    return { ok: false, error: `Unknown role(s): ${invalidRoles.join(", ")}` };
 
  if (getUserByUsername_(username))
    return { ok: false, error: `Username '${username}' already exists.` };
 
  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(USERS_SHEET);
 
  // Get headers to know column positions
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h).trim().toLowerCase().replace(/ /g,"_"));
 
  // Build row matching header order
  const row = new Array(headers.length).fill("");
  const set = (colName, val) => {
    const i = headers.indexOf(colName);
    if (i !== -1) row[i] = val;
  };
 
  set("username",         username);
  set("password_hash",    hashPassword_(password));
  set("name",             name);
  set("roles",            roles.join(","));
  set("available_days",   availableDays);
  set("active",           true);
  set("created_at",       new Date().toISOString());
  set("last_login",       "");
 
  sheet.appendRow(row);
 
  return { ok: true, message: `User '${username}' created with roles '${roles.join(",")}'.` };
}

/**
 * Updates an existing user's fields.
 * Direct replacement for your current handleUpdateUser.
 */
function handleUpdateUser(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok)                return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin")) return { ok: false, error: "Admin access required." };
 
  const username = String(payload.username || "").trim().toLowerCase();
  const fields   = payload.fields || {};
 
  const ss      = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet   = ss.getSheetByName(USERS_SHEET);
  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase().replace(/ /g,"_"));
 
  const rowIdx = data.findIndex((r, i) => i > 0 && String(r[0]).trim().toLowerCase() === username);
  if (rowIdx === -1) return { ok: false, error: `User '${username}' not found.` };
 
  // Helper: set a cell by column name
  const setCol = (colName, val) => {
    const i = headers.indexOf(colName);
    if (i !== -1) sheet.getRange(rowIdx + 1, i + 1).setValue(val);
  };
 
  // Update fields
  if ("name"           in fields) setCol("name",           fields.name);
  if ("roles"          in fields) setCol("roles",          fields.roles);
  if ("available_days" in fields) setCol("available_days", fields.available_days);
  if ("active"         in fields) setCol("active",         fields.active === true || fields.active === "true");
  if ("password"       in fields) setCol("password_hash",  hashPassword_(fields.password));
 
  // If user deactivated, kill their login sessions
  if ("active" in fields && !fields.active) revokeAllSessionsForUser_(username);
 
  return { ok: true, message: `User '${username}' updated.` };
}


function handleListUsers(payload) {
  const auth = validateToken(payload.token);
  if (!auth.ok)                return { ok: false, error: auth.error };
  if (!hasRole(auth, "admin")) return { ok: false, error: "Admin access required." };

  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(USERS_SHEET);
  const data  = sheet.getDataRange().getValues();
  if (data.length < 2) return { ok: true, users: [] };

  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const users = data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    delete obj.password_hash;
    // Normalise roles
    if (obj.roles) obj.roles = parseRoles_(obj.roles);
    return obj;
  });

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

function getUserByUsername_(username) {
  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase());

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === username) {
      const obj = {};
      headers.forEach((h, j) => { obj[h] = data[i][j]; });
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
  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(SESSIONS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim().toLowerCase());

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === token) {
      const obj = {};
      headers.forEach((h, j) => { obj[h] = data[i][j]; });
      return obj;
    }
  }
  return null;
}

function revokeSession_(token) {
  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(SESSIONS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return;

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === token) {
      // Find revoked column index
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
  const userCol    = headers.indexOf("username") + 1;
  const revokedCol = headers.indexOf("revoked") + 1;
  if (userCol < 1 || revokedCol < 1) return;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][userCol - 1]).trim().toLowerCase() === username) {
      sheet.getRange(i + 1, revokedCol).setValue(true);
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
// Run once, then comment out or delete.
function seedMCPSUsers() {
  const users = [
    { username: "mau",   password: "mcps2026!",  name: "Mauricio Rebaza", roles: "admin,technician"},
    { username: "tony",  password: "tony2026",   name: "Tony Siller",     roles: "technician"},
    { username: "chuy",  password: "chuy2026",   name: "Chuy Silva",      roles: "technician"},
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
