/**
 * SALES HUB ENGINE (Cross-Spreadsheet Version)
 */

const MCPS_CRM_SS_ID = "1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E";
const MCPS_TAX_RATE = 0.0825;

const MCPS_QUOTES_LINK_HEADERS = [
  'client_id', 'location_id', 'proposal_id', 'proposal_number',
  'agreement_id', 'agreement_number', 'service_account_id', 'sales_flow',
  'signature_required', 'activation_method', 'migration_status',
  'migration_notes', 'migrated_at', 'proposal_pdf_url',
  'proposal_approval_url', 'proposal_sent_at', 'proposal_accepted_at',
  'proposal_declined_at', 'proposal_change_requested_at',
  'proposal_response_note'
];

const MCPS_CLIENT_HEADERS = [
  'client_id', 'first_name', 'last_name', 'display_name', 'email', 'phone',
  'billing_address', 'billing_city', 'billing_state', 'billing_zip', 'status',
  'created_at', 'updated_at', 'legacy_quote_ids', 'notes'
];

const MCPS_LOCATION_HEADERS = [
  'location_id', 'client_id', 'pool_id', 'service_address', 'city', 'state',
  'zip_code', 'area', 'pool_type', 'pool_size', 'material', 'spa', 'finish',
  'debris_level', 'sun_exposure', 'pets_on_property', 'robot_on_site',
  'year_built', 'active', 'created_at', 'updated_at', 'notes'
];

const MCPS_PROPOSAL_HEADERS = [
  'proposal_id', 'proposal_number', 'legacy_quote_id', 'client_id',
  'location_id', 'status', 'service_type', 'proposal_title', 'created_by',
  'quote_source', 'quote_version', 'valid_until', 'travel_fee',
  'travel_one_way_miles', 'travel_round_trip_miles',
  'travel_billable_round_trip_miles', 'distance_source', 'subtotal',
  'discount_type', 'discount_value', 'discount_amount', 'discounted_subtotal',
  'tax_rate', 'sales_tax', 'total', 'chem_cost_est', 'net_profit_est',
  'margin_percent', 'specs_summary', 'proposal_pdf_url', 'contract_url',
  'proposal_image_url', 'sent_at', 'accepted_at', 'declined_at', 'expired_at',
  'converted_at', 'created_at', 'updated_at', 'notes'
];

const MCPS_PROPOSAL_ITEM_HEADERS = [
  'proposal_item_id', 'proposal_id', 'line_type', 'product_service_name',
  'description', 'quantity', 'rate', 'amount', 'taxable', 'quickbooks_sku',
  'quickbooks_item_name', 'sort_order', 'created_at', 'updated_at'
];

// Reusable Scope of Work items, authored once and offered across every quote.
//   service_types  comma-separated: weekly,startup,g2c,repair (blank = all)
//   default_on     TRUE/FALSE — pre-checked for those service types
//   active         FALSE archives an item without destroying history
const MCPS_SCOPE_LIBRARY_HEADERS = [
  'scope_item_id', 'label', 'service_types', 'default_on', 'sort_order',
  'active', 'created_at', 'updated_at'
];

const MCPS_SERVICE_ACCOUNT_HEADERS = [
  'service_account_id', 'client_id', 'location_id', 'source_proposal_id',
  'source_agreement_id', 'source_quote_id', 'pool_id', 'service_type',
  'service_name', 'status', 'schedule_type', 'route_status', 'billing_type',
  'monthly_rate', 'tax_rate', 'invoice_day', 'billing_start', 'service_start',
  'service_end', 'payment_log', 'contract_status', 'contract_url', 'created_at',
  'updated_at', 'notes'
];

const MCPS_SERVICE_AGREEMENT_HEADERS = [
  'agreement_id', 'agreement_number', 'client_id', 'location_id',
  'proposal_id', 'service_account_id', 'source_quote_id', 'status',
  'signature_required', 'activation_method', 'service_type', 'service_name',
  'monthly_rate', 'startup_fee', 'travel_fee', 'tax_rate', 'sales_tax', 'total',
  'billing_start', 'service_start', 'invoice_day', 'agreement_pdf_url',
  'contract_url', 'contract_file_id', 'signrequest_id', 'sent_at', 'signed_at',
  'declined_at', 'activated_at', 'created_by', 'created_at', 'updated_at',
  'notes',
  // In-portal e-signature audit trail (ESIGN Act / UETA). Appended additively
  // so existing column positions are preserved.
  'signature_name', 'signature_image_url', 'signature_method', 'signer_ip',
  'signer_user_agent', 'consent_accepted', 'consent_at', 'signed_pdf_url',
  'agreement_version'
];

const MCPS_PROPOSAL_APPROVAL_HEADERS = [
  'approval_id', 'proposal_id', 'quote_id', 'token', 'status',
  'customer_note', 'sent_at', 'responded_at', 'expires_at', 'created_at',
  'updated_at'
];

const MCPS_CONTRACT_FOLLOWUP_COLUMNS = [
  'target_agreement_id', 'followup_enabled', 'followup_schedule',
  'final_notice_lead_days', 'followup_next_index', 'followup_cycle',
  'last_followup_at', 'last_followup_error', 'followup_claimed_until',
  'followup_claim_id', 'followup_stopped_reason', 'followup_updated_at',
  'viewed_at', 'update_requested_at'
];

const MCPS_MIGRATION_LOG_HEADERS = [
  'timestamp', 'step', 'status', 'message', 'row_count', 'error'
];

const MCPS_POOL_COMPANY_HEADERS = [
  'pool_company_id', 'company_name', 'report_bcc_email', 'contact_name',
  'phone', 'notes', 'active', 'created_at', 'updated_at', 'request_token'
];

const MCPS_QUOTE_EXTRA_HEADERS = [
  'startup_company_email'
];

function getCrmSpreadsheet_() {
  return SpreadsheetApp.openById(MCPS_CRM_SS_ID);
}

// 2. The Settings Spreadsheet (where the script is attached / where 'Settings' tab lives)
const SETTINGS_SS = SpreadsheetApp.getActiveSpreadsheet();
function getCrmSheet_() {
  // We use the ID directly here so it never conflicts with other files
  try {
    return getCrmSpreadsheet_().getSheetByName("Quotes");
  } catch (e) {
    throw new Error("Could not find CRM Spreadsheet. Check permissions!");
  }
}

function normalizeHeader_(name) {
  return String(name || '').trim().toLowerCase().replace(/ /g, '_');
}

function headerIndex_(headers, name) {
  const target = normalizeHeader_(name);
  return headers.map(normalizeHeader_).indexOf(target);
}

function ensureSheet_(name, headers) {
  const ss = getCrmSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  const existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  const existingNorm = existing.map(normalizeHeader_);
  headers.forEach(function(h) {
    if (existingNorm.indexOf(normalizeHeader_(h)) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h);
      existingNorm.push(normalizeHeader_(h));
    }
  });
  sheet.setFrozenRows(1);
  return sheet;
}

function ensureNormalizedSalesSheets_() {
  const quotes = getCrmSheet_();
  if (!quotes) throw new Error('Quotes sheet not found');
  const qHeaders = quotes.getRange(1, 1, 1, quotes.getLastColumn()).getValues()[0];
  MCPS_QUOTES_LINK_HEADERS.concat(MCPS_QUOTE_EXTRA_HEADERS).forEach(function(h) {
    if (headerIndex_(qHeaders, h) === -1) {
      quotes.getRange(1, quotes.getLastColumn() + 1).setValue(h);
      qHeaders.push(h);
    }
  });
  ensureSheet_('Clients', MCPS_CLIENT_HEADERS);
  ensureSheet_('Client_Locations', MCPS_LOCATION_HEADERS);
  ensureSheet_('Proposals', MCPS_PROPOSAL_HEADERS);
  ensureSheet_('Proposal_Items', MCPS_PROPOSAL_ITEM_HEADERS);
  ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
  ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS);
  ensureSheet_('Service_Accounts', MCPS_SERVICE_ACCOUNT_HEADERS);
  ensureSheet_('Migration_Log', MCPS_MIGRATION_LOG_HEADERS);
  ensureSheet_('Pool_Companies', MCPS_POOL_COMPANY_HEADERS);
  return { ok: true };
}

function sheetToObjects_(sheet) {
  if (!sheet || sheet.getLastRow() < 1) return { headers: [], rows: [] };
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(function(h) { return normalizeHeader_(h); });
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const obj = { _rowNum: i + 1 };
    headers.forEach(function(h, j) { if (h) obj[h] = values[i][j]; });
    rows.push(obj);
  }
  return { headers: headers, rows: rows };
}

function appendObject_(sheet, obj, headers) {
  sheet = ensureSheet_(sheet.getName(), headers);
  const actualHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(normalizeHeader_);
  const row = actualHeaders.map(function(h) {
    return obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
  });
  sheet.appendRow(row);
  return sheet.getLastRow();
}

function findRowByValue_(sheet, colName, value) {
  const snap = sheetToObjects_(sheet);
  const col = normalizeHeader_(colName);
  const val = String(value || '').trim();
  if (!val) return null;
  for (let i = 0; i < snap.rows.length; i++) {
    if (String(snap.rows[i][col] || '').trim() === val) return snap.rows[i];
  }
  return null;
}

function softSetCell_(sheet, rowNum, colName, value) {
  const normalized = normalizeHeader_(colName);
  let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  let idx = headerIndex_(headers, normalized);
  if (idx === -1) {
    idx = headers.length;
    sheet.getRange(1, idx + 1).setValue(colName);
  }
  sheet.getRange(rowNum, idx + 1).setValue(value !== undefined && value !== null ? value : '');
}

function nextSequence_(sheet, idColumn, prefix, width) {
  sheet = sheet || null;
  let max = 0;
  if (sheet && sheet.getLastRow() >= 2) {
    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(normalizeHeader_);
    const idx = headers.indexOf(normalizeHeader_(idColumn));
    if (idx !== -1) {
      for (let i = 1; i < data.length; i++) {
        const m = String(data[i][idx] || '').match(new RegExp('^' + prefix + '-(\\d+)$', 'i'));
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    }
  }
  return prefix + '-' + String(max + 1).padStart(width || 6, '0');
}

function normalizeEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhone_(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeAddress_(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/[.,#]/g, '')
    .replace(/\s+/g, ' ');
}

function value_(obj, name, fallback) {
  const v = obj ? obj[normalizeHeader_(name)] : undefined;
  return v !== undefined && v !== null && v !== '' ? v : (fallback || '');
}

function number_(value) {
  const n = Number(value || 0);
  return isNaN(n) ? 0 : n;
}

function nowIso_() {
  return new Date().toISOString();
}

function parseJsonArray_(raw) {
  try {
    const parsed = raw ? JSON.parse(String(raw)) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch(e) {
    return [];
  }
}

function uniqueJsonPush_(raw, value) {
  const arr = parseJsonArray_(raw);
  if (value && arr.indexOf(value) === -1) arr.push(value);
  return JSON.stringify(arr);
}

function logMigration_(step, status, message, rowCount, error) {
  try {
    const sheet = ensureSheet_('Migration_Log', MCPS_MIGRATION_LOG_HEADERS);
    appendObject_(sheet, {
      timestamp: nowIso_(),
      step: step || '',
      status: status || '',
      message: message || '',
      row_count: rowCount || 0,
      error: error ? String(error) : ''
    }, MCPS_MIGRATION_LOG_HEADERS);
  } catch(e) {
    Logger.log('Migration log failed: ' + e);
  }
}

function mcpsMoney_(value) {
  return '$' + number_(value).toFixed(2);
}

function htmlEscape_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function replaceProposalPlaceholders_(template, plain, html) {
  let out = String(template || '');
  Object.keys(html || {}).forEach(function(key) {
    out = out.split('{{{' + key + '}}}').join(String(html[key] || ''));
  });
  Object.keys(plain || {}).forEach(function(key) {
    out = out.split('{{' + key + '}}').join(htmlEscape_(plain[key]));
  });
  return out;
}

function proposalFrequencyForService_(service) {
  const s = String(service || '').toLowerCase();
  if (s.indexOf('weekly') !== -1) return 'Weekly';
  if (s.indexOf('bi-weekly') !== -1 || s.indexOf('biweekly') !== -1) return 'Bi-Weekly';
  if (s.indexOf('startup') !== -1) return 'One-Time';
  if (s.indexOf('green') !== -1) return 'One-Time';
  return 'As Needed';
}

function proposalOptionEnabled_(options, key, fallback) {
  if (!options || options[key] === undefined || options[key] === null || options[key] === '') return fallback;
  if (options[key] === true || String(options[key]).toUpperCase() === 'TRUE') return true;
  if (options[key] === false || String(options[key]).toUpperCase() === 'FALSE') return false;
  return fallback;
}

function quoteHasSpa_(q) {
  return String(value_(q, 'spa') || '').toLowerCase() === 'yes' ||
    String(value_(q, 'spa') || '').toLowerCase() === 'true';
}

// Connector words that stay lowercase inside a Title Cased scope item.
var SCOPE_CONNECTORS_ = ['of','to','for','in','on','with','by','a','an','the'];

// Display formatting for Scope of Work line items ONLY.
//   "Pool and spa cleaning and brushing"  ->  "Pool & Spa Cleaning & Brushing"
//   "Testing and balancing of water"      ->  "Testing & Balancing of Water"
//
// Two rules, per Mau's confirmation:
//   1. A standalone "and" becomes "&" — word-boundary matched, so "Sand" and
//      "Standard" are never touched.
//   2. Title Case, except connector words, which stay lowercase unless they lead.
//
// ⚠️ Scope items only. Never run this over contract prose (buildAgreementTermsHtml_)
// or anything else — legal text must read as written, not as a headline.
// ⚠️ A byte-identical twin lives in js/features/quotes.js as qFormatScopeLabel().
// If you change one, change the other, or the admin's live preview will disagree
// with what the customer actually signs.
function formatScopeLabel_(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  s = s.replace(/\band\b/gi, '&');
  var caseSegment = function (seg, isLead) {
    var lower = seg.toLowerCase();
    if (!isLead && SCOPE_CONNECTORS_.indexOf(lower) !== -1) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  };
  return s.split(/\s+/).map(function (word, i) {
    if (word === '&') return word;
    // Each half of a hyphenated compound is cased on its own, so "24-hour"
    // reads "24-Hour" while connectors still lowercase: "green-to-clean"
    // becomes "Green-to-Clean", not "Green-To-Clean".
    return word.split('-').map(function (seg, j) {
      return caseSegment(seg, i === 0 && j === 0);
    }).join('-');
  }).join(' ');
}

function buildProposalScopeHtml_(service, q, options) {
  const s = String(service || '').toLowerCase();
  let items = [];
  const hasSpa = quoteHasSpa_(q);

  // If this quote has a resolved scope stored on it, that IS the scope — for the
  // proposal PDF, the signing page and the signed contract alike. This is what
  // stops the three documents disagreeing. Quotes saved before this existed have
  // nothing stored and fall through to the service-type defaults below.
  const stored = readStoredScopeItems_(q);
  if (stored) {
    return stored.map(function (item) {
      return '<li>' + htmlEscape_(formatScopeLabel_(item)) + '</li>';
    }).join('');
  }
  if (s.indexOf('startup') !== -1) {
    if (proposalOptionEnabled_(options, 'startup_chemical_work', true)) items.push('Startup chemical work');
    if (proposalOptionEnabled_(options, 'equipment_programming', true)) items.push('Equipment programming support');
    if (proposalOptionEnabled_(options, 'water_balance', true)) items.push('Water balance testing');
    if (proposalOptionEnabled_(options, 'service_report', true)) items.push('Startup service report after each visit');
  } else if (s.indexOf('green') !== -1) {
    if (proposalOptionEnabled_(options, 'pool_cleaning', true)) items.push(hasSpa ? 'Pool and spa cleanup' : 'Green pool cleanup');
    if (proposalOptionEnabled_(options, 'chemical_treatment', true)) items.push('Chemical testing and treatment');
    if (proposalOptionEnabled_(options, 'baskets', true)) items.push('Brushing and debris removal');
    if (proposalOptionEnabled_(options, 'follow_up', true)) items.push('Follow-up visit scheduling as needed');
  } else if (s.indexOf('repair') !== -1) {
    if (proposalOptionEnabled_(options, 'repair_labor', true)) items.push('Repair / replacement labor');
    if (proposalOptionEnabled_(options, 'job_documentation', true)) items.push('Job documentation');
    if (proposalOptionEnabled_(options, 'parts_coordination', true)) items.push('Parts coordination as approved');
    if (proposalOptionEnabled_(options, 'completion_report', true)) items.push('Completion report');
  } else {
    // Recurring/weekly scope. Wording per Tony's review (2026-07-27): the previous
    // list was "too broad", so each service is named specifically. Ordered
    // service → chemistry → cleaning → inspection → reporting so it reads as the
    // visit actually runs.
    if (proposalOptionEnabled_(options, 'pool_cleaning', true)) items.push(hasSpa ? 'Weekly pool and spa service' : 'Weekly pool service');
    if (proposalOptionEnabled_(options, 'chemical_treatment', true)) items.push('Water testing and balancing');
    if (proposalOptionEnabled_(options, 'baskets', true)) items.push('Clean pool baskets');
    if (proposalOptionEnabled_(options, 'equipment_inspection', true)) items.push('Equipment inspection');
    if (proposalOptionEnabled_(options, 'service_report', true)) items.push('Weekly service report');
    // Opt-in extras — default OFF. Tony flagged emergency response as a
    // "potential addition", and filter cleaning is now folded into equipment
    // inspection rather than promised separately on every quote.
    if (proposalOptionEnabled_(options, 'filter_cleaning', false)) items.push('Filter cleaning and inspection');
    if (proposalOptionEnabled_(options, 'emergency_response', false)) items.push('24-hour emergency response');
  }
  if (!items.length) items = [service || 'Pool service'];
  // Single choke point for scope wording — the proposal PDF, the signing page and
  // the signed agreement PDF all render through here, so they cannot disagree.
  return items.map(function(item) {
    return '<li>' + htmlEscape_(formatScopeLabel_(item)) + '</li>';
  }).join('');
}

// ══════════════════════════════════════════════════════════════════════════════
// SCOPE LIBRARY — reusable scope items + per-quote persistence
// ══════════════════════════════════════════════════════════════════════════════
//
// THE DEFECT THIS FIXES: proposal_scope_options was only ever read from the
// request payload when generating the proposal PDF. It was persisted nowhere, so
// handleGetProposalApproval_ (the signing page) and renderSignedAgreementPdf_
// (the signed contract) both called the scope builder with {} and silently fell
// back to service-type defaults. An admin could uncheck an item, send the
// proposal, and the customer would still sign a contract listing it.
//
// Now: the resolved scope is written to the quote's `scope_items_json` column at
// save/generate time, and all three render paths read that same stored value.

// v2: items gained an `active` field. Bumped so cached v1 payloads, which lack
// it, expire immediately rather than lingering for up to six hours.
var SCOPE_LIBRARY_CACHE_KEY_ = 'scope_library_v2';

function getScopeLibrarySheet_() {
  return ensureSheet_('Scope_Library', MCPS_SCOPE_LIBRARY_HEADERS);
}

function scopeServiceKeyFor_(service) {
  var s = String(service || '').toLowerCase();
  if (s.indexOf('startup') !== -1) return 'startup';
  if (s.indexOf('green') !== -1) return 'g2c';
  if (s.indexOf('repair') !== -1) return 'repair';
  return 'weekly';
}

// Reads the library, newest-cached-first. Small and rarely changed, so a 6h
// server cache is plenty; any write invalidates it immediately.
function readScopeLibrary_(includeInactive) {
  var cache = CacheService.getScriptCache();
  // The admin view is never served from cache: it is read immediately after an
  // edit, and a 6-hour-stale list would make saves look like they did nothing.
  if (!includeInactive) {
    var hit = cache.get(SCOPE_LIBRARY_CACHE_KEY_);
    if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  }

  var sheet = getScopeLibrarySheet_();
  var items = [];
  if (sheet.getLastRow() > 1) {
    var values = sheet.getDataRange().getValues();
    var headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var idx = function (name) { return headers.indexOf(name); };
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      var id = String(row[idx('scope_item_id')] || '').trim();
      var label = String(row[idx('label')] || '').trim();
      if (!id || !label) continue;
      var isActive = String(row[idx('active')] || '').toUpperCase() !== 'FALSE';
      if (!isActive && !includeInactive) continue;
      items.push({
        scope_item_id: id,
        label: label,
        service_types: String(row[idx('service_types')] || '').split(',')
          .map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean),
        default_on: String(row[idx('default_on')] || '').toUpperCase() !== 'FALSE',
        sort_order: Number(row[idx('sort_order')] || 0),
        active: isActive
      });
    }
  }
  items.sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
  if (!includeInactive) {
    try { cache.put(SCOPE_LIBRARY_CACHE_KEY_, JSON.stringify(items), 21600); } catch (e) {}
  }
  return items;
}

function invalidateScopeLibraryCache_() {
  try { CacheService.getScriptCache().remove(SCOPE_LIBRARY_CACHE_KEY_); } catch (e) {}
}

// Public read used by the quote tool. Returns everything so the tool can offer
// items from other service types too; it filters client-side.
// The quote tool wants active items only. The admin management view needs the
// archived ones too, or a deactivated item becomes unrecoverable from the UI.
function handleGetScopeLibrary_(payload) {
  try {
    if (payload && payload.include_inactive) {
      return { ok: true, items: readScopeLibrary_(true), include_inactive: true };
    }
    return { ok: true, items: readScopeLibrary_() };
  } catch (e) {
    return { ok: false, error: 'handleGetScopeLibrary_ Error: ' + e };
  }
}

// Admin write — create/update/archive a library item.
function handleSaveScopeLibraryItem_(payload) {
  try {
    var sheet = getScopeLibrarySheet_();
    var now = nowIso_();
    var id = String(payload.scope_item_id || '').trim();
    var label = String(payload.label || '').trim();
    if (!label && !id) return { ok: false, error: 'label required' };

    var serviceTypes = Array.isArray(payload.service_types)
      ? payload.service_types.join(',')
      : String(payload.service_types || '');

    if (id) {
      var existing = findRowByValue_(sheet, 'scope_item_id', id);
      if (!existing) return { ok: false, error: 'Scope item not found: ' + id };
      if (label) softSetCell_(sheet, existing._rowNum, 'label', label);
      if (payload.service_types !== undefined) softSetCell_(sheet, existing._rowNum, 'service_types', serviceTypes);
      if (payload.default_on !== undefined) softSetCell_(sheet, existing._rowNum, 'default_on', payload.default_on ? 'TRUE' : 'FALSE');
      if (payload.sort_order !== undefined) softSetCell_(sheet, existing._rowNum, 'sort_order', payload.sort_order);
      if (payload.active !== undefined) softSetCell_(sheet, existing._rowNum, 'active', payload.active ? 'TRUE' : 'FALSE');
      softSetCell_(sheet, existing._rowNum, 'updated_at', now);
      invalidateScopeLibraryCache_();
      return { ok: true, scope_item_id: id, updated: true };
    }

    var newId = nextSequence_(sheet, 'scope_item_id', 'SCP', 4);
    appendObject_(sheet, {
      scope_item_id: newId,
      label: label,
      service_types: serviceTypes,
      default_on: payload.default_on === false ? 'FALSE' : 'TRUE',
      sort_order: payload.sort_order === undefined ? 100 : payload.sort_order,
      active: 'TRUE',
      created_at: now,
      updated_at: now
    }, MCPS_SCOPE_LIBRARY_HEADERS);
    invalidateScopeLibraryCache_();
    return { ok: true, scope_item_id: newId, created: true };
  } catch (e) {
    return { ok: false, error: 'handleSaveScopeLibraryItem_ Error: ' + e };
  }
}

// ── Per-quote resolved scope ─────────────────────────────────────────────────
// Stored on the quote as JSON: { items: ["Weekly pool service", ...] }
// Plain labels, not ids, so the record stays readable and survives library edits.
function readStoredScopeItems_(q) {
  var raw = String(value_(q, 'scope_items_json') || '').trim();
  if (!raw) return null;
  try {
    var parsed = JSON.parse(raw);
    var items = Array.isArray(parsed) ? parsed : (parsed && parsed.items);
    if (!Array.isArray(items)) return null;
    items = items.map(function (s) { return String(s || '').trim(); }).filter(Boolean);
    return items.length ? items : null;
  } catch (e) {
    return null;
  }
}

function writeStoredScopeItems_(sheet, rowNum, items) {
  var clean = (items || []).map(function (s) { return String(s || '').trim(); }).filter(Boolean);
  softSetCell_(sheet, rowNum, 'scope_items_json', clean.length ? JSON.stringify({ items: clean }) : '');
  return clean;
}

// Turns a save payload into the JSON stored on the quote.
//
// The quote tool sends `scope_items` — the final list the admin actually sees in
// the preview (library selections + one-offs, in order). That is authoritative.
//
// ⚠️ Returns '' when the payload carries no scope information at all, rather than
// inventing one. An empty string means "nothing stored", so rendering falls back
// to service-type defaults — which is what every pre-existing quote must keep
// doing. Writing a resolved list here for a payload that never mentioned scope
// would silently freeze defaults onto quotes that were never authored.
function resolveScopeItemsJson_(payload) {
  if (!payload) return '';

  if (Array.isArray(payload.scope_items)) {
    var items = payload.scope_items
      .map(function (s) { return String(s || '').trim(); })
      .filter(Boolean);
    return items.length ? JSON.stringify({ items: items }) : '';
  }

  // Older/other callers may still send only the option toggles. Resolve those
  // through the SAME builder the documents use, so the stored list can never
  // disagree with what the renderer would have produced.
  if (payload.proposal_scope_options && typeof payload.proposal_scope_options === 'object') {
    var pseudoQuote = { service: payload.service, spa: payload.spa };
    var html = buildProposalScopeHtml_(payload.service, pseudoQuote, payload.proposal_scope_options);
    var labels = String(html).split('</li>')
      .map(function (chunk) { return chunk.replace(/^\s*<li>/, '').trim(); })
      .filter(Boolean)
      .map(function (s) {
        return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      });
    return labels.length ? JSON.stringify({ items: labels }) : '';
  }

  return '';
}

function buildProposalServiceRowsHtml_(service, rate, q, options) {
  const freq = proposalFrequencyForService_(service);
  const rows = [];
  const hasSpa = quoteHasSpa_(q);
  if (proposalOptionEnabled_(options, 'main_service', true)) {
    rows.push([service || 'Pool Service', freq, mcpsMoney_(rate)]);
  }
  if (hasSpa && proposalOptionEnabled_(options, 'spa_service', true)) {
    rows.push(['Attached Spa Service', freq, 'Included']);
  }
  if (proposalOptionEnabled_(options, 'equipment_inspections', true)) {
    rows.push(['Equipment Inspections', freq === 'Weekly' ? 'Monthly' : 'As Needed', 'Included']);
  }
  // Added per Tony's review (2026-07-27): "What do you think about adding
  // Equipment Monitoring — Weekly — Included". Recurring plans only.
  if (proposalOptionEnabled_(options, 'equipment_monitoring', true) &&
      (freq === 'Weekly' || freq === 'Bi-Weekly')) {
    rows.push(['Equipment Monitoring', freq, 'Included']);
  }
  if (proposalOptionEnabled_(options, 'chemicals_included', true) && String(service || '').toLowerCase().indexOf('repair') === -1) {
    rows.push(['Chemical Treatment', freq === 'Weekly' || freq === 'Bi-Weekly' ? 'Each Visit' : 'As Needed', 'Included']);
  }
  if (proposalOptionEnabled_(options, 'service_reports', true)) {
    rows.push(['Digital Service Report', freq === 'Weekly' || freq === 'Bi-Weekly' ? 'Each Visit' : 'At Completion', 'Included']);
  }
  if (proposalOptionEnabled_(options, 'priority_service', false)) {
    rows.push(['Priority Service', 'As Needed', 'Included']);
  }
  if (!rows.length) rows.push([service || 'Pool Service', freq, mcpsMoney_(rate)]);
  return rows.map(function(row) {
    return '<tr><td>' + htmlEscape_(row[0]) + '</td><td>' + htmlEscape_(row[1]) + '</td><td>' + htmlEscape_(row[2]) + '</td></tr>';
  }).join('');
}

function buildProposalItemsHtml_(q) {
  const rows = [
    ['Service Subtotal', mcpsMoney_(value_(q, 'service_subtotal'))],
    ['Discount', mcpsMoney_(value_(q, 'discount_amount'))],
    ['Travel Fee', mcpsMoney_(value_(q, 'travel_fee'))],
    ['Sales Tax', mcpsMoney_(value_(q, 'sales_tax'))],
    ['Total', mcpsMoney_(value_(q, 'total_with_tax'))]
  ];
  return rows.map(function(row) {
    return '<tr><td>' + htmlEscape_(row[0]) + '</td><td>' + htmlEscape_(row[1]) + '</td></tr>';
  }).join('');
}

function proposalApprovalToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').substring(0, 16);
}

function proposalApprovalBaseUrl_() {
  return PropertiesService.getScriptProperties().getProperty('PROPOSAL_APPROVAL_BASE_URL') ||
    'https://mcps-log.vercel.app/agreement.html';
}

function proposalApprovalUrl_(token, action) {
  const base = proposalApprovalBaseUrl_();
  const sep = base.indexOf('?') === -1 ? '?' : '&';
  return base + sep + 'token=' + encodeURIComponent(token) + (action ? '&response=' + encodeURIComponent(action) : '');
}

function findActiveProposalApproval_(proposalId) {
  const sheet = ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
  const snap = sheetToObjects_(sheet);
  const active = snap.rows.filter(function(r) {
    const status = String(r.status || '').toUpperCase();
    return String(r.proposal_id || '') === String(proposalId || '') &&
      (status === 'SENT' || status === '');
  }).sort(function(a, b) {
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
  return active[0] || null;
}

function getProposalByQuoteId_(quoteId) {
  const sync = syncQuoteToNormalized_(quoteId);
  const proposals = ensureSheet_('Proposals', MCPS_PROPOSAL_HEADERS);
  return {
    sync: sync,
    proposal: findRowByValue_(proposals, 'proposal_id', sync.proposal_id),
    proposals: proposals
  };
}

// ── Agreement-link email (sent when a proposal goes out for signature) ───────
// ⚠️ Leads with "Prepared For", NOT the price — confirmed with Mau, per Tony's
// review. The investment appears on the signing page below the terms.
function buildAgreementLinkEmailHtml_(d) {
  var facts = [
    ['Service', d.serviceName],
    d.serviceAddress ? ['Property', d.serviceAddress] : null,
    d.validUntil ? ['Valid Until', d.validUntil] : null
  ].filter(Boolean);

  var factRows = facts.map(function (f, i) {
    return '<tr>' +
      '<td style="padding:9px 0;border-bottom:' + (i === facts.length - 1 ? 'none' : '1px solid #E4EAEA') + ';' +
        'font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:10px;letter-spacing:.1em;' +
        'text-transform:uppercase;color:#6B7777;" width="110">' + htmlEscape_(f[0]) + '</td>' +
      '<td style="padding:9px 0;border-bottom:' + (i === facts.length - 1 ? 'none' : '1px solid #E4EAEA') + ';' +
        'font-family:' + MCPS_EMAIL_FB_ + ';font-size:14.5px;color:#222222;">' + htmlEscape_(f[1]) + '</td>' +
    '</tr>';
  }).join('');

  var body =
    '<tr><td style="padding:30px 32px 4px;">' +
      '<div style="font-family:' + MCPS_EMAIL_FB_ + ';font-size:15px;line-height:1.65;color:#3A4645;margin:0 0 20px;">' +
        'Hi ' + htmlEscape_(d.firstName) + ' &mdash; thank you for considering Mission Custom Pool Solutions. ' +
        'Your service agreement is ready to review and sign. It takes about two minutes, and there&rsquo;s ' +
        'nothing to download or print.' +
      '</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
        'style="background:#F3F5F6;border-radius:10px;margin:0 0 6px;"><tr><td style="padding:6px 18px;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + factRows + '</table>' +
      '</td></tr></table>' +
    '</td></tr>' +
    '<tr><td align="center" style="padding:22px 32px 8px;">' +
      '<a href="' + htmlEscape_(d.approvalUrl) + '" ' +
        'style="display:inline-block;background:#1FA7A8;color:#FFFFFF;text-decoration:none;' +
        'font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:15px;padding:15px 34px;' +
        'border-radius:11px;">Review &amp; Sign Your Agreement</a>' +
      '<div style="font-family:' + MCPS_EMAIL_FB_ + ';font-size:12.5px;color:#6B7777;margin-top:14px;">' +
        'Secure signing &middot; no account needed' +
      '</div>' +
    '</td></tr>' +
    '<tr><td style="padding:14px 32px 30px;">' +
      '<div style="font-family:' + MCPS_EMAIL_FB_ + ';font-size:13px;line-height:1.6;color:#6B7777;' +
        'border-top:1px solid #E4EAEA;padding-top:16px;">' +
        'Need something changed first? You can request an adjustment right from that page &mdash; ' +
        'just tell us what to fix and we&rsquo;ll send an updated agreement.' +
      '</div>' +
    '</td></tr>';

  return mcpsEmailShell_(
    mcpsEmailHero_({
      headline: 'Your service<br>agreement is ready.',
      lede: 'Prepared for ' + htmlEscape_(d.customerName) + '. Review the details and sign whenever you&rsquo;re ready.'
    }) + body + mcpsEmailFooter_(),
    'Your MCPS service agreement is ready to review and sign.'
  );
}

function buildAgreementLinkEmailText_(d) {
  var co = mcpsEmailCompany_();
  return [
    'YOUR SERVICE AGREEMENT IS READY',
    '',
    'Hi ' + d.firstName + ' — thank you for considering Mission Custom Pool Solutions.',
    'Your service agreement is ready to review and sign. It takes about two minutes.',
    '',
    'Service: ' + d.serviceName,
    d.serviceAddress ? 'Property: ' + d.serviceAddress : '',
    d.validUntil ? 'Valid until: ' + d.validUntil : '',
    '',
    'Review and sign here:',
    d.approvalUrl,
    '',
    'Need something changed first? You can request an adjustment right from that page.',
    '',
    'Every pool matters.',
    'Mission Custom Pool Solutions LLC · San Antonio, TX',
    co.website + ' · ' + co.phone
  ].filter(function (line) { return line !== ''; }).join('\n');
}

function handleSendProposalForApproval_(payload) {
  try {
    ensureNormalizedSalesSheets_();
    const quoteId = String(payload.quote_id || '').trim();
    if (!quoteId) return { ok: false, error: 'quote_id required' };
    const hit = getQuoteById_(quoteId);
    if (!hit) return { ok: false, error: 'Quote not found: ' + quoteId };
    const q = hit.object;
    const result = getProposalByQuoteId_(quoteId);
    const proposal = result.proposal;
    if (!proposal) return { ok: false, error: 'Proposal not found for quote ' + quoteId };
    const pdfUrl = value_(proposal, 'proposal_pdf_url') || value_(q, 'proposal_pdf_url');
    if (!pdfUrl) return { ok: false, error: 'Generate proposal PDF first.' };
    const email = value_(q, 'email');
    if (!email) return { ok: false, error: 'Customer email is required to send proposal approval.' };

    // The agreement link is now emailed by the portal itself (see below) rather
    // than relayed through Zapier, so there is no ZAPIER_PROPOSAL_WEBHOOK guard
    // here any more. The old guard returned an error *before* the approval record
    // was created, which meant this whole action was dead on any script where the
    // property was unset.
    const approvals = ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
    const now = nowIso_();
    const expires = new Date();
    expires.setDate(expires.getDate() + 30);
    let approval = findActiveProposalApproval_(proposal.proposal_id);
    let token = approval && approval.token ? String(approval.token) : '';
    let approvalId = approval && approval.approval_id ? String(approval.approval_id) : '';
    if (!approval) {
      token = proposalApprovalToken_();
      approvalId = nextSequence_(approvals, 'approval_id', 'APR', 6);
      appendObject_(approvals, {
        approval_id: approvalId,
        proposal_id: proposal.proposal_id,
        quote_id: quoteId,
        token: token,
        status: 'SENT',
        customer_note: '',
        sent_at: now,
        responded_at: '',
        expires_at: expires.toISOString(),
        created_at: now,
        updated_at: now
      }, MCPS_PROPOSAL_APPROVAL_HEADERS);
      approval = findRowByValue_(approvals, 'approval_id', approvalId);
    } else {
      softSetCell_(approvals, approval._rowNum, 'status', 'SENT');
      softSetCell_(approvals, approval._rowNum, 'sent_at', now);
      softSetCell_(approvals, approval._rowNum, 'updated_at', now);
      // A resend is a fresh offer, so it gets a fresh window. This previously
      // preserved the ORIGINAL expires_at (the `||` only filled a blank), which
      // meant a resend on day 20 left the customer 10 days rather than 30 — and
      // made any "expires in N days" copy wrong.
      softSetCell_(approvals, approval._rowNum, 'expires_at', expires.toISOString());
      // ⚠️ This row is REUSED, not recreated, so the follow-up lifecycle must be
      // reset too. Without it a resend inherits the previous cycle's state and an
      // already-exhausted approval would never be chased again. The cycle counter
      // also versions the Comms_Log ledger IDs so cycle 2's day-3 send cannot
      // collide with cycle 1's already-'sent' record.
      if (typeof fuResetLifecycleOnResend_ === 'function') {
        try {
          fuResetLifecycleOnResend_(approvals, approval._rowNum, value_(approval, 'followup_cycle'));
        } catch (fuErr) {
          Logger.log('followup lifecycle reset failed (non-blocking): ' + fuErr);
        }
      }
    }

    const approvalUrl = proposalApprovalUrl_(token, '');

    // Send the agreement link natively.
    // ⚠️ commsSendViaGmail_ deliberately, NOT sendCommsEmail_: the generic helper
    // dispatches on COMMS_SEND_MODE and routes through Zapier when that is set to
    // 'zapier', which would quietly reintroduce the relay we just removed.
    // HeadsUp.js sets the same precedent for transactional mail.
    const emailData = {
      firstName: String(value_(q, 'first_name') || '').trim() || 'there',
      customerName: [value_(q, 'first_name'), value_(q, 'last_name')].filter(Boolean).join(' ').trim() || 'Customer',
      serviceName: value_(q, 'service') || 'Pool Service',
      serviceAddress: [value_(q, 'address'), value_(q, 'city'), value_(q, 'zip_code')].filter(Boolean).join(', '),
      validUntil: value_(proposal, 'valid_until') || '',
      approvalUrl: approvalUrl
    };
    const sendMsg = {
      to: email,
      subject: 'Your MCPS service agreement is ready to sign',
      htmlBody: buildAgreementLinkEmailHtml_(emailData),
      plainBody: buildAgreementLinkEmailText_(emailData),
      recipientId: 'agreement_link_' + String(quoteId)
    };
    let sendResult;
    try {
      sendResult = (typeof commsSendViaGmail_ === 'function')
        ? commsSendViaGmail_(sendMsg)
        : (GmailApp.sendEmail(email, sendMsg.subject, sendMsg.plainBody,
            { name: 'Mission Custom Pool Solutions', htmlBody: sendMsg.htmlBody }),
           { ok: true, provider: 'gmail_fallback' });
    } catch (sendErr) {
      // Surface the failure rather than reporting a send that never happened —
      // the approval record already exists, so the link can be resent.
      return {
        ok: false,
        error: 'Agreement link email failed to send: ' + sendErr,
        approval_url: approvalUrl,
        proposal_id: proposal.proposal_id
      };
    }
    if (sendResult && sendResult.ok === false) {
      return {
        ok: false,
        error: 'Agreement link email failed to send: ' + (sendResult.error || 'unknown error'),
        approval_url: approvalUrl,
        proposal_id: proposal.proposal_id
      };
    }

    softSetCell_(result.proposals, proposal._rowNum, 'status', 'SENT');
    softSetCell_(result.proposals, proposal._rowNum, 'sent_at', now);
    softSetCell_(result.proposals, proposal._rowNum, 'updated_at', now);
    softSetCell_(hit.sheet, hit.rowNum, 'proposal_sent_at', now);
    softSetCell_(hit.sheet, hit.rowNum, 'proposal_approval_url', approvalUrl);
    softSetCell_(hit.sheet, hit.rowNum, 'proposal_number', proposal.proposal_number);
    return { ok: true, sent_at: now, approval_url: approvalUrl, proposal_id: proposal.proposal_id, proposal_number: proposal.proposal_number, sent_to: email };
  } catch(e) {
    return { ok: false, error: 'handleSendProposalForApproval_ Error: ' + e.toString() };
  }
}

// Everything the signing page renders, built in ONE place.
//
// `approval` is null when an admin is previewing a proposal that has not been
// sent yet. That is the entire point of sharing this builder: a preview assembled
// separately would drift from the live page, and a preview that drifts is worse
// than no preview — it certifies the wrong thing.
function buildAgreementPagePayload_(quoteRow, proposal, approval) {
  let q = quoteRow;
  // ⚠️ An amendment approval carries target_agreement_id. The signing page and the
  // /api/agreement/sign proxy both branch on this: without it, an amendment link
  // posts to sign_agreement and runs the ORIGINAL path — activating the customer
  // again, minting a second pool_id and re-sending the welcome email.
  const isAmendment = !!String(value_(approval, 'target_agreement_id') || '').trim();

  // ⚠️ Same substitution as the PDF: for an amendment, `q` is the PARENT quote, so
  // rendering its pricing would show the customer the original agreement's figures
  // on a page asking them to sign a change. Money comes from the amendment's own
  // snapshot; identity still comes from the parent, because it is the same
  // customer and property.
  if (isAmendment && typeof amAmendmentQuoteView_ === 'function') {
    try {
      const amendmentRow = findRowByValue_(
        ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS),
        'agreement_id', String(value_(approval, 'target_agreement_id') || '').trim());
      if (amendmentRow) q = amAmendmentQuoteView_(q, proposal, amendmentRow);
    } catch (amErr) {
      Logger.log('buildAgreementPagePayload_ amendment view failed: ' + amErr);
    }
  }

  const serviceName = value_(proposal, 'service_type') || value_(q, 'service') || 'Pool Service';
  const rate = value_(q, 'discounted_service_subtotal') || value_(q, 'quote_subtotal') || value_(q, 'service_subtotal');
  return {
    is_amendment: isAmendment,
    // The action the page must submit to. Never inferred client-side.
    sign_action: isAmendment ? 'sign_amendment' : 'sign_agreement',
    // Full legal Terms & Conditions for the merged agreement (bottom of the
    // signing page). Single source shared with the signed PDF renderer.
    agreement_terms_html: buildAgreementTermsHtml_(q),
    approval: {
      status: approval ? (value_(approval, 'status') || 'SENT') : 'SENT',
      customer_note: approval ? value_(approval, 'customer_note') : '',
      responded_at: approval ? value_(approval, 'responded_at') : ''
    },
      proposal: {
        proposal_number: value_(proposal, 'proposal_number'),
        status: value_(proposal, 'status'),
        proposal_pdf_url: value_(proposal, 'proposal_pdf_url'),
        service: serviceName,
        pool_specs: value_(q, 'specs_summary'),
        subtotal: value_(q, 'service_subtotal'),
        discount_amount: value_(q, 'discount_amount'),
        travel_fee: value_(q, 'travel_fee'),
        total: value_(proposal, 'total') || value_(q, 'total_with_tax'),
        sales_tax: value_(proposal, 'sales_tax') || value_(q, 'sales_tax'),
        investment: mcpsMoney_(rate) + (String(serviceName).toLowerCase().indexOf('weekly') !== -1 ? ' / month' : ''),
        valid_until: value_(proposal, 'valid_until'),
        // Pre-rendered scope list + service-plan rows so the page shows the same
        // detail as the proposal without re-implementing the logic client-side.
        scope_html: buildProposalScopeHtml_(serviceName, q, {}),
        service_plan_html: buildProposalServiceRowsHtml_(serviceName, rate, q, {}),
        customer_name: [value_(q, 'first_name'), value_(q, 'last_name')].filter(Boolean).join(' ').trim() || 'Customer',
        service_address: value_(q, 'address'),
        city_state_zip: [value_(q, 'city'), value_(q, 'zip_code')].filter(Boolean).join(', ')
      }
  };
}

function handleGetProposalApproval_(payload) {
  try {
    ensureNormalizedSalesSheets_();
    const token = String(payload.token || '').trim();
    if (!token) return { ok: false, error: 'Approval link is missing a token.' };
    const approvals = ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
    const approval = findRowByValue_(approvals, 'token', token);
    if (!approval) return { ok: false, error: 'This approval link is invalid.' };
    const proposal = findRowByValue_(ensureSheet_('Proposals', MCPS_PROPOSAL_HEADERS), 'proposal_id', approval.proposal_id);
    const hit = getQuoteById_(approval.quote_id);
    if (!proposal || !hit) return { ok: false, error: 'This proposal is no longer available.' };
    // ⚠️ An amendment token whose target row is missing or mistyped must FAIL,
    // not fall through. Silently rendering the parent quote would show the
    // customer the original agreement's pricing on a page headed as a change —
    // and they would sign it believing it was the amendment.
    const targetId = String(value_(approval, 'target_agreement_id') || '').trim();
    if (targetId) {
      const amdRow = findRowByValue_(
        ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS), 'agreement_id', targetId);
      if (!amdRow) {
        return { ok: false, error: 'This amendment is no longer available.' };
      }
      if (!isAmendmentRow_(amdRow)) {
        return { ok: false, error: 'This link is misconfigured. Please contact us for a new one.' };
      }
    }

    const expired = value_(approval, 'expires_at') && new Date(value_(approval, 'expires_at')).getTime() < new Date().getTime();

    recordApprovalViewed_(approvals, approval);

    const out = buildAgreementPagePayload_(hit.object, proposal, approval);
    out.ok = true;
    out.expired = !!expired;
    return out;
  } catch(e) {
    return { ok: false, error: 'handleGetProposalApproval_ Error: ' + e.toString() };
  }
}

// First time a customer opens their agreement. This is the one measurement that
// turns the funnel from guesswork into fact: without it "sent but not signed" and
// "never even opened" are indistinguishable.
//
// ⚠️ Deliberately inert beyond a single cell:
//   * writes ONLY if empty — first view, never last
//   * does NOT touch updated_at (that is an operational timestamp; analytics must
//     not make a row look edited)
//   * invalidates NO cache
//   * affects NO ordering anywhere
//   * swallows every error — this runs on the customer's signing page and must
//     never slow it down or break it
//
// ⚠️ The staff preview goes through handleGetAgreementPreview_, a different
// handler, so previewing a proposal correctly does not register as a customer
// view. Keep that separation.
function recordApprovalViewed_(approvals, approval) {
  try {
    if (String(value_(approval, 'viewed_at') || '').trim()) return;
    ensureColumn_(approvals, 'viewed_at');
    softSetCell_(approvals, approval._rowNum, 'viewed_at', nowIso_());
  } catch (e) {
    Logger.log('recordApprovalViewed_ failed (non-blocking): ' + e);
  }
}

// ── Preview before send (staff only) ─────────────────────────────────────────
// Renders the REAL signing page against a quote that has not been sent yet, so
// what an admin approves is byte-for-byte what the customer will receive. Uses
// the shared builder above — a separate "preview renderer" would drift silently.
//
// No approval row is created and no token is minted: previewing must never be
// able to start a signing flow, and an abandoned preview must leave no trace.
function handleGetAgreementPreview_(payload) {
  try {
    ensureNormalizedSalesSheets_();
    const quoteId = String(payload.quote_id || '').trim();
    if (!quoteId) return { ok: false, error: 'quote_id required' };
    const hit = getQuoteById_(quoteId);
    if (!hit) return { ok: false, error: 'Quote not found: ' + quoteId };
    const result = getProposalByQuoteId_(quoteId);
    const proposal = result && result.proposal;
    if (!proposal) {
      return { ok: false, error: 'Generate the proposal first — there is nothing to preview yet.' };
    }

    const out = buildAgreementPagePayload_(hit.object, proposal, null);
    out.ok = true;
    out.expired = false;
    out.preview = true;
    return out;
  } catch (e) {
    return { ok: false, error: 'handleGetAgreementPreview_ Error: ' + e.toString() };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SALES FUNNEL
//
// Definitions matter more than the code here, so they are stated once:
//
//   basis      Proposal_Approvals.sent_at, in the script timezone, calendar month
//   cohort     every approval SENT in that month. All metrics use that cohort as
//              their denominator, so an agreement sent in June and signed in July
//              counts in JUNE — otherwise close rate silently drifts with lag.
//   close rate signed ÷ sent, same cohort
//   median     median of (signed_at − sent_at). Median, not mean: one stalled
//              deal drags a mean badly.
//
// ⚠️ Amendments are EXCLUDED from the primary funnel. They are expansion revenue
// on an existing customer, not new-customer acquisition, and counting them would
// inflate close rate (an amendment is nearly always signed). Reported separately.
// ══════════════════════════════════════════════════════════════════════════════
var SALES_FUNNEL_CACHE_KEY_ = 'sales_funnel_v1';

function sfMonthKey_(d, tz) { return Utilities.formatDate(d, tz, 'yyyy-MM'); }

function sfParse_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v).trim();
  if (!s) return null;
  var d = new Date(s.length === 10 ? s + 'T00:00:00' : s);
  return isNaN(d.getTime()) ? null : d;
}

function sfMedian_(nums) {
  if (!nums.length) return null;
  var a = nums.slice().sort(function (x, y) { return x - y; });
  var mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// ── Joined customer identity for agreement rows ──────────────────────────────
// Service_Agreements stores no customer name — only who signed. Resolving it
// client-side meant the Contracts page rendered the literal word "Customer" until
// the CRM cache loaded, then flickered to the real name. Fake placeholder data is
// worse than an honest empty field, so the join happens here.
//
// Resolution order, quote LAST: an agreement can outlive a clean quote link
// (quotes get merged, re-keyed, archived), whereas Clients/Client_Locations are
// the normalized records the agreement actually points at.
//   1. Clients          by client_id    → display_name, else first + last
//   2. Client_Locations by location_id  → service_address, city
//   3. Quote            by source_quote_id (fallback only)
//
// Returns '' rather than a placeholder when nothing resolves — the UI skeletons
// the field instead of inventing a name.
function withAgreementCustomer_(rows) {
  if (!rows || !rows.length) return rows || [];
  try {
    var clients = {};
    sheetToObjects_(ensureSheet_('Clients', MCPS_CLIENT_HEADERS)).rows.forEach(function (c) {
      var id = String(value_(c, 'client_id') || '').trim();
      if (id) clients[id] = c;
    });
    var locations = {};
    sheetToObjects_(ensureSheet_('Client_Locations', MCPS_LOCATION_HEADERS)).rows.forEach(function (l) {
      var id = String(value_(l, 'location_id') || '').trim();
      if (id) locations[id] = l;
    });

    // ⚠️ Built ONCE, lazily, from a single read — and only if some row actually
    // needs the fallback. This previously called getQuoteById_ per agreement, and
    // that function re-reads the ENTIRE Quotes sheet every call: N contracts meant
    // N full-sheet scans, which is why names arrived late or not at all.
    var quoteIndex = null;
    function quoteFor(qid) {
      if (!qid) return null;
      if (quoteIndex === null) quoteIndex = buildQuoteNameIndex_();
      return quoteIndex[qid] || null;
    }

    return rows.map(function (a) {
      var name = '', label = '';

      var c = clients[String(a.client_id || '').trim()];
      if (c) {
        name = String(value_(c, 'display_name') || '').trim() ||
               [value_(c, 'first_name'), value_(c, 'last_name')].filter(Boolean).join(' ').trim();
      }
      var l = locations[String(a.location_id || '').trim()];
      if (l) {
        label = [value_(l, 'service_address'), value_(l, 'city')].filter(Boolean).join(', ').trim();
      }

      if (!name || !label) {
        var q = quoteFor(String(a.source_quote_id || '').trim());
        if (q) {
          if (!name) name = q.name;
          if (!label) label = q.label;
        }
      }

      a.customer_name = name || '';
      a.location_label = label || '';
      return a;
    });
  } catch (e) {
    Logger.log('withAgreementCustomer_ failed (non-blocking): ' + e);
    return rows;
  }
}

// One read of Quotes → { quote_id: { name, label } }.
//
// ⚠️ Exists specifically because getQuoteById_ re-reads the whole sheet on every
// call. Any loop that needs several quotes must use an index like this, never
// getQuoteById_ per iteration.
function buildQuoteNameIndex_() {
  var idx = {};
  try {
    var sheet = getCrmSheet_();
    if (!sheet || sheet.getLastRow() < 2) return idx;
    var data = sheet.getDataRange().getValues();
    var h = data[0];
    var qi = headerIndex_(h, 'quote_id');
    if (qi === -1) return idx;
    var ni = headerIndex_(h, 'client_name');
    var fi = headerIndex_(h, 'first_name'), li = headerIndex_(h, 'last_name');
    var ai = headerIndex_(h, 'address'),    ci = headerIndex_(h, 'city');
    var cell = function (row, i) { return i === -1 ? '' : String(row[i] == null ? '' : row[i]).trim(); };

    for (var r = 1; r < data.length; r++) {
      var id = cell(data[r], qi);
      if (!id || idx[id]) continue;
      var name = cell(data[r], ni) ||
                 [cell(data[r], fi), cell(data[r], li)].filter(Boolean).join(' ');
      idx[id] = {
        name: name,
        label: [cell(data[r], ai), cell(data[r], ci)].filter(Boolean).join(', ')
      };
    }
  } catch (e) {
    Logger.log('buildQuoteNameIndex_ failed (non-blocking): ' + e);
  }
  return idx;
}

// ── Contract follow-up cadence ──────────────────────────────────────────────
// Contracts display from Service_Agreements, but automated follow-ups are sent
// from Proposal_Approvals. These helpers join the operational row back onto the
// contract so staff can edit cadence inside the portal instead of Script Props.
function cfuEnsureColumns_(sheet) {
  MCPS_CONTRACT_FOLLOWUP_COLUMNS.forEach(function (c) { ensureColumn_(sheet, c); });
}

function cfuIsOriginalAgreement_(agreement) {
  var type = String(value_(agreement, 'agreement_type') || '').trim().toLowerCase();
  return !type || type === 'original';
}

function cfuApprovalMatchesAgreement_(approval, agreement) {
  var aid = String(value_(agreement, 'agreement_id') || '').trim();
  var target = String(value_(approval, 'target_agreement_id') || '').trim();
  if (target) return target === aid;
  if (!cfuIsOriginalAgreement_(agreement)) return false;
  var pid = String(value_(agreement, 'proposal_id') || '').trim();
  var qid = String(value_(agreement, 'source_quote_id') || '').trim();
  if (pid && String(value_(approval, 'proposal_id') || '').trim() === pid) return true;
  if (qid && String(value_(approval, 'quote_id') || '').trim() === qid) return true;
  return false;
}

function cfuPickApproval_(agreement, approvals, strict) {
  var aid = String(value_(agreement, 'agreement_id') || '').trim();
  var targetMatches = approvals.filter(function (r) {
    return String(value_(r, 'target_agreement_id') || '').trim() === aid;
  });
  if (targetMatches.length === 1) return targetMatches[0];
  if (targetMatches.length > 1) {
    if (strict) throw new Error('Multiple amendment approvals point at this agreement.');
    return null;
  }

  if (!cfuIsOriginalAgreement_(agreement)) return null;
  var pid = String(value_(agreement, 'proposal_id') || '').trim();
  var qid = String(value_(agreement, 'source_quote_id') || '').trim();
  var original = approvals.filter(function (r) {
    if (String(value_(r, 'target_agreement_id') || '').trim()) return false;
    if (pid && String(value_(r, 'proposal_id') || '').trim() === pid) return true;
    if (qid && String(value_(r, 'quote_id') || '').trim() === qid) return true;
    return false;
  });
  if (original.length === 1) return original[0];
  if (original.length > 1 && strict) {
    throw new Error('Multiple approval rows match this contract. Open the approval row directly before editing cadence.');
  }
  return original[0] || null;
}

function cfuApplyApprovalFields_(agreement, approval) {
  if (!approval) return agreement;
  agreement.followup_approval_id = String(value_(approval, 'approval_id') || '').trim();
  agreement.followup_enabled = String(value_(approval, 'followup_enabled') || '').trim();
  agreement.followup_schedule = String(value_(approval, 'followup_schedule') || '').trim();
  agreement.final_notice_lead_days = String(value_(approval, 'final_notice_lead_days') || '').trim();
  agreement.followup_next_index = String(value_(approval, 'followup_next_index') || '').trim();
  agreement.followup_cycle = String(value_(approval, 'followup_cycle') || '').trim();
  agreement.last_followup_at = String(value_(approval, 'last_followup_at') || '').trim();
  agreement.last_followup_error = String(value_(approval, 'last_followup_error') || '').trim();
  agreement.followup_stopped_reason = String(value_(approval, 'followup_stopped_reason') || '').trim();
  agreement.followup_updated_at = String(value_(approval, 'followup_updated_at') || '').trim();
  agreement.approval_status = String(value_(approval, 'status') || '').trim();
  agreement.approval_sent_at = String(value_(approval, 'sent_at') || '').trim();
  agreement.approval_expires_at = String(value_(approval, 'expires_at') || '').trim();
  return agreement;
}

function withAgreementFollowups_(rows) {
  if (!rows || !rows.length) return rows || [];
  try {
    var approvals = ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
    cfuEnsureColumns_(approvals);
    var approvalRows = sheetToObjects_(approvals).rows;
    return rows.map(function (a) {
      var copy = Object.assign({}, a);
      return cfuApplyApprovalFields_(copy, cfuPickApproval_(copy, approvalRows, false));
    });
  } catch (e) {
    Logger.log('withAgreementFollowups_ failed (non-blocking): ' + e);
    return rows;
  }
}

function cfuNormalizeSchedule_(raw) {
  var source = Array.isArray(raw) ? raw.join(',') : String(raw || '');
  var seen = {}, out = [];
  source.split(/[,\s]+/).forEach(function (part) {
    if (!part) return;
    var n = Number(part);
    if (isNaN(n) || n < 1 || n > 90 || Math.floor(n) !== n) return;
    if (!seen[n]) { seen[n] = true; out.push(n); }
  });
  out.sort(function (a, b) { return a - b; });
  if (!out.length) return { ok: false, error: 'Enter at least one follow-up day.' };
  if (out.length > 8) return { ok: false, error: 'Use 8 follow-up touches or fewer.' };
  return { ok: true, days: out, value: out.join(',') };
}

function cfuBool_(v) {
  if (v === true) return true;
  var s = String(v || '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

function handleUpdateContractFollowups_(payload) {
  try {
    var agreementId = String(payload.agreement_id || '').trim();
    if (!agreementId) return { ok: false, error: 'agreement_id required' };

    var schedule = cfuNormalizeSchedule_(payload.followup_schedule);
    if (!schedule.ok) return schedule;

    var finalLead = Number(String(payload.final_notice_lead_days || '').trim());
    if (isNaN(finalLead) || finalLead < 1 || finalLead > 30 || Math.floor(finalLead) !== finalLead) {
      return { ok: false, error: 'Final notice lead must be 1–30 days.' };
    }

    var agreements = ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS);
    var agreement = findRowByValue_(agreements, 'agreement_id', agreementId);
    if (!agreement) return { ok: false, error: 'Service agreement not found.' };

    var approvals = ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
    cfuEnsureColumns_(approvals);
    var approval = cfuPickApproval_(agreement, sheetToObjects_(approvals).rows, true);
    if (!approval) return { ok: false, error: 'No approval row is linked to this contract.' };

    var enabled = cfuBool_(payload.followup_enabled);
    var reset = cfuBool_(payload.reset_followups);
    var now = nowIso_();
    softSetCell_(approvals, approval._rowNum, 'followup_enabled', enabled ? 'TRUE' : 'FALSE');
    softSetCell_(approvals, approval._rowNum, 'followup_schedule', schedule.value);
    softSetCell_(approvals, approval._rowNum, 'final_notice_lead_days', finalLead);
    softSetCell_(approvals, approval._rowNum, 'followup_claimed_until', '');
    softSetCell_(approvals, approval._rowNum, 'followup_claim_id', '');
    softSetCell_(approvals, approval._rowNum, 'followup_updated_at', now);
    softSetCell_(approvals, approval._rowNum, 'updated_at', now);

    if (reset) {
      softSetCell_(approvals, approval._rowNum, 'followup_next_index', 0);
      softSetCell_(approvals, approval._rowNum, 'last_followup_at', '');
      softSetCell_(approvals, approval._rowNum, 'last_followup_error', '');
      softSetCell_(approvals, approval._rowNum, 'followup_stopped_reason', '');
    }

    var fresh = findRowByValue_(approvals, 'approval_id', approval.approval_id);
    return {
      ok: true,
      agreement_id: agreementId,
      approval_id: String(value_(fresh, 'approval_id') || ''),
      followup_enabled: String(value_(fresh, 'followup_enabled') || ''),
      followup_schedule: String(value_(fresh, 'followup_schedule') || ''),
      final_notice_lead_days: String(value_(fresh, 'final_notice_lead_days') || ''),
      followup_next_index: String(value_(fresh, 'followup_next_index') || ''),
      followup_cycle: String(value_(fresh, 'followup_cycle') || ''),
      last_followup_at: String(value_(fresh, 'last_followup_at') || ''),
      last_followup_error: String(value_(fresh, 'last_followup_error') || ''),
      followup_stopped_reason: String(value_(fresh, 'followup_stopped_reason') || ''),
      followup_updated_at: String(value_(fresh, 'followup_updated_at') || '')
    };
  } catch (e) {
    return { ok: false, error: 'handleUpdateContractFollowups_ Error: ' + e };
  }
}

function handleGetSalesFunnel_(payload) {
  try {
    var months = Math.min(24, Math.max(1, Number(payload && payload.months) || 6));
    var cacheVersion = String((payload && payload.cache_version) || 'stage5b-current-month').trim();
    var cacheKey = SALES_FUNNEL_CACHE_KEY_ + ':' + cacheVersion + ':' + months;
    var cache = CacheService.getScriptCache();
    if (payload && payload.refresh) {
      try { cache.remove(cacheKey); } catch (e) {}
    } else {
      var cached = cache.get(cacheKey);
      if (cached) { try { return JSON.parse(cached); } catch (e) {} }
    }

    ensureNormalizedSalesSheets_();
    var tz = Session.getScriptTimeZone() || 'America/Chicago';
    var now = new Date();

    // Signed timestamps live on Service_Agreements, NOT on the approval row.
    // ⚠️ Filter to original agreements: parent and amendments share a
    // source_quote_id, so an amendment could otherwise supply the close timestamp
    // for a new-customer deal.
    var agreements = ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS);
    var signedByProposal = {}, signedByQuote = {};
    sheetToObjects_(agreements).rows.forEach(function (a) {
      var type = String(value_(a, 'agreement_type') || '').trim().toLowerCase();
      if (type && type !== 'original') return;              // blank counts as original (legacy rows)
      var signedAt = sfParse_(value_(a, 'signed_at'));
      if (!signedAt) return;
      var pid = String(value_(a, 'proposal_id') || '').trim();
      var qid = String(value_(a, 'source_quote_id') || '').trim();
      if (pid && !signedByProposal[pid]) signedByProposal[pid] = signedAt;
      if (qid && !signedByQuote[qid]) signedByQuote[qid] = signedAt;
    });

    var approvals = ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
    var rows = sheetToObjects_(approvals).rows;

    var buckets = {};
    var expiringSoon = 0, amendmentsSigned = 0, trackingStart = null;

    rows.forEach(function (r) {
      var isAmendment = !!String(value_(r, 'target_agreement_id') || '').trim();
      var status = String(value_(r, 'status') || '').toUpperCase();
      var sentAt = sfParse_(value_(r, 'sent_at'));
      var viewedAt = sfParse_(value_(r, 'viewed_at'));
      var expiresAt = sfParse_(value_(r, 'expires_at'));

      if (viewedAt && (!trackingStart || viewedAt.getTime() < trackingStart.getTime())) {
        trackingStart = viewedAt;
      }

      // Live worklist — deliberately NOT cohort-scoped. "What needs chasing right
      // now" has nothing to do with which month it was sent in.
      if (status === 'SENT' && expiresAt &&
          expiresAt.getTime() > now.getTime() &&
          expiresAt.getTime() - now.getTime() <= 7 * 86400000) {
        expiringSoon++;
      }

      if (isAmendment) {
        if (status === 'APPROVED') amendmentsSigned++;
        return;                                             // out of the primary funnel
      }
      if (!sentAt) return;

      var key = sfMonthKey_(sentAt, tz);
      var b = buckets[key] || (buckets[key] = { month: key, sent: 0, viewed: 0, signed: 0, days: [] });
      b.sent++;
      if (viewedAt) b.viewed++;
      if (status === 'APPROVED') {
        b.signed++;
        var pid = String(value_(r, 'proposal_id') || '').trim();
        var qid = String(value_(r, 'quote_id') || '').trim();
        // Prefer the real signature timestamp; fall back to responded_at, which is
        // when the customer acted, for rows with no agreement record.
        var signedAt = signedByProposal[pid] || signedByQuote[qid] || sfParse_(value_(r, 'responded_at'));
        if (signedAt) {
          var days = (signedAt.getTime() - sentAt.getTime()) / 86400000;
          if (days >= 0) b.days.push(days);
        }
      }
    });

    // ⚠️ The CURRENT calendar month must always exist, even with no activity.
    // Without this, `current` fell back to the newest month that happened to have
    // data — so in August the band read "Sent in June 2026", which looks like a
    // stale page rather than a quiet month.
    var currentKey = sfMonthKey_(now, tz);
    if (!buckets[currentKey]) {
      buckets[currentKey] = { month: currentKey, sent: 0, viewed: 0, signed: 0, days: [] };
    }

    var shape = function (b) {
      var med = sfMedian_(b.days);
      return {
        month: b.month, sent: b.sent, viewed: b.viewed, signed: b.signed,
        close_rate: b.sent ? Math.round((b.signed / b.sent) * 1000) / 10 : 0,
        median_days_to_close: med === null ? null : Math.round(med * 10) / 10
      };
    };

    var keys = Object.keys(buckets).sort().reverse().slice(0, months);
    var out = keys.map(function (k) { return shape(buckets[k]); });

    // The most recent month that actually had activity — useful when the current
    // month is empty, but it must be LABELLED as historical, never as "now".
    var latestKey = Object.keys(buckets).filter(function (k) { return buckets[k].sent > 0; })
                          .sort().reverse()[0];

    var res = {
      ok: true,
      months: out,
      current: shape(buckets[currentKey]),
      latest_cohort: latestKey && latestKey !== currentKey ? shape(buckets[latestKey]) : null,
      expiring_soon: expiringSoon,
      amendments_signed: amendmentsSigned,
      // ⚠️ viewed_at only exists from the day tracking shipped. The UI must label
      // "viewed" against this date rather than implying older quotes went unopened.
      viewed_tracking_since: trackingStart ? Utilities.formatDate(trackingStart, tz, 'yyyy-MM-dd') : '',
      timezone: tz,
      generated_at: nowIso_()
    };
    if (!(payload && payload.refresh)) {
      try { cache.put(cacheKey, JSON.stringify(res), 300); } catch (e) {}
    }
    return res;
  } catch (e) {
    return { ok: false, error: 'handleGetSalesFunnel_ Error: ' + e };
  }
}

function handleRespondToProposal_(payload) {
  try {
    ensureNormalizedSalesSheets_();
    const token = String(payload.token || '').trim();
    const response = String(payload.response || '').trim().toLowerCase();
    const note = String(payload.note || '').trim();
    const statusMap = {
      approve: 'APPROVED',
      approved: 'APPROVED',
      decline: 'DECLINED',
      declined: 'DECLINED',
      changes: 'CHANGES_REQUESTED',
      changes_requested: 'CHANGES_REQUESTED',
      request_changes: 'CHANGES_REQUESTED'
    };
    const approvalStatus = statusMap[response];
    if (!token) return { ok: false, error: 'Approval link is missing a token.' };
    if (!approvalStatus) return { ok: false, error: 'Unknown proposal response.' };
    const approvals = ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
    const approval = findRowByValue_(approvals, 'token', token);
    if (!approval) return { ok: false, error: 'This approval link is invalid.' };
    const current = String(value_(approval, 'status') || '').toUpperCase();
    if (current && current !== 'SENT') {
      return { ok: true, already_responded: true, status: current, message: 'This proposal has already been responded to.' };
    }
    if (value_(approval, 'expires_at') && new Date(value_(approval, 'expires_at')).getTime() < new Date().getTime()) {
      softSetCell_(approvals, approval._rowNum, 'status', 'EXPIRED');
      return { ok: false, expired: true, error: 'This approval link has expired.' };
    }

    const proposals = ensureSheet_('Proposals', MCPS_PROPOSAL_HEADERS);
    const proposal = findRowByValue_(proposals, 'proposal_id', approval.proposal_id);
    const hit = getQuoteById_(approval.quote_id);
    if (!proposal || !hit) return { ok: false, error: 'This proposal is no longer available.' };
    const now = nowIso_();
    // ⚠️ AMENDMENT BRANCH — must return before touching the parent quote.
    //
    // Every write below this point targets the parent quote row, and the APPROVED
    // path additionally advances repair work orders and GENERATES AND SENDS a
    // contract for the parent. Running any of that because a customer declined or
    // queried an addendum would corrupt the original agreement's record.
    const amendmentTarget = String(value_(approval, 'target_agreement_id') || '').trim();
    if (amendmentTarget) {
      if (approvalStatus === 'APPROVED') {
        // Approving an amendment means signing it — that path writes the audit
        // trail. Accepting it here would mark it accepted with no signature.
        return { ok: false, error: 'Amendments are accepted by signing them.' };
      }
      softSetCell_(approvals, approval._rowNum, 'status', approvalStatus);
      softSetCell_(approvals, approval._rowNum, 'customer_note', note);
      softSetCell_(approvals, approval._rowNum, 'responded_at', now);
      softSetCell_(approvals, approval._rowNum, 'updated_at', now);
      if (proposal) {
        softSetCell_(proposals, proposal._rowNum, 'status',
          approvalStatus === 'DECLINED' ? 'DECLINED' : 'GENERATED');
        softSetCell_(proposals, proposal._rowNum, 'updated_at', now);
        if (approvalStatus === 'DECLINED') softSetCell_(proposals, proposal._rowNum, 'declined_at', now);
      }
      // Status on the AMENDMENT's own agreement row — never the parent's.
      try {
        const amendments = ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS);
        const amendmentRow = findRowByValue_(amendments, 'agreement_id', amendmentTarget);
        if (amendmentRow && approvalStatus === 'DECLINED') {
          softSetCell_(amendments, amendmentRow._rowNum, 'status', 'DECLINED');
          softSetCell_(amendments, amendmentRow._rowNum, 'declined_at', now);
          softSetCell_(amendments, amendmentRow._rowNum, 'updated_at', now);
        }
      } catch (amErr) {
        Logger.log('respond_to_proposal amendment status write failed: ' + amErr);
      }
      return { ok: true, status: approvalStatus, amendment: true, amendment_id: amendmentTarget };
    }

    softSetCell_(approvals, approval._rowNum, 'status', approvalStatus);
    softSetCell_(approvals, approval._rowNum, 'customer_note', note);
    softSetCell_(approvals, approval._rowNum, 'responded_at', now);
    softSetCell_(approvals, approval._rowNum, 'updated_at', now);

    if (approvalStatus === 'APPROVED') {
      softSetCell_(proposals, proposal._rowNum, 'status', 'ACCEPTED');
      softSetCell_(proposals, proposal._rowNum, 'accepted_at', now);
      softSetCell_(proposals, proposal._rowNum, 'updated_at', now);
      softSetCell_(hit.sheet, hit.rowNum, 'proposal_accepted_at', now);
      softSetCell_(hit.sheet, hit.rowNum, 'proposal_response_note', note);
      // Customer approval advances any repair work orders on this quote
      try { markRepairOrdersApprovedForQuote_(approval.quote_id); } catch (roErr) { Logger.log('markRepairOrdersApprovedForQuote_: ' + roErr); }
      let contract = handleGenerateContract_(approval.quote_id);
      if (contract.ok) {
        const sent = handleSendContract_(approval.quote_id);
        softSetCell_(proposals, proposal._rowNum, 'status', 'ACCEPTED');
        softSetCell_(proposals, proposal._rowNum, 'accepted_at', now);
        softSetCell_(proposals, proposal._rowNum, 'updated_at', now);
        softSetCell_(hit.sheet, hit.rowNum, 'proposal_accepted_at', now);
        return { ok: true, status: 'APPROVED', agreement_sent: !!sent.ok, agreement_error: sent.ok ? '' : sent.error };
      }
      return { ok: true, status: 'APPROVED', agreement_sent: false, agreement_error: contract.error || 'Agreement generation failed.' };
    }

    if (approvalStatus === 'DECLINED') {
      softSetCell_(proposals, proposal._rowNum, 'status', 'DECLINED');
      softSetCell_(proposals, proposal._rowNum, 'declined_at', now);
      softSetCell_(proposals, proposal._rowNum, 'updated_at', now);
      softSetCell_(hit.sheet, hit.rowNum, 'proposal_declined_at', now);
      softSetCell_(hit.sheet, hit.rowNum, 'proposal_response_note', note);
      return { ok: true, status: 'DECLINED' };
    }

    softSetCell_(proposals, proposal._rowNum, 'status', 'GENERATED');
    softSetCell_(proposals, proposal._rowNum, 'updated_at', now);
    softSetCell_(hit.sheet, hit.rowNum, 'proposal_change_requested_at', now);
    softSetCell_(hit.sheet, hit.rowNum, 'proposal_response_note', note);
    return { ok: true, status: 'CHANGES_REQUESTED' };
  } catch(e) {
    return { ok: false, error: 'handleRespondToProposal_ Error: ' + e.toString() };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// MERGED AGREEMENT (proposal + contract in one document) + IN-PORTAL E-SIGNATURE
// ──────────────────────────────────────────────────────────────────────────────

// Legal Terms & Conditions body for the merged Service Agreement. Rendered both
// into the signed PDF (renderSignedAgreementPdf_) and onto the public signing
// page (handleGetProposalApproval_) so there is a single source of truth.
//
// SOURCE OF TRUTH: this is a transcription of the official MCPS Service Agreement
// (the CONTRACT_TEMPLATE_ID Google Doc / "template (1).pdf"), with the {{...}}
// placeholders wired to real quote data. Three deliberate adaptations, all approved:
//
//   §2  SCOPE OF SERVICES — the template hard-codes a fixed bullet list. Because the
//       signing page renders the quote's actual Scope of Work directly above these
//       terms (and that list is per-quote), §2 now REFERENCES that section instead of
//       duplicating it. Prevents the contract contradicting what the customer was
//       quoted — e.g. a quote without filter cleaning can no longer sign a contract
//       that promises it.
//   §7  TERM & CANCELLATION — the template requires 30 days' notice. Per Tony's
//       review (2026-07-27: "I would also reconsider the 30-day cancellation policy.
//       For now, I believe cancellation should remain flexible"), the fixed 30-day
//       period is omitted. Restore it here if that policy is ever reinstated.
//   §11 ACCEPTANCE — the template was written for a wet signature. ESIGN/UETA consent
//       language is appended so the electronic signature is enforceable.
//
// Rendered into BOTH the signed PDF (renderSignedAgreementPdf_) and the public
// signing page (handleGetProposalApproval_) — one source of truth. Each signed
// agreement snapshots its own PDF, so edits here never alter an executed contract.
function buildAgreementTermsHtml_(q) {
  const fullName = [value_(q, 'first_name'), value_(q, 'last_name')].filter(Boolean).join(' ').trim() || 'Customer';
  const serviceName = value_(q, 'service') || 'Pool Service';
  const address = [value_(q, 'address'), value_(q, 'city'), value_(q, 'zip_code')].filter(Boolean).join(', ');
  const total = mcpsMoney_(value_(q, 'total_with_tax'));
  const monthly = mcpsMoney_(value_(q, 'discounted_service_subtotal') || value_(q, 'quote_subtotal') || value_(q, 'service_subtotal'));
  const salesTax = mcpsMoney_(value_(q, 'sales_tax'));
  const isRecurring = String(serviceName).toLowerCase().indexOf('weekly') !== -1;

  const clause = function(title, body) {
    return '<div class="term"><h4>' + htmlEscape_(title) + '</h4><p>' + body + '</p></div>';
  };
  // Same wrapper, but for clauses whose body carries its own block markup (lists).
  const clauseHtml = function(title, bodyHtml) {
    return '<div class="term"><h4>' + htmlEscape_(title) + '</h4>' + bodyHtml + '</div>';
  };
  const bullets = function(items) {
    return '<ul>' + items.map(function(i) { return '<li>' + i + '</li>'; }).join('') + '</ul>';
  };

  // Sales-tax label: use the quote's real rate rather than hard-coding 8.25%,
  // accepting either 0.0825 or 8.25 from the sheet.
  const taxRateRaw = Number(value_(q, 'tax_rate') || 0);
  const taxPct = taxRateRaw > 0 ? (taxRateRaw < 1 ? taxRateRaw * 100 : taxRateRaw) : 0;
  const taxLabel = taxPct > 0
    ? 'Sales Tax (' + String(taxPct.toFixed(2)).replace(/\.?0+$/, '') + '%)'
    : 'Sales Tax';

  return [
    clause('1. Property & Service Details',
      'This Service Agreement ("Agreement") is entered into between Mission Custom Pool Solutions LLC ' +
      '("Service Provider") and <b>' + htmlEscape_(fullName) + '</b> ("Client") for pool-related services ' +
      'at the property listed below.<br><br>' +
      '<b>Service Address:</b> ' + htmlEscape_(address || 'the address on file') + '<br>' +
      '<b>Service Type:</b> ' + htmlEscape_(serviceName)),

    clause('2. Scope of Services',
      'Mission Custom Pool Solutions LLC will provide the services set out in the <b>Scope of Work</b> and ' +
      '<b>Service Plan</b> shown above, which form part of this Agreement. Services not listed there are not ' +
      'included unless expressly agreed in writing.'),

    clauseHtml('3. Exclusions & Additional Services',
      '<p>Unless expressly stated in writing, this Agreement does not include:</p>' +
      bullets([
        'Equipment repairs or replacements',
        'Plumbing or electrical repairs',
        'Filter replacement or full filter tear-downs',
        'Acid washes or green-to-clean treatments',
        'Storm cleanups beyond normal service scope',
        'Services requiring a licensed repair technician'
      ]) +
      '<p>Any excluded or additional services may be quoted separately and performed only upon Client approval.</p>'),

    clause('4. Access & Safety',
      'Client agrees to provide clear and safe access to the pool area on scheduled service days. All pets must ' +
      'be secured prior to service. Mission Custom Pool Solutions LLC is not responsible for service delays or ' +
      'incomplete service due to restricted access, unsafe conditions, or environmental hazards.'),

    clauseHtml('5. Chemical Usage & Water Conditions',
      '<p>Service pricing assumes standard chemical usage under normal conditions.</p>' +
      '<p>Excessive chemical demand resulting from weather events, heavy bather load, algae growth, water ' +
      'features, or other abnormal conditions may result in additional charges. Any such charges will be ' +
      'communicated to the Client when identified.</p>' +
      '<p>Mission Custom Pool Solutions LLC is not responsible for chemical imbalances caused by factors ' +
      'outside scheduled service visits.</p>'),

    clauseHtml('6. Pricing & Payment Terms',
      (isRecurring
        ? bullets([
            'Monthly Service Rate: <b>' + htmlEscape_(monthly) + '</b>',
            htmlEscape_(taxLabel) + ': <b>' + htmlEscape_(salesTax) + '</b>',
            'Total Monthly Investment: <b>' + htmlEscape_(total) + '</b>'
          ])
        : bullets([
            'Service Total: <b>' + htmlEscape_(monthly) + '</b>',
            htmlEscape_(taxLabel) + ': <b>' + htmlEscape_(salesTax) + '</b>',
            'Total Investment: <b>' + htmlEscape_(total) + '</b>'
          ])) +
      '<p>Invoices are due upon receipt unless otherwise agreed in writing. Accounts past due may result in ' +
      'suspension of service until payment is received. Prices may be adjusted with reasonable advance notice.</p>'),

    clauseHtml('7. Term & Cancellation',
      isRecurring
        ? '<p>This Agreement operates on a <b>month-to-month</b> basis.</p>' +
          '<p>Either party may terminate this Agreement with written or emailed notice. Services performed prior ' +
          'to the termination date remain billable, and chemicals or materials already applied are non-refundable.</p>'
        : '<p>This Agreement covers the one-time service described above and is complete upon delivery of that ' +
          'service and the associated report.</p>' +
          '<p>One-time services may be rescheduled with reasonable notice. Deposits or work already performed ' +
          'are non-refundable.</p>'),

    clauseHtml('8. Liability & Limitations',
      '<p>Mission Custom Pool Solutions LLC is not responsible for:</p>' +
      bullets([
        'Pre-existing equipment or structural conditions',
        'Damage caused by acts of God, weather, vandalism, or misuse',
        'Delays or issues caused by utility outages or restricted access'
      ]) +
      '<p>Service Provider makes no guarantee against algae growth, staining, or equipment failure beyond ' +
      'routine maintenance efforts.</p>'),

    clause('9. Independent Contractor',
      'Mission Custom Pool Solutions LLC operates as an independent contractor. Nothing in this Agreement shall ' +
      'be construed as creating a partnership, joint venture, or employment relationship.'),

    clause('10. Entire Agreement',
      'This Agreement constitutes the entire understanding between the parties and supersedes all prior ' +
      'discussions or agreements. Any modifications must be made in writing and agreed upon by both parties. ' +
      'This Agreement is governed by the laws of the State of Texas.'),

    clause('11. Acceptance',
      'By signing below, Client acknowledges understanding and acceptance of the terms outlined in this ' +
      'Agreement. By selecting "Accept &amp; Sign" and providing a signature, Client agrees to conduct this ' +
      'transaction electronically and acknowledges that the electronic signature is legally binding and ' +
      'enforceable to the same extent as a handwritten signature under the U.S. ESIGN Act and applicable ' +
      'state law (UETA).')
  ].join('');
}

// Renders the merged Service Agreement (proposal scope + investment + terms +
// signature block) to a PDF in Drive and returns its URLs. Mirrors the rendering
// approach of handleGenerateProposal_ but uses the AgreementTemplate and injects
// the captured signature. Returns { url, downloadUrl, fileId }.
function renderSignedAgreementPdf_(q, proposal, sig) {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty('CONTRACT_FOLDER_ID') || props.getProperty('PROPOSAL_FOLDER_ID');
  if (!folderId) throw new Error('CONTRACT_FOLDER_ID or PROPOSAL_FOLDER_ID not set in Script Properties.');
  const folder = DriveApp.getFolderById(folderId);
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const fullName = [value_(q, 'first_name'), value_(q, 'last_name')].filter(Boolean).join(' ').trim() || 'Customer';
  const serviceName = value_(q, 'service') || 'Pool Service';
  const rate = value_(q, 'discounted_service_subtotal') || value_(q, 'quote_subtotal') || value_(q, 'service_subtotal');
  const fileName = 'Service Agreement - ' + fullName + ' - ' + (proposal && proposal.proposal_number || value_(q, 'quote_id'));

  let imageDataUri = '';
  const imageUrl = (proposal && value_(proposal, 'proposal_image_url')) || value_(q, 'proposal_image_url');
  if (imageUrl) imageDataUri = fetchImageAsDataUri_(imageUrl);

  const signedDate = sig.signedAt ? new Date(sig.signedAt) : now;
  const signatureImg = sig.signatureData
    ? '<img src="' + sig.signatureData + '" alt="Signature" style="max-height:70px;max-width:320px;">'
    : '<span style="font-family:\'Brush Script MT\',cursive;font-size:30px;color:#0f2b2f;">' + htmlEscape_(sig.signatureName) + '</span>';

  const signatureBlock =
    '<div class="sig-grid">' +
      '<div class="sig-col">' +
        '<div class="sig-mark">' + signatureImg + '</div>' +
        '<div class="sig-rule"></div>' +
        '<div class="sig-cap"><b>' + htmlEscape_(sig.signatureName) + '</b> — Customer</div>' +
      '</div>' +
      '<div class="sig-col">' +
        '<div class="sig-meta">' +
          'Signed electronically: <b>' + htmlEscape_(Utilities.formatDate(signedDate, tz, 'MMMM d, yyyy h:mm a')) + '</b><br>' +
          (sig.signerIp ? 'IP address: ' + htmlEscape_(sig.signerIp) + '<br>' : '') +
          'Agreement ref: ' + htmlEscape_((proposal && proposal.proposal_number) || value_(q, 'quote_id')) + '<br>' +
          'Method: ' + htmlEscape_(sig.signatureMethod === 'typed' ? 'Typed signature' : 'Drawn signature') +
        '</div>' +
      '</div>' +
    '</div>' +
    '<p class="sig-legal">This Agreement was signed electronically through the Mission Custom Pool Solutions customer portal. ' +
    'Under the U.S. ESIGN Act and applicable UETA, this electronic signature is legally binding and enforceable to the same ' +
    'extent as a handwritten signature. A copy of this signed Agreement has been retained by MCPS.</p>';

  const templateHtml = HtmlService.createHtmlOutputFromFile('AgreementTemplate').getContent();
  const rendered = replaceProposalPlaceholders_(templateHtml, {
    proposal_number: (proposal && proposal.proposal_number) || value_(q, 'quote_id'),
    proposal_date: Utilities.formatDate(now, tz, 'MM/dd/yyyy'),
    logo_url: getProposalLogoDataUri_(props),
    pool_image_url: imageDataUri || '',
    client_name: fullName,
    service_address: value_(q, 'address'),
    city_state_zip: [value_(q, 'city'), value_(q, 'zip_code')].filter(Boolean).join(', '),
    phone: value_(q, 'phone'),
    email: value_(q, 'email'),
    service_type: serviceName,
    pool_specs: value_(q, 'specs_summary'),
    subtotal: mcpsMoney_(value_(q, 'service_subtotal')),
    discount_amount: mcpsMoney_(value_(q, 'discount_amount')),
    travel_fee: mcpsMoney_(value_(q, 'travel_fee')),
    sales_tax: mcpsMoney_(value_(q, 'sales_tax')),
    total: mcpsMoney_(value_(q, 'total_with_tax')),
    investment: mcpsMoney_(rate) + (String(serviceName).toLowerCase().indexOf('weekly') !== -1 ? ' / MONTH' : ''),
    company_phone: props.getProperty('MCPS_COMPANY_PHONE') || '(210) 559-2073',
    company_email: props.getProperty('MCPS_COMPANY_EMAIL') || 'mauricio@mcpoolsolutions.org',
    company_website: props.getProperty('MCPS_COMPANY_WEBSITE') || 'missioncustompools.com'
  }, {
    scope_of_work: buildProposalScopeHtml_(serviceName, q, {}),
    service_plan_rows: buildProposalServiceRowsHtml_(serviceName, rate, q, {}),
    proposal_items: buildProposalItemsHtml_(q),
    terms_html: buildAgreementTermsHtml_(q),
    signature_block: signatureBlock
  });

  const htmlBlob = Utilities.newBlob(rendered, 'text/html', fileName + '.html');
  const htmlFile = folder.createFile(htmlBlob);
  const pdf = htmlFile.getAs(MimeType.PDF).setName(fileName + '.pdf');
  const pdfFile = folder.createFile(pdf);
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  htmlFile.setTrashed(true);
  const fileId = pdfFile.getId();
  return {
    url: pdfFile.getUrl(),
    downloadUrl: 'https://drive.google.com/uc?export=download&id=' + fileId,
    fileId: fileId
  };
}

// ── Shared transactional-email chrome ────────────────────────────────────────
// Table-based with fully inline styles. <style> blocks and flexbox are unreliable
// across mail clients, so nothing structural depends on either. Mirrors the
// already-shipped buildOnMyWayHtml_ in HeadsUp.js — keep the two visually in step.
//
// Font stacks degrade toward the brand rather than to Arial: Montserrat is
// geometric -> Avenir Next/Avenir (Mac + iPhone), then Segoe UI / Roboto.
// Open Sans is humanist -> Segoe UI (Windows), Roboto (Android), Helvetica Neue.
var MCPS_EMAIL_FH_ = "'Montserrat','Avenir Next','Avenir','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
var MCPS_EMAIL_FB_ = "'Open Sans','Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";

function mcpsEmailPortalBase_() {
  return (PropertiesService.getScriptProperties().getProperty('PORTAL_BASE_URL') || 'https://mcps-log.vercel.app')
    .replace(/\/$/, '');
}
function mcpsEmailIconUrl_() {
  return mcpsEmailPortalBase_() + '/assets/mission-icon-transparent.png';
}
function mcpsEmailCompany_() {
  var props = PropertiesService.getScriptProperties();
  return {
    phone: props.getProperty('MCPS_COMPANY_PHONE') || '(210) 559-2073',
    website: props.getProperty('MCPS_COMPANY_WEBSITE') || 'missioncustompools.com'
  };
}

// Teal hero band with the aqua glow. bgcolor is the universal fallback; the
// radial-gradient renders in Gmail/Apple Mail and degrades to flat teal elsewhere.
function mcpsEmailHero_(opts) {
  return '' +
  '<tr><td align="center" bgcolor="#0D3D3E" style="background-color:#0D3D3E;' +
    'background-image:radial-gradient(ellipse at 50% -20%, rgba(94,214,211,0.24), rgba(13,61,62,0) 60%);' +
    'padding:40px 32px 36px;">' +
    '<img src="' + htmlEscape_(mcpsEmailIconUrl_()) + '" alt="Mission Custom Pool Solutions" width="60" ' +
      'style="display:block;width:60px;max-width:60px;height:auto;border:0;margin:0 auto 16px;">' +
    '<div style="font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:11px;letter-spacing:.16em;' +
      'text-transform:uppercase;color:#5ED6D3;margin:0 0 14px;">Mission Custom Pool Solutions</div>' +
    '<div style="font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:29px;line-height:1.08;' +
      'letter-spacing:-.3px;color:#FFFFFF;margin:0 0 10px;">' + opts.headline + '</div>' +
    '<div style="font-family:' + MCPS_EMAIL_FB_ + ';font-size:14.5px;line-height:1.6;color:#BFD4D4;' +
      'max-width:390px;margin:0 auto;">' + opts.lede + '</div>' +
  '</td></tr>';
}

function mcpsEmailFooter_() {
  var co = mcpsEmailCompany_();
  return '' +
  '<tr><td align="center" style="padding:24px 32px 30px;border-top:1px solid #E4EAEA;">' +
    '<div style="font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:10px;letter-spacing:.2em;' +
      'text-transform:uppercase;color:#1FA7A8;margin-bottom:8px;">Every pool matters.</div>' +
    '<div style="font-family:' + MCPS_EMAIL_FB_ + ';font-size:12px;line-height:1.7;color:#8A9494;">' +
      'Mission Custom Pool Solutions LLC &middot; San Antonio, TX<br>' +
      '<a href="https://' + htmlEscape_(co.website) + '" style="color:#0D3D3E;text-decoration:none;">' +
        htmlEscape_(co.website) + '</a> &middot; ' + htmlEscape_(co.phone) +
    '</div>' +
  '</td></tr>';
}

function mcpsEmailShell_(innerRows, preheader) {
  return '' +
  '<!DOCTYPE html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="color-scheme" content="light only">' +
  '<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800&family=Open+Sans:wght@400;600&display=swap" rel="stylesheet">' +
  '</head><body style="margin:0;padding:0;background:#F3F5F6;">' +
  '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + htmlEscape_(preheader || '') + '</div>' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F6;">' +
  '<tr><td align="center" style="padding:24px 12px;">' +
  '<table role="presentation" width="600" cellpadding="0" cellspacing="0" ' +
    'style="width:600px;max-width:600px;background:#FFFFFF;border-radius:12px;overflow:hidden;">' +
  innerRows +
  '</table></td></tr></table></body></html>';
}

// Numbered "what happens next" list, shared by the welcome email.
function mcpsEmailSteps_(steps) {
  return steps.map(function (s, i) {
    return '<tr>' +
      '<td valign="top" width="30" style="padding:11px 12px 11px 0;">' +
        '<div style="width:24px;height:24px;border-radius:12px;background:#0D3D3E;color:#FFFFFF;' +
          'font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:12px;line-height:24px;' +
          'text-align:center;">' + (i + 1) + '</div></td>' +
      '<td valign="top" style="padding:11px 0;border-bottom:' +
        (i === steps.length - 1 ? 'none' : '1px solid #E4EAEA') + ';' +
        'font-family:' + MCPS_EMAIL_FB_ + ';font-size:14px;line-height:1.55;color:#3A4645;">' +
        s + '</td></tr>';
  }).join('');
}

// ── Welcome email (sent the moment the agreement is signed) ──────────────────
// ⚠️ Deliberately carries NO pricing — that lives on the signed PDF, which is
// linked below. Confirmed with Mau.
//
// d.serviceDay / d.techName are populated once auto-assignment lands (Stage 3).
// Until then — and permanently for startups and green-to-cleans, which have no
// day at signing — the block renders a deliberate "we'll be in touch" fallback
// rather than looking like missing data.
function buildWelcomeEmailHtml_(d) {
  var hasSchedule = !!(d.serviceDay && String(d.serviceDay).trim());

  // Technician avatar. A real photo when one is on file, otherwise their initials
  // in a teal circle — never a broken image or an empty hole. Circles use
  // border-radius, which every modern client honours; Outlook desktop squares it
  // off, which is a fine degradation.
  var techAvatar = '';
  if (d.techName && d.showPhoto !== false) {
    if (d.techPhotoUrl) {
      techAvatar =
        '<td width="64" valign="top" style="padding-right:14px;">' +
          '<img src="' + htmlEscape_(d.techPhotoUrl) + '" alt="' + htmlEscape_(d.techName) + '" ' +
            'width="56" height="56" style="display:block;width:56px;height:56px;border:0;' +
            'border-radius:28px;object-fit:cover;background:#0D3D3E;">' +
        '</td>';
    } else {
      var initials = String(d.techName).trim().split(/\s+/).map(function (p) { return p.charAt(0); })
        .join('').slice(0, 2).toUpperCase();
      techAvatar =
        '<td width="64" valign="top" style="padding-right:14px;">' +
          '<div style="width:56px;height:56px;border-radius:28px;background:#0D3D3E;color:#FFFFFF;' +
            'font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:19px;line-height:56px;' +
            'text-align:center;">' + htmlEscape_(initials) + '</div>' +
        '</td>';
    }
  }

  var techBlock = d.techName
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;' +
        'border-top:1px solid rgba(13,61,62,.12);padding-top:14px;"><tr>' +
        '<td style="padding-top:14px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
          techAvatar +
          '<td valign="middle">' +
            '<div style="font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:10px;' +
              'letter-spacing:.1em;text-transform:uppercase;color:#1FA7A8;margin-bottom:2px;">Your technician</div>' +
            '<div style="font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:17px;color:#0D3D3E;">' +
              htmlEscape_(d.techName) + '</div>' +
            (d.techBio && d.showBio !== false
              ? '<div style="font-family:' + MCPS_EMAIL_FB_ + ';font-size:13px;line-height:1.55;' +
                'color:#3A4645;margin-top:5px;max-width:340px;">' + htmlEscape_(d.techBio) + '</div>'
              : '') +
          '</td>' +
        '</tr></table></td>' +
      '</tr></table>'
    : '';

  var scheduleCard = hasSchedule
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
        'style="background:#EAF8F7;border-radius:10px;margin:0 0 22px;"><tr>' +
        '<td style="padding:18px 20px;">' +
          '<div style="font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:10px;letter-spacing:.12em;' +
            'text-transform:uppercase;color:#1FA7A8;margin-bottom:4px;">Your service day</div>' +
          '<div style="font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:19px;color:#0D3D3E;">' +
            htmlEscape_(d.serviceDay) + '</div>' +
          '<div style="font-family:' + MCPS_EMAIL_FB_ + ';font-size:12.5px;color:#6B7777;margin-top:6px;">' +
            'No need to be home &mdash; we&rsquo;ll text you when we&rsquo;re on the way.</div>' +
          techBlock +
        '</td></tr></table>'
    : '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
        'style="background:#F3F5F6;border-radius:10px;margin:0 0 22px;"><tr>' +
        '<td style="padding:16px 18px;">' +
          '<div style="font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:10px;letter-spacing:.12em;' +
            'text-transform:uppercase;color:#6B7777;margin-bottom:4px;">Your service day</div>' +
          '<div style="font-family:' + MCPS_EMAIL_FB_ + ';font-size:14px;line-height:1.6;color:#3A4645;">' +
            'Your service coordinator will be in touch shortly to confirm the day we&rsquo;ll be servicing ' +
            'your pool, and to introduce your technician.</div>' +
        '</td></tr></table>';

  var steps = [
    hasSchedule
      ? '<strong style="color:#0D3D3E;">Your first visit is on the schedule.</strong> ' +
        'We&rsquo;ll text you when we&rsquo;re on the way.'
      : '<strong style="color:#0D3D3E;">We schedule your first visit.</strong> ' +
        'Your service coordinator will be in touch to let you know your service day.',
    '<strong style="color:#0D3D3E;">Your technician arrives.</strong> ' +
      htmlEscape_(d.serviceName) + ', with a service report after every visit.',
    '<strong style="color:#0D3D3E;">You relax.</strong> ' +
      'Consistent care, transparent pricing, no surprises.'
  ];

  var cta = d.signedPdfUrl
    ? '<tr><td align="center" style="padding:6px 32px 34px;">' +
        '<a href="' + htmlEscape_(d.signedPdfUrl) + '" ' +
          'style="display:inline-block;background:#1FA7A8;color:#FFFFFF;text-decoration:none;' +
          'font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:15px;padding:14px 30px;' +
          'border-radius:11px;">View Your Signed Agreement</a>' +
      '</td></tr>'
    : '';

  var body =
    '<tr><td style="padding:30px 32px 4px;">' +
      '<div style="font-family:' + MCPS_EMAIL_FB_ + ';font-size:15px;line-height:1.65;color:#3A4645;margin:0 0 18px;">' +
        'Thank you for trusting us with your pool, ' + htmlEscape_(d.firstName) + '. You&rsquo;re set up for ' +
        '<strong style="color:#0D3D3E;">' + htmlEscape_(d.serviceName) + '</strong>: the same technician each ' +
        'visit, water tested and balanced every time, and a service report sent to you afterward so you always ' +
        'know exactly what was done.' +
      '</div>' +
      scheduleCard +
      '<div style="font-family:' + MCPS_EMAIL_FH_ + ';font-weight:bold;font-size:12px;letter-spacing:.14em;' +
        'text-transform:uppercase;color:#0D3D3E;margin:24px 0 4px;">What happens next</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + mcpsEmailSteps_(steps) + '</table>' +
    '</td></tr>';

  return mcpsEmailShell_(
    mcpsEmailHero_({
      headline: 'Welcome to the<br>Mission family.',
      lede: 'Your agreement is signed, ' + htmlEscape_(d.firstName) + ' &mdash; and your pool is officially in good hands.'
    }) + body + cta + mcpsEmailFooter_(),
    'Your agreement is signed. Here is what happens next.'
  );
}

function buildWelcomeEmailText_(d) {
  var co = mcpsEmailCompany_();
  return [
    'WELCOME TO THE MISSION FAMILY',
    '',
    'Thank you for trusting us with your pool, ' + d.firstName + '. You are set up for ' + d.serviceName + ':',
    'the same technician each visit, water tested and balanced every time, and a service report after each visit.',
    '',
    d.serviceDay
      ? 'Your service day: ' + d.serviceDay + (d.techName ? ' (technician: ' + d.techName + ')' : '')
      : 'Your service coordinator will be in touch shortly to confirm your service day and introduce your technician.',
    '',
    'WHAT HAPPENS NEXT',
    d.serviceDay
      ? '1. Your first visit is on the schedule. We will text you when we are on the way.'
      : '1. We schedule your first visit and let you know your service day.',
    '2. Your technician arrives — ' + d.serviceName + ', with a service report after every visit.',
    '3. You relax. Consistent care, transparent pricing, no surprises.',
    '',
    d.signedPdfUrl ? 'Your signed agreement: ' + d.signedPdfUrl : '',
    '',
    'Every pool matters.',
    'Mission Custom Pool Solutions LLC · San Antonio, TX',
    co.website + ' · ' + co.phone
  ].filter(function (line) { return line !== ''; }).join('\n');
}

function sendSignedAgreementWelcomeEmail_(q, proposal, pdf, activate, signatureName) {
  const to = String(value_(q, 'email') || '').trim();
  if (!to) return { ok: false, skipped: true, error: 'Customer email is missing.' };

  const firstName = String(value_(q, 'first_name') || String(signatureName || '').split(' ')[0] || 'there').trim();
  const customerName = [value_(q, 'first_name'), value_(q, 'last_name')].filter(Boolean).join(' ').trim() || signatureName || 'Customer';
  const serviceName = value_(q, 'service') || (proposal && value_(proposal, 'service_type')) || 'Pool Service';
  const signedPdfUrl = (pdf && (pdf.url || pdf.downloadUrl)) || value_(q, 'contract_url') || value_(q, 'contract_download_url') || '';
  const proposalNumber = (proposal && value_(proposal, 'proposal_number')) || value_(q, 'proposal_number') || value_(q, 'quote_id') || '';

  // ⚠️ Re-read the Routes row rather than trusting `q`. `q` was loaded BEFORE
  // activation ran, so it predates the assignment write — using it would render
  // the "we'll be in touch" fallback for every customer while appearing to work.
  const poolId = (activate && activate.pool_id) || value_(q, 'pool_id') || '';
  const schedule = lookupAssignedScheduleForPool_(poolId);

  const d = {
    firstName: firstName,
    customerName: customerName,
    serviceName: serviceName,
    signedPdfUrl: signedPdfUrl,
    serviceDay: schedule.serviceDay,   // '' -> fallback copy (startups, G2C, unassigned)
    techName: schedule.techName,
    techPhotoUrl: schedule.techPhotoUrl,
    techBio: schedule.techBio,
    showPhoto: schedule.showPhoto,
    showBio: schedule.showBio
  };

  const subject = 'Welcome to the Mission family, ' + firstName;
  const htmlBody = buildWelcomeEmailHtml_(d);
  const plainBody = buildWelcomeEmailText_(d);

  const msg = {
    to: to,
    subject: subject,
    htmlBody: htmlBody,
    plainBody: plainBody,
    recipientId: 'signed_welcome_' + String(value_(q, 'quote_id') || proposalNumber || to)
  };

  // Record what we told them, but ONLY once the send actually succeeded — the
  // marker is what makes a later schedule change detectable, and marking an email
  // that never went out would suppress the correction the customer needs.
  const markNotified = function () {
    try {
      if (schedule.serviceDay && typeof recordScheduleNotified_ === 'function') {
        recordScheduleNotified_(poolId, schedule.rawDay || schedule.serviceDay, schedule.techName);
      }
    } catch (e) {
      Logger.log('recordScheduleNotified_ skipped: ' + e);
    }
  };

  if (typeof sendCommsEmail_ === 'function') {
    const res = sendCommsEmail_(msg);
    if (!res || res.ok !== false) markNotified();
    return Object.assign({ sent_to: to }, res);
  }

  const opts = { name: 'Mission Custom Pool Solutions', htmlBody: htmlBody };
  GmailApp.sendEmail(to, subject, plainBody, opts);
  markNotified();
  return { ok: true, provider: 'gmail_fallback', providerMessageId: '', sent_to: to };
}

// Public customer action: accept + e-sign the merged agreement in one step.
// Authenticated by the Proposal_Approvals token (no portal session). On success
// it records the signature audit trail, generates the signed PDF, and activates
// the customer by reusing activateQuoteServiceFromAgreement_ (assigns pool_id,
// sets ACTIVE_CUSTOMER, contract_status=SIGNED, syncs the route schedule).
// ══════════════════════════════════════════════════════════════════════════════
// SHARED SIGNING CORE
//
// Records acceptance, saves the signature image, renders the signed PDF, and
// writes the ESIGN/UETA audit trail onto the agreement row it is GIVEN. Returns
// the artifacts. That is the whole job.
//
// ⚠️ It deliberately does NOT:
//   * activate the customer      (mints pool_id + Routes row — original only)
//   * advance repair work orders (original only)
//   * send the welcome email     (original only — existing customers already had it)
//   * mirror anything onto the QUOTE row
//
// Those live only on the original-signing path, so the amendment path is
// structurally incapable of triggering them. There is deliberately no
// `isAmendment` flag: a flag is how the wrong branch eventually runs, and the
// thing being protected is an executed contract.
// ══════════════════════════════════════════════════════════════════════════════
function signAndRecord_(ctx) {
  var now = ctx.now || nowIso_();
  var sig = ctx.signature || {};
  var out = { pdf: null, signatureUrl: '', signedAt: now, audited: false };

  // Acceptance on the approval + proposal. Both are per-document records, so an
  // amendment updates its OWN approval and proposal, never the parent's.
  if (ctx.approvals && ctx.approval) {
    softSetCell_(ctx.approvals, ctx.approval._rowNum, 'status', 'APPROVED');
    softSetCell_(ctx.approvals, ctx.approval._rowNum, 'customer_note', ctx.note || '');
    softSetCell_(ctx.approvals, ctx.approval._rowNum, 'responded_at', now);
    softSetCell_(ctx.approvals, ctx.approval._rowNum, 'updated_at', now);
  }
  if (ctx.proposals && ctx.proposal) {
    softSetCell_(ctx.proposals, ctx.proposal._rowNum, 'status', 'ACCEPTED');
    softSetCell_(ctx.proposals, ctx.proposal._rowNum, 'accepted_at', now);
    softSetCell_(ctx.proposals, ctx.proposal._rowNum, 'updated_at', now);
  }

  // Signature image (drawn signatures only).
  if (sig.data) {
    try {
      out.signatureUrl = saveProposalImageToDrive_(sig.data, 'sig_' + (ctx.quoteId || 'agreement'));
    } catch (sigErr) {
      Logger.log('signAndRecord_ signature save failed: ' + sigErr);
    }
  }

  // The signed document.
  try {
    out.pdf = renderSignedAgreementPdf_(ctx.quote, ctx.proposal, {
      signatureName: sig.name,
      signatureMethod: sig.method,
      signatureData: sig.data,
      signatureUrl: out.signatureUrl,
      signedAt: now,
      signerIp: sig.ip
    });
  } catch (pdfErr) {
    Logger.log('signAndRecord_ PDF render failed: ' + pdfErr);
  }

  // Audit trail onto the GIVEN row — never one this function looked up itself.
  var row = ctx.agreementRow;
  if (ctx.agreements && row) {
    var sheet = ctx.agreements, n = row._rowNum;
    softSetCell_(sheet, n, 'status', 'SIGNED');
    softSetCell_(sheet, n, 'signed_at', now);
    softSetCell_(sheet, n, 'activated_at', now);
    softSetCell_(sheet, n, 'activation_method', ctx.activationMethod || 'IN_PORTAL_ESIGN');
    if (out.pdf && out.pdf.url) {
      softSetCell_(sheet, n, 'agreement_pdf_url', out.pdf.url);
      softSetCell_(sheet, n, 'contract_url', out.pdf.url);
      softSetCell_(sheet, n, 'contract_file_id', out.pdf.fileId);
      softSetCell_(sheet, n, 'signed_pdf_url', out.pdf.url);
    }
    softSetCell_(sheet, n, 'signature_name', sig.name || '');
    softSetCell_(sheet, n, 'signature_image_url', out.signatureUrl);
    softSetCell_(sheet, n, 'signature_method', sig.method || '');
    softSetCell_(sheet, n, 'signer_ip', sig.ip || '');
    softSetCell_(sheet, n, 'signer_user_agent', sig.userAgent || '');
    softSetCell_(sheet, n, 'consent_accepted', 'TRUE');
    softSetCell_(sheet, n, 'consent_at', now);
    softSetCell_(sheet, n, 'agreement_version', (ctx.proposal && value_(ctx.proposal, 'proposal_number')) || '');
    softSetCell_(sheet, n, 'updated_at', now);
    out.audited = true;
  } else {
    Logger.log('signAndRecord_: no agreement row supplied — audit trail NOT written');
  }

  return out;
}

function handleSignAgreement_(payload) {
  try {
    ensureNormalizedSalesSheets_();
    const token = String(payload.token || '').trim();
    if (!token) return { ok: false, error: 'Signing link is missing a token.' };
    const signatureName = String(payload.signature_name || '').trim();
    const signatureData = String(payload.signature_data || '').trim();
    const signatureMethod = String(payload.signature_method || (signatureData ? 'drawn' : 'typed')).trim().toLowerCase();
    const consent = payload.consent === true || String(payload.consent).toUpperCase() === 'TRUE';
    const note = String(payload.note || '').trim();
    const signerIp = String(payload.signer_ip || '').trim();
    const signerUa = String(payload.signer_user_agent || '').trim();
    if (!consent) return { ok: false, error: 'Please accept the electronic signature consent to continue.' };
    if (!signatureName) return { ok: false, error: 'Please enter your full legal name to sign.' };
    if (signatureMethod === 'drawn' && !signatureData) return { ok: false, error: 'Please draw your signature before signing.' };

    const approvals = ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
    const approval = findRowByValue_(approvals, 'token', token);
    if (!approval) return { ok: false, error: 'This signing link is invalid.' };
    const current = String(value_(approval, 'status') || '').toUpperCase();
    if (current && current !== 'SENT') {
      return { ok: true, already_responded: true, status: current, message: 'This agreement has already been responded to.' };
    }
    if (value_(approval, 'expires_at') && new Date(value_(approval, 'expires_at')).getTime() < new Date().getTime()) {
      softSetCell_(approvals, approval._rowNum, 'status', 'EXPIRED');
      return { ok: false, expired: true, error: 'This signing link has expired.' };
    }

    const proposals = ensureSheet_('Proposals', MCPS_PROPOSAL_HEADERS);
    const proposal = findRowByValue_(proposals, 'proposal_id', approval.proposal_id);
    const hit = getQuoteById_(approval.quote_id);
    if (!proposal || !hit) return { ok: false, error: 'This agreement is no longer available.' };
    const q = hit.object;
    const quoteId = String(approval.quote_id);
    const now = nowIso_();

    // ⚠️ DEFENCE IN DEPTH. An amendment token must never reach the original path.
    // If it did — through a stale page, a replayed request, or a future proxy bug —
    // it would activate the customer a second time, mint another pool_id, create a
    // duplicate Routes row and re-send the welcome email. Fail BEFORE any of the
    // PDF, quote-mirroring or activation work happens.
    if (String(value_(approval, 'target_agreement_id') || '').trim()) {
      return { ok: false, error: 'This is an amendment link. Use the amendment signing flow.' };
    }

    // ── 1. Resolve (or create) the agreement row BEFORE signing ──────────────
    // The audit trail has to be written onto a row that already exists, and
    // activation must REUSE that row rather than create a second one. Doing this
    // first is what makes the id explicit for every step below.
    let agreementId = '';
    try {
      const pre = syncQuoteToNormalized_(quoteId);
      agreementId = (pre && pre.agreement_id) || '';
    } catch (preErr) {
      Logger.log('handleSignAgreement_ pre-sync failed (non-blocking): ' + preErr);
    }
    const agreements = ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS);
    let agreementRow = agreementId ? findRowByValue_(agreements, 'agreement_id', agreementId) : null;
    // ⚠️ Originals only — parent and amendments share a source_quote_id.
    if (!agreementRow) agreementRow = findOriginalAgreementByQuoteStrict_(agreements, quoteId);
    if (agreementRow && !agreementId) agreementId = String(agreementRow.agreement_id || '');

    // ── 2. Sign and record ───────────────────────────────────────────────────
    // Shared with amendment signing. Records acceptance, saves the signature,
    // renders the PDF and writes the ESIGN audit trail — and nothing else.
    const signed = signAndRecord_({
      quote: q, quoteId: quoteId,
      proposal: proposal, proposals: proposals,
      approval: approval, approvals: approvals,
      agreements: agreements, agreementRow: agreementRow,
      signature: {
        name: signatureName, method: signatureMethod, data: signatureData,
        ip: signerIp, userAgent: signerUa
      },
      note: note, now: now, activationMethod: 'IN_PORTAL_ESIGN'
    });
    const pdf = signed.pdf;
    const signatureUrl = signed.signatureUrl;

    // ── 3. Mirror onto the QUOTE ─────────────────────────────────────────────
    // ⚠️ ORIGINAL PATH ONLY, and deliberately outside signAndRecord_. An
    // amendment writing these would repoint the parent quote at the addendum PDF
    // and overwrite its acceptance timestamps.
    softSetCell_(hit.sheet, hit.rowNum, 'proposal_accepted_at', now);
    if (note) softSetCell_(hit.sheet, hit.rowNum, 'proposal_response_note', note);
    if (pdf && pdf.url) {
      softSetCell_(hit.sheet, hit.rowNum, 'contract_generated', 'Yes');
      softSetCell_(hit.sheet, hit.rowNum, 'contract_url', pdf.url);
      softSetCell_(hit.sheet, hit.rowNum, 'contract_download_url', pdf.downloadUrl);
      softSetCell_(hit.sheet, hit.rowNum, 'contract_file_id', pdf.fileId);
    }

    // The customer's PREFERRED start date, if they picked one. Recorded atomically
    // with the signature so there is no orphan write from an abandoned signing.
    // ⚠️ A request only — service_start and billing_start are untouched here and
    // remain admin-set. Confirming this is a separate, deliberate action.
    try {
      const requestedStart = String(payload.requested_start_date || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(requestedStart)) {
        ensureColumn_(hit.sheet, 'requested_start_date');
        ensureColumn_(hit.sheet, 'requested_start_at');
        softSetCell_(hit.sheet, hit.rowNum, 'requested_start_date', requestedStart);
        softSetCell_(hit.sheet, hit.rowNum, 'requested_start_at', now);
      }

      // The weekday we actually SHOWED them, stored separately from the date.
      // Not redundant: if an admin later shifts the date, the promise we made
      // was the day.
      const committedDay = String(payload.committed_service_day || '').trim().toUpperCase();
      if (/^(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)$/.test(committedDay)) {
        ensureColumn_(hit.sheet, 'committed_service_day');
        softSetCell_(hit.sheet, hit.rowNum, 'committed_service_day', committedDay);
      }

      // ⚠️ PREFERRED-WEEK MODE. The customer was shown NO service day, so there
      // is no promise here — only a week, plus the date they happened to click.
      //
      // The hint is stored under its own name and is deliberately NOT written to
      // requested_start_date. addWeeklyPoolToRoutes_ derives preferredDay from
      // requested_start_date, so putting the hint there would silently convert a
      // "some time that week" into a hard weekday commitment the customer was
      // never offered.
      const requestedWeek = String(payload.requested_start_week || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(requestedWeek)) {
        ensureColumn_(hit.sheet, 'requested_start_week');
        ensureColumn_(hit.sheet, 'requested_start_at');
        softSetCell_(hit.sheet, hit.rowNum, 'requested_start_week', requestedWeek);
        softSetCell_(hit.sheet, hit.rowNum, 'requested_start_at', now);

        const hint = String(payload.requested_start_date_hint || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(hint)) {
          ensureColumn_(hit.sheet, 'requested_start_date_hint');
          softSetCell_(hit.sheet, hit.rowNum, 'requested_start_date_hint', hint);
        }
      }
    } catch (startErr) {
      Logger.log('requested_start_date persist failed (non-blocking): ' + startErr);
    }

    // ── 4. Activate the customer ─────────────────────────────────────────────
    // ⚠️ ORIGINAL PATH ONLY. Mints pool_id and creates the Routes row; running it
    // for an amendment would produce a duplicate pool and a phantom route stop.
    // The explicit agreementId makes it reuse the row from step 1.
    const activate = activateQuoteServiceFromAgreement_(quoteId, now, 'IN_PORTAL_ESIGN', agreementId);

    // 7. Advance any repair work orders tied to this quote
    try { markRepairOrdersApprovedForQuote_(quoteId); } catch (roErr) { Logger.log('markRepairOrdersApprovedForQuote_: ' + roErr); }

    // 8. Send a branded welcome email. Non-blocking: signing/activation should
    // stay complete even if the email provider is temporarily unavailable.
    let welcomeEmail = { ok: false, skipped: true, error: 'Not attempted.' };
    try {
      welcomeEmail = sendSignedAgreementWelcomeEmail_(q, proposal, pdf, activate, signatureName);
      if (!welcomeEmail.ok) Logger.log('sendSignedAgreementWelcomeEmail_: ' + (welcomeEmail.error || 'failed'));
    } catch (welcomeErr) {
      welcomeEmail = { ok: false, skipped: false, error: String(welcomeErr) };
      Logger.log('sendSignedAgreementWelcomeEmail_ exception: ' + welcomeErr);
    }

    return {
      ok: true,
      status: 'SIGNED',
      signed_pdf_url: (pdf && pdf.url) || '',
      pool_id: (activate && activate.pool_id) || '',
      customer_name: signatureName,
      welcome_email_sent: !!welcomeEmail.ok,
      welcome_email_error: welcomeEmail.ok ? '' : (welcomeEmail.error || '')
    };
  } catch (e) {
    return { ok: false, error: 'handleSignAgreement_ Error: ' + e.toString() };
  }
}

function blobToDataUri_(blob) {
  if (!blob) return '';
  const contentType = blob.getContentType() || 'image/png';
  return 'data:' + contentType + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

function fetchImageAsDataUri_(url) {
  if (!url) return '';
  if (String(url).indexOf('data:image/') === 0) return String(url);
  try {
    return blobToDataUri_(UrlFetchApp.fetch(String(url), { muteHttpExceptions: true }).getBlob());
  } catch(e) {
    Logger.log('fetchImageAsDataUri_ failed for ' + url + ': ' + e);
    return '';
  }
}

function getProposalLogoDataUri_(props) {
  const fileId = props.getProperty('PROPOSAL_LOGO_FILE_ID');
  if (fileId) {
    try {
      return blobToDataUri_(DriveApp.getFileById(fileId).getBlob());
    } catch(e) {
      Logger.log('PROPOSAL_LOGO_FILE_ID failed: ' + e);
    }
  }
  return fetchImageAsDataUri_(props.getProperty('PROPOSAL_LOGO_URL') ||
    'https://mcps-log.vercel.app/logo.png');
}

function saveProposalImageToDrive_(dataUrl, quoteId) {
  if (!dataUrl) return '';
  const folderId = PropertiesService.getScriptProperties().getProperty('PROPOSAL_FOLDER_ID') ||
    PropertiesService.getScriptProperties().getProperty('CONTRACT_FOLDER_ID');
  if (!folderId) throw new Error('PROPOSAL_FOLDER_ID or CONTRACT_FOLDER_ID not set in Script Properties.');
  const match = String(dataUrl).match(/^data:([A-Za-z0-9_\-+\/.]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid proposal image payload.');
  const mimeType = match[1] || 'image/jpeg';
  const ext = mimeType.indexOf('png') !== -1 ? 'png' : 'jpg';
  const blob = Utilities.newBlob(Utilities.base64Decode(match[2]), mimeType, 'proposal_pool_' + quoteId + '.' + ext);
  const folder = DriveApp.getFolderById(folderId);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://lh3.googleusercontent.com/d/' + file.getId();
}

function appendProposalSection_(body, title) {
  const p = body.appendParagraph(title);
  p.setBackgroundColor('#00515b');
  p.setSpacingBefore(10);
  p.setSpacingAfter(6);
  p.editAsText().setForegroundColor('#ffffff').setBold(true).setFontSize(11);
  return p;
}

function handleGenerateProposal_(payload) {
  try {
    ensureNormalizedSalesSheets_();
    const quoteId = String(payload.quote_id || '').trim();
    if (!quoteId) return { ok: false, error: 'quote_id required' };
    const sync = syncQuoteToNormalized_(quoteId);
    const hit = getQuoteById_(quoteId);
    if (!hit) return { ok: false, error: 'Quote not found: ' + quoteId };
    const q = hit.object;

    const proposals = ensureSheet_('Proposals', MCPS_PROPOSAL_HEADERS);
    const proposal = findRowByValue_(proposals, 'proposal_id', sync.proposal_id);
    if (!proposal) return { ok: false, error: 'Proposal not found for quote ' + quoteId };

    // Freeze the scope that this PDF is about to show onto the quote, so the
    // signing page and the signed contract render the identical list. When the
    // caller supplies scope explicitly it wins (the admin may have just edited
    // it); otherwise whatever is already stored stands.
    try {
      const resolvedScope = resolveScopeItemsJson_(
        Object.assign({}, payload, { service: value_(q, 'service'), spa: value_(q, 'spa') })
      );
      if (resolvedScope) {
        ensureColumn_(hit.sheet, 'scope_items_json');
        softSetCell_(hit.sheet, hit.rowNum, 'scope_items_json', resolvedScope);
        q.scope_items_json = resolvedScope;   // so this render uses it immediately
      }
    } catch (scopeErr) {
      Logger.log('Scope persist on generate failed (non-blocking): ' + scopeErr);
    }

    let imageUrl = value_(proposal, 'proposal_image_url');
    let imageDataUri = '';
    if (payload.proposal_image_data_url) {
      imageDataUri = String(payload.proposal_image_data_url);
      imageUrl = saveProposalImageToDrive_(payload.proposal_image_data_url, quoteId);
      softSetCell_(proposals, proposal._rowNum, 'proposal_image_url', imageUrl);
      softSetCell_(hit.sheet, hit.rowNum, 'proposal_image_url', imageUrl);
    }

    const props = PropertiesService.getScriptProperties();
    const folderId = props.getProperty('PROPOSAL_FOLDER_ID') || props.getProperty('CONTRACT_FOLDER_ID');
    if (!folderId) return { ok: false, error: 'PROPOSAL_FOLDER_ID or CONTRACT_FOLDER_ID not set in Script Properties.' };
    const folder = DriveApp.getFolderById(folderId);
    const tz = Session.getScriptTimeZone();
    const now = new Date();
    const valid = new Date(now.getTime());
    valid.setDate(valid.getDate() + 30);
    const fullName = [value_(q, 'first_name'), value_(q, 'last_name')].filter(Boolean).join(' ').trim() || 'Customer';
    const fileName = 'Proposal - ' + fullName + ' - ' + proposal.proposal_number;
    if (!imageDataUri && imageUrl) imageDataUri = fetchImageAsDataUri_(imageUrl);

    const serviceName = value_(q, 'service') || 'Pool Service';
    const rate = value_(q, 'discounted_service_subtotal') || value_(q, 'quote_subtotal') || value_(q, 'service_subtotal');
    const templateHtml = HtmlService.createHtmlOutputFromFile('ProposalTemplate').getContent();
    const renderedHtml = replaceProposalPlaceholders_(templateHtml, {
      proposal_number: proposal.proposal_number,
      proposal_date: Utilities.formatDate(now, tz, 'MM/dd/yyyy'),
      valid_until: Utilities.formatDate(valid, tz, 'MM/dd/yyyy'),
      logo_url: getProposalLogoDataUri_(props),
      pool_image_url: imageDataUri || '',
      client_name: fullName,
      service_address: value_(q, 'address'),
      city_state_zip: [value_(q, 'city'), value_(q, 'zip_code')].filter(Boolean).join(', '),
      phone: value_(q, 'phone'),
      email: value_(q, 'email'),
      project_summary: payload.project_summary ||
        'Thank you for the opportunity to provide you with a custom pool care solution. Below is our recommended plan to keep your pool clean, safe, and always ready to enjoy.',
      service_type: serviceName,
      pool_specs: value_(q, 'specs_summary'),
      subtotal: mcpsMoney_(value_(q, 'service_subtotal')),
      discount_amount: mcpsMoney_(value_(q, 'discount_amount')),
      travel_fee: mcpsMoney_(value_(q, 'travel_fee')),
      sales_tax: mcpsMoney_(value_(q, 'sales_tax')),
      total: mcpsMoney_(value_(q, 'total_with_tax')),
      investment: mcpsMoney_(rate) + (serviceName.toLowerCase().indexOf('weekly') !== -1 ? ' / MONTH' : ''),
      company_phone: props.getProperty('MCPS_COMPANY_PHONE') || '(210) 559-2073',
      company_email: props.getProperty('MCPS_COMPANY_EMAIL') || 'mauricio@mcpoolsolutions.org',
      company_website: props.getProperty('MCPS_COMPANY_WEBSITE') || 'missioncustompools.com'
    }, {
      scope_of_work: buildProposalScopeHtml_(serviceName, q, payload.proposal_scope_options || {}),
      service_plan_rows: buildProposalServiceRowsHtml_(serviceName, rate, q, payload.proposal_plan_options || {}),
      proposal_items: buildProposalItemsHtml_(q)
    });

    const htmlBlob = Utilities.newBlob(renderedHtml, 'text/html', fileName + '.html');
    const htmlFile = folder.createFile(htmlBlob);
    const pdf = htmlFile.getAs(MimeType.PDF).setName(fileName + '.pdf');
    const pdfFile = folder.createFile(pdf);
    pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    htmlFile.setTrashed(true);

    const url = pdfFile.getUrl();
    softSetCell_(proposals, proposal._rowNum, 'proposal_pdf_url', url);
    softSetCell_(proposals, proposal._rowNum, 'status', 'GENERATED');
    softSetCell_(proposals, proposal._rowNum, 'valid_until', Utilities.formatDate(valid, tz, 'yyyy-MM-dd'));
    softSetCell_(proposals, proposal._rowNum, 'updated_at', nowIso_());
    softSetCell_(hit.sheet, hit.rowNum, 'proposal_pdf_url', url);
    softSetCell_(hit.sheet, hit.rowNum, 'proposal_number', proposal.proposal_number);
    return { ok: true, proposal_pdf_url: url, proposal_number: proposal.proposal_number, proposal_id: proposal.proposal_id, proposal_image_url: imageUrl };
  } catch(e) {
    return { ok: false, error: 'handleGenerateProposal_ Error: ' + e.toString() };
  }
}
function handleGetWeeklyGoal_() {
  const cache    = CacheService.getScriptCache();
  const cacheKey = 'weekly_goal';
  const cached   = cache.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch(e) {} }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const settings = ss.getSheetByName("Settings");
    const goal = settings ? Number(settings.getRange("A2").getValue()) : 5;

    const quotesSheet = getCrmSheet_();
    const data = quotesSheet.getDataRange().getValues();
    const headers = data.shift();

    const signedAtIdx = headers.map(h => String(h).toLowerCase().trim()).indexOf('signed_at');

    const now = new Date();
    const startOfWeek = new Date(now);
    const day = now.getDay();
    startOfWeek.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    startOfWeek.setHours(0, 0, 0, 0);

    const signedCount = data.filter(r => {
      const signedDate = signedAtIdx !== -1 && r[signedAtIdx] ? new Date(r[signedAtIdx]) : null;
      return signedDate && signedDate >= startOfWeek;
    }).length;

    const result = { ok: true, goal: goal, signed_this_week: signedCount };
    try { cache.put(cacheKey, JSON.stringify(result), 120); } catch(e) {}
    return result;
  } catch (e) {
    return { ok: false, error: e.toString() };
  }
}

// Make sure handleSalesHubFetch also uses the CRM sheet
function handleSalesHubFetch_() {
  try {
    const crmSS = getCrmSpreadsheet_();
    const sheet = crmSS.getSheetByName("Quotes");
    
    const data = sheet.getDataRange().getValues();
    const headers = data.shift();

    // Helper to find column index
    const getIdx = (name) => headers.map(h => String(h).toLowerCase().trim()).indexOf(name.toLowerCase());

    const results = data.map((row, i) => ({
      id: row[getIdx('quote_id')],
      name: row[getIdx('first_name')] + " " + row[getIdx('last_name')],
      status: row[getIdx('status')],
      area: row[getIdx('area')],
      email: row[getIdx('email')],
      phone: row[getIdx('phone')],
      address: row[getIdx('address')]
    }));

    return { ok: true, data: results };
  } catch (e) {
    return { ok: false, error: "Fetch Error: " + e.toString() };
  }
}
// Helper to find column index by name (case-insensitive)
function getColIdx_(headers, name) {
  const idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(name.toLowerCase().trim());
  if (idx === -1) throw new Error("Missing column: " + name);
  return idx;
}

function mapProposalStatus_(legacyStatus) {
  const s = String(legacyStatus || '').trim().toUpperCase();
  if (s === 'SENT') return 'SENT';
  if (s === 'SIGNED') return 'ACCEPTED';
  if (s === 'LOST') return 'DECLINED';
  if (s === 'ACTIVE_CUSTOMER') return 'CONVERTED_TO_SERVICE';
  if (s === 'COMPLETED_JOB' || s === 'COMPLETED') return 'CONVERTED_TO_INVOICE';
  if (s === 'EXPIRED') return 'EXPIRED';
  if (s === 'DRAFT') return 'DRAFT';
  return 'GENERATED';
}

function mapServiceStatus_(legacyStatus) {
  const s = String(legacyStatus || '').trim().toUpperCase();
  if (s === 'ACTIVE_CUSTOMER' || s === 'SIGNED') return 'ACTIVE';
  if (s === 'LOST') return 'CANCELLED';
  if (s === 'COMPLETED_JOB' || s === 'COMPLETED') return 'COMPLETED';
  if (s === 'PAUSED') return 'PAUSED';
  return 'PENDING';
}

function mapAgreementStatusFromQuote_(q) {
  const signedAt = value_(q, 'signed_at');
  const status = String(value_(q, 'status')).trim().toUpperCase();
  const contractStatus = String(value_(q, 'contract_status')).trim().toUpperCase();
  const sentAt = value_(q, 'sent_at') || value_(q, 'send_contract_at');
  const signatureRequired = String(value_(q, 'signature_required', 'TRUE')).toUpperCase();
  if (signatureRequired === 'FALSE') return 'NOT_REQUIRED';
  if (signedAt || status === 'SIGNED' || status === 'ACTIVE_CUSTOMER') return 'SIGNED';
  if (status === 'LOST') return 'DECLINED';
  if (sentAt || status === 'SENT') return 'SENT';
  if (contractStatus === 'CONTRACT_GENERATED' || value_(q, 'contract_url')) return 'GENERATED';
  return 'DRAFT';
}

function defaultActivationMethodFromQuote_(q) {
  const explicit = String(value_(q, 'activation_method')).trim();
  if (explicit) return explicit;
  const service = String(value_(q, 'service')).toLowerCase();
  const signatureRequired = String(value_(q, 'signature_required', 'TRUE')).toUpperCase();
  if (signatureRequired === 'FALSE') return 'ADMIN_OVERRIDE';
  if (service.indexOf('startup') !== -1) return 'STARTUP_AUTO';
  if (service.indexOf('green') !== -1) return 'GTC_AUTO';
  if (String(value_(q, 'sales_flow')).toUpperCase() === 'AGREEMENT_DIRECT') return 'AGREEMENT_DIRECT';
  return 'SIGNED_AGREEMENT';
}

// ⚠️ One place decides what an amendment is. Blank type = original, because every
// row written before amendments existed carries no type.
function isAmendmentRow_(agreement) {
  return String(value_(agreement, 'agreement_type') || '').trim().toLowerCase() === 'amendment';
}

function agreementCanActivate_(agreement) {
  // ⚠️ An amendment can be perfectly valid and SIGNED and still must never
  // activate — activation is for a NEW service, and an amendment changes one that
  // already exists. Without this, a signed amendment passed the status check.
  if (isAmendmentRow_(agreement)) return false;
  const status = String(value_(agreement, 'status')).toUpperCase();
  const sigReq = String(value_(agreement, 'signature_required', 'TRUE')).toUpperCase();
  const method = String(value_(agreement, 'activation_method')).toUpperCase();
  return status === 'SIGNED' || sigReq === 'FALSE' ||
    ['ADMIN_OVERRIDE', 'STARTUP_AUTO', 'GTC_AUTO'].indexOf(method) !== -1;
}

function quoteObjectFromRow_(headers, row, rowNum) {
  const obj = { _rowNum: rowNum || null };
  headers.forEach(function(h, i) {
    const key = normalizeHeader_(h);
    if (key) obj[key] = row[i];
  });
  return obj;
}

function getQuoteById_(quoteId) {
  const sheet = getCrmSheet_();
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;
  const headers = data[0];
  const qIdx = headerIndex_(headers, 'quote_id');
  if (qIdx === -1) return null;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][qIdx] || '').trim() === String(quoteId || '').trim()) {
      return { sheet: sheet, headers: headers, row: data[i], rowNum: i + 1, object: quoteObjectFromRow_(headers, data[i], i + 1) };
    }
  }
  return null;
}

function getQuoteByPoolId_(poolId) {
  const sheet = getCrmSheet_();
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;
  const headers = data[0];
  const pIdx = headerIndex_(headers, 'pool_id');
  if (pIdx === -1) return null;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][pIdx] || '').trim() === String(poolId || '').trim()) {
      return { sheet: sheet, headers: headers, row: data[i], rowNum: i + 1, object: quoteObjectFromRow_(headers, data[i], i + 1) };
    }
  }
  return null;
}

function findClientForQuote_(q) {
  const clients = ensureSheet_('Clients', MCPS_CLIENT_HEADERS);
  const snap = sheetToObjects_(clients);
  const email = normalizeEmail_(value_(q, 'email'));
  const phone = normalizePhone_(value_(q, 'phone'));
  const first = String(value_(q, 'first_name')).trim().toLowerCase();
  const last = String(value_(q, 'last_name')).trim().toLowerCase();
  const addr = normalizeAddress_(value_(q, 'address'));
  const zip = String(value_(q, 'zip_code')).trim();

  if (email) {
    const hit = snap.rows.find(function(r) { return normalizeEmail_(r.email) === email; });
    if (hit) return hit;
  }
  if (phone) {
    const hit = snap.rows.find(function(r) { return normalizePhone_(r.phone) === phone; });
    if (hit) return hit;
  }
  if (first || last) {
    const locations = sheetToObjects_(ensureSheet_('Client_Locations', MCPS_LOCATION_HEADERS)).rows;
    const hit = snap.rows.find(function(c) {
      const sameName = String(c.first_name || '').trim().toLowerCase() === first &&
        String(c.last_name || '').trim().toLowerCase() === last;
      if (!sameName) return false;
      return locations.some(function(l) {
        return String(l.client_id || '') === String(c.client_id || '') &&
          normalizeAddress_(l.service_address) === addr &&
          String(l.zip_code || '').trim() === zip;
      });
    });
    if (hit) return hit;
  }
  return null;
}

function findOrCreateClientFromQuote_(q) {
  const clients = ensureSheet_('Clients', MCPS_CLIENT_HEADERS);
  const quoteId = String(value_(q, 'quote_id')).trim();
  const now = nowIso_();

  const explicitId = String(value_(q, 'client_id')).trim();
  if (explicitId) {
    const explicit = findRowByValue_(clients, 'client_id', explicitId);
    if (explicit) {
      softSetCell_(clients, explicit._rowNum, 'updated_at', now);
      softSetCell_(clients, explicit._rowNum, 'legacy_quote_ids', uniqueJsonPush_(explicit.legacy_quote_ids, quoteId));
      return String(explicit.client_id);
    }
  }

  const existing = findClientForQuote_(q);
  if (existing) {
    softSetCell_(clients, existing._rowNum, 'updated_at', now);
    softSetCell_(clients, existing._rowNum, 'legacy_quote_ids', uniqueJsonPush_(existing.legacy_quote_ids, quoteId));
    if (String(value_(q, 'status')).toUpperCase() === 'ACTIVE_CUSTOMER') softSetCell_(clients, existing._rowNum, 'status', 'active');
    if (!existing.email && value_(q, 'email')) softSetCell_(clients, existing._rowNum, 'email', value_(q, 'email'));
    if (!existing.phone && value_(q, 'phone')) softSetCell_(clients, existing._rowNum, 'phone', value_(q, 'phone'));
    return String(existing.client_id);
  }

  const first = String(value_(q, 'first_name')).trim();
  const last = String(value_(q, 'last_name')).trim();
  const status = String(value_(q, 'status')).toUpperCase() === 'ACTIVE_CUSTOMER' ? 'active' : 'prospect';
  const clientId = nextSequence_(clients, 'client_id', 'CLI', 6);
  appendObject_(clients, {
    client_id: clientId,
    first_name: first,
    last_name: last,
    display_name: [first, last].filter(Boolean).join(' ').trim(),
    email: value_(q, 'email'),
    phone: value_(q, 'phone'),
    billing_address: '',
    billing_city: '',
    billing_state: '',
    billing_zip: '',
    status: status,
    created_at: now,
    updated_at: now,
    legacy_quote_ids: JSON.stringify(quoteId ? [quoteId] : []),
    notes: ''
  }, MCPS_CLIENT_HEADERS);
  return clientId;
}

function findLocationForQuote_(clientId, q) {
  const locations = ensureSheet_('Client_Locations', MCPS_LOCATION_HEADERS);
  const rows = sheetToObjects_(locations).rows;
  const addr = normalizeAddress_(value_(q, 'address'));
  const zip = String(value_(q, 'zip_code')).trim();
  const poolId = String(value_(q, 'pool_id')).trim();

  const byAddress = rows.find(function(r) {
    return String(r.client_id || '') === String(clientId) &&
      normalizeAddress_(r.service_address) === addr &&
      String(r.zip_code || '').trim() === zip;
  });
  if (byAddress) return byAddress;

  if (poolId) {
    const poolHits = rows.filter(function(r) { return String(r.pool_id || '').trim() === poolId; });
    if (poolHits.length === 1) return poolHits[0];
  }
  return null;
}

function findOrCreateLocationFromQuote_(clientId, q) {
  const locations = ensureSheet_('Client_Locations', MCPS_LOCATION_HEADERS);
  const now = nowIso_();

  const explicitId = String(value_(q, 'location_id')).trim();
  if (explicitId) {
    const explicit = findRowByValue_(locations, 'location_id', explicitId);
    if (explicit && String(explicit.client_id) === String(clientId)) {
      softSetCell_(locations, explicit._rowNum, 'updated_at', now);
      return String(explicit.location_id);
    }
  }

  const existing = findLocationForQuote_(clientId, q);
  if (existing) {
    if (!existing.pool_id && value_(q, 'pool_id')) softSetCell_(locations, existing._rowNum, 'pool_id', value_(q, 'pool_id'));
    softSetCell_(locations, existing._rowNum, 'updated_at', now);
    return String(existing.location_id);
  }

  const locationId = nextSequence_(locations, 'location_id', 'LOC', 6);
  appendObject_(locations, {
    location_id: locationId,
    client_id: clientId,
    pool_id: value_(q, 'pool_id'),
    service_address: value_(q, 'address'),
    city: value_(q, 'city'),
    state: 'TX',
    zip_code: value_(q, 'zip_code'),
    area: value_(q, 'area'),
    pool_type: value_(q, 'pool_type'),
    pool_size: value_(q, 'size'),
    material: value_(q, 'material'),
    spa: value_(q, 'spa'),
    finish: value_(q, 'finish'),
    debris_level: value_(q, 'debris'),
    sun_exposure: value_(q, 'high_sun_exposure'),
    pets_on_property: value_(q, 'has_pets'),
    robot_on_site: value_(q, 'has_robot'),
    year_built: value_(q, 'year_built'),
    active: String(value_(q, 'status')).toUpperCase() === 'ACTIVE_CUSTOMER' ? 'TRUE' : '',
    created_at: now,
    updated_at: now,
    notes: ''
  }, MCPS_LOCATION_HEADERS);
  return locationId;
}

function findOrCreateProposalFromQuote_(clientId, locationId, q) {
  const proposals = ensureSheet_('Proposals', MCPS_PROPOSAL_HEADERS);
  const quoteId = String(value_(q, 'quote_id')).trim();
  const existing = quoteId ? findRowByValue_(proposals, 'legacy_quote_id', quoteId) : null;
  const now = nowIso_();
  if (existing) {
    let proposalStatus = mapProposalStatus_(value_(q, 'status'));
    if (value_(q, 'proposal_accepted_at') && String(value_(q, 'status')).toUpperCase() !== 'ACTIVE_CUSTOMER') proposalStatus = 'ACCEPTED';
    if (value_(q, 'proposal_declined_at')) proposalStatus = 'DECLINED';
    softSetCell_(proposals, existing._rowNum, 'client_id', clientId);
    softSetCell_(proposals, existing._rowNum, 'location_id', locationId);
    softSetCell_(proposals, existing._rowNum, 'status', proposalStatus);
    softSetCell_(proposals, existing._rowNum, 'service_type', value_(q, 'service'));
    softSetCell_(proposals, existing._rowNum, 'travel_fee', value_(q, 'travel_fee'));
    softSetCell_(proposals, existing._rowNum, 'subtotal', value_(q, 'service_subtotal'));
    softSetCell_(proposals, existing._rowNum, 'discount_type', value_(q, 'discount_type'));
    softSetCell_(proposals, existing._rowNum, 'discount_value', value_(q, 'discount_value'));
    softSetCell_(proposals, existing._rowNum, 'discount_amount', value_(q, 'discount_amount'));
    softSetCell_(proposals, existing._rowNum, 'discounted_subtotal', value_(q, 'discounted_service_subtotal'));
    softSetCell_(proposals, existing._rowNum, 'sales_tax', value_(q, 'sales_tax'));
    softSetCell_(proposals, existing._rowNum, 'total', value_(q, 'total_with_tax'));
    softSetCell_(proposals, existing._rowNum, 'contract_url', value_(q, 'contract_url'));
    softSetCell_(proposals, existing._rowNum, 'sent_at', value_(q, 'proposal_sent_at') || value_(q, 'sent_at') || value_(q, 'send_contract_at'));
    softSetCell_(proposals, existing._rowNum, 'accepted_at', value_(q, 'proposal_accepted_at') || value_(q, 'signed_at'));
    softSetCell_(proposals, existing._rowNum, 'declined_at', value_(q, 'proposal_declined_at') || value_(q, 'lost_at'));
    softSetCell_(proposals, existing._rowNum, 'converted_at', String(value_(q, 'status')).toUpperCase() === 'ACTIVE_CUSTOMER' ? now : value_(existing, 'converted_at'));
    softSetCell_(proposals, existing._rowNum, 'notes', value_(q, 'notes'));
    softSetCell_(proposals, existing._rowNum, 'updated_at', now);
    return { proposal_id: String(existing.proposal_id), proposal_number: String(existing.proposal_number) };
  }

  const proposalId = nextSequence_(proposals, 'proposal_id', 'PRP', 6);
  const proposalNumber = nextSequence_(proposals, 'proposal_number', 'PRO', 4);
  const createdAt = value_(q, 'timestamp') || now;
  let initialProposalStatus = mapProposalStatus_(value_(q, 'status'));
  if (value_(q, 'proposal_accepted_at') && String(value_(q, 'status')).toUpperCase() !== 'ACTIVE_CUSTOMER') initialProposalStatus = 'ACCEPTED';
  if (value_(q, 'proposal_declined_at')) initialProposalStatus = 'DECLINED';
  appendObject_(proposals, {
    proposal_id: proposalId,
    proposal_number: proposalNumber,
    legacy_quote_id: quoteId,
    client_id: clientId,
    location_id: locationId,
    status: initialProposalStatus,
    service_type: value_(q, 'service'),
    proposal_title: value_(q, 'service') || 'Pool Service Proposal',
    created_by: value_(q, 'created_by'),
    quote_source: value_(q, 'quote_source'),
    quote_version: value_(q, 'quote_version'),
    valid_until: '',
    travel_fee: value_(q, 'travel_fee'),
    travel_one_way_miles: value_(q, 'travel_one_way_miles'),
    travel_round_trip_miles: value_(q, 'travel_round_trip_miles'),
    travel_billable_round_trip_miles: value_(q, 'travel_billable_round_trip_miles'),
    distance_source: value_(q, 'distance_source'),
    subtotal: value_(q, 'service_subtotal'),
    discount_type: value_(q, 'discount_type'),
    discount_value: value_(q, 'discount_value'),
    discount_amount: value_(q, 'discount_amount'),
    discounted_subtotal: value_(q, 'discounted_service_subtotal'),
    tax_rate: MCPS_TAX_RATE,
    sales_tax: value_(q, 'sales_tax'),
    total: value_(q, 'total_with_tax'),
    chem_cost_est: value_(q, 'chem_cost_est'),
    net_profit_est: value_(q, 'net_profit_est'),
    margin_percent: value_(q, 'margin_percent'),
    specs_summary: value_(q, 'specs_summary'),
    proposal_pdf_url: '',
    contract_url: value_(q, 'contract_url'),
    sent_at: value_(q, 'proposal_sent_at') || value_(q, 'sent_at') || value_(q, 'send_contract_at'),
    accepted_at: value_(q, 'proposal_accepted_at') || value_(q, 'signed_at'),
    declined_at: value_(q, 'proposal_declined_at') || value_(q, 'lost_at'),
    expired_at: '',
    converted_at: String(value_(q, 'status')).toUpperCase() === 'ACTIVE_CUSTOMER' ? now : '',
    created_at: createdAt,
    updated_at: now,
    notes: value_(q, 'notes')
  }, MCPS_PROPOSAL_HEADERS);
  return { proposal_id: proposalId, proposal_number: proposalNumber };
}

function createProposalItemsIfMissing_(proposalId, q) {
  const itemsSheet = ensureSheet_('Proposal_Items', MCPS_PROPOSAL_ITEM_HEADERS);
  const existing = sheetToObjects_(itemsSheet).rows.some(function(r) {
    return String(r.proposal_id || '') === String(proposalId);
  });
  if (existing) return;

  const now = nowIso_();
  const qbNames = String(value_(q, 'quickbooks_item_names')).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  const qbSkus = String(value_(q, 'quickbooks_skus')).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  let sort = 1;
  const add = function(lineType, name, description, qty, rate, amount, taxable, sku, qbName) {
    appendObject_(itemsSheet, {
      proposal_item_id: nextSequence_(itemsSheet, 'proposal_item_id', 'PIT', 6),
      proposal_id: proposalId,
      line_type: lineType,
      product_service_name: name,
      description: description || '',
      quantity: qty,
      rate: rate,
      amount: amount,
      taxable: taxable ? 'TRUE' : 'FALSE',
      quickbooks_sku: sku || '',
      quickbooks_item_name: qbName || name,
      sort_order: sort++,
      created_at: now,
      updated_at: now
    }, MCPS_PROPOSAL_ITEM_HEADERS);
  };

  const serviceName = value_(q, 'service') || qbNames[0] || 'Pool Service';
  const serviceAmount = number_(value_(q, 'service_subtotal'));
  if (serviceAmount || serviceName) {
    add('service', serviceName, value_(q, 'specs_summary'), 1, serviceAmount, serviceAmount, true, qbSkus[0], qbNames[0]);
  }

  const travel = number_(value_(q, 'travel_fee'));
  if (travel > 0) add('fee', 'Travel Fee', value_(q, 'distance_source'), 1, travel, travel, true, '', 'Travel Fee');

  const discount = number_(value_(q, 'discount_amount'));
  if (discount > 0) add('discount', 'Discount', value_(q, 'discount_type'), 1, -discount, -discount, false, '', 'Discount');
}

function shouldCreateServiceAccountFromQuote_(q) {
  const status = String(value_(q, 'status')).trim().toUpperCase();
  const service = String(value_(q, 'service')).trim().toLowerCase();
  const poolId = String(value_(q, 'pool_id')).trim();
  if (!poolId) return false;
  return status === 'ACTIVE_CUSTOMER' || status === 'SIGNED' ||
    service.indexOf('startup') !== -1 || service.indexOf('green') !== -1 ||
    service.indexOf('repair') !== -1;
}

function findOrCreateServiceAccountFromQuote_(clientId, locationId, proposalId, q, agreementId) {
  if (!shouldCreateServiceAccountFromQuote_(q)) return '';
  const services = ensureSheet_('Service_Accounts', MCPS_SERVICE_ACCOUNT_HEADERS);
  const quoteId = String(value_(q, 'quote_id')).trim();
  // ⚠️ This is Service_ACCOUNTS, not Service_Agreements — it has no
  // agreement_type column, so the originals-only filter used elsewhere does not
  // apply here. The guarantee is structural instead: amendments never call this.
  // Only activateQuoteServiceFromAgreement_ reaches it, and the amendment signing
  // path never invokes activation. The negative test asserts zero calls.
  const existing = quoteId ? findRowByValue_(services, 'source_quote_id', quoteId) : null;
  const now = nowIso_();
  if (existing) {
    softSetCell_(services, existing._rowNum, 'client_id', clientId);
    softSetCell_(services, existing._rowNum, 'location_id', locationId);
    softSetCell_(services, existing._rowNum, 'source_proposal_id', proposalId);
    if (agreementId) softSetCell_(services, existing._rowNum, 'source_agreement_id', agreementId);
    softSetCell_(services, existing._rowNum, 'pool_id', value_(q, 'pool_id'));
    softSetCell_(services, existing._rowNum, 'status', mapServiceStatus_(value_(q, 'status')));
    softSetCell_(services, existing._rowNum, 'invoice_day', value_(q, 'invoice_day'));
    softSetCell_(services, existing._rowNum, 'billing_start', value_(q, 'billing_start'));
    softSetCell_(services, existing._rowNum, 'monthly_rate', value_(q, 'discounted_service_subtotal') || value_(q, 'quote_subtotal'));
    softSetCell_(services, existing._rowNum, 'service_end', value_(q, 'service_end'));
    softSetCell_(services, existing._rowNum, 'payment_log', value_(q, 'payment_log'));
    softSetCell_(services, existing._rowNum, 'contract_status', value_(q, 'contract_status'));
    softSetCell_(services, existing._rowNum, 'contract_url', value_(q, 'contract_url'));
    softSetCell_(services, existing._rowNum, 'updated_at', now);
    return String(existing.service_account_id);
  }

  const service = String(value_(q, 'service')).trim();
  const serviceLower = service.toLowerCase();
  const serviceId = nextSequence_(services, 'service_account_id', 'SVC', 6);
  appendObject_(services, {
    service_account_id: serviceId,
    client_id: clientId,
    location_id: locationId,
    source_proposal_id: proposalId,
    source_agreement_id: agreementId || '',
    source_quote_id: quoteId,
    pool_id: value_(q, 'pool_id'),
    service_type: service,
    service_name: service || 'Pool Service',
    status: mapServiceStatus_(value_(q, 'status')),
    schedule_type: serviceLower.indexOf('weekly') !== -1 ? 'recurring' : 'one_time',
    route_status: serviceLower.indexOf('startup') !== -1 ? 'startup' : (serviceLower.indexOf('green') !== -1 ? 'gtc' : ''),
    billing_type: serviceLower.indexOf('weekly') !== -1 ? 'monthly' : 'one_time',
    monthly_rate: value_(q, 'discounted_service_subtotal') || value_(q, 'quote_subtotal'),
    tax_rate: MCPS_TAX_RATE,
    invoice_day: value_(q, 'invoice_day'),
    billing_start: value_(q, 'billing_start'),
    service_start: value_(q, 'startup_start_date') || value_(q, 'billing_start') || value_(q, 'timestamp'),
    service_end: value_(q, 'service_end'),
    payment_log: value_(q, 'payment_log'),
    contract_status: value_(q, 'contract_status'),
    contract_url: value_(q, 'contract_url'),
    created_at: now,
    updated_at: now,
    notes: value_(q, 'notes')
  }, MCPS_SERVICE_ACCOUNT_HEADERS);
  return serviceId;
}

function shouldHaveServiceAgreementFromQuote_(q) {
  const status = String(value_(q, 'status')).trim().toUpperCase();
  const contractStatus = String(value_(q, 'contract_status')).trim();
  const salesFlow = String(value_(q, 'sales_flow')).trim().toUpperCase();
  const signatureRequired = String(value_(q, 'signature_required')).trim().toUpperCase();
  return !!(value_(q, 'contract_url') || value_(q, 'contract_file_id') ||
    value_(q, 'send_contract_at') || value_(q, 'sent_at') || value_(q, 'signed_at') ||
    contractStatus || salesFlow === 'AGREEMENT_DIRECT' || signatureRequired === 'FALSE' ||
    status === 'SIGNED' || status === 'ACTIVE_CUSTOMER');
}

// ══════════════════════════════════════════════════════════════════════════════
// ⚠️ RESOLVING AN AGREEMENT FROM A QUOTE ID
//
// A parent agreement and every amendment made against it share the SAME
// source_quote_id. Any lookup that resolves "the agreement for this quote" by
// scanning for the first matching row can therefore land on an amendment and
// write to — or activate from — the wrong record, silently corrupting an executed
// contract. Six call sites did exactly that.
//
// Blank agreement_type counts as 'original': every row written before amendments
// existed carries no type, and all of those are originals.
//
// Returns { row, count }. `count > 1` is ambiguous and callers MUST refuse rather
// than pick one — returning the first match is the bug this replaces.
// ══════════════════════════════════════════════════════════════════════════════
function findOriginalAgreementByQuote_(agreements, quoteId) {
  var qid = String(quoteId || '').trim();
  if (!qid) return { row: null, count: 0 };
  var matches = sheetToObjects_(agreements).rows.filter(function (a) {
    if (String(value_(a, 'source_quote_id') || '').trim() !== qid) return false;
    var type = String(value_(a, 'agreement_type') || '').trim().toLowerCase();
    return !type || type === 'original';
  });
  return { row: matches.length === 1 ? matches[0] : null, count: matches.length };
}

// ⚠️ THROWS on ambiguity. It must not return null there.
//
// "Ambiguous" and "missing" are completely different states and conflating them
// is dangerous: a caller that reads null as "none exists" will happily CREATE
// another original, turning two conflicting agreements into three. Returning null
// here did exactly that in findOrCreateServiceAgreementFromQuote_.
//
// Two originals for one quote is already a data fault. Refusing loudly is the only
// safe response — the alternative is silently picking one, or manufacturing more.
function findOriginalAgreementByQuoteStrict_(agreements, quoteId) {
  var hit = findOriginalAgreementByQuote_(agreements, quoteId);
  if (hit.count > 1) {
    throw new Error('Ambiguous agreement lookup: ' + hit.count +
      ' original agreements exist for quote ' + quoteId +
      '. Resolve by agreement_id — refusing to guess or create another.');
  }
  return hit.row;   // null only when genuinely none exists
}

function findOrCreateServiceAgreementFromQuote_(clientId, locationId, proposalId, q, forceCreate) {
  const agreements = ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS);
  const quoteId = String(value_(q, 'quote_id')).trim();
  // ⚠️ Originals only — an amendment shares this quote id and must never be
  // reused or updated as if it were the primary agreement.
  const existing = findOriginalAgreementByQuoteStrict_(agreements, quoteId);
  if (!existing && !forceCreate && !shouldHaveServiceAgreementFromQuote_(q)) return '';

  const now = nowIso_();
  const status = mapAgreementStatusFromQuote_(q);
  const activationMethod = defaultActivationMethodFromQuote_(q);
  const signatureRequired = String(value_(q, 'signature_required', 'TRUE')).toUpperCase() === 'FALSE' ? 'FALSE' : 'TRUE';
  const common = {
    client_id: clientId,
    location_id: locationId,
    proposal_id: proposalId,
    source_quote_id: quoteId,
    status: status,
    signature_required: signatureRequired,
    activation_method: activationMethod,
    service_type: value_(q, 'service'),
    service_name: value_(q, 'service') || 'Pool Service',
    monthly_rate: value_(q, 'discounted_service_subtotal') || value_(q, 'quote_subtotal'),
    startup_fee: String(value_(q, 'service')).toLowerCase().indexOf('startup') !== -1 ? value_(q, 'quote_subtotal') : '',
    travel_fee: value_(q, 'travel_fee'),
    tax_rate: MCPS_TAX_RATE,
    sales_tax: value_(q, 'sales_tax'),
    total: value_(q, 'total_with_tax'),
    billing_start: value_(q, 'billing_start'),
    service_start: value_(q, 'startup_start_date') || value_(q, 'billing_start'),
    invoice_day: value_(q, 'invoice_day'),
    agreement_pdf_url: value_(q, 'contract_download_url') || value_(q, 'contract_url'),
    contract_url: value_(q, 'contract_url'),
    contract_file_id: value_(q, 'contract_file_id'),
    sent_at: value_(q, 'sent_at') || value_(q, 'send_contract_at'),
    signed_at: value_(q, 'signed_at'),
    declined_at: value_(q, 'lost_at'),
    activated_at: String(value_(q, 'status')).toUpperCase() === 'ACTIVE_CUSTOMER' ? now : '',
    created_by: value_(q, 'created_by'),
    updated_at: now,
    notes: value_(q, 'notes')
  };

  if (existing) {
    updateObjectRow_(agreements, existing._rowNum, common);
    return String(existing.agreement_id || '');
  }

  const agreementId = nextSequence_(agreements, 'agreement_id', 'AGR', 6);
  const agreementNumber = nextSequence_(agreements, 'agreement_number', 'AGR', 4);
  appendObject_(agreements, Object.assign({
    agreement_id: agreementId,
    agreement_number: agreementNumber,
    service_account_id: '',
    signrequest_id: '',
    created_at: now
  }, common), MCPS_SERVICE_AGREEMENT_HEADERS);
  return agreementId;
}

function updateAgreementServiceAccountLink_(agreementId, serviceAccountId) {
  if (!agreementId || !serviceAccountId) return;
  const agreements = ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS);
  const agreement = findRowByValue_(agreements, 'agreement_id', agreementId);
  if (agreement) {
    softSetCell_(agreements, agreement._rowNum, 'service_account_id', serviceAccountId);
    softSetCell_(agreements, agreement._rowNum, 'updated_at', nowIso_());
  }
}

// knownAgreementId: when the caller already resolved (or created) the agreement
// row, pass it. It is authoritative — this function then updates that row rather
// than looking one up, which is what stops a second agreement being created for a
// quote that already has one.
// allowCreate=false means: use knownAgreementId, or resolve the existing original,
// but NEVER manufacture a new agreement row. Activation passes false — an
// activation that creates its own agreement is how a quote ends up with two.
function syncQuoteToNormalized_(quoteId, knownAgreementId, allowCreate) {
  ensureNormalizedSalesSheets_();
  const hit = getQuoteById_(quoteId);
  if (!hit) return { ok: false, error: 'Quote not found: ' + quoteId };
  const q = hit.object;
  const clientId = findOrCreateClientFromQuote_(q);
  const locationId = findOrCreateLocationFromQuote_(clientId, q);
  const proposal = findOrCreateProposalFromQuote_(clientId, locationId, q);
  createProposalItemsIfMissing_(proposal.proposal_id, q);
  // ⚠️ Explicit id wins. Parent and amendments share a source_quote_id, so a
  // lookup here could resolve the wrong row — or create a duplicate original.
  let agreementId = String(knownAgreementId || '').trim();
  if (!agreementId) {
    if (allowCreate === false) {
      // No id supplied and creation forbidden: resolve an EXISTING original only.
      // Ambiguity throws rather than yielding a null that reads as "none".
      const existingOnly = findOriginalAgreementByQuoteStrict_(
        ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS), quoteId);
      agreementId = existingOnly ? String(existingOnly.agreement_id || '') : '';
    } else {
      agreementId = findOrCreateServiceAgreementFromQuote_(clientId, locationId, proposal.proposal_id, q, false);
    }
  }
  const serviceAccountId = findOrCreateServiceAccountFromQuote_(clientId, locationId, proposal.proposal_id, q, agreementId);
  updateAgreementServiceAccountLink_(agreementId, serviceAccountId);

  softSetCell_(hit.sheet, hit.rowNum, 'client_id', clientId);
  softSetCell_(hit.sheet, hit.rowNum, 'location_id', locationId);
  softSetCell_(hit.sheet, hit.rowNum, 'proposal_id', proposal.proposal_id);
  softSetCell_(hit.sheet, hit.rowNum, 'proposal_number', proposal.proposal_number);
  if (agreementId) {
    const agreement = findRowByValue_(ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS), 'agreement_id', agreementId);
    softSetCell_(hit.sheet, hit.rowNum, 'agreement_id', agreementId);
    if (agreement && agreement.agreement_number) softSetCell_(hit.sheet, hit.rowNum, 'agreement_number', agreement.agreement_number);
  }
  if (serviceAccountId) softSetCell_(hit.sheet, hit.rowNum, 'service_account_id', serviceAccountId);
  softSetCell_(hit.sheet, hit.rowNum, 'migration_status', 'MIGRATED');
  softSetCell_(hit.sheet, hit.rowNum, 'migration_notes', '');
  softSetCell_(hit.sheet, hit.rowNum, 'migrated_at', nowIso_());

  if (value_(q, 'pool_id')) {
    const locations = ensureSheet_('Client_Locations', MCPS_LOCATION_HEADERS);
    const loc = findRowByValue_(locations, 'location_id', locationId);
    if (loc) {
      softSetCell_(locations, loc._rowNum, 'pool_id', value_(q, 'pool_id'));
      softSetCell_(locations, loc._rowNum, 'active', 'TRUE');
    }
  }

  return {
    ok: true,
    client_id: clientId,
    location_id: locationId,
    proposal_id: proposal.proposal_id,
    proposal_number: proposal.proposal_number,
    agreement_id: agreementId,
    service_account_id: serviceAccountId
  };
}

function migrateQuotesToNormalizedSheets_(limit) {
  ensureNormalizedSalesSheets_();
  const sheet = getCrmSheet_();
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { ok: true, migrated: 0, errors: 0 };
  const headers = data[0];
  const qIdx = headerIndex_(headers, 'quote_id');
  const statusIdx = headerIndex_(headers, 'migration_status');
  let migrated = 0;
  let errors = 0;
  const max = limit ? Number(limit) : data.length - 1;

  for (let i = 1; i < data.length && migrated < max; i++) {
    const quoteId = qIdx !== -1 ? String(data[i][qIdx] || '').trim() : '';
    if (!quoteId) continue;
    const already = statusIdx !== -1 ? String(data[i][statusIdx] || '').trim().toUpperCase() : '';
    const qObj = quoteObjectFromRow_(headers, data[i], i + 1);
    if (already.indexOf('SKIP') === 0) continue;
    if (isLeadImportOnlyQuote_(qObj)) {
      softSetCell_(sheet, i + 1, 'migration_status', 'SKIPPED_LEAD_IMPORT');
      softSetCell_(sheet, i + 1, 'migration_notes', 'Imported lead row without proposal pricing; skipped by migration.');
      continue;
    }
    if (already === 'MIGRATED' && value_(qObj, 'client_id') && value_(qObj, 'location_id') && value_(qObj, 'proposal_id')) {
      continue;
    }
    try {
      syncQuoteToNormalized_(quoteId);
      migrated++;
    } catch(e) {
      errors++;
      softSetCell_(sheet, i + 1, 'migration_status', 'ERROR');
      softSetCell_(sheet, i + 1, 'migration_notes', String(e));
      logMigration_('migrateQuotesToNormalizedSheets_', 'ERROR', 'Failed quote ' + quoteId, 1, e);
    }
  }
  logMigration_('migrateQuotesToNormalizedSheets_', errors ? 'PARTIAL' : 'OK', 'Quotes migration run complete', migrated, errors ? errors + ' row errors' : '');
  return { ok: errors === 0, migrated: migrated, errors: errors };
}

// ── Stage 0b: migration coverage (READ-ONLY) ─────────────────────────────────
//
// Answers one question before any backfill is written: does every person in
// Quotes actually have a Clients row?
//
// The reason to check rather than assume: migrateQuotesToNormalizedSheets_
// calls isLeadImportOnlyQuote_ and deliberately SKIPS bare imported leads
// (status LEAD with no service, no pricing, no source). That was correct when
// the goal was migrating deals — a lead has no deal. But it means the exact
// people we now want to send proposals to may have no Clients row and would be
// invisible to a relational people-search.
//
// If unlinked_people is 0, the backfill is unnecessary and should not be built.
// ⚠️ WRITES NOTHING.
function analyzeMigrationCoverage_() {
  const sheet = getCrmSheet_();
  if (!sheet || sheet.getLastRow() < 2) {
    return { ok: true, quotes: 0, note: 'Quotes sheet is empty.' };
  }
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idx = (name) => headerIndex_(headers, name);
  const qIdx = idx('quote_id'), statusIdx = idx('migration_status'), cliIdx = idx('client_id');

  const clients = sheetToObjects_(ensureSheet_('Clients', MCPS_CLIENT_HEADERS)).rows;
  const knownClientIds = {};
  clients.forEach(function (c) {
    const id = String(c.client_id || '').trim();
    if (id) knownClientIds[id] = true;
  });

  let total = 0, linked = 0, skippedLeadImport = 0, wouldSkip = 0, danglingClientId = 0;
  const unlinked = [];        // people with no Clients row — the actual gap

  for (let i = 1; i < data.length; i++) {
    const quoteId = qIdx !== -1 ? String(data[i][qIdx] || '').trim() : '';
    if (!quoteId) continue;
    total++;

    const q = quoteObjectFromRow_(headers, data[i], i + 1);
    const clientId = cliIdx !== -1 ? String(data[i][cliIdx] || '').trim() : '';
    const mstatus = statusIdx !== -1 ? String(data[i][statusIdx] || '').trim().toUpperCase() : '';

    if (mstatus === 'SKIPPED_LEAD_IMPORT') skippedLeadImport++;
    if (isLeadImportOnlyQuote_(q)) wouldSkip++;

    if (clientId && knownClientIds[clientId]) { linked++; continue; }
    // A client_id pointing at a row that no longer exists is its own problem —
    // counted separately so a merge or manual edit doesn't hide as "unlinked".
    if (clientId && !knownClientIds[clientId]) { danglingClientId++; continue; }

    unlinked.push({
      quote_id: quoteId,
      name: [value_(q, 'first_name'), value_(q, 'last_name')].filter(Boolean).join(' ').trim(),
      email: String(value_(q, 'email') || ''),
      phone: String(value_(q, 'phone') || ''),
      status: String(value_(q, 'status') || ''),
      migration_status: mstatus,
      lead_import_only: isLeadImportOnlyQuote_(q)
    });
  }

  const leadOnlyUnlinked = unlinked.filter(function (u) { return u.lead_import_only; }).length;

  return {
    ok: true,
    generated_at: nowIso_(),
    quotes: total,
    clients: clients.length,
    linked_to_client: linked,
    dangling_client_id: danglingClientId,
    marked_skipped_lead_import: skippedLeadImport,
    would_be_skipped_today: wouldSkip,
    unlinked_people: unlinked.length,
    unlinked_because_lead_import: leadOnlyUnlinked,
    // Capped: this is a diagnostic, not an export, and the response crosses the
    // GAS payload limit on a large sheet.
    sample: unlinked.slice(0, 50),
    verdict: unlinked.length === 0
      ? 'complete — every quote resolves to a Clients row; the C1 backfill is not needed'
      : (leadOnlyUnlinked === unlinked.length
          ? 'gap is entirely lead-import rows — a person-only backfill closes it'
          : 'gap includes non-lead rows — inspect the sample before backfilling')
  };
}

function handleAnalyzeMigrationCoverage_(payload) {
  try {
    return analyzeMigrationCoverage_();
  } catch (e) {
    return { ok: false, error: 'analyzeMigrationCoverage_ Error: ' + e };
  }
}

function isLeadImportOnlyQuote_(q) {
  const status = String(value_(q, 'status')).trim().toUpperCase();
  if (status !== 'LEAD') return false;
  const service = String(value_(q, 'service')).trim();
  const total = number_(value_(q, 'total_with_tax'));
  const subtotal = number_(value_(q, 'quote_subtotal')) || number_(value_(q, 'service_subtotal'));
  const source = String(value_(q, 'quote_source') || value_(q, 'quote_version') || '').trim();
  return !service && !total && !subtotal && !source;
}

// agreementId: the row this activation belongs to, resolved by the caller BEFORE
// signing. Passing it prevents the sync below from finding-or-creating a second
// agreement — which for an amendment would mean a duplicate original, a second
// pool_id and a phantom customer on the route board.
function activateQuoteServiceFromAgreement_(quoteId, signedAt, activationMethod, agreementId) {
  const hit = getQuoteById_(quoteId);
  if (!hit) return { ok: false, error: 'Quote not found: ' + quoteId };

  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ VALIDATE BEFORE MUTATING. Everything below this block writes: it mints a
  // pool_id, flips the quote to ACTIVE_CUSTOMER and creates Routes rows. Those
  // are not undoable, and the id was previously only checked afterwards, by
  // syncQuoteToNormalized_ — by which point a phantom customer already existed
  // on the route board.
  //
  // Three things must be true before a single cell changes:
  //   1. an agreement id was supplied            (no id, no activation)
  //   2. that row actually exists
  //   3. it is an ORIGINAL, never an amendment   (an amendment activating would
  //      mint a SECOND pool_id for a customer who already has one)
  // ══════════════════════════════════════════════════════════════════════════
  const agrId = String(agreementId || '').trim();
  if (!agrId) {
    return { ok: false, error: 'Activation requires an explicit agreement_id.' };
  }
  const agrSheet = ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS);
  const agrRow = findRowByValue_(agrSheet, 'agreement_id', agrId);
  if (!agrRow) {
    return { ok: false, error: 'Agreement not found: ' + agrId };
  }
  if (isAmendmentRow_(agrRow)) {
    return { ok: false, error: 'Cannot activate from an amendment. Amendments change an existing service.' };
  }
  // ⚠️ 4. The agreement must BELONG to the quote being activated.
  // Existing + original is not enough: a valid agreement for quote A could
  // activate quote B, minting a pool_id and Routes row for a customer whose
  // agreement nobody signed.
  //
  // A blank source_quote_id cannot contradict anything, so it is allowed (legacy
  // rows predate the link) but logged — silently trusting it would be worse.
  const agrQuote = String(value_(agrRow, 'source_quote_id') || '').trim();
  const wantQuote = String(quoteId || '').trim();
  if (agrQuote && agrQuote !== wantQuote) {
    return { ok: false, error: 'Agreement ' + agrId + ' belongs to quote ' + agrQuote +
                               ', not ' + wantQuote + '. Refusing to activate.' };
  }
  if (!agrQuote) {
    Logger.log('activateQuoteServiceFromAgreement_: agreement ' + agrId +
               ' has no source_quote_id — cannot verify ownership of quote ' + wantQuote);
  }

  const now = nowIso_();
  const method = activationMethod || defaultActivationMethodFromQuote_(hit.object);
  let poolId = String(value_(hit.object, 'pool_id')).trim();
  if (!poolId) {
    poolId = _mcpsNextPoolId_(hit.sheet);
    softSetCell_(hit.sheet, hit.rowNum, 'pool_id', poolId);
  }
  softSetCell_(hit.sheet, hit.rowNum, 'status', 'ACTIVE_CUSTOMER');
  softSetCell_(hit.sheet, hit.rowNum, 'signed_at', signedAt || now);
  softSetCell_(hit.sheet, hit.rowNum, 'contract_status', 'SIGNED');
  softSetCell_(hit.sheet, hit.rowNum, 'activation_method', method);

  const fresh = getQuoteById_(quoteId);
  try {
    syncQuoteOperationalSchedule_(fresh.headers, fresh.row, poolId);
  } catch(routesErr) {
    Logger.log('activateQuoteServiceFromAgreement_ route sync failed: ' + routesErr);
  }

  // ⚠️ allowCreate=false — activation must REUSE the row resolved before signing,
  // never mint a second one for the same quote.
  const sync = syncQuoteToNormalized_(quoteId, agreementId, false);
  return Object.assign({ ok: true, quote_id: quoteId, pool_id: poolId }, sync);
}

function handleServiceAgreementSigned_(payload) {
  ensureNormalizedSalesSheets_();
  const agreements = ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS);
  const signedAt = payload.signed_at || nowIso_();
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ EXTERNAL, UNAUTHENTICATED CALLER (SignRequest → Zapier).
  //
  // Every identifier here comes from outside. Resolving them in priority order
  // and taking the first hit meant a later identifier was never examined: a
  // payload carrying a valid quote_id AND a rogue amendment signrequest_id
  // resolved on the quote_id, passed the type check, and silently ignored the
  // signrequest entirely.
  //
  // So: resolve EVERY supplied identifier, then require them to agree. A payload
  // whose identifiers point at different agreements is not a request to be
  // interpreted — it is a request to be refused.
  // ══════════════════════════════════════════════════════════════════════════
  const resolved = [];
  if (payload.agreement_id) {
    resolved.push({ src: 'agreement_id',
                    row: findRowByValue_(agreements, 'agreement_id', payload.agreement_id) });
  }
  if (payload.signrequest_id) {
    resolved.push({ src: 'signrequest_id',
                    row: findRowByValue_(agreements, 'signrequest_id', payload.signrequest_id) });
  }
  if (payload.quote_id) {
    try {
      resolved.push({ src: 'quote_id',
                      row: findOriginalAgreementByQuoteStrict_(agreements, payload.quote_id) });
    } catch (ambErr) {
      return { ok: false, error: String(ambErr.message || ambErr) };
    }
  }

  const hits = resolved.filter(function (r) { return !!r.row; });

  // ⚠️ Type-check EVERY resolved row, not just the winner. An amendment reached
  // through any identifier must stop the whole request — otherwise a rogue
  // signrequest_id rides along beside a legitimate quote_id.
  for (var ri = 0; ri < hits.length; ri++) {
    if (isAmendmentRow_(hits[ri].row)) {
      return { ok: false,
               error: 'This is an amendment (via ' + hits[ri].src +
                      '). Amendments are signed through the amendment flow.' };
    }
  }

  // Identifiers must not disagree.
  const distinct = [];
  hits.forEach(function (h) {
    var id = String(value_(h.row, 'agreement_id') || '');
    if (distinct.indexOf(id) === -1) distinct.push(id);
  });
  if (distinct.length > 1) {
    return { ok: false,
             error: 'Conflicting identifiers: ' +
                    hits.map(function (h) { return h.src + '→' + value_(h.row, 'agreement_id'); }).join(', ') +
                    '. Refusing to guess which agreement was signed.' };
  }

  let agreement = hits.length ? hits[0].row : null;

  let quoteId = String(payload.quote_id || (agreement && agreement.source_quote_id) || '').trim();
  if (!quoteId && payload.row_number) {
    const sheet = getCrmSheet_();
    const rowNum = Number(payload.row_number);
    if (rowNum > 1) {
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const row = sheet.getRange(rowNum, 1, 1, sheet.getLastColumn()).getValues()[0];
      quoteId = value_(quoteObjectFromRow_(headers, row, rowNum), 'quote_id');
    }
  }
  if (!quoteId) return { ok: false, error: 'quote_id, agreement_id, row_number, or signrequest_id required' };

  const activate = activateQuoteServiceFromAgreement_(quoteId, signedAt,
    payload.activation_method || 'SIGNED_AGREEMENT', agreement && agreement.agreement_id);
  const refreshedAgreement = agreement || findOriginalAgreementByQuoteStrict_(agreements, quoteId);
  if (refreshedAgreement) {
    softSetCell_(agreements, refreshedAgreement._rowNum, 'status', 'SIGNED');
    softSetCell_(agreements, refreshedAgreement._rowNum, 'signed_at', signedAt);
    softSetCell_(agreements, refreshedAgreement._rowNum, 'activated_at', nowIso_());
    if (payload.signrequest_id) softSetCell_(agreements, refreshedAgreement._rowNum, 'signrequest_id', payload.signrequest_id);
    if (activate.service_account_id) softSetCell_(agreements, refreshedAgreement._rowNum, 'service_account_id', activate.service_account_id);
    softSetCell_(agreements, refreshedAgreement._rowNum, 'updated_at', nowIso_());
  }
  return activate;
}

function completeStartupAndCreateWeeklyService_(quoteId, billingStart) {
  try {
    const sync = syncQuoteToNormalized_(quoteId);
    if (!sync.ok) return sync;
    const services = ensureSheet_('Service_Accounts', MCPS_SERVICE_ACCOUNT_HEADERS);
    const rows = sheetToObjects_(services).rows;
    const now = nowIso_();
    rows.forEach(function(svc) {
      if (String(svc.source_quote_id || '') === String(quoteId) &&
          String(svc.service_type || '').toLowerCase().indexOf('startup') !== -1 &&
          String(svc.status || '').toUpperCase() !== 'COMPLETED') {
        softSetCell_(services, svc._rowNum, 'status', 'COMPLETED');
        softSetCell_(services, svc._rowNum, 'service_end', billingStart || now);
        softSetCell_(services, svc._rowNum, 'updated_at', now);
      }
    });
    const weeklyExists = rows.some(function(svc) {
      return String(svc.source_quote_id || '') === String(quoteId) &&
        String(svc.service_type || '').toLowerCase().indexOf('weekly') !== -1;
    });
    if (!weeklyExists) {
      appendObject_(services, {
        service_account_id: nextSequence_(services, 'service_account_id', 'SVC', 6),
        client_id: sync.client_id,
        location_id: sync.location_id,
        source_proposal_id: sync.proposal_id,
        source_quote_id: quoteId,
        pool_id: value_(getQuoteById_(quoteId).object, 'pool_id'),
        service_type: 'Weekly Full Service',
        service_name: 'Weekly Full Service',
        status: 'ACTIVE',
        schedule_type: 'recurring',
        route_status: '',
        billing_type: 'monthly',
        monthly_rate: value_(getQuoteById_(quoteId).object, 'discounted_service_subtotal') || value_(getQuoteById_(quoteId).object, 'quote_subtotal'),
        tax_rate: MCPS_TAX_RATE,
        invoice_day: value_(getQuoteById_(quoteId).object, 'invoice_day'),
        billing_start: billingStart || '',
        service_start: billingStart || now,
        service_end: '',
        payment_log: value_(getQuoteById_(quoteId).object, 'payment_log'),
        contract_status: value_(getQuoteById_(quoteId).object, 'contract_status'),
        contract_url: value_(getQuoteById_(quoteId).object, 'contract_url'),
        created_at: now,
        updated_at: now,
        notes: 'Created during startup-to-weekly conversion.'
      }, MCPS_SERVICE_ACCOUNT_HEADERS);
    }
    return { ok: true };
  } catch(e) {
    logMigration_('completeStartupAndCreateWeeklyService_', 'ERROR', 'Failed quote ' + quoteId, 1, e);
    return { ok: false, error: String(e) };
  }
}

function markStartupServiceCompleteByPool_(poolId) {
  try {
    ensureNormalizedSalesSheets_();
    const services = ensureSheet_('Service_Accounts', MCPS_SERVICE_ACCOUNT_HEADERS);
    const rows = sheetToObjects_(services).rows;
    const now = nowIso_();
    let updated = 0;
    rows.forEach(function(svc) {
      const isSamePool = String(svc.pool_id || '').trim() === String(poolId || '').trim();
      const isStartup = String(svc.service_type || '').toLowerCase().indexOf('startup') !== -1 ||
        String(svc.route_status || '').toLowerCase() === 'startup';
      if (isSamePool && isStartup && String(svc.status || '').toUpperCase() !== 'COMPLETED') {
        softSetCell_(services, svc._rowNum, 'status', 'COMPLETED');
        softSetCell_(services, svc._rowNum, 'service_end', now);
        softSetCell_(services, svc._rowNum, 'updated_at', now);
        updated++;
      }
    });
    return { ok: true, updated: updated };
  } catch(e) {
    logMigration_('markStartupServiceCompleteByPool_', 'ERROR', 'Failed pool ' + poolId, 1, e);
    return { ok: false, error: String(e) };
  }
}

function updateObjectRow_(sheet, rowNum, fields) {
  Object.keys(fields || {}).forEach(function(k) {
    softSetCell_(sheet, rowNum, k, fields[k]);
  });
}

function listSheetRows_(sheetName, headers, filters) {
  const sheet = ensureSheet_(sheetName, headers);
  let rows = sheetToObjects_(sheet).rows.map(function(r) {
    const copy = {};
    Object.keys(r).forEach(function(k) { if (k !== '_rowNum') copy[k] = r[k]; });
    return copy;
  });
  Object.keys(filters || {}).forEach(function(k) {
    const val = String(filters[k] || '').trim();
    if (!val) return;
    rows = rows.filter(function(r) { return String(r[normalizeHeader_(k)] || '').trim() === val; });
  });
  return rows;
}

function upsertNormalizedRow_(sheetName, headers, idColumn, prefix, payload) {
  const sheet = ensureSheet_(sheetName, headers);
  const id = String(payload[idColumn] || '').trim();
  const now = nowIso_();
  let row = id ? findRowByValue_(sheet, idColumn, id) : null;
  const obj = {};
  headers.forEach(function(h) {
    const key = normalizeHeader_(h);
    if (payload[key] !== undefined) obj[key] = payload[key];
    else if (payload[h] !== undefined) obj[key] = payload[h];
  });
  obj.updated_at = now;
  if (row) {
    updateObjectRow_(sheet, row._rowNum, obj);
    return { id: id, created: false };
  }
  obj[idColumn] = id || nextSequence_(sheet, idColumn, prefix, 6);
  obj.created_at = obj.created_at || now;
  appendObject_(sheet, obj, headers);
  return { id: obj[idColumn], created: true };
}

function normalizeCompanyName_(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function findPoolCompanyByName_(name) {
  const target = normalizeCompanyName_(name).toLowerCase();
  if (!target) return null;
  const sheet = ensureSheet_('Pool_Companies', MCPS_POOL_COMPANY_HEADERS);
  const rows = sheetToObjects_(sheet).rows;
  for (let i = 0; i < rows.length; i++) {
    if (normalizeCompanyName_(rows[i].company_name).toLowerCase() === target) return rows[i];
  }
  return null;
}

function listPoolCompanies_() {
  return listSheetRows_('Pool_Companies', MCPS_POOL_COMPANY_HEADERS, {})
    .filter(function(c) { return String(c.active || 'TRUE').toUpperCase() !== 'FALSE'; })
    .sort(function(a, b) {
      return String(a.company_name || '').localeCompare(String(b.company_name || ''));
    });
}

function upsertPoolCompany_(payload) {
  const company = payload.company || payload;
  const companyName = normalizeCompanyName_(company.company_name || company.name || company.startup_company);
  if (!companyName) return { ok: false, error: 'Company name is required.' };

  const existing = findPoolCompanyByName_(companyName);
  const data = {
    pool_company_id: existing ? existing.pool_company_id : company.pool_company_id,
    company_name: companyName,
    report_bcc_email: String(company.report_bcc_email || company.email || '').trim(),
    contact_name: String(company.contact_name || '').trim(),
    phone: String(company.phone || '').trim(),
    notes: String(company.notes || '').trim(),
    active: company.active === undefined ? 'TRUE' : company.active
  };
  const res = upsertNormalizedRow_('Pool_Companies', MCPS_POOL_COMPANY_HEADERS, 'pool_company_id', 'PCO', data);
  return { ok: true, pool_company_id: res.id, created: res.created };
}

function handleNormalizedSalesAction_(payload) {
  const action = String(payload.action || '');
  ensureNormalizedSalesSheets_();

  if (action === 'setup_normalized_sales_sheets') {
    return { ok: true };
  }

  if (action === 'migrate_quotes_normalized') {
    return migrateQuotesToNormalizedSheets_(payload.limit || 0);
  }

  if (action === 'get_startup_companies') {
    return { ok: true, companies: listPoolCompanies_() };
  }

  if (action === 'upsert_startup_company') {
    return upsertPoolCompany_(payload);
  }

  if (action === 'get_clients') {
    let clients = listSheetRows_('Clients', MCPS_CLIENT_HEADERS, {});
    const q = String(payload.q || payload.search || '').trim().toLowerCase();
    if (q) {
      clients = clients.filter(function(c) {
        return [c.display_name, c.first_name, c.last_name, c.email, c.phone, c.client_id]
          .join(' ').toLowerCase().indexOf(q) !== -1;
      });
    }
    if (payload.status) clients = clients.filter(function(c) { return String(c.status || '') === String(payload.status); });
    return { ok: true, clients: clients };
  }

  if (action === 'upsert_client') {
    const res = upsertNormalizedRow_('Clients', MCPS_CLIENT_HEADERS, 'client_id', 'CLI', payload.client || payload);
    return { ok: true, client_id: res.id, created: res.created };
  }

  if (action === 'get_client_locations') {
    return { ok: true, locations: listSheetRows_('Client_Locations', MCPS_LOCATION_HEADERS, { client_id: payload.client_id }) };
  }

  if (action === 'upsert_client_location') {
    const res = upsertNormalizedRow_('Client_Locations', MCPS_LOCATION_HEADERS, 'location_id', 'LOC', payload.location || payload);
    return { ok: true, location_id: res.id, created: res.created };
  }

  if (action === 'get_client_proposals') {
    return { ok: true, proposals: listSheetRows_('Proposals', MCPS_PROPOSAL_HEADERS, { client_id: payload.client_id }) };
  }

  if (action === 'get_location_proposals') {
    return { ok: true, proposals: listSheetRows_('Proposals', MCPS_PROPOSAL_HEADERS, { location_id: payload.location_id }) };
  }

  if (action === 'create_proposal' || action === 'upsert_proposal') {
    const proposals = ensureSheet_('Proposals', MCPS_PROPOSAL_HEADERS);
    const data = payload.proposal || payload;
    const now = nowIso_();
    const proposalId = String(data.proposal_id || '').trim();
    const existing = proposalId ? findRowByValue_(proposals, 'proposal_id', proposalId) : null;
    const obj = {};
    MCPS_PROPOSAL_HEADERS.forEach(function(h) {
      const key = normalizeHeader_(h);
      if (data[key] !== undefined) obj[key] = data[key];
      else if (data[h] !== undefined) obj[key] = data[h];
    });
    obj.updated_at = now;
    if (existing) {
      updateObjectRow_(proposals, existing._rowNum, obj);
      return { ok: true, proposal_id: proposalId, proposal_number: existing.proposal_number, created: false };
    }
    obj.proposal_id = proposalId || nextSequence_(proposals, 'proposal_id', 'PRP', 6);
    obj.proposal_number = obj.proposal_number || nextSequence_(proposals, 'proposal_number', 'PRO', 4);
    obj.status = obj.status || 'DRAFT';
    obj.tax_rate = obj.tax_rate || MCPS_TAX_RATE;
    obj.created_at = obj.created_at || now;
    appendObject_(proposals, obj, MCPS_PROPOSAL_HEADERS);
    return { ok: true, proposal_id: obj.proposal_id, proposal_number: obj.proposal_number, created: true };
  }

  if (action === 'save_proposal_items') {
    const proposalId = String(payload.proposal_id || '').trim();
    if (!proposalId) return { ok: false, error: 'proposal_id required' };
    const items = Array.isArray(payload.items) ? payload.items : [];
    const sheet = ensureSheet_('Proposal_Items', MCPS_PROPOSAL_ITEM_HEADERS);
    const now = nowIso_();
    items.forEach(function(item, i) {
      const obj = {};
      MCPS_PROPOSAL_ITEM_HEADERS.forEach(function(h) {
        const key = normalizeHeader_(h);
        if (item[key] !== undefined) obj[key] = item[key];
        else if (item[h] !== undefined) obj[key] = item[h];
      });
      obj.proposal_item_id = obj.proposal_item_id || nextSequence_(sheet, 'proposal_item_id', 'PIT', 6);
      obj.proposal_id = proposalId;
      obj.sort_order = obj.sort_order || i + 1;
      obj.created_at = obj.created_at || now;
      obj.updated_at = now;
      appendObject_(sheet, obj, MCPS_PROPOSAL_ITEM_HEADERS);
    });
    return { ok: true, count: items.length };
  }

  if (action === 'get_proposals_by_status') {
    return { ok: true, proposals: listSheetRows_('Proposals', MCPS_PROPOSAL_HEADERS, { status: payload.status }) };
  }

  if (action === 'get_latest_client_proposal') {
    const proposals = listSheetRows_('Proposals', MCPS_PROPOSAL_HEADERS, { client_id: payload.client_id })
      .sort(function(a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
    return { ok: true, proposal: proposals[0] || null };
  }

  if (action === 'get_proposal') {
    const sheet = ensureSheet_('Proposals', MCPS_PROPOSAL_HEADERS);
    const key = payload.proposal_id ? 'proposal_id' : (payload.proposal_number ? 'proposal_number' : 'legacy_quote_id');
    const val = payload.proposal_id || payload.proposal_number || payload.legacy_quote_id;
    const proposal = findRowByValue_(sheet, key, val);
    if (!proposal) return { ok: false, error: 'Proposal not found' };
    const items = listSheetRows_('Proposal_Items', MCPS_PROPOSAL_ITEM_HEADERS, { proposal_id: proposal.proposal_id });
    const clean = {};
    Object.keys(proposal).forEach(function(k) { if (k !== '_rowNum') clean[k] = proposal[k]; });
    return { ok: true, proposal: clean, items: items };
  }

  if (action === 'update_proposal_status') {
    const sheet = ensureSheet_('Proposals', MCPS_PROPOSAL_HEADERS);
    const proposal = findRowByValue_(sheet, 'proposal_id', payload.proposal_id);
    if (!proposal) return { ok: false, error: 'Proposal not found' };
    softSetCell_(sheet, proposal._rowNum, 'status', payload.status);
    if (payload.status === 'SENT') softSetCell_(sheet, proposal._rowNum, 'sent_at', nowIso_());
    if (payload.status === 'ACCEPTED') softSetCell_(sheet, proposal._rowNum, 'accepted_at', nowIso_());
    if (payload.status === 'DECLINED') softSetCell_(sheet, proposal._rowNum, 'declined_at', nowIso_());
    if (payload.status === 'EXPIRED') softSetCell_(sheet, proposal._rowNum, 'expired_at', nowIso_());
    softSetCell_(sheet, proposal._rowNum, 'updated_at', nowIso_());
    if (proposal.legacy_quote_id) {
      const hit = getQuoteById_(proposal.legacy_quote_id);
      if (hit) {
        const legacy = {
          SENT: 'SENT',
          DECLINED: 'LOST',
          EXPIRED: 'EXPIRED',
          CONVERTED_TO_SERVICE: 'ACTIVE_CUSTOMER',
          CONVERTED_TO_INVOICE: 'COMPLETED_JOB'
        }[String(payload.status || '').toUpperCase()];
        if (legacy) softSetCell_(hit.sheet, hit.rowNum, 'status', legacy);
        if (payload.status === 'SENT') softSetCell_(hit.sheet, hit.rowNum, 'sent_at', nowIso_());
        if (payload.status === 'ACCEPTED') softSetCell_(hit.sheet, hit.rowNum, 'proposal_accepted_at', nowIso_());
        if (payload.status === 'DECLINED') softSetCell_(hit.sheet, hit.rowNum, 'lost_at', nowIso_());
        try { syncQuoteToNormalized_(proposal.legacy_quote_id); } catch(_) {}
      }
    }
    return { ok: true };
  }

  if (action === 'send_proposal_for_approval') {
    return handleSendProposalForApproval_(payload);
  }

  if (action === 'get_service_accounts') {
    return { ok: true, services: listSheetRows_('Service_Accounts', MCPS_SERVICE_ACCOUNT_HEADERS, {}) };
  }

  if (action === 'get_service_agreements') {
    return { ok: true, agreements: withAgreementFollowups_(withAgreementCustomer_(listSheetRows_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS, {}))) };
  }

  if (action === 'get_client_service_agreements') {
    return { ok: true, agreements: withAgreementFollowups_(withAgreementCustomer_(listSheetRows_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS, { client_id: payload.client_id }))) };
  }

  if (action === 'get_location_service_agreements') {
    return { ok: true, agreements: withAgreementFollowups_(withAgreementCustomer_(listSheetRows_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS, { location_id: payload.location_id }))) };
  }

  if (action === 'get_service_agreement') {
    const sheet = ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS);
    let agreement = null;
    if (payload.agreement_id) {
      agreement = findRowByValue_(sheet, 'agreement_id', payload.agreement_id);
    } else if (payload.agreement_number) {
      agreement = findRowByValue_(sheet, 'agreement_number', payload.agreement_number);
    } else {
      // ⚠️ Quote id is AMBIGUOUS by nature — the parent and every amendment share
      // one. Resolve to the original only, and refuse rather than return a guess.
      try {
        agreement = findOriginalAgreementByQuoteStrict_(sheet,
          payload.quote_id || payload.source_quote_id);
      } catch (ambErr) {
        return { ok: false, error: String(ambErr.message || ambErr) };
      }
    }
    if (!agreement) return { ok: false, error: 'Service agreement not found' };
    const clean = {};
    Object.keys(agreement).forEach(function(k) { if (k !== '_rowNum') clean[k] = agreement[k]; });
    // Same joined fields as the list routes — otherwise a contract shows one name
    // in the list and another (or none) in the detail view.
    return { ok: true, agreement: withAgreementFollowups_(withAgreementCustomer_([clean]))[0] };
  }

  if (action === 'update_contract_followups') {
    return handleUpdateContractFollowups_(payload);
  }

  if (action === 'create_direct_service_agreement' || action === 'create_service_agreement_from_proposal') {
    const data = payload.agreement || payload;
    if (data.quote_id) {
      const sync = syncQuoteToNormalized_(data.quote_id);
      const hit = getQuoteById_(data.quote_id);
      const agreementId = findOrCreateServiceAgreementFromQuote_(sync.client_id, sync.location_id, sync.proposal_id, hit.object, true);
      return { ok: true, agreement_id: agreementId, quote_id: data.quote_id };
    }
    const res = upsertNormalizedRow_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS, 'agreement_id', 'AGR', data);
    return { ok: true, agreement_id: res.id, created: res.created };
  }

  if (action === 'update_service_agreement') {
    const res = upsertNormalizedRow_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS, 'agreement_id', 'AGR', payload.agreement || payload);
    return { ok: true, agreement_id: res.id, created: res.created };
  }

  if (action === 'service_agreement_signed') {
    return handleServiceAgreementSigned_(payload);
  }

  if (action === 'activate_service_account_from_agreement') {
    const agreement = payload.agreement_id
      ? findRowByValue_(ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS), 'agreement_id', payload.agreement_id)
      : findOriginalAgreementByQuoteStrict_(
          ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS), payload.quote_id);
    if (!agreement) return { ok: false, error: 'Service agreement not found' };
    // ⚠️ Staff can pass an explicit agreement_id here. A signed amendment would
    // otherwise satisfy the status check and activate a duplicate service.
    if (isAmendmentRow_(agreement)) {
      return { ok: false, error: 'Cannot activate from an amendment.' };
    }
    if (!agreementCanActivate_(agreement)) return { ok: false, error: 'Agreement is not signed or override-enabled.' };
    return activateQuoteServiceFromAgreement_(agreement.source_quote_id,
      agreement.signed_at || nowIso_(), agreement.activation_method, agreement.agreement_id);
  }

  if (action === 'get_client_service_accounts') {
    return { ok: true, services: listSheetRows_('Service_Accounts', MCPS_SERVICE_ACCOUNT_HEADERS, { client_id: payload.client_id }) };
  }

  if (action === 'get_location_service_accounts') {
    return { ok: true, services: listSheetRows_('Service_Accounts', MCPS_SERVICE_ACCOUNT_HEADERS, { location_id: payload.location_id }) };
  }

  if (action === 'update_service_account') {
    const res = upsertNormalizedRow_('Service_Accounts', MCPS_SERVICE_ACCOUNT_HEADERS, 'service_account_id', 'SVC', payload.service || payload);
    return { ok: true, service_account_id: res.id, created: res.created };
  }

  return { ok: false, error: 'Unknown normalized sales action: ' + action };
}


/**
 * REPLACEMENT FOR handleImportLeads_
 * Targets the correct CRM sheet and maps all provided lead info.
 */
function handleImportLeads_(leads) {
  const sheet = getCrmSheet_(); 
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  
  const newRows = leads.map(l => {
    let row = new Array(headers.length).fill("");
    row[getColIdx_(headers, 'quote_id')] = "Q-" + Utilities.getUuid().substring(0,8);
    row[getColIdx_(headers, 'first_name')] = l.first_name || "";
    row[getColIdx_(headers, 'last_name')] = l.last_name || "";
    row[getColIdx_(headers, 'email')] = l.email || "";
    row[getColIdx_(headers, 'phone')] = l.phone || "";
    row[getColIdx_(headers, 'address')] = l.address || "";
    row[getColIdx_(headers, 'city')] = l.city || "";
    row[getColIdx_(headers, 'area')] = l.area || "";
    row[getColIdx_(headers, 'status')] = "LEAD";
    row[getColIdx_(headers, 'specs_summary')] = l.pool_info || "";
    row[getColIdx_(headers, 'year_built')] = l.year_built || "";
    row[getColIdx_(headers, 'contact_log')] = "[]";
    return row;
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, headers.length).setValues(newRows);
  return { ok: true, count: newRows.length };
}

/**
 * REPLACEMENT FOR handleUpdateLead_
 * Targets the correct CRM sheet for updates.
 */
function handleUpdateLead_(payload) {
  ensureNormalizedSalesSheets_();
  const sheet = getCrmSheet_(); // Updated to use the CRM sheet helper
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const data = sheet.getDataRange().getValues();
  
  const idCol = getColIdx_(headers, 'quote_id');
  let rowIdx = -1;

  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] == payload.quote_id) { rowIdx = i + 1; break; }
  }

  if (rowIdx === -1) return { ok: false, error: "Quote ID not found" };

  sheet.getRange(rowIdx, getColIdx_(headers, 'status') + 1).setValue(payload.status);
  sheet.getRange(rowIdx, getColIdx_(headers, 'notes') + 1).setValue(payload.notes);

  // Write pool_id when provided (used during ACTIVE_CUSTOMER activation)
  if (payload.pool_id !== undefined && payload.pool_id !== null) {
    try {
      sheet.getRange(rowIdx, getColIdx_(headers, 'pool_id') + 1).setValue(payload.pool_id);
    } catch(_) {}
  }

  // Write sponsored_by_mcp when explicitly provided
  if (payload.sponsored_by_mcp !== undefined) {
    try {
      sheet.getRange(rowIdx, getColIdx_(headers, 'sponsored_by_mcp') + 1).setValue(payload.sponsored_by_mcp);
    } catch(_) {}
  }

  if (payload.contact_entry) {
    const logColIdx = getColIdx_(headers, 'contact_log') + 1;
    const currentLogStr = sheet.getRange(rowIdx, logColIdx).getValue();
    let logArr = currentLogStr ? JSON.parse(currentLogStr) : [];
    logArr.push(payload.contact_entry);
    sheet.getRange(rowIdx, logColIdx).setValue(JSON.stringify(logArr));
  }

  // Billing fields — write value, creating the column header if it doesn't exist yet
  const softSet = (colName, val) => {
    let idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(colName.toLowerCase().trim());
    if (idx === -1) {
      // Column missing — add it to the end of the header row
      idx = headers.length;
      sheet.getRange(1, idx + 1).setValue(colName);
      headers.push(colName); // keep local headers in sync for subsequent softSet calls
    }
    sheet.getRange(rowIdx, idx + 1).setValue(val !== undefined && val !== null ? val : '');
  };
  if (payload.invoice_day !== undefined && payload.invoice_day !== null && payload.invoice_day !== '') {
    softSet('invoice_day', Number(payload.invoice_day));
  }
  if (payload.billing_start !== undefined && payload.billing_start !== null && payload.billing_start !== '') {
    softSet('billing_start', String(payload.billing_start));
  }
  if (payload.payment_log !== undefined && payload.payment_log !== null) {
    softSet('payment_log', JSON.stringify(payload.payment_log));
  }

  // service_end — write if explicitly provided; auto-set when status changes to LOST and column is empty
  if (payload.service_end !== undefined) {
    softSet('service_end', payload.service_end ? String(payload.service_end) : '');
  } else if (payload.status && (String(payload.status).toUpperCase() === 'LOST' || String(payload.status).toUpperCase() === 'COMPLETED_JOB')) {
    const seIdx = headers.map(h => String(h).toLowerCase().trim()).indexOf('service_end');
    const existingVal = seIdx !== -1 ? sheet.getRange(rowIdx, seIdx + 1).getValue() : '';
    if (!existingVal) {
      softSet('service_end', Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));
    }
  }

  // signed_at is written by Zapier when the contract is signed — do not overwrite it here

  // When a quote is closed out, pull the pool off the live schedule.
  if (payload.status && (String(payload.status).toUpperCase() === 'LOST' || String(payload.status).toUpperCase() === 'COMPLETED_JOB')) {
    try {
      const pidIdx = headers.map(h => String(h).toLowerCase().trim()).indexOf('pool_id');
      const existingPoolId = pidIdx !== -1 ? String(data[rowIdx - 1][pidIdx] || '').trim() : '';
      if (existingPoolId) deactivatePoolInRoutes_(existingPoolId);
    } catch(deactivateErr) {
      Logger.log('deactivatePoolInRoutes_ failed (non-blocking): ' + deactivateErr);
    }
  }

  // Operational schedule sync when a pool_id is first assigned.
  // Weekly service gets a Routes placeholder; startups get dated Scheduled_Visits.
  if (payload.pool_id && String(payload.pool_id).trim()) {
    try {
      syncQuoteOperationalSchedule_(headers, data[rowIdx - 1], String(payload.pool_id).trim());
    } catch(routesErr) {
      Logger.log('Operational schedule sync failed (non-blocking): ' + routesErr);
    }
  }

  try {
    syncQuoteToNormalized_(payload.quote_id);
  } catch(syncErr) {
    softSetCell_(sheet, rowIdx, 'migration_status', 'SYNC_FAILED');
    softSetCell_(sheet, rowIdx, 'migration_notes', String(syncErr));
    logMigration_('handleUpdateLead_', 'ERROR', 'Normalized sync failed for ' + payload.quote_id, 1, syncErr);
  }

  return { ok: true };
}




function handleSetWeeklyGoal_(newGoal) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const settings = ss.getSheetByName("Settings");
  settings.getRange("A2").setValue(newGoal);
  return { ok: true };
}

// Appends a column to a sheet if it isn't already there, and returns the current
// header row. Needed because handleSaveQuote_'s set() silently no-ops on unknown
// columns — without this, writing a newly added field fails with no error at all.
function ensureColumn_(sheet, columnName) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var exists = headers.some(function (h) {
    return String(h).trim().toLowerCase() === String(columnName).trim().toLowerCase();
  });
  if (!exists) {
    sheet.getRange(1, lastCol + 1).setValue(columnName);
    headers = sheet.getRange(1, 1, 1, lastCol + 1).getValues()[0];
  }
  return headers;
}

function handleSaveQuote_(payload) {
  try {
    ensureNormalizedSalesSheets_();
    const sheet = getCrmSheet_();
    // Self-migrating: adds scope_items_json the first time a quote is saved after
    // this ships, so no manual sheet edit is required.
    ensureColumn_(sheet, 'scope_items_json');
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    const quoteId = "Q-" + Utilities.getUuid().substring(0, 8).toUpperCase();
    const row = new Array(headers.length).fill("");

    const set = (col, val) => {
      const idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(col.toLowerCase().trim());
      if (idx !== -1) row[idx] = val !== undefined && val !== null ? val : "";
    };

    set('quote_id',                    quoteId);
    set('first_name',                  payload.first_name);
    set('last_name',                   payload.last_name);
    set('email',                       payload.email);
    set('phone',                       payload.phone);
    set('address',                     payload.address);
    set('city',                        payload.city);
    set('zip_code',                    payload.zip_code);
    set('service',                     payload.service);
    set('pool_type',                   payload.pool_type);
    set('size',                        payload.size);
    set('material',                    payload.material);
    set('spa',                         payload.spa);
    set('finish',                      payload.finish);
    set('debris',                      payload.debris);
    set('has_robot',                   payload.has_robot);
    set('high_sun_exposure',           payload.high_sun_exposure);
    set('has_pets',                    payload.has_pets);
    set('startup_chemical_work',       payload.startup_chemical_work);
    set('startup_programming',         payload.startup_programming);
    set('startup_pool_school',         payload.startup_pool_school);
    set('startup_company',             payload.startup_company);
    set('startup_company_email',       payload.startup_company_email);
    set('sponsored_by_mcp',            payload.sponsored_by_mcp);
    set('startup_start_date',          payload.startup_start_date);
    set('startup_total_days',          payload.startup_total_days);
    set('repair_job_type',             payload.repair_job_type);
    set('repair_company_name',         payload.repair_company_name);
    set('repair_company_address',      payload.repair_company_address);
    set('repair_job_description',      payload.repair_job_description);
    set('repair_invoice_amount',       payload.repair_invoice_amount);
    set('repair_sku',                  payload.repair_sku);
    set('client_id',                   payload.client_id || '');
    set('location_id',                 payload.location_id || '');
    set('travel_fee',                  payload.travel_fee);
    set('travel_one_way_miles',        payload.travel_one_way_miles);
    set('travel_round_trip_miles',     payload.travel_round_trip_miles);
    set('travel_billable_round_trip_miles', payload.travel_billable_round_trip_miles);
    set('distance_source',             payload.distance_source);
    set('service_subtotal',            payload.service_subtotal);
    set('discount_type',               payload.discount_type);
    set('discount_value',              payload.discount_value);
    set('discount_amount',             payload.discount_amount);
    set('discounted_service_subtotal', payload.discounted_service_subtotal);
    set('quote_subtotal',              payload.quote_subtotal);
    set('sales_tax',                   payload.sales_tax);
    set('total_with_tax',              payload.total_with_tax);
    set('chem_cost_est',               payload.chem_cost_est);
    set('net_profit_est',              payload.net_profit_est);
    set('margin_percent',              payload.margin_percent);
    set('specs_summary',               payload.specs_summary);
    set('quickbooks_skus',             payload.quickbooks_skus);
    set('quickbooks_item_names',       payload.quickbooks_item_names);
    set('created_by',                  payload.created_by);
    set('quote_source',                payload.quote_source);
    set('quote_version',               payload.quote_version);
    // Resolved Scope of Work for THIS quote — the toggles plus any one-off items
    // the admin typed. Persisting it here is what makes the proposal PDF, the
    // signing page and the signed contract show the same scope. Sent as
    // scope_items (array of labels) by the quote tool.
    set('scope_items_json',            resolveScopeItemsJson_(payload));
    set('status',                      payload.status || 'UNSENT');
    set('sales_flow',                  payload.sales_flow || 'proposal_first');
    set('signature_required',          payload.signature_required === false || String(payload.signature_required).toUpperCase() === 'FALSE' ? 'FALSE' : 'TRUE');
    set('activation_method',           payload.activation_method || '');
    set('contact_log',                 '[]');
    set('timestamp',                   new Date().toISOString());
    set('source_sheet',                'Quotes');
    set('area',                        payload.area || '');

    // ── MCP-sponsored Pool Startup: auto-assign pool_id so the Routes row and
    // 3 scheduled visits are created immediately, without a manual activation step.
    // (standard activation path already handles this via handleUpdateLead_ + pool_id)
    let _autoPoolId = null;
    if (String(payload.service || '').toLowerCase().includes('startup') &&
        payload.startup_start_date) {
      try {
        _autoPoolId = _mcpsNextPoolId_(sheet);
        set('pool_id', _autoPoolId);   // writes into row[] if pool_id column exists
      } catch (pidErr) {
        Logger.log('handleSaveQuote_: pool_id auto-generate failed: ' + pidErr);
      }
    } else if (String(payload.service || '').toLowerCase().includes('green')) {
      // Green-to-Clean: auto-assign pool_id so the pool appears in service log
      // dropdown and can be scheduled via schedule_gtc_visit.
      try {
        _autoPoolId = _mcpsNextPoolId_(sheet);
        set('pool_id', _autoPoolId);
      } catch (pidErr) {
        Logger.log('handleSaveQuote_: G2C pool_id auto-generate failed: ' + pidErr);
      }
    } else if (String(payload.activation_method || '').toUpperCase() === 'ADMIN_OVERRIDE' ||
               String(payload.signature_required || '').toUpperCase() === 'FALSE') {
      // Admin override: make a normal service operational immediately. Route
      // manager can then place this pool because Quotes has ACTIVE_CUSTOMER + pool_id.
      try {
        _autoPoolId = _mcpsNextPoolId_(sheet);
        set('pool_id', _autoPoolId);
      } catch (pidErr) {
        Logger.log('handleSaveQuote_: override pool_id auto-generate failed: ' + pidErr);
      }
    } else if (String(payload.service || '').toLowerCase() === 'repair_job' && payload.pool_id) {
      // Existing-customer repair: attach to their real pool_id for legacy lookups
      // (getQuoteByPoolId_, Pool Profile, etc.) without minting a new one or
      // triggering syncQuoteOperationalSchedule_ (the pool already has a schedule).
      try {
        set('pool_id', payload.pool_id);
      } catch (pidErr) {
        Logger.log('handleSaveQuote_: repair existing pool_id set failed: ' + pidErr);
      }
    }

    sheet.appendRow(row);
    const appendedRowNum = sheet.getLastRow();

    if (_autoPoolId) {
      try {
        syncQuoteOperationalSchedule_(headers, row, _autoPoolId);
      } catch (routesErr) {
        Logger.log('handleSaveQuote_: Routes/visits create failed (non-blocking): ' + routesErr);
      }
    }

    // Repair quotes also create a dispatchable work order for the Jobs tab
    if (String(payload.service || '').toLowerCase() === 'repair_job') {
      try {
        createRepairOrderFromQuote_(payload, quoteId);
      } catch (roErr) {
        Logger.log('handleSaveQuote_: repair order create failed (non-blocking): ' + roErr);
      }
    }

    let normalized = null;
    try {
      normalized = syncQuoteToNormalized_(quoteId);
    } catch(syncErr) {
      softSetCell_(sheet, appendedRowNum, 'migration_status', 'NORMALIZED_WRITE_FAILED');
      softSetCell_(sheet, appendedRowNum, 'migration_notes', String(syncErr));
      logMigration_('handleSaveQuote_', 'ERROR', 'Normalized write failed for ' + quoteId, 1, syncErr);
      return jsonResponse_({
        ok: true,
        quote_id: quoteId,
        pool_id: _autoPoolId || null,
        warning: 'Quote saved to legacy Quotes, but normalized write failed: ' + String(syncErr)
      });
    }

    return jsonResponse_({
      ok: true,
      quote_id: quoteId,
      pool_id: _autoPoolId || null,
      client_id: normalized && normalized.client_id,
      location_id: normalized && normalized.location_id,
      proposal_id: normalized && normalized.proposal_id,
      proposal_number: normalized && normalized.proposal_number,
      agreement_id: normalized && normalized.agreement_id,
      service_account_id: normalized && normalized.service_account_id
    });
  } catch (e) {
    return jsonResponse_({ ok: false, error: "handleSaveQuote_ Error: " + e.toString() });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// QUOTE INFO UPDATE
// ──────────────────────────────────────────────────────────────────────────────

function handleUpdateQuoteInfo_(payload) {
  try {
    const sheet = getCrmSheet_();
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    const idCol = getColIdx_(headers, 'quote_id');
    let rowNum = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]).trim() === String(payload.quote_id).trim()) {
        rowNum = i + 1;
        break;
      }
    }
    if (rowNum === -1) return { ok: false, error: 'Quote not found: ' + payload.quote_id };

    ['first_name','last_name','email','phone','address','city','zip_code'].forEach(col => {
      if (payload[col] !== undefined) {
        const idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(col);
        if (idx !== -1) sheet.getRange(rowNum, idx + 1).setValue(payload[col]);
      }
    });

    try {
      syncQuoteToNormalized_(payload.quote_id);
    } catch(syncErr) {
      softSetCell_(sheet, rowNum, 'migration_status', 'SYNC_FAILED');
      softSetCell_(sheet, rowNum, 'migration_notes', String(syncErr));
      logMigration_('handleUpdateQuoteInfo_', 'ERROR', 'Normalized sync failed for ' + payload.quote_id, 1, syncErr);
    }

    return { ok: true };
  } catch(e) {
    return { ok: false, error: 'handleUpdateQuoteInfo_ Error: ' + e.toString() };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// CONTRACT GENERATION
// ──────────────────────────────────────────────────────────────────────────────

function handleGenerateContract_(quoteId) {
  try {
    const sheet = getCrmSheet_();
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    const idCol = headers.map(h => String(h).toLowerCase().trim()).indexOf('quote_id');
    let rowNum = -1;
    let rowData = null;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]).trim() === String(quoteId).trim()) {
        rowNum = i + 1;
        rowData = data[i];
        break;
      }
    }
    if (rowNum === -1 || !rowData) return { ok: false, error: 'Quote not found: ' + quoteId };

    const get = (col) => {
      const idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(col.toLowerCase().trim());
      return idx !== -1 ? rowData[idx] : '';
    };
    const setCell = (col, val) => {
      const idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(col.toLowerCase().trim());
      if (idx !== -1) sheet.getRange(rowNum, idx + 1).setValue(val);
    };

    const props = PropertiesService.getScriptProperties();
    const templateId = props.getProperty('CONTRACT_TEMPLATE_ID');
    const folderId   = props.getProperty('CONTRACT_FOLDER_ID');
    if (!templateId) return { ok: false, error: 'CONTRACT_TEMPLATE_ID not set in Script Properties.' };
    if (!folderId)   return { ok: false, error: 'CONTRACT_FOLDER_ID not set in Script Properties.' };

    const fullName = [get('first_name'), get('last_name')].filter(Boolean).join(' ').trim() || 'Customer';
    const fileName = 'Pool Service Agreement - ' + fullName + ' - #' + quoteId;

    const templateFile = DriveApp.getFileById(templateId);
    const folder       = DriveApp.getFolderById(folderId);
    const tempDoc      = templateFile.makeCopy('TEMP_DOC_' + fileName, folder);
    const doc          = DocumentApp.openById(tempDoc.getId());
    const body         = doc.getBody();

    body.replaceText('{{DATE}}',      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM d, yyyy'));
    body.replaceText('{{CLIENT_NAME}}', fullName);
    body.replaceText('{{EMAIL}}',     String(get('email')  || ''));
    body.replaceText('{{PHONE}}',     String(get('phone')  || ''));
    body.replaceText('{{ADDRESS}}',   String(get('address') || ''));
    body.replaceText('{{SERVICE_TYPE}}', String(get('service') || ''));
    body.replaceText('{{TOTAL}}',     '$' + Number(get('total_with_tax')  || 0).toFixed(2));
    body.replaceText('{{POOL_SPECS}}', String(get('specs_summary') || ''));
    body.replaceText('{{MONTHLY_RATE}}', '$' + Number(get('quote_subtotal')  || 0).toFixed(2));
    body.replaceText('{{SALES_TAX}}', '$' + Number(get('sales_tax')  || 0).toFixed(2));
    body.replaceText('{{QUOTE_ID}}',  quoteId || 'N/A');

    const zip      = String(get('zip_code') || '');
    const city     = String(get('city')     || '');
    const location = [city, zip].filter(Boolean).join(', ');
    body.replaceText('{{ZIP_CODE}}',  zip      || 'N/A');
    body.replaceText('{{CITY}}',      city     || 'N/A');
    body.replaceText('{{LOCATION}}',  location || 'N/A');
    body.replaceText('{{TRAVEL_FEE}}', '$' + Number(get('travel_fee') || 0).toFixed(2));

    const startDateRaw = get('contract_start_date');
    let startDateFormatted = 'TBD';
    if (startDateRaw) {
      try {
        startDateFormatted = Utilities.formatDate(new Date(startDateRaw), Session.getScriptTimeZone(), 'MMMM d, yyyy');
      } catch(_) {
        startDateFormatted = String(startDateRaw);
      }
    }
    body.replaceText('{{CONTRACT_START_DATE}}', startDateFormatted);

    doc.saveAndClose();

    const pdfBlob    = tempDoc.getAs(MimeType.PDF).setName(fileName + '.pdf');
    const pdfFile    = folder.createFile(pdfBlob);
    tempDoc.setTrashed(true);

    const fileId            = pdfFile.getId();
    const driveUrl          = pdfFile.getUrl();
    const directDownloadUrl = 'https://drive.google.com/uc?export=download&id=' + fileId;

    setCell('contract_generated',    'Yes');
    setCell('contract_file_id',      fileId);
    setCell('contract_url',          driveUrl);
    setCell('contract_download_url', directDownloadUrl);
    setCell('contract_status',       'CONTRACT_GENERATED');

    let normalized = null;
    try {
      normalized = syncQuoteToNormalized_(quoteId);
    } catch(syncErr) {
      logMigration_('handleGenerateContract_', 'ERROR', 'Normalized sync failed for ' + quoteId, 1, syncErr);
    }

    return {
      ok: true,
      contract_url: driveUrl,
      contract_download_url: directDownloadUrl,
      file_id: fileId,
      agreement_id: normalized && normalized.agreement_id
    };
  } catch(e) {
    return { ok: false, error: 'handleGenerateContract_ Error: ' + e.toString() };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// CONTRACT SENDING (fires Zapier webhook → Drive → SignRequest → Sheet update)
// ──────────────────────────────────────────────────────────────────────────────

function handleSendContract_(quoteId) {
  try {
    const sheet = getCrmSheet_();
    const data  = sheet.getDataRange().getValues();
    const headers = data[0];

    const idCol = headers.map(h => String(h).toLowerCase().trim()).indexOf('quote_id');
    let rowNum = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]).trim() === String(quoteId).trim()) { rowNum = i + 1; break; }
    }
    if (rowNum === -1) return { ok: false, error: 'Quote not found: ' + quoteId };

    const get = col => {
      const idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(col.toLowerCase().trim());
      return idx !== -1 ? data[rowNum - 1][idx] : '';
    };
    const setCell = (col, val) => {
      const idx = headers.map(h => String(h).toLowerCase().trim()).indexOf(col.toLowerCase().trim());
      if (idx !== -1) sheet.getRange(rowNum, idx + 1).setValue(val);
    };

    const webhookUrl = PropertiesService.getScriptProperties().getProperty('ZAPIER_CONTRACT_WEBHOOK');
    if (!webhookUrl) return { ok: false, error: 'ZAPIER_CONTRACT_WEBHOOK not set in Script Properties.' };

    const sentAt = new Date().toISOString();

    // Extract file ID from Drive URL (contract_file_id column may not exist in sheet)
    const contractUrl = get('contract_url');
    const fileIdMatch = contractUrl.match(/\/d\/([a-zA-Z0-9_\-]+)/);
    const contractFileId = fileIdMatch ? fileIdMatch[1] : get('contract_file_id');

    let normalized = null;
    try {
      normalized = syncQuoteToNormalized_(quoteId);
    } catch(syncErr) {
      logMigration_('handleSendContract_', 'ERROR', 'Normalized sync failed before send for ' + quoteId, 1, syncErr);
    }
    const agreement = normalized && normalized.agreement_id
      ? findRowByValue_(ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS), 'agreement_id', normalized.agreement_id)
      : null;

    const zapPayload = {
      row_number:       rowNum,
      quote_id:         get('quote_id'),
      agreement_id:     normalized && normalized.agreement_id || '',
      agreement_number: agreement && agreement.agreement_number || '',
      first_name:       get('first_name'),
      last_name:        get('last_name'),
      email:            get('email'),
      contract_file_id: contractFileId,
      url:              contractUrl,
      send_contract:    'true',    // string — Zapier filter uses text match
      send_contract_at: sentAt,
      // sent_at intentionally omitted — Zapier filter checks "Does not exist"
      status:           get('status')
    };

    UrlFetchApp.fetch(webhookUrl, {
      method:           'post',
      contentType:      'application/json',
      payload:          JSON.stringify(zapPayload),
      muteHttpExceptions: true
    });

    // Update Quotes sheet columns
    setCell('send_contract',    true);
    setCell('send_contract_at', sentAt);
    setCell('status',           'SENT');

    try {
      syncQuoteToNormalized_(quoteId);
    } catch(syncErr) {
      logMigration_('handleSendContract_', 'ERROR', 'Normalized sync failed for ' + quoteId, 1, syncErr);
    }

    return { ok: true, sent_at: sentAt };
  } catch(e) {
    return { ok: false, error: 'handleSendContract_ Error: ' + e.toString() };
  }
}

// Sets route_status = 'inactive' in the Routes sheet for a given pool_id.
// Called when a quote is marked COMPLETED_JOB or LOST so the pool drops off the schedule.
function deactivatePoolInRoutes_(poolId) {
  if (!poolId) return;
  const ROUTES_SS_ID = "1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM";
  const sheet = SpreadsheetApp.openById(ROUTES_SS_ID).getSheetByName('Routes');
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;
  const headers = data[0].map(h => String(h).toLowerCase().trim());
  const poolIdCol    = headers.indexOf('pool_id');
  const routeStCol   = headers.indexOf('route_status');
  if (poolIdCol === -1 || routeStCol === -1) return;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][poolIdCol]).trim() === String(poolId).trim()) {
      sheet.getRange(i + 1, routeStCol + 1).setValue('inactive');
      Logger.log('deactivatePoolInRoutes_: set inactive for pool ' + poolId);
      return;
    }
  }
  Logger.log('deactivatePoolInRoutes_: pool not found in Routes: ' + poolId);
}

// ──────────────────────────────────────────────────────────────────────────────
// Operational schedule sync rules:
// - Weekly Full Service gets a Routes row with UNSCHEDULED/UNASSIGNED so it can
//   be placed on the permanent weekly route.
// - Pool Startup gets dated Scheduled_Visits only. It is a short project, not a
//   recurring route stop.
// - Green-to-Clean keeps its existing route placeholder flow.
// ──────────────────────────────────────────────────────────────────────────────
function syncQuoteOperationalSchedule_(quoteHeaders, quoteRow, poolId) {
  const qIdx = (col) => quoteHeaders.map(h => String(h).toLowerCase().trim()).indexOf(col.toLowerCase().trim());
  const get = (col) => { const i = qIdx(col); return i !== -1 ? String(quoteRow[i] || '').trim() : ''; };
  const service = get('service').toLowerCase();
  if (!poolId || !service) return;

  if (service.indexOf('startup') !== -1) {
    addStartupPoolToRoutes_(quoteHeaders, quoteRow, poolId);
  } else if (service.indexOf('green') !== -1) {
    addGtcPoolToRoutes_(quoteHeaders, quoteRow, poolId);
  } else if (service.indexOf('weekly full service') !== -1) {
    addWeeklyPoolToRoutes_(quoteHeaders, quoteRow, poolId);
  }
}

function addStartupPoolToRoutes_(quoteHeaders, quoteRow, poolId) {
  // Helper: read a column from the quote row (case-insensitive)
  const qIdx = (col) => quoteHeaders.map(h => String(h).toLowerCase().trim()).indexOf(col.toLowerCase().trim());
  const get  = (col) => { const i = qIdx(col); return i !== -1 ? String(quoteRow[i] || '').trim() : ''; };

  // Only proceed for Pool Startup service type
  const service = get('service');
  if (!service.toLowerCase().includes('startup')) return;

  // Build customer data from the quote row
  const firstName    = get('first_name');
  const lastName     = get('last_name');
  const startupDate  = get('startup_start_date');
  const customerName = [firstName, lastName].filter(Boolean).join(' ').trim();

  // Generate 3 one-time startup visits in Scheduled_Visits. This is idempotent
  // by pool_id + visit_type so re-saving an active startup does not duplicate it.
  try {
    const svBase = {
      pool_id:       poolId,
      customer_name: customerName,
      service_type:  'Pool Startup',
      status:        'scheduled',
      created_by:    ''   // auth doesn't flow into this helper; left empty
    };
    [
      { visit_type: 'startup_day_1', offset: 0 },
      { visit_type: 'startup_day_2', offset: 1 },
      { visit_type: 'startup_day_3', offset: 2 }
    ].forEach(function(v) {
      createScheduledVisitIfMissing_(poolId, v.visit_type, Object.assign({}, svBase, {
        visit_type:     v.visit_type,
        scheduled_date: svAddDays_(startupDate, v.offset)
      }));
    });
    Logger.log('addStartupPoolToRoutes_: created 3 startup visits for ' + poolId);
  } catch (svErr) {
    Logger.log('addStartupPoolToRoutes_: startup visit creation failed (non-blocking): ' + svErr);
  }

  Logger.log('addStartupPoolToRoutes_: scheduled startup visits for ' + poolId + ' (' + customerName + ')');
}

function createScheduledVisitIfMissing_(poolId, visitType, data) {
  const sheet = ensureScheduledVisitsSheet_();
  if (sheet.getLastRow() > 1) {
    const rows = sheet.getDataRange().getValues();
    const h = rows[0].map(x => String(x || '').trim().toLowerCase().replace(/ /g, '_'));
    const pidCol = h.indexOf('pool_id');
    const vtCol = h.indexOf('visit_type');
    const stCol = h.indexOf('status');
    for (let i = 1; i < rows.length; i++) {
      const pid = String(pidCol !== -1 ? rows[i][pidCol] : '').trim();
      const vt = String(vtCol !== -1 ? rows[i][vtCol] : '').trim();
      const st = String(stCol !== -1 ? rows[i][stCol] : '').trim().toLowerCase();
      if (pid === String(poolId).trim() && vt === String(visitType).trim() && st !== 'cancelled') {
        return { ok: true, skipped: true, row: i + 1 };
      }
    }
  }
  return createScheduledVisit_(data);
}

function addWeeklyPoolToRoutes_(quoteHeaders, quoteRow, poolId) {
  const ROUTES_SS_ID = "1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM";
  const qIdx = (col) => quoteHeaders.map(h => String(h).toLowerCase().trim()).indexOf(col.toLowerCase().trim());
  const get  = (col) => { const i = qIdx(col); return i !== -1 ? String(quoteRow[i] || '').trim() : ''; };

  const service = get('service');
  if (service.toLowerCase().indexOf('weekly full service') === -1) return;

  const routesSs = SpreadsheetApp.openById(ROUTES_SS_ID);
  const routesSheet = routesSs.getSheetByName('Routes');
  if (!routesSheet) { Logger.log('addWeeklyPoolToRoutes_: Routes sheet not found'); return; }

  const ensureRoutesCol = (name) => {
    const hdrs = routesSheet.getRange(1, 1, 1, routesSheet.getLastColumn()).getValues()[0]
      .map(h => String(h || '').trim().toLowerCase().replace(/ /g, '_'));
    let idx = hdrs.indexOf(name);
    if (idx === -1) {
      idx = routesSheet.getLastColumn();
      routesSheet.getRange(1, idx + 1).setValue(name);
    }
    return idx;
  };
  // pin_reason / pinned_at live past column J. They survive a recalculation only
  // because captureRouteExtras_ now carries extra columns by pool_id — before
  // that fix, calculateRoutes() blanked everything past J on every run.
  ['pool_id', 'customer_name', 'address', 'city', 'service', 'route_status', 'day_of_week', 'operator', 'maps_link', 'lat', 'lng', 'pinned', 'pin_reason', 'pinned_at'].forEach(ensureRoutesCol);

  const rData = routesSheet.getDataRange().getValues();
  const rHeaders = rData[0].map(h => String(h || '').trim().toLowerCase().replace(/ /g, '_'));
  const rIdx = (col) => rHeaders.indexOf(col);
  const pidCol = rIdx('pool_id');
  if (pidCol !== -1) {
    for (let i = 1; i < rData.length; i++) {
      if (String(rData[i][pidCol] || '').trim() === String(poolId).trim()) {
        Logger.log('addWeeklyPoolToRoutes_: ' + poolId + ' already in Routes — skipping');
        return;
      }
    }
  }

  const firstName    = get('first_name');
  const lastName     = get('last_name');
  const address      = get('address');
  const city         = get('city');
  const customerName = [firstName, lastName].filter(Boolean).join(' ').trim();
  const mapsUrl      = 'https://www.google.com/maps/search/?api=1&query=' +
    encodeURIComponent(address + (city ? ', ' + city : '') + ', TX');

  const newRow = new Array(rHeaders.length).fill('');
  const setR = (col, val) => { const i = rIdx(col); if (i !== -1) newRow[i] = val; };
  setR('pool_id',       poolId);
  setR('customer_name', customerName);
  setR('address',       address);
  setR('city',          city);
  setR('service',       service || 'Weekly Full Service');
  setR('route_status',  'weekly');

  // Automatic day + technician assignment (AutoAssign.js). Returns null whenever
  // the feature is off, no eligible technician is configured, or anything at all
  // goes wrong — in which case this falls back to the original
  // UNSCHEDULED/UNASSIGNED placeholder and the pool lands in the manual routing
  // queue exactly as before. Signing must never fail because of scheduling.
  var assignment = null;
  try {
    if (typeof autoAssignWeeklyPool_ === 'function') {
      // The weekday the customer picked off the Starts calendar, so the engine
      // assigns the day we actually offered them. Callers reach here through
      // activateQuoteServiceFromAgreement_, which re-reads the quote AFTER
      // handleSignAgreement_ stores the request — so this row is current.
      // ⚠️ Reads requested_start_date ONLY — never requested_start_date_hint.
      // A hint means the customer chose a WEEK and was shown no weekday; turning
      // it into a preferred day would manufacture a commitment nobody made.
      // committed_service_day wins when present: it is the day we actually
      // displayed, which survives an admin moving the date.
      var committed = String(get('committed_service_day') || '').trim().toUpperCase();
      var preferredDay = committed || ((typeof aaWeekdayFromDate_ === 'function')
        ? aaWeekdayFromDate_(get('requested_start_date')) : '');
      assignment = autoAssignWeeklyPool_({
        address: [address, city].filter(Boolean).join(', '),
        // Zone inputs: the ZIP resolves the service area without geocoding, and
        // location_id carries any per-location override an admin has set for an
        // address that sits in the wrong ZIP.
        zip: get('zip_code'),
        locationId: get('location_id'),
        preferredDay: preferredDay
      });
    }
  } catch (assignErr) {
    Logger.log('addWeeklyPoolToRoutes_: auto-assign failed (non-blocking): ' + assignErr);
    assignment = null;
  }

  setR('day_of_week',   assignment ? assignment.day : 'UNSCHEDULED');
  setR('operator',      assignment ? assignment.operator : 'UNASSIGNED');
  setR('maps_link',     mapsUrl);
  // Store the geocode the assignment already paid for. Writing 0,0 here left every
  // newly signed pool invisible to clustering until the next full recalculation.
  setR('lat',           assignment && assignment.lat ? assignment.lat : 0);
  setR('lng',           assignment && assignment.lng ? assignment.lng : 0);
  // ⚠️ Pinned by DEFAULT. Routes are not bulk-refreshed in practice, because
  // moving a customer means telling them — so stability is the real default and
  // the code should say so. calculateRoutes() skips pinned weekly pools, which
  // narrows a recalculation to what it should be doing: placing new and
  // unassigned pools rather than reshuffling served customers.
  setR('pinned',        'TRUE');
  setR('pin_reason',    assignment && assignment.day ? 'promised_at_signing' : 'new_pool');
  setR('pinned_at',     nowIso_());

  routesSheet.appendRow(newRow);
  try { CacheService.getScriptCache().remove('unassigned_pools'); } catch(e) {}

  // B7 — turn the promised date into a real scheduled stop, so it shows on the
  // route board that week instead of living as a note on a quote.
  //
  // ⚠️ Only when an actual DATE was promised. Preferred-week mode stores
  // requested_start_week and no date, so there is nothing to schedule and
  // nothing is created — inventing a date would be a promise nobody made.
  //
  // ensureWeeklyServiceVisit_ (not createScheduledVisit_) because signing is
  // retried on network failure and the raw creator has no dedupe guard.
  try {
    var promisedDate = String(get('requested_start_date') || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(promisedDate) &&
        typeof ensureWeeklyServiceVisit_ === 'function') {
      ensureWeeklyServiceVisit_(poolId, promisedDate, {
        customer_name: customerName,
        service_type: service,
        assigned_technician: assignment ? assignment.operator : '',
        created_by: 'signing'
      });
    }
  } catch (svErr) {
    Logger.log('addWeeklyPoolToRoutes_: first visit not scheduled (non-blocking): ' + svErr);
  }

  if (assignment) {
    Logger.log('addWeeklyPoolToRoutes_: auto-assigned ' + poolId + ' to ' +
      assignment.operator + ' on ' + assignment.day);
    if (assignment.exceptions && assignment.exceptions.length) {
      // PERSIST FIRST, THEN EMAIL. These objects used to exist only inside the
      // alert email — once it was archived the problem was invisible, and an
      // Action Queue card would have had nothing to read.
      try {
        if (typeof recordAssignmentExceptions_ === 'function') {
          recordAssignmentExceptions_(poolId, get('quote_id'), assignment.exceptions);
        }
      } catch (exErr) {
        Logger.log('addWeeklyPoolToRoutes_: could not persist exceptions (non-blocking): ' + exErr);
      }
      // Alert AFTER the row is written and the lock released — never during.
      if (typeof sendAssignmentExceptionAlert_ === 'function') {
        sendAssignmentExceptionAlert_({
          customerName: customerName, poolId: poolId,
          operator: assignment.operator, day: assignment.day,
          exceptions: assignment.exceptions
        });
      }
    }
  } else {
    Logger.log('addWeeklyPoolToRoutes_: created weekly Routes placeholder for ' + poolId + ' (' + customerName + ')');
  }
}

function repairMissingWeeklyRouteRows_() {
  const sheet = getCrmSheet_();
  if (!sheet || sheet.getLastRow() < 2) return { ok: true, checked: 0, repaired: 0 };
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const h = headers.map(x => String(x || '').trim().toLowerCase().replace(/ /g, '_'));
  const col = name => h.indexOf(name);
  let checked = 0;
  let repaired = 0;

  for (let i = 1; i < data.length; i++) {
    const poolId = String(col('pool_id') !== -1 ? data[i][col('pool_id')] : '').trim();
    const status = String(col('status') !== -1 ? data[i][col('status')] : '').trim().toUpperCase();
    const service = String(col('service') !== -1 ? data[i][col('service')] : '').trim().toLowerCase();
    if (!poolId || status.indexOf('ACTIVE_CUSTOMER') !== 0 || service.indexOf('weekly full service') === -1) continue;
    checked++;
    addWeeklyPoolToRoutes_(headers, data[i], poolId);
    repaired++;
  }

  try { CacheService.getScriptCache().remove('unassigned_pools'); } catch(e) {}
  return { ok: true, checked: checked, repaired: repaired };
}

function TEST_repair_missing_weekly_routes() {
  const res = repairMissingWeeklyRouteRows_();
  Logger.log(JSON.stringify(res, null, 2));
}

// ─── Green-to-Clean: create Routes row (UNSCHEDULED) on quote save ───────────
function addGtcPoolToRoutes_(quoteHeaders, quoteRow, poolId) {
  const ROUTES_SS_ID = "1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM";
  const qIdx = (col) => quoteHeaders.map(h => String(h).toLowerCase().trim()).indexOf(col.toLowerCase().trim());
  const get  = (col) => { const i = qIdx(col); return i !== -1 ? String(quoteRow[i] || '').trim() : ''; };

  const routesSs   = SpreadsheetApp.openById(ROUTES_SS_ID);
  const routesSheet = routesSs.getSheetByName('Routes');
  if (!routesSheet) { Logger.log('addGtcPoolToRoutes_: Routes sheet not found'); return; }

  // Duplicate guard
  if (routesSheet.getLastRow() > 1) {
    const rData  = routesSheet.getDataRange().getValues();
    const rH     = rData[0].map(h => String(h || '').trim().toLowerCase().replace(/ /g, '_'));
    const pidCol = rH.indexOf('pool_id');
    if (pidCol !== -1 && rData.slice(1).some(r => String(r[pidCol] || '').trim() === poolId)) {
      Logger.log('addGtcPoolToRoutes_: ' + poolId + ' already in Routes — skipping');
      return;
    }
  }

  const rHeaders = routesSheet.getRange(1, 1, 1, routesSheet.getLastColumn()).getValues()[0]
    .map(h => String(h || '').trim().toLowerCase().replace(/ /g, '_'));
  const rIdx = (col) => rHeaders.indexOf(col);

  const firstName    = get('first_name');
  const lastName     = get('last_name');
  const address      = get('address');
  const city         = get('city');
  const customerName = [firstName, lastName].filter(Boolean).join(' ').trim();
  const mapsUrl      = 'https://www.google.com/maps/search/?api=1&query=' +
    encodeURIComponent(address + (city ? ', ' + city : '') + ', TX');

  const newRow = new Array(rHeaders.length).fill('');
  const setR = (col, val) => { const i = rIdx(col); if (i !== -1) newRow[i] = val; };

  setR('pool_id',       poolId);
  setR('customer_name', customerName);
  setR('address',       address);
  setR('city',          city);
  setR('service',       'Green-to-Clean Cleaning Service');
  setR('route_status',  'gtc');
  setR('day_of_week',   'UNSCHEDULED');
  setR('operator',      'UNASSIGNED');
  setR('maps_link',     mapsUrl);
  setR('lat',           0);
  setR('lng',           0);
  setR('pinned',        'FALSE');

  routesSheet.appendRow(newRow);
  Logger.log('addGtcPoolToRoutes_: created Routes row for ' + poolId + ' (' + customerName + ')');
}

// ─── Pool ID generator ───────────────────────────────────────────────────────
/**
 * Returns the next sequential MCPS-XXXX pool ID by scanning the Quotes sheet.
 * Mirrors the frontend _nextMcpsPoolId_() logic but runs server-side.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet - the Quotes sheet
 * @returns {string} e.g. "MCPS-0012"
 */
function _mcpsNextPoolId_(sheet) {
  let max = 0;
  if (sheet && sheet.getLastRow() >= 2) {
    const data   = sheet.getDataRange().getValues();
    const h      = data[0].map(function(x) { return String(x || '').toLowerCase().trim(); });
    const pidCol = h.indexOf('pool_id');
    if (pidCol !== -1) {
      for (var i = 1; i < data.length; i++) {
        var m = String(data[i][pidCol] || '').match(/^MCPS-(\d+)$/i);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    }
  }
  return 'MCPS-' + String(max + 1).padStart(4, '0');
}

// ─── Date utility ─────────────────────────────────────────────────────────────
/**
 * Returns a yyyy-MM-dd string offset by n days from dateStr.
 * Returns '' if dateStr is empty or unparseable.
 */
function svAddDays_(dateStr, n) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return '';
  d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, 'America/Chicago', 'yyyy-MM-dd');
}

// ─── Green-to-Clean visit scheduling ─────────────────────────────────────────

function handleScheduleGtcVisit_(payload, auth) {
  if (!payload.pool_id)        return { ok: false, error: 'pool_id required' };
  if (!payload.scheduled_date) return { ok: false, error: 'scheduled_date required' };

  const result = createScheduledVisit_({
    pool_id:             String(payload.pool_id).trim(),
    customer_name:       String(payload.customer_name || '').trim(),
    service_type:        'Green-to-Clean Cleaning Service',
    visit_type:          'one_time',
    scheduled_date:      String(payload.scheduled_date).trim(),
    assigned_technician: String(payload.assigned_technician || '').trim(),
    notes:               String(payload.notes || '').trim(),
    status:              'scheduled',
    created_by:          auth && auth.username ? auth.username : ''
  });

  if (!result.ok) return result;

  const visitsRes = handleGetGtcVisits_(payload.pool_id);
  return { ok: true, visits: visitsRes.visits || [] };
}

function handleGetGtcPools_() {
  try {
    const ss    = SpreadsheetApp.openById(SV_ROUTES_SS_ID);
    const sheet = ss.getSheetByName('Routes');
    if (!sheet || sheet.getLastRow() < 2) return { ok: true, pools: [] };

    const data = sheet.getDataRange().getValues();
    const h    = data[0].map(x => String(x || '').trim().toLowerCase().replace(/ /g, '_'));
    const col  = name => h.indexOf(name);

    const pools = [];
    for (let i = 1; i < data.length; i++) {
      const status = String(col('route_status') !== -1 ? data[i][col('route_status')] : '').trim().toLowerCase();
      if (status !== 'gtc') continue;
      pools.push({
        pool_id:       String(col('pool_id')       !== -1 ? data[i][col('pool_id')]       : '').trim(),
        customer_name: String(col('customer_name') !== -1 ? data[i][col('customer_name')] : '').trim(),
        address:       String(col('address')       !== -1 ? data[i][col('address')]       : '').trim(),
        city:          String(col('city')          !== -1 ? data[i][col('city')]          : '').trim(),
        operator:      String(col('operator')      !== -1 ? data[i][col('operator')]      : '').trim(),
      });
    }
    return { ok: true, pools };
  } catch(e) {
    Logger.log('handleGetGtcPools_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}

function handleGetGtcVisits_(poolId) {
  try {
    const ss = SpreadsheetApp.openById(SV_ROUTES_SS_ID);
    const sheet = ss.getSheetByName('Scheduled_Visits');
    if (!sheet || sheet.getLastRow() < 2) return { ok: true, visits: [] };

    const data = sheet.getDataRange().getValues();
    const h    = data[0].map(x => String(x || '').trim().toLowerCase().replace(/ /g, '_'));
    const col  = name => h.indexOf(name);

    const visits = [];
    for (let i = 1; i < data.length; i++) {
      const pid = String(col('pool_id') !== -1 ? data[i][col('pool_id')] : '').trim();
      if (pid !== String(poolId).trim()) continue;
      const vtype = String(col('visit_type') !== -1 ? data[i][col('visit_type')] : '').trim();
      if (vtype !== 'one_time') continue;

      const rawDate = col('scheduled_date') !== -1 ? data[i][col('scheduled_date')] : '';
      let dateStr = '';
      if (rawDate instanceof Date) {
        dateStr = Utilities.formatDate(rawDate, 'America/Chicago', 'yyyy-MM-dd');
      } else {
        const m = String(rawDate || '').match(/(\d{4}-\d{2}-\d{2})/);
        if (m) dateStr = m[1];
      }

      visits.push({
        scheduled_visit_id:  String(col('scheduled_visit_id') !== -1 ? data[i][col('scheduled_visit_id')] : ''),
        scheduled_date:      dateStr,
        assigned_technician: String(col('assigned_technician') !== -1 ? data[i][col('assigned_technician')] : ''),
        status:              String(col('status') !== -1 ? data[i][col('status')] : ''),
        notes:               String(col('notes') !== -1 ? data[i][col('notes')] : ''),
      });
    }

    visits.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
    return { ok: true, visits };
  } catch(e) {
    Logger.log('handleGetGtcVisits_ error: ' + e);
    return { ok: false, error: String(e) };
  }
}
