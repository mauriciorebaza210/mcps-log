// SeedUsers.gs
// ─────────────────────────────────────────────────────────────────────────────
// Run seedMCPSUsers() ONCE from the Apps Script editor to create
// Mau, Tony, and Chuy in the Log-Ins spreadsheet Users sheet.
//
// Passwords are NOT stored in source. Before re-running, set a temporary seed
// password in Script Properties (SEED_DEFAULT_PW) or replace the placeholder
// below, then change it via the Admin panel after first login. Existing users
// are skipped, so this is a no-op on the live project.
// ─────────────────────────────────────────────────────────────────────────────

function seedMCPSUsers() {
  const seedPw = PropertiesService.getScriptProperties().getProperty("SEED_DEFAULT_PW") || "CHANGE_ME_BEFORE_SEEDING";
  const users = [
    { username: "mau",   password: seedPw, name: "Mauricio Rebaza", role: "admin"      },
    { username: "tony",  password: seedPw, name: "Tony Siller",     role: "technician" },
    { username: "chuy",  password: seedPw, name: "Chuy Silva",      role: "technician" },
  ];

  const ss    = SpreadsheetApp.openById(AUTH_SHEET_ID);
  const sheet = ss.getSheetByName(USERS_SHEET);

  if (!sheet) {
    Logger.log("Users sheet not found — run setupAuthSheets() first.");
    return;
  }

  let created = 0;
  let skipped = 0;

  users.forEach(u => {
    if (getUserByUsername_(u.username)) {
      Logger.log("Already exists, skipping: " + u.username);
      skipped++;
      return;
    }

    sheet.appendRow([
      u.username,
      hashPassword_(u.password),
      u.name,
      u.role,
      true,
      new Date().toISOString(),
      ""
    ]);
    Logger.log("Created: " + u.username + " (" + u.role + ")");
    created++;
  });

  const msg = `Done. Created: ${created}, Skipped (already exist): ${skipped}`;
  Logger.log(msg);

  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(msg, "MCPS Seed Users");
  } catch(e) {}
}

// ─── Quick test ───────────────────────────────────────────────────────────────
// Set TEST_LOGIN_USER / TEST_LOGIN_PW in Script Properties to exercise this.
function TEST_loginFlow() {
  const props = PropertiesService.getScriptProperties();
  const result = handleLogin({
    username: props.getProperty("TEST_LOGIN_USER") || "",
    password: props.getProperty("TEST_LOGIN_PW")   || ""
  });
  Logger.log("Login result: " + JSON.stringify(result));
}