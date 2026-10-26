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
  buildAuthorizeUrl, verifyState, exchangeCodeAndStore, disconnect, qboFetch,
  getCustomerMap, saveCustomerMap, qboAppBase
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

// ══════════════════════════════════════════════════════════════════════════════
// MONTHLY SERVICE INVOICES
// ══════════════════════════════════════════════════════════════════════════════
// Automates what was done by hand every month: open the client's last monthly
// invoice in QBO, duplicate it, change the invoice no. to the new month name
// ("September" → "October"), save, send.
//
// The month name IS the invoice number on every monthly invoice, and it repeats
// across customers, so DocNumber cannot be the idempotency key the way PR-<id> is
// for payroll. Every invoice we create carries PrivateNote "mcps-auto:<quote>:<YYYY-MM>"
// instead, and before creating we also treat a hand-made invoice with the same
// month name, dated in or just after that month, as "already billed".
//
// Creating never emails anyone. Sending is its own op and is refused unless the
// QBO_INVOICE_SEND env var is "on", so no bug in the batch UI can reach a client.

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function monthNameFromKey(monthKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''));
  if (!m) return '';
  return MONTH_NAMES[Number(m[2]) - 1] || '';
}

function isMonthDocNumber(docNumber) {
  const d = String(docNumber || '').trim().toLowerCase();
  return MONTH_NAMES.some(n => n.toLowerCase() === d);
}

function autoNoteKey(quoteId, monthKey) {
  return `mcps-auto:${quoteId}:${monthKey}`;
}

// Texas business day, not the server's UTC day — an invoice made at 8pm CT must
// not be dated tomorrow.
function todayCentral() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}

// A hand-made invoice counts as this month's if it's numbered with the month name
// and dated from ~10 days before the month through the end of the following month
// (catch-up invoices happen: "August" dated 9/21).
function inBillingWindow(txnDate, monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1) - 10 * 86400000);
  const end = new Date(Date.UTC(y, m + 1, 0));
  const d = new Date(String(txnDate || '') + 'T00:00:00Z');
  return !isNaN(d) && d >= start && d <= end;
}

const qboEsc = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function recentInvoices(customerId) {
  const q = `select * from Invoice where CustomerRef = '${qboEsc(customerId)}' orderby TxnDate desc maxresults 25`;
  const json = await qboFetch(`query?query=${encodeURIComponent(q)}`);
  return (json.QueryResponse && json.QueryResponse.Invoice) || [];
}

// From a customer's recent invoices: the one already covering monthKey (if any)
// and the most recent OTHER monthly invoice to copy from.
function pickInvoices(invoices, quoteId, monthKey) {
  const monthName = monthNameFromKey(monthKey).toLowerCase();
  const key = autoNoteKey(quoteId, monthKey);
  const existing = invoices.find(inv =>
    String(inv.PrivateNote || '').includes(key) ||
    (String(inv.DocNumber || '').trim().toLowerCase() === monthName && inBillingWindow(inv.TxnDate, monthKey))
  ) || null;
  const template = invoices.find(inv => isMonthDocNumber(inv.DocNumber) && (!existing || inv.Id !== existing.Id)) || null;
  return { existing, template };
}

function itemLines(inv) {
  return ((inv && inv.Line) || []).filter(l => l.DetailType === 'SalesItemLineDetail' && l.SalesItemLineDetail);
}

function invoiceSummary(inv) {
  if (!inv) return null;
  const lines = itemLines(inv);
  return {
    id: inv.Id,
    doc_number: inv.DocNumber || '',
    txn_date: inv.TxnDate || '',
    subtotal: cents(lines.reduce((s, l) => s + (Number(l.Amount) || 0), 0)),
    tax: cents(inv.TxnTaxDetail && inv.TxnTaxDetail.TotalTax),
    total: cents(inv.TotalAmt),
    balance: cents(inv.Balance),
    email: (inv.BillEmail && inv.BillEmail.Address) || '',
    email_status: inv.EmailStatus || '',
    auto: String(inv.PrivateNote || '').includes('mcps-auto:'),
    lines: lines.map(l => ({
      item: (l.SalesItemLineDetail.ItemRef && l.SalesItemLineDetail.ItemRef.name) || '',
      description: l.Description || '',
      qty: Number(l.SalesItemLineDetail.Qty) || 1,
      rate: cents(l.SalesItemLineDetail.UnitPrice),
      amount: cents(l.Amount),
      taxable: !!(l.SalesItemLineDetail.TaxCodeRef && l.SalesItemLineDetail.TaxCodeRef.value && l.SalesItemLineDetail.TaxCodeRef.value !== 'NON')
    })),
    qbo_url: `${qboAppBase()}/app/invoice?txnId=${inv.Id}`
  };
}

function stripIds(addr) {
  if (!addr || typeof addr !== 'object') return undefined;
  const { Id, ...rest } = addr;
  return rest;
}

// ── customers ─────────────────────────────────────────────────────────────────
// GET /api/qbo/customers?token=<admin> → every active QBO customer, for matching.
async function opCustomers(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await requireAdminPortalToken(req, res);
    if (!session) return;

    const customers = [];
    for (let start = 1; start < 10000; start += 1000) {
      const q = `select Id, DisplayName, CompanyName, GivenName, FamilyName, PrimaryEmailAddr from Customer where Active = true startposition ${start} maxresults 1000`;
      const json = await qboFetch(`query?query=${encodeURIComponent(q)}`);
      const page = (json.QueryResponse && json.QueryResponse.Customer) || [];
      page.forEach(c => customers.push({
        id: c.Id,
        name: c.DisplayName || c.CompanyName || [c.GivenName, c.FamilyName].filter(Boolean).join(' '),
        email: (c.PrimaryEmailAddr && c.PrimaryEmailAddr.Address) || ''
      }));
      if (page.length < 1000) break;
    }
    return sendJson(res, 200, { ok: true, customers });
  } catch (error) {
    console.error('qbo/customers failed', error);
    return sendJson(res, 502, { ok: false, error: 'Could not load QuickBooks customers.' });
  }
}

// ── customer_map ──────────────────────────────────────────────────────────────
// GET  /api/qbo/customer_map?token=<admin>          → { map: { quote_id: {...} } }
// POST /api/qbo/customer_map { token, entries }     → merge + save
async function opCustomerMap(req, res) {
  try {
    const session = await requireAdminPortalToken(req, res);
    if (!session) return;
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, map: await getCustomerMap() });
    if (req.method === 'POST') {
      const map = await saveCustomerMap((req.body && req.body.entries) || {});
      return sendJson(res, 200, { ok: true, map });
    }
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('qbo/customer_map failed', error);
    return sendJson(res, 500, { ok: false, error: 'Could not read or save the customer links.' });
  }
}

// ── invoice_prepare ───────────────────────────────────────────────────────────
// POST /api/qbo/invoice_prepare { token, clients: [{ quote_id, qbo_customer_id, month_key, portal_rate }] }
// Read-only. For each client: the invoice it would be copied from, whether this
// month is already billed in QBO, and whether last month's rate matches the portal.
async function opInvoicePrepare(req, res) {
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await requireAdminPortalToken(req, res);
    if (!session) return;

    const clients = Array.isArray(req.body && req.body.clients) ? req.body.clients.slice(0, 100) : [];
    const results = [];
    // Small parallel batches: QBO allows ~10 concurrent requests per company.
    for (let i = 0; i < clients.length; i += 5) {
      const batch = clients.slice(i, i + 5);
      const out = await Promise.all(batch.map(async c => {
        const quoteId = String(c.quote_id || '').trim();
        const customerId = String(c.qbo_customer_id || '').trim();
        const monthKey = String(c.month_key || '').trim();
        if (!quoteId || !customerId || !monthNameFromKey(monthKey)) {
          return { quote_id: quoteId, ok: false, error: 'Missing client, QuickBooks customer, or month.' };
        }
        try {
          const { existing, template } = pickInvoices(await recentInvoices(customerId), quoteId, monthKey);
          const tpl = invoiceSummary(template);
          const portalRate = cents(c.portal_rate);
          return {
            quote_id: quoteId,
            ok: true,
            month_name: monthNameFromKey(monthKey),
            existing: invoiceSummary(existing),
            template: tpl,
            rate_mismatch: !!(tpl && portalRate > 0 && Math.abs(tpl.subtotal - portalRate) > 0.01)
          };
        } catch (e) {
          console.error('qbo/invoice_prepare client failed', quoteId, e);
          return { quote_id: quoteId, ok: false, error: 'QuickBooks lookup failed.' };
        }
      }));
      results.push(...out);
    }
    return sendJson(res, 200, { ok: true, results });
  } catch (error) {
    console.error('qbo/invoice_prepare failed', error);
    return sendJson(res, 502, { ok: false, error: 'Could not read invoices from QuickBooks.' });
  }
}

// ── invoice_create ────────────────────────────────────────────────────────────
// POST /api/qbo/invoice_create { token, quote_id, qbo_customer_id, month_key }
// Creates ONE unsent invoice copied from the client's last monthly invoice.
// Idempotent: if this month is already billed, returns that invoice instead.
async function opInvoiceCreate(req, res) {
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await requireAdminPortalToken(req, res);
    if (!session) return;

    const quoteId = String((req.body && req.body.quote_id) || '').trim();
    const customerId = String((req.body && req.body.qbo_customer_id) || '').trim();
    const monthKey = String((req.body && req.body.month_key) || '').trim();
    const monthName = monthNameFromKey(monthKey);
    if (!quoteId || !customerId || !monthName) {
      return sendJson(res, 400, { ok: false, error: 'quote_id, qbo_customer_id and month_key (YYYY-MM) are required.' });
    }

    const { existing, template } = pickInvoices(await recentInvoices(customerId), quoteId, monthKey);
    if (existing) return sendJson(res, 200, { ok: true, already_exists: true, invoice: invoiceSummary(existing) });
    if (!template) {
      return sendJson(res, 422, { ok: false, error: 'No previous monthly invoice to copy for this customer. Make the first one in QuickBooks.' });
    }

    const lines = itemLines(template).map(l => {
      const d = l.SalesItemLineDetail;
      const detail = { ItemRef: d.ItemRef, Qty: d.Qty, UnitPrice: d.UnitPrice };
      if (d.TaxCodeRef) detail.TaxCodeRef = d.TaxCodeRef;
      if (d.ClassRef) detail.ClassRef = d.ClassRef;
      return { DetailType: 'SalesItemLineDetail', Amount: l.Amount, Description: l.Description, SalesItemLineDetail: detail };
    });
    if (!lines.length) return sendJson(res, 422, { ok: false, error: 'The previous invoice has no product lines to copy.' });

    const body = {
      CustomerRef: { value: customerId },
      DocNumber: monthName,
      TxnDate: todayCentral(),
      Line: lines,
      PrivateNote: autoNoteKey(quoteId, monthKey),
      EmailStatus: 'NotSet'
      // TxnTaxDetail deliberately omitted: automated sales tax recalculates it.
    };
    const copy = ['SalesTermRef', 'CustomerMemo', 'BillEmail', 'BillEmailCc', 'BillEmailBcc', 'ClassRef',
      'DepartmentRef', 'AllowOnlineCreditCardPayment', 'AllowOnlineACHPayment', 'GlobalTaxCalculation'];
    copy.forEach(k => { if (template[k] !== undefined && template[k] !== null) body[k] = template[k]; });
    ['BillAddr', 'ShipAddr', 'ShipFromAddr'].forEach(k => { const a = stripIds(template[k]); if (a) body[k] = a; });

    // Every monthly invoice is numbered with the month name, so the number
    // legitimately repeats across customers.
    const created = await qboFetch('invoice?include=allowduplicatedocnum', { method: 'POST', body });
    const inv = created.Invoice || {};
    return sendJson(res, 200, { ok: true, created: true, invoice: invoiceSummary(inv), template_id: template.Id });
  } catch (error) {
    console.error('qbo/invoice_create failed', error);
    return sendJson(res, 502, { ok: false, error: 'QuickBooks rejected the invoice. Open the client in QBO and check their last invoice.' });
  }
}

// ── invoice_send ──────────────────────────────────────────────────────────────
// POST /api/qbo/invoice_send { token, invoice_id, quote_id }
// Emails an invoice through QBO. Off unless QBO_INVOICE_SEND=on, and only for
// invoices this portal created (mcps-auto note) that still have a balance.
async function opInvoiceSend(req, res) {
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await requireAdminPortalToken(req, res);
    if (!session) return;

    if (String(process.env.QBO_INVOICE_SEND || '').toLowerCase() !== 'on') {
      return sendJson(res, 403, { ok: false, send_disabled: true, error: 'Sending is turned off. Invoices stay as unsent drafts in QuickBooks until QBO_INVOICE_SEND is on.' });
    }

    const invoiceId = String((req.body && req.body.invoice_id) || '').replace(/[^0-9]/g, '');
    const quoteId = String((req.body && req.body.quote_id) || '').trim();
    if (!invoiceId || !quoteId) return sendJson(res, 400, { ok: false, error: 'invoice_id and quote_id are required.' });

    const current = (await qboFetch(`invoice/${invoiceId}`)).Invoice || {};
    if (!String(current.PrivateNote || '').includes(`mcps-auto:${quoteId}:`)) {
      return sendJson(res, 409, { ok: false, error: 'That invoice was not created by the portal for this client.' });
    }
    if (!(current.BillEmail && current.BillEmail.Address)) {
      return sendJson(res, 422, { ok: false, error: 'This invoice has no billing email in QuickBooks.' });
    }
    const sent = await qboFetch(`invoice/${invoiceId}/send`, { method: 'POST', contentType: 'application/octet-stream' });
    return sendJson(res, 200, { ok: true, invoice: invoiceSummary(sent.Invoice || current) });
  } catch (error) {
    console.error('qbo/invoice_send failed', error);
    return sendJson(res, 502, { ok: false, error: 'QuickBooks could not send the invoice.' });
  }
}

// ── invoice_status ────────────────────────────────────────────────────────────
// POST /api/qbo/invoice_status { token, ids: [...] } → { invoices: { id: { balance, total, email_status } } }
async function opInvoiceStatus(req, res) {
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await requireAdminPortalToken(req, res);
    if (!session) return;

    const ids = [...new Set((Array.isArray(req.body && req.body.ids) ? req.body.ids : [])
      .map(id => String(id).replace(/[^0-9]/g, '')).filter(Boolean))].slice(0, 200);
    const invoices = {};
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50).map(id => `'${id}'`).join(',');
      const q = `select Id, Balance, TotalAmt, EmailStatus from Invoice where Id in (${chunk})`;
      const json = await qboFetch(`query?query=${encodeURIComponent(q)}`);
      ((json.QueryResponse && json.QueryResponse.Invoice) || []).forEach(inv => {
        invoices[inv.Id] = { balance: cents(inv.Balance), total: cents(inv.TotalAmt), email_status: inv.EmailStatus || '' };
      });
    }
    return sendJson(res, 200, { ok: true, invoices });
  } catch (error) {
    console.error('qbo/invoice_status failed', error);
    return sendJson(res, 502, { ok: false, error: 'Could not read invoice balances from QuickBooks.' });
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
  journal: opJournal,
  customers: opCustomers,
  customer_map: opCustomerMap,
  invoice_prepare: opInvoicePrepare,
  invoice_create: opInvoiceCreate,
  invoice_send: opInvoiceSend,
  invoice_status: opInvoiceStatus
};

export default async function handler(req, res) {
  const op = String((req.query && req.query.op) || '').trim();
  const fn = OPS[op];
  if (!fn) return sendJson(res, 404, { ok: false, error: 'Unknown QuickBooks operation.' });
  return fn(req, res);
}
