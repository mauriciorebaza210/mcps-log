// ============================================================
// PASTE THIS INTO YOUR EXISTING APPS SCRIPT PROJECT
// File name suggestion: 09_quotes_new.gs
//
// PURPOSE: Saves quotes from the Vercel portal into a clean
// single-table "Quotes" sheet in your new spreadsheet.
// Status updates happen IN-PLACE — no row-moving.
//
// NEW SPREADSHEET ID: 1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E
// ============================================================

const NEW_QUOTES_SS_ID = '1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E';

const QUOTES_SCHEMA = [
  'quote_id', 'timestamp', 'created_by', 'quote_source', 'quote_version',
  'first_name', 'last_name', 'email', 'phone', 'address', 'city', 'zip_code',
  'service', 'pool_type', 'size', 'material', 'spa', 'finish', 'debris',
  'has_robot', 'high_sun_exposure', 'has_pets',
  'startup_chemical_work', 'startup_programming', 'startup_pool_school', 'startup_company',
  'sponsored_by_mcp', 'startup_start_date', 'startup_total_days',
  'repair_job_type', 'repair_company_name', 'repair_company_address',
  'repair_job_description', 'repair_invoice_amount', 'repair_sku',
  'travel_fee', 'travel_one_way_miles', 'travel_round_trip_miles',
  'travel_billable_round_trip_miles', 'distance_source',
  'service_subtotal', 'discount_type', 'discount_value', 'discount_amount',
  'discounted_service_subtotal', 'quote_subtotal', 'sales_tax', 'total_with_tax',
  'chem_cost_est', 'net_profit_est', 'margin_percent',
  'specs_summary', 'quickbooks_skus', 'quickbooks_item_names',
  'status', 'signed_at', 'lost_at', 'completed_at', 'contract_url', 'notes'
];

// ── Quote ID generator for the new Quotes sheet ──────────────────────────────
function nextNewQuoteId_(quotesSheet) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const lastRow = quotesSheet.getLastRow();
    if (lastRow < 2) return 'Q0001';
    const hm = getHeaderMap_(quotesSheet);
    const qCol = hm.map['quote_id'];
    if (!qCol) return 'Q' + String(Date.now()).slice(-6);
    const values = quotesSheet.getRange(2, qCol, lastRow - 1, 1).getValues().flat();
    let maxN = 0;
    for (const v of values) {
      const m = String(v || '').match(/Q(\d+)$/i);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    return 'Q' + String(maxN + 1).padStart(4, '0');
  } finally {
    lock.releaseLock();
  }
}

// ── Ensure the Quotes sheet exists with the correct schema ───────────────────
function ensureQuotesSheet_(ss) {
  let sh = ss.getSheetByName('Quotes');
  if (!sh) {
    sh = ss.insertSheet('Quotes');
    sh.getRange(1, 1, 1, QUOTES_SCHEMA.length).setValues([QUOTES_SCHEMA]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, QUOTES_SCHEMA.length).setFontWeight('bold');
  } else {
    // Append any missing columns (safe, never reorders existing columns)
    const existingHeaders = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
      .map(h => String(h || '').trim().toLowerCase());
    const existingSet = new Set(existingHeaders.filter(Boolean));
    const toAdd = QUOTES_SCHEMA.filter(h => !existingSet.has(h.toLowerCase()));
    if (toAdd.length > 0) {
      const nextCol = sh.getLastColumn() + 1;
      sh.getRange(1, nextCol, 1, toAdd.length).setValues([toAdd]);
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

// ── Main handler: called from doPost when action === 'save_quote' ─────────────
function handleSaveQuote_(data) {
  const ss = SpreadsheetApp.openById(NEW_QUOTES_SS_ID);
  const quotesSheet = ensureQuotesSheet_(ss);
  const hm = getHeaderMap_(quotesSheet);

  const quoteId = nextNewQuoteId_(quotesSheet);
  const now = new Date();

  // Build a row aligned to QUOTES_SCHEMA
  const row = new Array(QUOTES_SCHEMA.length).fill('');

  const put = (key, val) => {
    const idx = QUOTES_SCHEMA.indexOf(key);
    if (idx !== -1) {
      if (val === null || val === undefined) row[idx] = '';
      else if (Array.isArray(val)) row[idx] = val.join(', ');
      else row[idx] = val;
    }
  };

  // Fixed fields
  put('quote_id',    quoteId);
  put('timestamp',   now);
  put('status',      data.status || 'UNSENT');

  // Copy all payload fields
  const skip = new Set(['quote_id', 'timestamp', 'status', 'action', 'token']);
  Object.keys(data || {}).forEach(k => {
    if (!skip.has(k)) put(k, data[k]);
  });

  quotesSheet.appendRow(row);

  logDebug_('INFO', 'save_quote: new quote saved', { quote_id: quoteId });

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, quote_id: quoteId }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Hook into the existing doPost ────────────────────────────────────────────
// ADD THIS BLOCK inside your doPost function, BEFORE the "Standard path" comment:
//
//   if (data.action === 'save_quote') {
//     return handleSaveQuote_(data);
//   }
//
// That's all — the rest of your doPost stays exactly as-is.

// ── Optional: get_quotes action for doGet (returns last 50 quotes) ────────────
// ADD THIS BLOCK inside your doGet function, after the map_data block:
//
//   if (action === 'get_quotes') {
//     const ss2 = SpreadsheetApp.openById(NEW_QUOTES_SS_ID);
//     const qsh = ss2.getSheetByName('Quotes');
//     if (!qsh || qsh.getLastRow() < 2) {
//       return ContentService.createTextOutput(JSON.stringify({ ok: true, data: [] }))
//         .setMimeType(ContentService.MimeType.JSON);
//     }
//     const data2 = qsh.getDataRange().getValues();
//     const headers = data2[0].map(h => String(h).trim().toLowerCase().replace(/ /g, '_'));
//     const rows = data2.slice(1).reverse().slice(0, 50).map(r => {
//       const obj = {};
//       headers.forEach((h, i) => { obj[h] = r[i]; });
//       return obj;
//     });
//     return ContentService.createTextOutput(JSON.stringify({ ok: true, data: rows }))
//       .setMimeType(ContentService.MimeType.JSON);
//   }
