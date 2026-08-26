import crypto from 'node:crypto';
import dotenv from 'dotenv';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_CRM_SS_ID = '1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E';
const DEFAULT_AUTH_SS_ID = '1e2XmGuosFSzeDQYMf3TYG3ZFfENYTyne5pqOi3L5m1g';
const DEFAULT_ROUTES_SS_ID = '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM';
const DEFAULT_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxFrdZRbkXuGuazfqf7q-rKp-T-3DinM8t_3Pp5i6Efr7tciDU59Go6L7s3kxCQl9I/exec';

let accessTokenCache = null;
let accessTokenPromise = null;
const tokenValidationCache = new Map();
const dataCache = new Map();

if ((!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) &&
    process.env.VERCEL_ENV !== 'production' &&
    process.env.VERCEL_ENV !== 'preview') {
  dotenv.config({ path: '.env.local', override: true, quiet: true });
}

function b64url(value) {
  return Buffer.from(value).toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function privateKey() {
  const raw = process.env.GOOGLE_PRIVATE_KEY || '';
  return raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\n/g, '\n')
    .trim();
}

async function getAccessToken() {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60000) {
    return accessTokenCache.token;
  }
  if (accessTokenPromise) return accessTokenPromise;

  accessTokenPromise = requestAccessToken_();
  try {
    return await accessTokenPromise;
  } finally {
    accessTokenPromise = null;
  }
}

async function requestAccessToken_() {
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key = privateKey();
  if (!email || !key) throw new Error('Missing GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY');

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now
  }));
  const input = `${header}.${claim}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), key);
  const assertion = `${input}.${b64url(signature)}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || 'Google OAuth token request failed');
  }
  accessTokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000
  };
  return accessTokenCache.token;
}

export function crmSpreadsheetId() {
  return process.env.CRM_SPREADSHEET_ID || DEFAULT_CRM_SS_ID;
}

export function authSpreadsheetId() {
  return process.env.AUTH_SPREADSHEET_ID || DEFAULT_AUTH_SS_ID;
}

export function routesSpreadsheetId() {
  return process.env.ROUTES_SPREADSHEET_ID || DEFAULT_ROUTES_SS_ID;
}

// Spreadsheet that holds QBO config tabs (QBO_Tokens, QBO_Account_Map).
// Defaults to the CRM spreadsheet the service account can already reach.
export function qboConfigSpreadsheetId() {
  return process.env.QBO_CONFIG_SPREADSHEET_ID || crmSpreadsheetId();
}

export function appsScriptUrl() {
  return process.env.APPS_SCRIPT_URL || process.env.MCPS_APPS_SCRIPT_URL || process.env.GAS_URL || DEFAULT_APPS_SCRIPT_URL;
}

// Full session object from GAS validate_token (includes roles). Cached briefly.
// Returns null when the token is missing or invalid.
export async function validatePortalSession(token) {
  const clean = String(token || '').trim();
  if (!clean) return null;
  const hit = tokenValidationCache.get(clean);
  if (hit && hit.expiresAt > Date.now()) return hit.session;

  const base = appsScriptUrl();
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'validate_token',
      token: clean
    })
  });
  const json = await res.json().catch(() => ({}));
  const ok = !!(res.ok && json && json.ok);
  const session = ok ? json : null;
  tokenValidationCache.set(clean, { ok, session, expiresAt: Date.now() + 10 * 60 * 1000 });
  return session;
}

function parseRoles(raw) {
  const roles = String(raw || '')
    .split(',')
    .map(role => role.trim().toLowerCase())
    .filter(Boolean);
  return roles.length ? roles : ['technician'];
}

function isTruthyFalse(value) {
  return ['false', '0', 'no'].includes(String(value || '').trim().toLowerCase());
}

function isExpiredDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || Date.now() > date.getTime();
}

// Fast path for Vercel read APIs. The session data lives in the Auth spreadsheet,
// so read-only endpoints can avoid a slow Apps Script validate_token round trip.
// GAS validation remains available as a fallback where a deployment has not yet
// shared the Auth spreadsheet with the service account.
export async function validatePortalSessionFromSheets(token) {
  const clean = String(token || '').trim();
  if (!clean) return null;

  const hit = tokenValidationCache.get(clean);
  if (hit && hit.expiresAt > Date.now()) return hit.session;

  const values = await readSheetRanges(['Sessions', 'Users'], authSpreadsheetId());
  const sessions = rowsToObjects(values.Sessions);
  const users = rowsToObjects(values.Users);
  const sessionRow = sessions.find(row => String(row.token || '').trim() === clean);
  if (!sessionRow) return null;
  if (isTruthyFalse(sessionRow.revoked) === false && String(sessionRow.revoked || '').trim()) return null;
  if (isExpiredDate(sessionRow.expires_at)) return null;

  const username = String(sessionRow.username || '').trim().toLowerCase();
  const userRow = users.find(row => String(row.username || '').trim().toLowerCase() === username);
  if (userRow && isTruthyFalse(userRow.active)) return null;

  const roles = parseRoles((userRow && (userRow.roles || userRow.role)) || sessionRow.roles || sessionRow.role);
  const session = {
    ok: true,
    username,
    name: (userRow && userRow.name) || sessionRow.name || username,
    roles,
    operator_name: (userRow && userRow.operator_name) || sessionRow.operator_name || '',
    email: (userRow && userRow.email) || '',
    phone: (userRow && userRow.phone) || '',
    first_name: (userRow && userRow.first_name) || '',
    last_name: (userRow && userRow.last_name) || ''
  };

  tokenValidationCache.set(clean, { ok: true, session, expiresAt: Date.now() + 10 * 60 * 1000 });
  return session;
}

export async function validatePortalToken(token) {
  return !!(await validatePortalSession(token));
}

// Roles can arrive as session.roles[] or nested under session.user.roles[].
export function hasAdminAccess(session) {
  if (!session) return false;
  const roles = []
    .concat(session.roles || [])
    .concat((session.user && session.user.roles) || [])
    .map(r => String(r).trim().toLowerCase());
  return roles.includes('admin') || roles.includes('manager');
}

// Route guard for QBO admin endpoints. Reads token from query or JSON body.
// On failure it sends the response and returns null; on success returns the session.
export async function requireAdminPortalToken(req, res) {
  const token = (req.query && req.query.token)
    || (req.body && req.body.token)
    || '';
  const session = await validatePortalSession(token);
  if (!session) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return null;
  }
  if (!hasAdminAccess(session)) {
    sendJson(res, 403, { ok: false, error: 'Admin access required.' });
    return null;
  }
  return session;
}

export function normalizeHeader(name) {
  return String(name || '').trim().toLowerCase().replace(/ /g, '_');
}

function parseCell(key, value) {
  if (value === undefined || value === null) return '';
  const moneyNumberFields = new Set([
    'service_subtotal', 'discount_value', 'discount_amount',
    'discounted_service_subtotal', 'quote_subtotal', 'sales_tax',
    'total_with_tax', 'chem_cost_est', 'net_profit_est', 'margin_percent',
    'travel_fee', 'travel_one_way_miles', 'travel_round_trip_miles',
    'travel_billable_round_trip_miles', 'repair_invoice_amount'
  ]);
  const booleanFields = new Set([
    'has_robot', 'high_sun_exposure', 'has_pets', 'startup_chemical_work',
    'startup_programming', 'startup_pool_school', 'sponsored_by_mcp'
  ]);
  if (moneyNumberFields.has(key)) {
    const n = Number(String(value).replace(/[$,%]/g, '').trim());
    return Number.isFinite(n) ? n : value;
  }
  if (booleanFields.has(key)) {
    const s = String(value).trim().toLowerCase();
    return s === 'true' || s === 'yes' || s === '1';
  }
  if (key === 'contact_log') {
    try {
      const parsed = JSON.parse(String(value || '[]'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return value;
}

export function rowsToObjects(values) {
  if (!Array.isArray(values) || values.length < 1) return [];
  const headers = values[0].map(normalizeHeader);
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      if (h) obj[h] = parseCell(h, row[i] ?? '');
    });
    return obj;
  });
}

export async function readSheetRange(range, spreadsheetId = crmSpreadsheetId()) {
  const token = await getAccessToken();
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  url.searchParams.set('majorDimension', 'ROWS');
  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Sheets API read failed');
  return json.values || [];
}

export async function readSheetRanges(ranges, spreadsheetId = crmSpreadsheetId()) {
  const cleanRanges = (ranges || []).map(r => String(r || '').trim()).filter(Boolean);
  if (!cleanRanges.length) return {};

  const token = await getAccessToken();
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet`);
  cleanRanges.forEach(range => url.searchParams.append('ranges', range));
  url.searchParams.set('majorDimension', 'ROWS');

  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Sheets API batch read failed');

  const out = {};
  (json.valueRanges || []).forEach((valueRange, index) => {
    out[cleanRanges[index]] = valueRange.values || [];
  });
  cleanRanges.forEach(range => {
    if (!out[range]) out[range] = [];
  });
  return out;
}

function rangeSheetName(range) {
  const raw = String(range || '').split('!')[0].trim();
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

export async function listSheetTitles(spreadsheetId = crmSpreadsheetId()) {
  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Sheets API metadata read failed');
  return (json.sheets || [])
    .map(sheet => sheet && sheet.properties && sheet.properties.title)
    .filter(Boolean);
}

export async function readExistingSheetRanges(ranges, spreadsheetId = crmSpreadsheetId()) {
  const cleanRanges = (ranges || []).map(r => String(r || '').trim()).filter(Boolean);
  if (!cleanRanges.length) return {};

  const titles = new Set(await listSheetTitles(spreadsheetId));
  const existing = cleanRanges.filter(range => titles.has(rangeSheetName(range)));
  const out = existing.length ? await readSheetRanges(existing, spreadsheetId) : {};
  cleanRanges.forEach(range => {
    if (!out[range]) out[range] = [];
  });
  return out;
}

// Overwrite a range with a 2D array of values.
export async function writeSheetRange(range, values, spreadsheetId = crmSpreadsheetId()) {
  const token = await getAccessToken();
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  url.searchParams.set('valueInputOption', 'RAW');
  const res = await fetch(url.toString(), {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ range, majorDimension: 'ROWS', values })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Sheets API write failed');
  return json;
}

// Append rows to a sheet/tab (Google picks the next empty row).
export async function appendSheetRows(sheetName, rows, spreadsheetId = crmSpreadsheetId()) {
  const token = await getAccessToken();
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}:append`);
  url.searchParams.set('valueInputOption', 'RAW');
  url.searchParams.set('insertDataOption', 'INSERT_ROWS');
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ majorDimension: 'ROWS', values: rows })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Sheets API append failed');
  return json;
}

export async function clearSheetRange(range, spreadsheetId = crmSpreadsheetId()) {
  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}'
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Sheets API clear failed');
  return json;
}

// Ensure a tab exists with the given header row. Creates the tab (and writes
// headers) when missing; otherwise leaves existing data untouched. Returns the
// header row currently in the sheet.
export async function ensureSheetWithHeaders(sheetName, headers, spreadsheetId = crmSpreadsheetId()) {
  const token = await getAccessToken();
  const meta = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`,
    { headers: { authorization: `Bearer ${token}` } }
  ).then(r => r.json());
  const titles = (meta.sheets || []).map(s => s.properties && s.properties.title);
  if (!titles.includes(sheetName)) {
    const addRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] })
      }
    );
    const addJson = await addRes.json();
    if (!addRes.ok) throw new Error(addJson.error?.message || 'Sheets API addSheet failed');
    await writeSheetRange(`${sheetName}!A1`, [headers], spreadsheetId);
    return headers.slice();
  }
  const existing = await readSheetRange(`${sheetName}!1:1`, spreadsheetId);
  if (!existing.length || !existing[0].length) {
    await writeSheetRange(`${sheetName}!A1`, [headers], spreadsheetId);
    return headers.slice();
  }
  return existing[0];
}

export async function getCached(key, ttlMs, loader) {
  const hit = dataCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await loader();
  dataCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

export function sendJson(res, status, body, cacheSeconds = 0) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (cacheSeconds > 0) {
    res.setHeader('cache-control', `s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds}`);
  } else {
    res.setHeader('cache-control', 'no-store');
  }
  res.status(status).send(JSON.stringify(body));
}

// ── Batched writes ────────────────────────────────────────────────────────────
// values:batchUpdate takes many ranges in ONE request. Apps Script's softSetCell_
// did the opposite: a getLastColumn(), a header read and a setValue() PER CELL,
// three round trips each, ~200 call sites. A save that touched forty cells cost
// well over a hundred Sheets operations; here it costs one.
export async function writeSheetRanges(updates, spreadsheetId = crmSpreadsheetId()) {
  const data = (updates || []).filter(u => u && u.range && Array.isArray(u.values));
  if (!data.length) return { totalUpdatedCells: 0 };
  const token = await getAccessToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: data.map(u => ({ range: u.range, majorDimension: 'ROWS', values: u.values }))
      })
    }
  );
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Sheets API batch write failed');
  return json;
}

// A1 column letter for a zero-based index. Needed beyond column Z: Proposals
// carries 51 columns, so a full-row write range ends at AY.
export function colLetter(index) {
  let n = Number(index) + 1, out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// Quote a tab name for an A1 range. Sheet titles with spaces or apostrophes
// break an unquoted range, and the failure is a confusing 400 rather than
// anything that names the sheet.
export function a1(sheetName, startCol, row, endCol) {
  const safe = `'${String(sheetName).replace(/'/g, "''")}'`;
  return `${safe}!${colLetter(startCol)}${row}:${colLetter(endCol)}${row}`;
}
