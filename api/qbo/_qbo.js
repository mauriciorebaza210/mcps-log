import crypto from 'node:crypto';
import {
  qboConfigSpreadsheetId,
  ensureSheetWithHeaders,
  readSheetRange,
  writeSheetRange
} from '../_sheets.js';

// ── Intuit endpoints ──────────────────────────────────────────────────────────
const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL     = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL    = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPE         = 'com.intuit.quickbooks.accounting';
const MINOR_VERSION = '65';

const TOKENS_SHEET = 'QBO_Tokens';
const MAP_SHEET    = 'QBO_Account_Map';

const TOKEN_HEADERS = [
  'Realm_ID', 'Access_Token', 'Refresh_Token',
  'Access_Expires_At', 'Refresh_Token_Updated_At', 'Company_Name', 'Updated_At'
];
const MAP_HEADERS = ['Bucket', 'Account_ID', 'Account_Name'];

export const REQUIRED_BUCKETS = [
  'wages_expense', 'payroll_tax_expense', 'federal_income_tax_payable',
  'fica_payable', 'futa_payable', 'suta_payable', 'bank_checking'
];

function apiBase() {
  return String(process.env.QBO_ENV || '').toLowerCase() === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function basicAuth() {
  const id = process.env.QBO_CLIENT_ID || '';
  const secret = process.env.QBO_CLIENT_SECRET || '';
  if (!id || !secret) throw new Error('Missing QBO_CLIENT_ID or QBO_CLIENT_SECRET');
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

// ── OAuth state (HMAC-signed, time-limited; carries no portal token) ───────────
const STATE_TTL_MS = 10 * 60 * 1000;

function stateSecret() {
  const s = process.env.QBO_STATE_SECRET;
  if (!s) throw new Error('Missing QBO_STATE_SECRET');
  return s;
}

export function signState() {
  const payload = { n: crypto.randomBytes(8).toString('hex'), ts: Date.now() };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 2) return false;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { ts } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof ts === 'number' && Date.now() - ts <= STATE_TTL_MS;
  } catch (_) {
    return false;
  }
}

export function buildAuthorizeUrl() {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', process.env.QBO_CLIENT_ID || '');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('redirect_uri', process.env.QBO_REDIRECT_URI || '');
  url.searchParams.set('state', signState());
  return url.toString();
}

// ── Token storage (single config row in QBO_Tokens) ───────────────────────────
async function readTokenRow() {
  const ssId = qboConfigSpreadsheetId();
  const headers = await ensureSheetWithHeaders(TOKENS_SHEET, TOKEN_HEADERS, ssId);
  const idx = {};
  headers.forEach((h, i) => { idx[String(h).trim()] = i; });
  const rows = await readSheetRange(`${TOKENS_SHEET}!A2:Z2`, ssId);
  const row = rows[0] || [];
  const get = h => (idx[h] !== undefined ? row[idx[h]] : '') || '';
  return {
    realm_id:          String(get('Realm_ID')),
    access_token:      String(get('Access_Token')),
    refresh_token:     String(get('Refresh_Token')),
    access_expires_at: Number(get('Access_Expires_At')) || 0,
    refresh_updated_at: String(get('Refresh_Token_Updated_At')),
    company_name:      String(get('Company_Name'))
  };
}

async function writeTokenRow(t) {
  const ssId = qboConfigSpreadsheetId();
  await ensureSheetWithHeaders(TOKENS_SHEET, TOKEN_HEADERS, ssId);
  const row = [
    t.realm_id, t.access_token, t.refresh_token,
    String(t.access_expires_at || 0), t.refresh_updated_at || '',
    t.company_name || '', new Date().toISOString()
  ];
  await writeSheetRange(`${TOKENS_SHEET}!A2`, [row], ssId);
}

async function requestTokens(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { authorization: basicAuth(), accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || 'QBO token request failed');
  }
  return json;
}

// Exchange the authorization code for tokens, fetch the company name, and persist.
export async function exchangeCodeAndStore(code, realmId) {
  const json = await requestTokens({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.QBO_REDIRECT_URI || ''
  });
  const now = Date.now();
  const tokens = {
    realm_id: realmId,
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    access_expires_at: now + Number(json.expires_in || 3600) * 1000,
    refresh_updated_at: new Date(now).toISOString(),
    company_name: ''
  };
  await writeTokenRow(tokens);
  try { tokens.company_name = await fetchCompanyName(realmId, json.access_token); } catch (_) {}
  if (tokens.company_name) await writeTokenRow(tokens);
  return tokens;
}

// Return a valid access token, refreshing if expired. Concurrency-safe: before
// persisting a rotated refresh token we re-read the row, and if another instance
// already wrote a newer refresh token we keep theirs rather than clobber it with
// a value that Intuit may have since invalidated.
export async function getValidAccessToken() {
  const t = await readTokenRow();
  if (!t.refresh_token) throw new Error('QuickBooks is not connected.');
  if (t.access_token && t.access_expires_at > Date.now() + 60000) {
    return { accessToken: t.access_token, realmId: t.realm_id };
  }

  const json = await requestTokens({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  const now = Date.now();
  const fresh = {
    realm_id: t.realm_id,
    access_token: json.access_token,
    refresh_token: json.refresh_token || t.refresh_token,
    access_expires_at: now + Number(json.expires_in || 3600) * 1000,
    refresh_updated_at: new Date(now).toISOString(),
    company_name: t.company_name
  };

  const current = await readTokenRow();
  const someoneElseRotated =
    current.refresh_token && current.refresh_token !== t.refresh_token;
  if (someoneElseRotated) {
    // Keep the newer stored refresh token; our access token is still valid for this call.
    if (current.access_token && current.access_expires_at > Date.now() + 60000) {
      return { accessToken: current.access_token, realmId: current.realm_id };
    }
    fresh.refresh_token = current.refresh_token;
  }
  await writeTokenRow(fresh);
  return { accessToken: fresh.access_token, realmId: fresh.realm_id };
}

// Authenticated call to the QBO Accounting API. `path` is relative to the company,
// e.g. `journalentry` or `query?query=...`.
export async function qboFetch(path, { method = 'GET', body, accessToken, realmId } = {}) {
  if (!accessToken || !realmId) {
    const t = await getValidAccessToken();
    accessToken = t.accessToken;
    realmId = t.realmId;
  }
  const url = new URL(`${apiBase()}/v3/company/${realmId}/${path}`);
  if (!url.searchParams.has('minorversion')) url.searchParams.set('minorversion', MINOR_VERSION);
  const res = await fetch(url.toString(), {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fault = json && json.Fault && json.Fault.Error && json.Fault.Error[0];
    throw new Error(fault ? `${fault.Message}${fault.Detail ? ': ' + fault.Detail : ''}` : `QBO API ${res.status}`);
  }
  return json;
}

async function fetchCompanyName(realmId, accessToken) {
  const json = await qboFetch(`companyinfo/${realmId}`, { accessToken, realmId });
  return (json.CompanyInfo && json.CompanyInfo.CompanyName) || '';
}

export async function getConnectionStatus() {
  const t = await readTokenRow();
  return {
    connected: !!t.refresh_token,
    realmId: t.realm_id,
    companyName: t.company_name,
    expiresAt: t.access_expires_at
  };
}

export async function disconnect() {
  const t = await readTokenRow();
  if (t.refresh_token) {
    try {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { authorization: basicAuth(), accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ token: t.refresh_token })
      });
    } catch (_) {}
  }
  await writeTokenRow({ realm_id: '', access_token: '', refresh_token: '', access_expires_at: 0, refresh_updated_at: '', company_name: '' });
}

// ── Account map (bucket → { account_id, account_name }) ───────────────────────
export async function getAccountMap() {
  const ssId = qboConfigSpreadsheetId();
  await ensureSheetWithHeaders(MAP_SHEET, MAP_HEADERS, ssId);
  const rows = await readSheetRange(`${MAP_SHEET}!A2:C`, ssId);
  const map = {};
  rows.forEach(r => {
    const bucket = String(r[0] || '').trim();
    if (bucket) map[bucket] = { account_id: String(r[1] || '').trim(), account_name: String(r[2] || '').trim() };
  });
  return map;
}

export async function saveAccountMap(map) {
  const ssId = qboConfigSpreadsheetId();
  await ensureSheetWithHeaders(MAP_SHEET, MAP_HEADERS, ssId);
  const rows = REQUIRED_BUCKETS.map(b => {
    const e = map[b] || {};
    return [b, String(e.account_id || '').trim(), String(e.account_name || '').trim()];
  });
  // Rewrite the whole bucket block (A2:C{n+1}) so removals/edits stick.
  await writeSheetRange(`${MAP_SHEET}!A2:C${rows.length + 1}`, rows, ssId);
  return getAccountMap();
}

// Buckets with no account id mapped yet.
export function missingBuckets(map) {
  return REQUIRED_BUCKETS.filter(b => !(map[b] && map[b].account_id));
}
