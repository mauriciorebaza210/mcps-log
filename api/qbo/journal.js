import { sendJson, requireAdminPortalToken } from '../_sheets.js';
import { qboFetch, getAccountMap, missingBuckets } from './_qbo.js';

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
export default async function handler(req, res) {
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

    // Idempotency: if a JE with this DocNumber already exists, treat as success.
    const existing = await qboFetch(`query?query=${encodeURIComponent(`select Id, DocNumber from JournalEntry where DocNumber = '${docNumber}'`)}`);
    const found = existing.QueryResponse && existing.QueryResponse.JournalEntry && existing.QueryResponse.JournalEntry[0];
    if (found) {
      return sendJson(res, 200, { ok: true, je_id: found.Id, doc_number: docNumber, deduped: true });
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
