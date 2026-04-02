// distance_quotes.gs
// Ported from Quote_Log/08_distance.gs and Quote_Log/09_quotes_new.gs
// Adds travel-distance lookup and quote-saving to the Chem Log project.

// ══════════════════════════════════════════════════════════════════════════════
// PART A — Travel / Distance (ported from 08_distance.gs)
// ══════════════════════════════════════════════════════════════════════════════

function getMapsCfg_() {
  const props = PropertiesService.getScriptProperties();
  return {
    apiKey:    props.getProperty("GOOGLE_MAPS_API_KEY"),
    hq:        props.getProperty("HQ_ADDRESS") || "6991 Raintree Grove, Elmendorf, TX 78112",
    rate:      parseFloat(props.getProperty("RATE_PER_MILE") || "0.40"),
    roundTo:   parseInt(props.getProperty("ROUND_TO_MILES") || "5", 10),
    cacheDays: parseInt(props.getProperty("CACHE_MAX_AGE_DAYS") || "60", 10),
  };
}

function normalizeDestKey_(dest) {
  return String(dest || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

function getDistanceCacheSheet_(ss) {
  const name = "Distance_Cache";
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(["dest_key", "destination", "one_way_miles", "updated_at", "source", "status"]);
  }
  return sh;
}

function cacheLookup_(ss, destKey, maxAgeDays) {
  const sh = getDistanceCacheSheet_(ss);
  const values = sh.getDataRange().getValues();
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  for (let i = values.length - 1; i >= 1; i--) {
    const row = values[i];
    if (row[0] === destKey && row[5] === "OK") {
      const updated = row[3] instanceof Date ? row[3].getTime() : new Date(row[3]).getTime();
      if (!isNaN(updated) && (now - updated) <= maxAgeMs) {
        return { oneWayMiles: parseFloat(row[2]), destination: row[1] };
      }
    }
  }
  return null;
}

function cacheWrite_(ss, destKey, destination, oneWayMiles, source, status) {
  const sh = getDistanceCacheSheet_(ss);
  sh.appendRow([destKey, destination, oneWayMiles || "", new Date(), source || "", status || "OK"]);
}

function getDrivingMiles_(origin, destination, apiKey) {
  const url = "https://maps.googleapis.com/maps/api/distancematrix/json"
    + "?origins="      + encodeURIComponent(origin)
    + "&destinations=" + encodeURIComponent(destination)
    + "&mode=driving&units=imperial"
    + "&key="          + encodeURIComponent(apiKey);

  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(resp.getContentText());

  if (data.status !== "OK") throw new Error("DistanceMatrix status: " + data.status);

  const el = data.rows && data.rows[0] && data.rows[0].elements && data.rows[0].elements[0]
    ? data.rows[0].elements[0] : null;
  if (!el || el.status !== "OK") throw new Error("Route status: " + (el ? el.status : "NO_ELEMENT"));

  return el.distance.value / 1609.344; // meters → miles
}

function computeTravelWithCache_(destination) {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = getMapsCfg_();
  if (!cfg.apiKey) throw new Error("Missing GOOGLE_MAPS_API_KEY in Script Properties");

  const destKey = normalizeDestKey_(destination);
  const hit     = cacheLookup_(ss, destKey, cfg.cacheDays);
  let oneWay, source;

  if (hit) {
    oneWay = hit.oneWayMiles;
    source = "cache";
  } else {
    oneWay = getDrivingMiles_(cfg.hq, destination, cfg.apiKey);
    source = "google_distance_matrix";
    cacheWrite_(ss, destKey, destination, oneWay, source, "OK");
  }

  const roundTrip = oneWay * 2;
  const billable  = Math.ceil(roundTrip / cfg.roundTo) * cfg.roundTo;
  const fee       = billable * cfg.rate;

  return {
    origin:                    cfg.hq,
    destination:               destination,
    dest_key:                  destKey,
    one_way_miles:             Math.round(oneWay    * 10) / 10,
    round_trip_miles:          Math.round(roundTrip * 10) / 10,
    billable_round_trip_miles: billable,
    travel_rate_per_mile:      cfg.rate,
    travel_fee:                Math.round(fee * 100) / 100,
    distance_source:           source,
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// PART B — Quote Saving (ported/adapted from 09_quotes_new.gs)
// ══════════════════════════════════════════════════════════════════════════════

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

function nextNewQuoteId_(quotesSheet) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const lastRow = quotesSheet.getLastRow();
    if (lastRow < 2) return 'Q0001';
    const headers = quotesSheet.getRange(1, 1, 1, quotesSheet.getLastColumn()).getValues()[0];
    const qCol = headers.indexOf('quote_id');
    if (qCol === -1) return 'Q' + String(Date.now()).slice(-6);
    const values = quotesSheet.getRange(2, qCol + 1, lastRow - 1, 1).getValues().flat();
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

function handleSaveQuote_(data) {
  const ss          = SpreadsheetApp.openById(NEW_QUOTES_SS_ID);
  const quotesSheet = ensureQuotesSheet_(ss);
  const quoteId     = nextNewQuoteId_(quotesSheet);
  const now         = new Date();

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

  put('quote_id',  quoteId);
  put('timestamp', now);
  put('status',    data.status || 'UNSENT');

  const skip = new Set(['quote_id', 'timestamp', 'status', 'action', 'token']);
  Object.keys(data || {}).forEach(k => {
    if (!skip.has(k)) put(k, data[k]);
  });

  quotesSheet.appendRow(row);

  Logger.log('save_quote: saved ' + quoteId);

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, quote_id: quoteId }))
    .setMimeType(ContentService.MimeType.JSON);
}
