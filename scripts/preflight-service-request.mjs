// Preflight for the service-request feature.
//
//   node scripts/preflight-service-request.mjs
//
// Answers one question before any other work is worth doing: can the service
// account READ and WRITE both spreadsheets this feature touches?
//
// The CRM spreadsheet is already exercised by api/crm/*, so read+write there is
// near-certain. The ROUTES spreadsheet is the real unknown — nothing on `main`
// has ever written to it from Vercel, and without this check we would only find
// out at the moment an admin approves a visit.
//
// Write checks use a scratch tab that is created and then deleted, so this never
// touches real data.
//
// ⚠️ api/_sheets.js on `main` does not load .env.local (that was added on the
// unmerged branch). Under `vercel dev` the env is injected by the platform, but a
// bare `node` run has to do it here — and BEFORE importing _sheets.js, since it
// reads process.env at module scope. Hence the dynamic imports below.

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true, quiet: true });

const { crmSpreadsheetId, readSheetRange, writeSheetRange, ensureSheetWithHeaders,
        appendSheetRows } = await import('../api/_sheets.js');
const { routesSpreadsheetId } = await import('../api/_lib/ids.js');

const SCRATCH = '_preflight_scratch';

let failures = 0;
const ok  = (l, d = '') => console.log(`  \x1b[32mok\x1b[0m    ${l}${d ? '  ' + d : ''}`);
const bad = (l, d = '') => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m  ${l}${d ? '\n        ' + d : ''}`); };

async function checkRead(name, id, tab) {
  try {
    const rows = await readSheetRange(`${tab}!A1:B2`, id);
    ok(`read  ${name} · ${tab}`, rows.length ? `(${rows[0].length} cols visible)` : '(empty)');
  } catch (e) {
    bad(`read  ${name} · ${tab}`, e.message);
  }
}

// Create a scratch tab, write to it, then delete it. Deleting needs the sheetId,
// so this goes through batchUpdate directly rather than the _sheets.js helpers.
async function checkWrite(name, id) {
  try {
    await ensureSheetWithHeaders(SCRATCH, ['preflight'], id);
    await appendSheetRows(SCRATCH, [[new Date().toISOString(), 'service-request preflight']], id);
    await writeSheetRange(`${SCRATCH}!A1`, [['preflight']], id);
    const removed = await deleteScratch(id);
    ok(`write ${name}`, removed ? '(scratch tab created and removed)' : '(scratch tab created — remove by hand)');
  } catch (e) {
    bad(`write ${name}`, e.message);
  }
}

async function deleteScratch(spreadsheetId) {
  const { google } = { google: null };  // no SDK in this repo; raw REST below
  const token = await getToken();
  const meta = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    { headers: { authorization: `Bearer ${token}` } }
  ).then(r => r.json());
  const sheet = (meta.sheets || []).find(s => s.properties && s.properties.title === SCRATCH);
  if (!sheet) return false;
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: sheet.properties.sheetId } }] })
  });
  return res.ok;
}

// Minimal JWT mint, mirroring api/_sheets.js. Duplicated rather than exported
// because this is a one-off dev script and _sheets.js must stay untouched.
async function getToken() {
  const crypto = await import('node:crypto');
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').trim()
    .replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').trim();
  const b64 = v => Buffer.from(v).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const now = Math.floor(Date.now() / 1000);
  const input = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now
  }));
  const assertion = input + '.' + b64(crypto.default.sign('RSA-SHA256', Buffer.from(input), key));
  const json = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  }).then(r => r.json());
  return json.access_token;
}

const crmId = crmSpreadsheetId();
const routesId = routesSpreadsheetId();
const account = process.env.GOOGLE_CLIENT_EMAIL || '(GOOGLE_CLIENT_EMAIL not set)';

console.log('\nService-request preflight\n');
console.log(`  service account:    ${account}`);
console.log(`  CRM spreadsheet:    ${crmId}`);
console.log(`  Routes spreadsheet: ${routesId}\n`);

console.log('CRM spreadsheet — Quotes, Clients, Client_Locations, Service_Requests');
await checkRead('CRM', crmId, 'Quotes');
await checkRead('CRM', crmId, 'Clients');
await checkRead('CRM', crmId, 'Client_Locations');
await checkWrite('CRM', crmId);

console.log('\nRoutes spreadsheet — Scheduled_Visits, Repair_Orders, Routes');
await checkRead('Routes', routesId, 'Scheduled_Visits');
await checkRead('Routes', routesId, 'Routes');
await checkRead('Routes', routesId, 'Repair_Orders');
await checkWrite('Routes', routesId);

if (failures) {
  console.log(`\n\x1b[31m${failures} check(s) failed.\x1b[0m`);
  console.log('\nIf the Routes checks failed, the fix is a share, not a code change:');
  console.log('  1. Open the Routes spreadsheet in Google Sheets');
  console.log(`  2. Share → paste:  ${account}`);
  console.log('  3. Set it to Editor → uncheck "Notify people" → Share');
  console.log('  4. Re-run this script\n');
  process.exit(1);
}
console.log('\n\x1b[32mAll checks passed.\x1b[0m\n');
