// QuoteLog.gs
// Handles saving quotes to the CRM spreadsheet and calculating travel distance.
// All functions share global scope with RoutePlanner.gs, so CRM_SPREADSHEET_ID,
// getHaversineDistance_(), and getGeocodeCache_() are directly available.

// ─── Schema ──────────────────────────────────────────────────────────────────
const QUOTES_SHEET_NAME = 'Quotes';

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
  'status'
];

// ─── Travel rate ($/round-trip mile) ─────────────────────────────────────────
const TRAVEL_RATE_PER_MILE = 0.40;

// ─── Ensure Quotes sheet exists with correct headers ─────────────────────────
function ensureQuotesSheet_(ss) {
  let sheet = ss.getSheetByName(QUOTES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(QUOTES_SHEET_NAME);
    sheet.getRange(1, 1, 1, QUOTES_SCHEMA.length)
      .setValues([QUOTES_SCHEMA])
      .setFontWeight('bold');
    sheet.setFrozenRows(1);
    Logger.log('Created Quotes sheet with ' + QUOTES_SCHEMA.length + ' columns.');
  } else {
    // Forward-compatible: append any missing columns
    const existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0].map(h => String(h).trim());
    const missing = QUOTES_SCHEMA.filter(col => !existingHeaders.includes(col));
    if (missing.length > 0) {
      const startCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, startCol, 1, missing.length)
        .setValues([missing])
        .setFontWeight('bold');
      Logger.log('Added missing columns to Quotes sheet: ' + missing.join(', '));
    }
  }
  return sheet;
}

// ─── Generate next sequential quote ID (thread-safe) ─────────────────────────
function nextQuoteId_(quotesSheet) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const lastRow = quotesSheet.getLastRow();
    let maxNum = 0;
    if (lastRow > 1) {
      // Read all existing IDs to find the highest number
      const ids = quotesSheet.getRange(2, 1, lastRow - 1, 1).getValues()
        .map(r => String(r[0]).trim())
        .filter(id => /^Q\d+$/.test(id));
      ids.forEach(id => {
        const n = parseInt(id.slice(1), 10);
        if (n > maxNum) maxNum = n;
      });
    }
    return 'Q' + String(maxNum + 1).padStart(4, '0');
  } finally {
    lock.releaseLock();
  }
}

// ─── Save quote to Quotes sheet ───────────────────────────────────────────────
function handleSaveQuote_(payload) {
  try {
    const ss = SpreadsheetApp.openById(CRM_SPREADSHEET_ID);
    const sheet = ensureQuotesSheet_(ss);
    const quoteId = nextQuoteId_(sheet);
    const ts = Utilities.formatDate(new Date(), 'America/Chicago', "yyyy-MM-dd'T'HH:mm:ss");

    // Build row in schema order
    const row = QUOTES_SCHEMA.map(col => {
      switch (col) {
        case 'quote_id':                      return quoteId;
        case 'timestamp':                     return ts;
        case 'created_by':                    return payload.created_by || '';
        case 'quote_source':                  return payload.quote_source || 'portal';
        case 'quote_version':                 return payload.quote_version || '';
        case 'first_name':                    return payload.first_name || '';
        case 'last_name':                     return payload.last_name || '';
        case 'email':                         return payload.email || '';
        case 'phone':                         return payload.phone || '';
        case 'address':                       return payload.address || '';
        case 'city':                          return payload.city || '';
        case 'zip_code':                      return payload.zip_code || '';
        case 'service':                       return payload.service || '';
        case 'pool_type':                     return payload.pool_type || '';
        case 'size':                          return payload.size || '';
        case 'material':                      return payload.material || '';
        case 'spa':                           return payload.spa || '';
        case 'finish':                        return payload.finish || '';
        case 'debris':                        return payload.debris || '';
        case 'has_robot':                     return payload.has_robot ? 'Yes' : 'No';
        case 'high_sun_exposure':             return payload.high_sun_exposure ? 'Yes' : 'No';
        case 'has_pets':                      return payload.has_pets ? 'Yes' : 'No';
        case 'startup_chemical_work':         return payload.startup_chemical_work ? 'Yes' : 'No';
        case 'startup_programming':           return payload.startup_programming ? 'Yes' : 'No';
        case 'startup_pool_school':           return payload.startup_pool_school ? 'Yes' : 'No';
        case 'startup_company':               return payload.startup_company || '';
        case 'sponsored_by_mcp':             return payload.sponsored_by_mcp ? 'Yes' : 'No';
        case 'startup_start_date':            return payload.startup_start_date || '';
        case 'startup_total_days':            return payload.startup_total_days || 0;
        case 'repair_job_type':               return payload.repair_job_type || '';
        case 'repair_company_name':           return payload.repair_company_name || '';
        case 'repair_company_address':        return payload.repair_company_address || '';
        case 'repair_job_description':        return payload.repair_job_description || '';
        case 'repair_invoice_amount':         return payload.repair_invoice_amount || 0;
        case 'repair_sku':                    return payload.repair_sku || '';
        case 'travel_fee':                    return payload.travel_fee || 0;
        case 'travel_one_way_miles':          return payload.travel_one_way_miles || 0;
        case 'travel_round_trip_miles':       return payload.travel_round_trip_miles || 0;
        case 'travel_billable_round_trip_miles': return payload.travel_billable_round_trip_miles || 0;
        case 'distance_source':              return payload.distance_source || 'none';
        case 'service_subtotal':             return payload.service_subtotal || 0;
        case 'discount_type':                return payload.discount_type || '';
        case 'discount_value':               return payload.discount_value || 0;
        case 'discount_amount':              return payload.discount_amount || 0;
        case 'discounted_service_subtotal':  return payload.discounted_service_subtotal || 0;
        case 'quote_subtotal':               return payload.quote_subtotal || 0;
        case 'sales_tax':                    return payload.sales_tax || 0;
        case 'total_with_tax':               return payload.total_with_tax || 0;
        case 'chem_cost_est':                return payload.chem_cost_est || 0;
        case 'net_profit_est':               return payload.net_profit_est || 0;
        case 'margin_percent':               return payload.margin_percent || 0;
        case 'specs_summary':                return payload.specs_summary || '';
        case 'quickbooks_skus':              return payload.quickbooks_skus || '';
        case 'quickbooks_item_names':        return payload.quickbooks_item_names || '';
        case 'status':                       return payload.status || 'UNSENT';
        default:                             return '';
      }
    });

    sheet.appendRow(row);
    Logger.log('Saved quote ' + quoteId);
    return { ok: true, quote_id: quoteId };

  } catch (err) {
    Logger.log('handleSaveQuote_ error: ' + err);
    return { ok: false, error: String(err) };
  }
}

// ─── Calculate travel distance from office to destination ─────────────────────
function handleDistance_(dest) {
  if (!dest || !dest.trim()) {
    return { ok: false, error: 'No destination provided' };
  }

  try {
    const crmSs = SpreadsheetApp.openById(CRM_SPREADSHEET_ID);
    const { cacheSheet, cache } = getGeocodeCache_(crmSs);
    const newCacheRows = [];
    const geocoder = Maps.newGeocoder();

    // ── Geocode destination ──────────────────────────────────────────────────
    const destKey = dest.trim().toLowerCase();
    let destLat, destLng, distanceSource;

    if (cache[destKey]) {
      destLat = cache[destKey].lat;
      destLng = cache[destKey].lng;
      distanceSource = 'geocode_cache';
    } else {
      Utilities.sleep(150);
      const res = geocoder.geocode(dest.trim());
      if (res.status !== 'OK' || !res.results || !res.results.length) {
        return { ok: false, error: 'Could not geocode destination' };
      }
      const loc = res.results[0].geometry.location;
      destLat = loc.lat;
      destLng = loc.lng;
      cache[destKey] = { lat: destLat, lng: destLng };
      newCacheRows.push([dest.trim(), destLat, destLng]);
      distanceSource = 'google_maps_api';
    }

    // ── Geocode office (cached after first call) ─────────────────────────────
    const officeKey = OFFICE_ADDRESS.toLowerCase();
    let officeLat, officeLng;

    if (cache[officeKey]) {
      officeLat = cache[officeKey].lat;
      officeLng = cache[officeKey].lng;
    } else {
      Utilities.sleep(150);
      const officeRes = geocoder.geocode(OFFICE_ADDRESS);
      if (officeRes.status !== 'OK' || !officeRes.results || !officeRes.results.length) {
        return { ok: false, error: 'Could not geocode office address' };
      }
      const offLoc = officeRes.results[0].geometry.location;
      officeLat = offLoc.lat;
      officeLng = offLoc.lng;
      cache[officeKey] = { lat: officeLat, lng: officeLng };
      newCacheRows.push([OFFICE_ADDRESS, officeLat, officeLng]);
    }

    // ── Write new cache entries ───────────────────────────────────────────────
    if (newCacheRows.length > 0) {
      const startRow = cacheSheet.getLastRow() + 1;
      cacheSheet.getRange(startRow, 1, newCacheRows.length, 3).setValues(newCacheRows);
    }

    // ── Calculate distances ───────────────────────────────────────────────────
    const one_way_miles = Math.round(getHaversineDistance_(officeLat, officeLng, destLat, destLng) * 10) / 10;
    const round_trip_miles = Math.round(one_way_miles * 2 * 10) / 10;
    const billable_round_trip_miles = round_trip_miles;
    const travel_fee = Math.round(billable_round_trip_miles * TRAVEL_RATE_PER_MILE * 100) / 100;

    return {
      ok: true,
      travel: {
        one_way_miles,
        round_trip_miles,
        billable_round_trip_miles,
        travel_fee,
        distance_source: distanceSource
      }
    };

  } catch (err) {
    Logger.log('handleDistance_ error: ' + err);
    return { ok: false, error: String(err) };
  }
}
