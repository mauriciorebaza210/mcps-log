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
  'notes'
];

const MCPS_PROPOSAL_APPROVAL_HEADERS = [
  'approval_id', 'proposal_id', 'quote_id', 'token', 'status',
  'customer_note', 'sent_at', 'responded_at', 'expires_at', 'created_at',
  'updated_at'
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

function buildProposalScopeHtml_(service, q, options) {
  const s = String(service || '').toLowerCase();
  let items = [];
  const hasSpa = quoteHasSpa_(q);
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
    if (proposalOptionEnabled_(options, 'pool_cleaning', true)) items.push(hasSpa ? 'Pool and spa cleaning and brushing' : 'Pool cleaning and brushing');
    if (proposalOptionEnabled_(options, 'chemical_treatment', true)) items.push('Chemical testing and treatment');
    if (proposalOptionEnabled_(options, 'filter_cleaning', true)) items.push('Filter cleaning and inspection');
    if (proposalOptionEnabled_(options, 'equipment_inspection', true)) items.push('Equipment inspection');
    if (proposalOptionEnabled_(options, 'baskets', true)) items.push('Skimmer and pump basket cleaning');
    if (proposalOptionEnabled_(options, 'service_report', true)) items.push('Service report after each visit');
  }
  if (!items.length) items = [service || 'Pool service'];
  return items.map(function(item) { return '<li>' + htmlEscape_(item) + '</li>'; }).join('');
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
    'https://mcps-log.vercel.app/proposal-approval.html';
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

    const props = PropertiesService.getScriptProperties();
    const webhookUrl = props.getProperty('ZAPIER_PROPOSAL_WEBHOOK');
    if (!webhookUrl) return { ok: false, error: 'ZAPIER_PROPOSAL_WEBHOOK not set in Script Properties.' };

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
      softSetCell_(approvals, approval._rowNum, 'expires_at', value_(approval, 'expires_at') || expires.toISOString());
    }

    const approvalUrl = proposalApprovalUrl_(token, '');
    const zapPayload = {
      quote_id: quoteId,
      proposal_id: proposal.proposal_id,
      proposal_number: proposal.proposal_number,
      first_name: value_(q, 'first_name'),
      last_name: value_(q, 'last_name'),
      email: email,
      phone: value_(q, 'phone'),
      service: value_(q, 'service'),
      total: value_(q, 'total_with_tax'),
      proposal_pdf_url: pdfUrl,
      approval_url: approvalUrl,
      approve_url: proposalApprovalUrl_(token, 'approve'),
      decline_url: proposalApprovalUrl_(token, 'decline'),
      changes_url: proposalApprovalUrl_(token, 'changes_requested'),
      sent_at: now
    };

    UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(zapPayload),
      muteHttpExceptions: true
    });

    softSetCell_(result.proposals, proposal._rowNum, 'status', 'SENT');
    softSetCell_(result.proposals, proposal._rowNum, 'sent_at', now);
    softSetCell_(result.proposals, proposal._rowNum, 'updated_at', now);
    softSetCell_(hit.sheet, hit.rowNum, 'proposal_sent_at', now);
    softSetCell_(hit.sheet, hit.rowNum, 'proposal_approval_url', approvalUrl);
    softSetCell_(hit.sheet, hit.rowNum, 'proposal_number', proposal.proposal_number);
    return { ok: true, sent_at: now, approval_url: approvalUrl, proposal_id: proposal.proposal_id, proposal_number: proposal.proposal_number };
  } catch(e) {
    return { ok: false, error: 'handleSendProposalForApproval_ Error: ' + e.toString() };
  }
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
    const q = hit.object;
    const expired = value_(approval, 'expires_at') && new Date(value_(approval, 'expires_at')).getTime() < new Date().getTime();
    return {
      ok: true,
      expired: !!expired,
      approval: {
        status: value_(approval, 'status') || 'SENT',
        customer_note: value_(approval, 'customer_note'),
        responded_at: value_(approval, 'responded_at')
      },
      proposal: {
        proposal_number: value_(proposal, 'proposal_number'),
        status: value_(proposal, 'status'),
        proposal_pdf_url: value_(proposal, 'proposal_pdf_url'),
        service: value_(proposal, 'service_type') || value_(q, 'service'),
        total: value_(proposal, 'total') || value_(q, 'total_with_tax'),
        sales_tax: value_(proposal, 'sales_tax') || value_(q, 'sales_tax'),
        valid_until: value_(proposal, 'valid_until'),
        customer_name: [value_(q, 'first_name'), value_(q, 'last_name')].filter(Boolean).join(' ').trim() || 'Customer',
        service_address: value_(q, 'address'),
        city_state_zip: [value_(q, 'city'), value_(q, 'zip_code')].filter(Boolean).join(', ')
      }
    };
  } catch(e) {
    return { ok: false, error: 'handleGetProposalApproval_ Error: ' + e.toString() };
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
      company_phone: props.getProperty('MCPS_COMPANY_PHONE') || '(210) 989-0287',
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

function agreementCanActivate_(agreement) {
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
  const existing = findClientForQuote_(q);
  const quoteId = String(value_(q, 'quote_id')).trim();
  const now = nowIso_();
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
  const existing = findLocationForQuote_(clientId, q);
  const now = nowIso_();
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
    service.indexOf('startup') !== -1 || service.indexOf('green') !== -1;
}

function findOrCreateServiceAccountFromQuote_(clientId, locationId, proposalId, q, agreementId) {
  if (!shouldCreateServiceAccountFromQuote_(q)) return '';
  const services = ensureSheet_('Service_Accounts', MCPS_SERVICE_ACCOUNT_HEADERS);
  const quoteId = String(value_(q, 'quote_id')).trim();
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

function findOrCreateServiceAgreementFromQuote_(clientId, locationId, proposalId, q, forceCreate) {
  const agreements = ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS);
  const quoteId = String(value_(q, 'quote_id')).trim();
  const existing = quoteId ? findRowByValue_(agreements, 'source_quote_id', quoteId) : null;
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

function syncQuoteToNormalized_(quoteId) {
  ensureNormalizedSalesSheets_();
  const hit = getQuoteById_(quoteId);
  if (!hit) return { ok: false, error: 'Quote not found: ' + quoteId };
  const q = hit.object;
  const clientId = findOrCreateClientFromQuote_(q);
  const locationId = findOrCreateLocationFromQuote_(clientId, q);
  const proposal = findOrCreateProposalFromQuote_(clientId, locationId, q);
  createProposalItemsIfMissing_(proposal.proposal_id, q);
  const agreementId = findOrCreateServiceAgreementFromQuote_(clientId, locationId, proposal.proposal_id, q, false);
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

function isLeadImportOnlyQuote_(q) {
  const status = String(value_(q, 'status')).trim().toUpperCase();
  if (status !== 'LEAD') return false;
  const service = String(value_(q, 'service')).trim();
  const total = number_(value_(q, 'total_with_tax'));
  const subtotal = number_(value_(q, 'quote_subtotal')) || number_(value_(q, 'service_subtotal'));
  const source = String(value_(q, 'quote_source') || value_(q, 'quote_version') || '').trim();
  return !service && !total && !subtotal && !source;
}

function activateQuoteServiceFromAgreement_(quoteId, signedAt, activationMethod) {
  const hit = getQuoteById_(quoteId);
  if (!hit) return { ok: false, error: 'Quote not found: ' + quoteId };
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

  const sync = syncQuoteToNormalized_(quoteId);
  return Object.assign({ ok: true, quote_id: quoteId, pool_id: poolId }, sync);
}

function handleServiceAgreementSigned_(payload) {
  ensureNormalizedSalesSheets_();
  const agreements = ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS);
  const signedAt = payload.signed_at || nowIso_();
  let agreement = null;
  if (payload.agreement_id) agreement = findRowByValue_(agreements, 'agreement_id', payload.agreement_id);
  if (!agreement && payload.quote_id) agreement = findRowByValue_(agreements, 'source_quote_id', payload.quote_id);
  if (!agreement && payload.signrequest_id) agreement = findRowByValue_(agreements, 'signrequest_id', payload.signrequest_id);

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

  const activate = activateQuoteServiceFromAgreement_(quoteId, signedAt, payload.activation_method || 'SIGNED_AGREEMENT');
  const refreshedAgreement = agreement || findRowByValue_(agreements, 'source_quote_id', quoteId);
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
    return { ok: true, agreements: listSheetRows_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS, {}) };
  }

  if (action === 'get_client_service_agreements') {
    return { ok: true, agreements: listSheetRows_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS, { client_id: payload.client_id }) };
  }

  if (action === 'get_location_service_agreements') {
    return { ok: true, agreements: listSheetRows_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS, { location_id: payload.location_id }) };
  }

  if (action === 'get_service_agreement') {
    const sheet = ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS);
    const key = payload.agreement_id ? 'agreement_id' : (payload.agreement_number ? 'agreement_number' : 'source_quote_id');
    const val = payload.agreement_id || payload.agreement_number || payload.quote_id || payload.source_quote_id;
    const agreement = findRowByValue_(sheet, key, val);
    if (!agreement) return { ok: false, error: 'Service agreement not found' };
    const clean = {};
    Object.keys(agreement).forEach(function(k) { if (k !== '_rowNum') clean[k] = agreement[k]; });
    return { ok: true, agreement: clean };
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
      : findRowByValue_(ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS), 'source_quote_id', payload.quote_id);
    if (!agreement) return { ok: false, error: 'Service agreement not found' };
    if (!agreementCanActivate_(agreement)) return { ok: false, error: 'Agreement is not signed or override-enabled.' };
    return activateQuoteServiceFromAgreement_(agreement.source_quote_id, agreement.signed_at || nowIso_(), agreement.activation_method);
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

function handleSaveQuote_(payload) {
  try {
    ensureNormalizedSalesSheets_();
    const sheet = getCrmSheet_();
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
  ['pool_id', 'customer_name', 'address', 'city', 'service', 'route_status', 'day_of_week', 'operator', 'maps_link', 'lat', 'lng', 'pinned'].forEach(ensureRoutesCol);

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
  setR('day_of_week',   'UNSCHEDULED');
  setR('operator',      'UNASSIGNED');
  setR('maps_link',     mapsUrl);
  setR('lat',           0);
  setR('lng',           0);
  setR('pinned',        'FALSE');

  routesSheet.appendRow(newRow);
  try { CacheService.getScriptCache().remove('unassigned_pools'); } catch(e) {}
  Logger.log('addWeeklyPoolToRoutes_: created weekly Routes placeholder for ' + poolId + ' (' + customerName + ')');
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
