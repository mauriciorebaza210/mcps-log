// Every QuickBooks endpoint, behind one Vercel Function.
//
// ⚠️ WHY THIS IS ONE FILE. Hobby allows 12 Vercel Functions per deployment and
// without a framework every file under api/ becomes one. QBO was seven of them.
// Folding them into a single function bought back six slots — the difference
// between this branch deploying and not.
//
// The public URLs did NOT change. A rewrite in vercel.json maps
// /api/qbo/<op> → /api/qbo?op=<op>, so the frontend still calls
// /api/qbo/status, /api/qbo/map and the rest exactly as before, and — the one
// that really matters — Intuit's registered redirect URI (/api/qbo/callback,
// stored in QBO_REDIRECT_URI and configured in the Intuit app) keeps working
// untouched. Renaming that would have meant re-registering the OAuth callback.
//
// Each op below is its former file's handler, moved verbatim. The only change
// is the wrapper: they are named functions now instead of default exports.

import { sendJson, validatePortalToken, requireAdminPortalToken } from '../_sheets.js';
import {
  getConnectionStatus, getAccountMap, saveAccountMap, missingBuckets, REQUIRED_BUCKETS,
  buildAuthorizeUrl, verifyState, exchangeCodeAndStore, disconnect, qboFetch
} from './_qbo.js';

// ── status ────────────────────────────────────────────────────────────────────
// GET /api/qbo/status?token=<portal token>
// Returns connection + whether the account map is complete (drives the UI banner).
async function opStatus(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const ok = await validatePortalToken(req.query.token);
    if (!ok) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });

    const status = await getConnectionStatus();
    let mapComplete = false;
    let missing = [];
    if (status.connected) {
      const map = await getAccountMap();
      missing = missingBuckets(map);
      mapComplete = missing.length === 0;
    }
    return sendJson(res, 200, { ok: true, ...status, mapComplete, missing });
  } catch (error) {
    console.error('qbo/status failed', error);
    return sendJson(res, 500, { ok: false, error: 'Could not read QuickBooks status.' });
  }
}

// ── connect ───────────────────────────────────────────────────────────────────
// GET /api/qbo/connect?token=<admin portal token>
// Validates the admin, then redirects the browser to Intuit's consent screen.
async function opConnect(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await requireAdminPortalToken(req, res);
    if (!session) return; // response already sent
    const url = buildAuthorizeUrl();
    res.statusCode = 302;
    res.setHeader('Location', url);
    res.end();
  } catch (error) {
    console.error('qbo/connect failed', error);
    return sendJson(res, 500, { ok: false, error: 'Could not start QuickBooks connection.' });
  }
}

// ── callback ──────────────────────────────────────────────────────────────────
function page(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title}</title>
    <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0d4d44;color:#fff;
      display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
      .card{background:#fff;color:#0d4d44;border-radius:14px;padding:2rem 2.5rem;max-width:420px;text-align:center;
      box-shadow:0 10px 40px rgba(0,0,0,.3)} h1{margin:.2rem 0 1rem;font-size:1.25rem}
      p{color:#444;line-height:1.5} .ok{color:#166534}</style></head>
    <body><div class="card"><h1 class="${title.includes('Connected') ? 'ok' : ''}">${title}</h1>
    <p>${message}</p><p style="margin-top:1.5rem;font-size:.85rem;color:#888">You can close this tab and return to the portal.</p>
    </div></body></html>`;
}

// GET /api/qbo/callback?code=...&realmId=...&state=...  (Intuit redirect target)
async function opCallback(req, res) {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  try {
    const { code, realmId, state, error } = req.query || {};
    if (error) { res.status(400).send(page('Connection cancelled', String(error))); return; }
    if (!verifyState(state)) { res.status(400).send(page('Connection failed', 'Invalid or expired request. Please start the connection again from the portal.')); return; }
    if (!code || !realmId) { res.status(400).send(page('Connection failed', 'Missing authorization code from QuickBooks.')); return; }

    const tokens = await exchangeCodeAndStore(String(code), String(realmId));
    res.status(200).send(page('QuickBooks Connected', `Linked to <strong>${tokens.company_name || 'your company'}</strong>. Next, map your accounts in the portal.`));
  } catch (e) {
    console.error('qbo/callback failed', e);
    res.status(500).send(page('Connection failed', 'Could not complete the QuickBooks connection. Please try again.'));
  }
}

// ── disconnect ────────────────────────────────────────────────────────────────
// POST /api/qbo/disconnect { token }  → revoke + clear stored tokens.
async function opDisconnect(req, res) {
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await requireAdminPortalToken(req, res);
    if (!session) return;
    await disconnect();
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error('qbo/disconnect failed', error);
    return sendJson(res, 500, { ok: false, error: 'Could not disconnect QuickBooks.' });
  }
}

// ── accounts ──────────────────────────────────────────────────────────────────
// GET /api/qbo/accounts?token=<admin>
// Returns the active chart of accounts for the mapping dropdowns.
async function opAccounts(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await requireAdminPortalToken(req, res);
    if (!session) return;

    const query = 'select Id, Name, FullyQualifiedName, AccountType, AccountSubType, Classification from Account where Active = true MAXRESULTS 1000';
    const json = await qboFetch(`query?query=${encodeURIComponent(query)}`);
    const accounts = ((json.QueryResponse && json.QueryResponse.Account) || []).map(a => ({
      id: a.Id,
      name: a.FullyQualifiedName || a.Name,
      type: a.AccountType,
      subType: a.AccountSubType,
      classification: a.Classification
    }));
    return sendJson(res, 200, { ok: true, accounts });
  } catch (error) {
    console.error('qbo/accounts failed', error);
    return sendJson(res, 502, { ok: false, error: 'Could not load QuickBooks accounts.' });
  }
}

// ── map ───────────────────────────────────────────────────────────────────────
// GET  /api/qbo/map?token=<admin>           → current bucket→account map
// POST /api/qbo/map  { token, map }         → save the map (full replace)
async function opMap(req, res) {
  try {
    const session = await requireAdminPortalToken(req, res);
    if (!session) return;

    if (req.method === 'GET') {
      const map = await getAccountMap();
      return sendJson(res, 200, { ok: true, map, buckets: REQUIRED_BUCKETS, missing: missingBuckets(map) });
    }
    if (req.method === 'POST') {
      const incoming = (req.body && req.body.map) || {};
      const saved = await saveAccountMap(incoming);
      return sendJson(res, 200, { ok: true, map: saved, missing: missingBuckets(saved) });
    }
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('qbo/map failed', error);
    return sendJson(res, 500, { ok: false, error: 'Could not read or save the account map.' });
  }
}

// ── journal ───────────────────────────────────────────────────────────────────
const cents = n => Math.round((Number(n) || 0) * 100) / 100;

// DocNumber is the idempotency key (QBO max 21 chars). Deterministic per paycheck.
function docNumberFor(paycheckId) {
  return 'PR-' + String(paycheckId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 18);
}

function ymd(d) {
  const x = d instanceof Date ? d : new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// POST /api/qbo/journal { token, paycheck_id, paycheck }
// Posts ONE balanced JournalEntry for a recorded paycheck. Idempotent on DocNumber.
async function opJournal(req, res) {
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await requireAdminPortalToken(req, res);
    if (!session) return;

    const paycheckId = String((req.body && req.body.paycheck_id) || '').trim();
    const p = (req.body && req.body.paycheck) || {};
    if (!paycheckId) return sendJson(res, 400, { ok: false, error: 'paycheck_id is required' });

    // Account map must be complete before we can post.
    const map = await getAccountMap();
    const missing = missingBuckets(map);
    if (missing.length) {
      return sendJson(res, 400, { ok: false, error: 'Account map incomplete', missing });
    }

    // Pull the saved figures (frontend passes the row it just saved).
    const gross  = cents(p.gross);
    const fed    = cents(p.fed);
    const ss     = cents(p.ss);
    const med    = cents(p.med);
    const erSs   = cents(p.er_ss);
    const erMed  = cents(p.er_med);
    const futa   = cents(p.futa);
    const suta   = cents(p.suta);
    let   net    = cents(p.net);
    if (gross <= 0) return sendJson(res, 400, { ok: false, error: 'Paycheck gross must be greater than zero.' });

    const payrollTax = cents(erSs + erMed + futa + suta);
    const fica = cents(ss + med + erSs + erMed);

    // Balance check to the cent; absorb any sub-cent rounding drift on the net line.
    const debits  = cents(gross + payrollTax);
    const credits = cents(fed + fica + futa + suta + net);
    const drift = cents(debits - credits);
    if (Math.abs(drift) > 0.02) {
      return sendJson(res, 422, { ok: false, error: `Journal entry is out of balance by ${drift.toFixed(2)}.` });
    }
    net = cents(net + drift); // nudge only the bank/net line

    const acct = b => ({ value: map[b].account_id });
    const line = (amount, postingType, bucket, desc) => ({
      Amount: cents(amount),
      DetailType: 'JournalEntryLineDetail',
      Description: desc,
      JournalEntryLineDetail: { PostingType: postingType, AccountRef: acct(bucket) }
    });

    const rawLines = [
      line(gross,      'Debit',  'wages_expense',              'Gross wages'),
      line(payrollTax, 'Debit',  'payroll_tax_expense',        'Employer payroll taxes'),
      line(fed,        'Credit', 'federal_income_tax_payable', 'Federal income tax withheld'),
      line(fica,       'Credit', 'fica_payable',               'FICA (SS + Medicare, ee + er)'),
      line(futa,       'Credit', 'futa_payable',               'FUTA'),
      line(suta,       'Credit', 'suta_payable',               'SUTA (TX)'),
      line(net,        'Credit', 'bank_checking',              'Net pay')
    ].filter(l => l.Amount > 0); // QBO rejects zero-amount lines

    const docNumber = docNumberFor(paycheckId);
    const txnDate = ymd(p.pay_date ? new Date(p.pay_date) : (p.period_end ? new Date(p.period_end) : new Date()));
    const privateNote = `MCPS payroll · ${p.name || p.username || ''} · ${p.period_start || ''} → ${p.period_end || ''} · paycheck_id=${paycheckId}`;

    // DocNumber is deterministic per paycheck, so an existing JE means this paycheck was
    // already posted. Rewrite it in full rather than skipping: a paycheck can be edited
    // after posting, and returning early would leave QuickBooks holding stale amounts.
    // Same-value retries simply rewrite identical lines, so this stays idempotent.
    const existing = await qboFetch(`query?query=${encodeURIComponent(`select * from JournalEntry where DocNumber = '${docNumber}'`)}`);
    const found = existing.QueryResponse && existing.QueryResponse.JournalEntry && existing.QueryResponse.JournalEntry[0];
    if (found) {
      const updated = await qboFetch('journalentry', {
        method: 'POST',
        body: {
          Id: found.Id,
          SyncToken: found.SyncToken,
          sparse: false, // full replace — dropped lines (e.g. a bonus removed) must disappear
          DocNumber: docNumber,
          TxnDate: txnDate,
          PrivateNote: privateNote,
          Line: rawLines
        }
      });
      const je = updated.JournalEntry || {};
      return sendJson(res, 200, { ok: true, je_id: je.Id || found.Id, doc_number: docNumber, updated: true });
    }

    const created = await qboFetch('journalentry', {
      method: 'POST',
      body: { DocNumber: docNumber, TxnDate: txnDate, PrivateNote: privateNote, Line: rawLines }
    });
    const je = created.JournalEntry || {};
    return sendJson(res, 200, { ok: true, je_id: je.Id, doc_number: docNumber });
  } catch (error) {
    console.error('qbo/journal failed', error);
    // Sanitized message only — full detail stays in server logs.
    return sendJson(res, 502, { ok: false, error: 'QuickBooks rejected the journal entry. Check the account mapping and try again.' });
  }
}

// ── dispatch ──────────────────────────────────────────────────────────────────
// `op` arrives from the vercel.json rewrite, so it is the old path segment.
// An unknown op is a 404 rather than a fallthrough: a typo'd endpoint should
// fail loudly, not quietly hit whichever handler happens to be first.
const OPS = {
  status: opStatus,
  connect: opConnect,
  callback: opCallback,
  disconnect: opDisconnect,
  accounts: opAccounts,
  map: opMap,
  journal: opJournal
};

export default async function handler(req, res) {
  const op = String((req.query && req.query.op) || '').trim();
  const fn = OPS[op];
  if (!fn) return sendJson(res, 404, { ok: false, error: 'Unknown QuickBooks operation.' });
  return fn(req, res);
}
