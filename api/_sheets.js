import crypto from 'node:crypto';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_CRM_SS_ID = '1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E';
const DEFAULT_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxFrdZRbkXuGuazfqf7q-rKp-T-3DinM8t_3Pp5i6Efr7tciDU59Go6L7s3kxCQl9I/exec';

let accessTokenCache = null;
const tokenValidationCache = new Map();
const dataCache = new Map();

function b64url(value) {
  return Buffer.from(value).toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function privateKey() {
  const raw = process.env.GOOGLE_PRIVATE_KEY || '';
  return raw.replace(/\\n/g, '\n');
}

async function getAccessToken() {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60000) {
    return accessTokenCache.token;
  }
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

export async function validatePortalToken(token) {
  const clean = String(token || '').trim();
  if (!clean) return false;
  const hit = tokenValidationCache.get(clean);
  if (hit && hit.expiresAt > Date.now()) return hit.ok;

  const base = process.env.APPS_SCRIPT_URL || process.env.MCPS_APPS_SCRIPT_URL || DEFAULT_APPS_SCRIPT_URL;
  const url = new URL(base);
  url.searchParams.set('action', 'validate_token');
  url.searchParams.set('token', clean);
  const res = await fetch(url.toString());
  const json = await res.json().catch(() => ({}));
  const ok = !!(res.ok && json && json.ok);
  tokenValidationCache.set(clean, { ok, expiresAt: Date.now() + 10 * 60 * 1000 });
  return ok;
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

export async function readSheetRange(range) {
  const token = await getAccessToken();
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${crmSpreadsheetId()}/values/${encodeURIComponent(range)}`);
  url.searchParams.set('majorDimension', 'ROWS');
  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Sheets API read failed');
  return json.values || [];
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
