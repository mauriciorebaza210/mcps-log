// ══════════════════════════════════════════════════════════════════════════════
// FAST QUOTE CREATION — the flat Quotes row, written straight to Sheets
//
// WHY THIS EXISTS: Apps Script's save_quote takes 81 seconds, measured against
// the live deployment. A bare Apps Script round trip is already ~5s; the other
// ~76s is syncQuoteToNormalized_ fanning out across Clients, Client_Locations,
// Proposals, Proposal_Items, Service_Agreements and Service_Accounts, mostly
// re-reading header rows it has already read. Nobody should watch a spinner for
// a minute to raise a quote.
//
// ⚠️ THE INSIGHT THAT MAKES THIS SAFE: syncQuoteToNormalized_ is built entirely
// from findOrCreate* calls, so it is IDEMPOTENT — and handleGenerateProposal_
// calls it itself before doing anything else. So the relational rows do not have
// to exist at save time. Writing the flat row alone is complete, and the fan-out
// happens later, once, only when a proposal is actually generated.
//
// That is not a shortcut around the model, it is moving expensive work to the
// moment it is needed rather than paying it on every save.
//
// ⚠️ WHAT THIS PATH MUST NOT BE USED FOR: green_to_clean and pool_startup.
// handleSaveQuote_ mints a pool_id for those and writes their Routes rows, and
// skipping that would create a customer with no pool and no route. Those still
// go through Apps Script, where the extra time buys something real.

import crypto from 'node:crypto';
import {
  crmSpreadsheetId, readSheetRange, writeSheetRange, normalizeHeader, sendJson
} from '../_sheets.js';

// Services whose quote is purely a sales document until someone signs it.
// Everything else needs the operational setup only Apps Script does.
export const FAST_SERVICES = ['Weekly Full Service', 'Bi-Weekly Maintenance', 'Repair / Replacement / Other Job'];

function clean(v, max = 500) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function newQuoteId() {
  return 'Q-' + crypto.randomBytes(4).toString('hex');
}

/**
 * Build the flat Quotes row. Mirrors the columns handleSaveQuote_ writes, so a
 * quote raised this way is indistinguishable downstream from one raised in the
 * quote tool — the proposal renderer, the signing page and the CRM all read the
 * same fields.
 */
export function buildQuoteRow(body, actor) {
  const now = new Date().toISOString();
  return {
    quote_id: newQuoteId(),
    timestamp: now,
    source_sheet: 'Quotes',
    created_by: clean(actor, 80) || 'portal',
    quote_source: 'service_request',
    quote_version: '2.0',
    status: 'UNSENT',

    first_name: clean(body.first_name, 80),
    last_name: clean(body.last_name, 80),
    email: clean(body.email, 254).toLowerCase(),
    phone: clean(body.phone, 40),
    address: clean(body.address),
    city: clean(body.city, 80),
    zip_code: clean(body.zip_code, 12),
    area: clean(body.area, 20),

    service: clean(body.service, 80),
    pool_type: clean(body.pool_type, 40),
    size: clean(body.size, 40),
    material: clean(body.material, 40),
    spa: clean(body.spa, 10),
    finish: clean(body.finish, 20),
    debris: clean(body.debris, 20),
    has_robot: body.has_robot ? 'TRUE' : 'FALSE',
    high_sun_exposure: body.high_sun_exposure ? 'TRUE' : 'FALSE',
    has_pets: body.has_pets ? 'TRUE' : 'FALSE',

    repair_job_type: clean(body.repair_job_type, 80),
    repair_invoice_amount: num(body.repair_invoice_amount),

    travel_fee: num(body.travel_fee),
    service_subtotal: num(body.service_subtotal),
    discount_type: clean(body.discount_type, 20),
    discount_value: num(body.discount_value),
    discount_amount: num(body.discount_amount),
    discounted_service_subtotal: num(body.discounted_service_subtotal),
    quote_subtotal: num(body.quote_subtotal),
    sales_tax: num(body.sales_tax),
    total_with_tax: num(body.total_with_tax),
    chem_cost_est: num(body.chem_cost_est),
    net_profit_est: num(body.net_profit_est),
    margin_percent: num(body.margin_percent),

    specs_summary: clean(body.specs_summary, 900),
    quickbooks_skus: clean(body.quickbooks_skus, 300),
    quickbooks_item_names: clean(body.quickbooks_item_names, 300),

    sales_flow: 'proposal_first',
    signature_required: 'TRUE',
    activation_method: 'SIGNED_AGREEMENT',
    contact_log: '[]'
  };
}

function colLetter(index) {
  let n = index, out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}

export async function handler(req, res) {
  const body = req.body || {};
  const service = clean(body.service, 80);

  if (!FAST_SERVICES.includes(service)) {
    return sendJson(res, 400, {
      ok: false, code: 'needs_apps_script',
      error: `${service} needs the operational setup Apps Script performs (pool ID, route rows). Use the quote tool for this one.`
    });
  }
  if (!clean(body.address)) return sendJson(res, 400, { ok: false, error: 'Address required.' });
  if (!num(body.total_with_tax)) return sendJson(res, 400, { ok: false, error: 'A priced quote is required.' });

  const id = crmSpreadsheetId();
  // The whole sheet, because the write needs both the header AND the real row
  // count — see the anchoring note below.
  const values = await readSheetRange('Quotes', id);
  const header = (values[0] || []).map(normalizeHeader);

  // ⚠️ NEVER REPAIR THIS HEADER. Quotes is a 95-column legacy sheet that Apps
  // Script owns and extends through ensureColumn_; api/_repo/sheets-driver.js
  // says the same thing about it — "the compat sheet: never restructured".
  //
  // An earlier version of this did repair it, and the cost was immediate: four
  // rows landed with every value shifted 79 columns right, because the row was
  // built against a header this code had grown rather than the one the sheet
  // actually had. Writing into someone else's schema is not worth a lost field.
  //
  // A key with nowhere to go is dropped and logged. The sheet stays exactly as
  // Apps Script left it.
  if (header.indexOf('quote_id') === -1) {
    return sendJson(res, 500, { ok: false, error: 'The Quotes sheet header is not readable.' });
  }

  const row = buildQuoteRow(body, (req.session && (req.session.name || req.session.username)) || '');
  const dropped = Object.keys(row).filter(k => header.indexOf(k) === -1);
  if (dropped.length) console.warn('Quotes has no column for:', dropped.join(', '));

  // ⚠️ NOT appendSheetRows. The Sheets values:append API picks its own anchor by
  // scanning the range for a "table", and on a sheet with blank rows in it — as
  // Quotes has, wherever rows have been cleared — it can choose an anchor that
  // is not column A. That is exactly what happened here: four rows landed with
  // every value shifted 79 columns right, which reads back as a row with no
  // quote_id at all.
  //
  // Writing to an explicit A-anchored range removes the guesswork. The row
  // number is computed from the sheet we just read, so there is no second read
  // to disagree with.
  const targetRow = values.length + 1;
  const width = header.length;
  await writeSheetRange(
    `Quotes!A${targetRow}:${colLetter(width - 1)}${targetRow}`,
    [header.map(h => (row[h] === undefined ? '' : row[h]))],
    id
  );
  return sendJson(res, 200, {
    ok: true, quote_id: row.quote_id, total: row.total_with_tax,
    dropped_fields: dropped
  });
}
