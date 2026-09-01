// Spreadsheet ids this feature needs beyond what api/_sheets.js exports.
//
// `main`'s _sheets.js exports crmSpreadsheetId() but not routesSpreadsheetId() —
// that helper only exists on the unmerged working branch. Rather than editing
// _sheets.js (which would collide when the branches meet), the id lives here,
// following the exact same env-override-with-known-default shape.

export function routesSpreadsheetId() {
  return process.env.ROUTES_SPREADSHEET_ID || '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM';
}

export function authSpreadsheetId() {
  return process.env.AUTH_SPREADSHEET_ID || '1e2XmGuosFSzeDQYMf3TYG3ZFfENYTyne5pqOi3L5m1g';
}
