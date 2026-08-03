// StartupRequests.gs
// External pool-builder startup request intake:
//   public:  lookup company by request_token → AI-extract construction sheet photo → submit request
//   admin:   list pending/history → edit fields → approve (creates startup pool via handleSaveQuote_) / reject
// Requests live on the CRM SS in the Startup_Requests sheet; company tokens live on Pool_Companies.

const MCPS_STARTUP_REQUEST_HEADERS = [
  'request_id', 'status', 'pool_company_id', 'company_name',
  'first_name', 'last_name', 'email', 'phone', 'address', 'city', 'zip_code',
  'pool_shape', 'pool_dimensions', 'pool_length_ft', 'pool_width_ft',
  'pool_depth', 'depth_min_ft', 'depth_max_ft', 'spa', 'water_features', 'sheer_descents',
  'pool_area_sqft', 'pool_gallons_est', 'pool_gallons_low', 'pool_gallons_high',
  'pool_gallons_method', 'pool_gallons_confidence', 'pool_gallons_notes',
  'l_leg_count', 'l_leg_length_ft', 'l_leg_width_ft', 'l_overlap_assumption',
  'spa_shape', 'spa_length_ft', 'spa_width_ft', 'spa_diameter_ft', 'spa_depth_ft',
  'spa_gallons_est', 'spa_gallons_low', 'spa_gallons_high', 'spa_shared_circulation',
  'total_gallons_est', 'total_gallons_low', 'total_gallons_high',
  'plaster_type', 'plaster_date',
  'equip_filter', 'equip_pump', 'equip_heater', 'equip_chlorinator', 'equip_salt_system', 'equip_booster',
  'requested_start_date', 'notes',
  'raw_extraction', 'photo_urls', 'reviewed_by_builder',
  'submitted_at', 'approved_at', 'approved_by', 'admin_notes',
  'change_requested_date', 'change_requested_note', 'change_requested_at',
  'quote_id', 'pool_id', 'created_at', 'updated_at'
];

// Builder/admin-editable columns — the only ones accepted from submit/update payloads.
const SR_EDITABLE_FIELDS = [
  'first_name', 'last_name', 'email', 'phone', 'address', 'city', 'zip_code',
  'pool_shape', 'pool_dimensions', 'pool_length_ft', 'pool_width_ft',
  'pool_depth', 'depth_min_ft', 'depth_max_ft', 'spa', 'water_features', 'sheer_descents',
  'pool_area_sqft', 'pool_gallons_est', 'pool_gallons_low', 'pool_gallons_high',
  'pool_gallons_method', 'pool_gallons_confidence', 'pool_gallons_notes',
  'l_leg_count', 'l_leg_length_ft', 'l_leg_width_ft', 'l_overlap_assumption',
  'spa_shape', 'spa_length_ft', 'spa_width_ft', 'spa_diameter_ft', 'spa_depth_ft',
  'spa_gallons_est', 'spa_gallons_low', 'spa_gallons_high', 'spa_shared_circulation',
  'total_gallons_est', 'total_gallons_low', 'total_gallons_high',
  'plaster_type', 'plaster_date',
  'equip_filter', 'equip_pump', 'equip_heater', 'equip_chlorinator', 'equip_salt_system', 'equip_booster',
  'requested_start_date', 'notes'
];

const SR_MAX_PHOTO_B64_LENGTH = 1600000; // ~1.2 MB image
const SR_EXTRACT_VERSION = 'sr-extract-2026-07-06b';
const SR_GAL_PER_CUFT = 7.48;
const SR_OVAL_GALLON_FACTOR = 5.9;
const SR_FREEFORM_FACTOR = 0.85;

const SR_SITE_ORIGIN = 'https://mcps-log.vercel.app';

function getStartupRequestsSheet_() {
  return ensureSheet_('Startup_Requests', MCPS_STARTUP_REQUEST_HEADERS);
}

// ─── Builder notification emails (best-effort, never blocks the mutation) ─────

function srSendBuilderEmail_(toEmail, subject, body) {
  const to = String(toEmail || '').trim();
  if (!to) return; // email is optional on the intake form — silent no-op
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: body });
  } catch (e) {
    Logger.log('srSendBuilderEmail_: failed to send to ' + to + ': ' + e);
  }
}

function srStatusLink_(companyToken, requestId) {
  return SR_SITE_ORIGIN + '/startup-request?t=' + encodeURIComponent(companyToken) + '&r=' + encodeURIComponent(requestId);
}

// ─── Company token ────────────────────────────────────────────────────────────

function findPoolCompanyByToken_(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const sheet = ensureSheet_('Pool_Companies', MCPS_POOL_COMPANY_HEADERS);
  const rows = sheetToObjects_(sheet).rows;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i].request_token || '').trim() === t &&
        String(rows[i].active || 'TRUE').toUpperCase() !== 'FALSE') {
      return rows[i];
    }
  }
  return null;
}

function handleGetStartupRequestLink_(payload, auth) {
  const companyId = String(payload.pool_company_id || '').trim();
  if (!companyId) return { ok: false, error: 'pool_company_id required' };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheet_('Pool_Companies', MCPS_POOL_COMPANY_HEADERS);
    const parsed = sheetToObjects_(sheet);
    const row = parsed.rows.find(function(r) { return String(r.pool_company_id || '').trim() === companyId; });
    if (!row) return { ok: false, error: 'Company not found' };

    let token = String(row.request_token || '').trim();
    if (!token || payload.rotate === true || String(payload.rotate).toLowerCase() === 'true') {
      token = Utilities.getUuid().replace(/-/g, '');
      const colIdx = parsed.headers.indexOf('request_token');
      if (colIdx === -1) return { ok: false, error: 'request_token column missing' };
      sheet.getRange(row._rowNum, colIdx + 1).setValue(token);
    }
    return { ok: true, request_token: token, company_name: row.company_name };
  } finally {
    lock.releaseLock();
  }
}

// ─── Rate limiting (public actions burn AI tokens / sheet writes) ─────────────

function srRateLimitExceeded_(kind, token, max) {
  try {
    const cache = CacheService.getScriptCache();
    const key = 'sr_rl_' + kind + ':' + String(token).slice(0, 40);
    const count = Number(cache.get(key) || 0);
    if (count >= max) return true;
    cache.put(key, String(count + 1), 600); // 10-minute window
    return false;
  } catch (e) {
    return false;
  }
}

// ─── Public: lookup ───────────────────────────────────────────────────────────

function handleStartupRequestLookup_(payload) {
  if (srRateLimitExceeded_('lk', payload.t, 30)) {
    return { ok: false, error: 'Too many attempts — please try again in a few minutes.' };
  }
  const company = findPoolCompanyByToken_(payload.t);
  if (!company) return { ok: false, error: 'Invalid or inactive link' };
  return { ok: true, company_name: company.company_name, pool_company_id: company.pool_company_id, extract_version: SR_EXTRACT_VERSION };
}

// ─── Public: AI extraction (no Drive write — photos persist only at submit) ───

const SR_EXTRACT_PROMPT = [
  'This photo is a handwritten pool construction record sheet from a pool building company.',
  'It may be rotated, skewed, or photographed at an angle — read it as-is.',
  'Extract the fields below and respond with ONLY a JSON object, no other text.',
  'Use an empty string "" for anything not visible or not legible — NEVER guess.',
  'Also list every field name you could not confidently read in "illegible_fields".',
  '',
  '{',
  '  "first_name": "",   // from NAME (first person\'s first name)',
  '  "last_name": "",    // from NAME (may be two people e.g. "Molina/Esparza" — use the first person\'s last name, put the rest in notes)',
  '  "address": "",      // street address only, from ADDRESS',
  '  "city": "",         // from ADDRESS',
  '  "zip_code": "",     // from ADDRESS',
  '  "phone": "",        // from PHONE# — format as 210-555-1234; if multiple, the first',
  '  "email": "",        // from EMAIL',
  '  "pool_shape": "",   // from SPECIFICATIONS, e.g. "Rectangular" or "Freeform"',
  '  "pool_dimensions": "", // from POOL INFO, normalized as length x width in feet, e.g. "18 x 31 ft"',
  '  "pool_length_ft": "", // numeric length in feet derived from pool_dimensions, e.g. "31"',
  '  "pool_width_ft": "", // numeric width in feet derived from pool_dimensions, e.g. "18"',
  '  "pool_depth": "",   // from POOL DEPTH, normalized in feet, e.g. "4-5 ft" or "3.5-6.5 ft"',
  '  "depth_min_ft": "", // numeric shallowest depth in feet, e.g. "4" or "3.5"',
  '  "depth_max_ft": "", // numeric deepest depth in feet, e.g. "5" or "6.5"',
  '  "spa": "",          // "Yes" if SPA has a size/entry, "No" if blank or crossed out',
  '  "water_features": "", // from WATER FEATURES excluding shear/sheer descents; use "No" if that field is blank',
  '  "sheer_descents": "", // from SHEAR DESCENT(S) / sheer descent(s), separate from water_features; use "No" if blank or crossed out',
  '  "l_leg_count": "", // for L-shape notation like "2 - 17 x 34", usually "2"',
  '  "l_leg_length_ft": "", // for L-shape leg length in feet, e.g. "34"',
  '  "l_leg_width_ft": "", // for L-shape leg width in feet, e.g. "17"',
  '  "l_overlap_assumption": "", // use "shared_corner" only if the sheet convention is clear; otherwise ""',
  '  "spa_shape": "", // from SPA, e.g. "Round", "Square", "Rectangular"; if written "7\' Round", use spa_shape "Round" and spa_diameter_ft "7"',
  '  "spa_diameter_ft": "", // for round spa, e.g. "7"',
  '  "spa_length_ft": "", // for square/rectangular spa, e.g. "7"',
  '  "spa_width_ft": "", // for square/rectangular spa, e.g. "7"',
  '  "spa_depth_ft": "", // if visible; if not visible leave blank',
  '  "spa_shared_circulation": "", // "Yes" if spillover/shared circulation is visible, otherwise ""',
  '  "plaster_type": "", // from CUSTOMERS\' SELECTIONS → PLASTER, e.g. "Quartzscape French Gray"',
  '  "plaster_date": "", // from CONSTRUCTION PROCESS → PLASTER date, as yyyy-mm-dd (dates like 6/30/26 are month/day/year 2026)',
  '  "equip_filter": "", // EQUIPMENT section — include brand line if written (e.g. "Hayward Sand")',
  '  "equip_pump": "", // include pump brand when written near the equipment section, e.g. "Pentair 2.75HP VS"',
  '  "equip_heater": "", // for count/checkbox values: 0 means "No", 1 means "Yes", values greater than 1 stay numeric',
  '  "equip_chlorinator": "",',
  '  "equip_salt_system": "", // for count/checkbox values: 0 means "No", 1 means "Yes", values greater than 1 stay numeric',
  '  "equip_booster": "", // for count/checkbox values: 0 means "No", 1 means "Yes", values greater than 1 stay numeric',
  '  "requested_start_date": "", // ONLY from a STARTUP/SCHOOL date or explicit startup request date, as yyyy-mm-dd; ignore construction process requested/completed dates like mobilization, excavation, steel, plumbing, decking, plaster',
  '  "notes": "",        // anything important that fits nowhere else (second customer name, extras, upgrades)',
  '  "illegible_fields": [] // field names above you could not confidently read',
  '}'
].join('\n');

const SR_EXTRACT_TOOL = {
  name: 'record_startup_sheet',
  description: 'Record extracted fields from a pool construction sheet.',
  input_schema: {
    type: 'object',
    properties: {
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      address: { type: 'string' },
      city: { type: 'string' },
      zip_code: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
      pool_shape: { type: 'string' },
      pool_dimensions: { type: 'string' },
      pool_length_ft: { type: 'string' },
      pool_width_ft: { type: 'string' },
      pool_depth: { type: 'string' },
      depth_min_ft: { type: 'string' },
      depth_max_ft: { type: 'string' },
      spa: { type: 'string' },
      water_features: { type: 'string' },
      sheer_descents: { type: 'string' },
      l_leg_count: { type: 'string' },
      l_leg_length_ft: { type: 'string' },
      l_leg_width_ft: { type: 'string' },
      l_overlap_assumption: { type: 'string' },
      spa_shape: { type: 'string' },
      spa_diameter_ft: { type: 'string' },
      spa_length_ft: { type: 'string' },
      spa_width_ft: { type: 'string' },
      spa_depth_ft: { type: 'string' },
      spa_shared_circulation: { type: 'string' },
      plaster_type: { type: 'string' },
      plaster_date: { type: 'string' },
      equip_filter: { type: 'string' },
      equip_pump: { type: 'string' },
      equip_heater: { type: 'string' },
      equip_chlorinator: { type: 'string' },
      equip_salt_system: { type: 'string' },
      equip_booster: { type: 'string' },
      requested_start_date: { type: 'string' },
      notes: { type: 'string' },
      illegible_fields: { type: 'array', items: { type: 'string' } }
    },
    required: [
      'first_name', 'last_name', 'address', 'city', 'zip_code', 'phone', 'email',
      'pool_shape', 'pool_dimensions', 'pool_length_ft', 'pool_width_ft',
      'pool_depth', 'depth_min_ft', 'depth_max_ft', 'spa', 'water_features', 'sheer_descents',
      'l_leg_count', 'l_leg_length_ft', 'l_leg_width_ft', 'l_overlap_assumption',
      'spa_shape', 'spa_diameter_ft', 'spa_length_ft', 'spa_width_ft', 'spa_depth_ft',
      'spa_shared_circulation',
      'plaster_type', 'plaster_date', 'equip_filter', 'equip_pump', 'equip_heater',
      'equip_chlorinator', 'equip_salt_system', 'equip_booster',
      'requested_start_date', 'notes', 'illegible_fields'
    ]
  }
};

function extractStartupSheet_(base64, mimeType) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in Script Properties');

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 2048,
      tools: [SR_EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'record_startup_sheet' },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: base64 } },
          { type: 'text', text: SR_EXTRACT_PROMPT }
        ]
      }]
    }),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) throw new Error('Claude API error ' + code + ': ' + body.substring(0, 200));

  const data = JSON.parse(body);
  return normalizeStartupExtraction_(srClaudeExtraction_(data));
}

function normalizeStartupExtraction_(fields) {
  fields = fields || {};
  if (fields.pool_shape) {
    const shape = String(fields.pool_shape).trim();
    fields.pool_shape = shape
      .replace(/\bfree\s*form\b/i, 'Freeform')
      .replace(/\brectangular\b/i, 'Rectangular')
      .replace(/\bl\s*-?\s*shape\b/i, 'L Shape');
  }
  normalizeStartupDimensions_(fields);
  normalizeStartupDepth_(fields);
  if (!String(fields.water_features || '').trim()) fields.water_features = 'No';
  if (!String(fields.sheer_descents || '').trim()) fields.sheer_descents = 'No';
  if (/she+a?r\s+descent/i.test(String(fields.water_features || ''))) {
    if (String(fields.sheer_descents || '').toLowerCase() === 'no') fields.sheer_descents = fields.water_features;
    fields.water_features = 'No';
  }

  ['equip_heater', 'equip_salt_system', 'equip_booster'].forEach(function(key) {
    fields[key] = normalizeStartupCount_(fields[key]);
  });

  fields.plaster_date = normalizeStartupDate_(fields.plaster_date);
  fields.requested_start_date = normalizeStartupDate_(fields.requested_start_date);
  calculateStartupGallons_(fields);
  return fields;
}

function normalizeStartupDimensions_(fields) {
  const dim = String(fields.pool_dimensions || '').trim();
  let length = srNumber_(fields.pool_length_ft);
  let width = srNumber_(fields.pool_width_ft);
  const shape = String(fields.pool_shape || '').toLowerCase();

  if (srIsLShape_(shape, dim)) {
    const lDims = srParseLShape_(fields);
    if (lDims.count && lDims.length && lDims.width) {
      fields.l_leg_count = srFormatNumber_(lDims.count);
      fields.l_leg_length_ft = srFormatNumber_(lDims.length);
      fields.l_leg_width_ft = srFormatNumber_(lDims.width);
      fields.pool_length_ft = srFormatNumber_(lDims.length);
      fields.pool_width_ft = srFormatNumber_(lDims.width);
      fields.pool_dimensions = srFormatNumber_(lDims.count) + ' - ' + srFormatNumber_(lDims.width) + ' x ' + srFormatNumber_(lDims.length) + ' ft';
      fields.l_overlap_assumption = String(fields.l_overlap_assumption || '').trim() || 'shared_corner';
      return;
    }
  }

  if ((!length || !width) && dim) {
    const nums = dim.match(/\d+(?:\.\d+)?/g) || [];
    if (nums.length >= 2) {
      const a = Number(nums[0]);
      const b = Number(nums[1]);
      if (!length) length = Math.max(a, b);
      if (!width) width = Math.min(a, b);
    }
  }
  if (length && width && width > length) {
    const tmp = length;
    length = width;
    width = tmp;
  }

  if (length) fields.pool_length_ft = srFormatNumber_(length);
  if (width) fields.pool_width_ft = srFormatNumber_(width);
  if (length && width) fields.pool_dimensions = srFormatNumber_(width) + ' x ' + srFormatNumber_(length) + ' ft';
}

function normalizeStartupDepth_(fields) {
  const raw = String(fields.pool_depth || '').trim();
  let minDepth = srNumber_(fields.depth_min_ft);
  let maxDepth = srNumber_(fields.depth_max_ft);
  const parsed = srParseDepths_(raw);

  if ((!minDepth || !maxDepth) && parsed.length) {
    minDepth = minDepth || Math.min.apply(null, parsed);
    maxDepth = maxDepth || Math.max.apply(null, parsed);
  }

  if (minDepth) fields.depth_min_ft = srFormatNumber_(minDepth);
  if (maxDepth) fields.depth_max_ft = srFormatNumber_(maxDepth);
  if (minDepth && maxDepth) {
    fields.pool_depth = minDepth === maxDepth
      ? srFormatNumber_(minDepth) + ' ft'
      : srFormatNumber_(minDepth) + '-' + srFormatNumber_(maxDepth) + ' ft';
  }
}

function srParseDepths_(raw) {
  const text = String(raw || '').toLowerCase();
  const depths = [];
  let match;
  const feetInches = /(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches))?/g;
  while ((match = feetInches.exec(text)) !== null) {
    depths.push(Number(match[1]) + (match[2] ? Number(match[2]) / 12 : 0));
  }
  if (depths.length) return depths;
  const nums = text.match(/\d+(?:\.\d+)?/g) || [];
  return nums.map(function(n) { return Number(n); }).filter(function(n) { return n > 0; });
}

function srNumber_(value) {
  const n = Number(String(value === undefined || value === null ? '' : value).replace(/[^\d.]/g, ''));
  return isFinite(n) && n > 0 ? n : 0;
}

function srFormatNumber_(n) {
  n = Number(n);
  if (!isFinite(n)) return '';
  return String(Math.round(n * 100) / 100).replace(/\.0+$/, '');
}

function calculateStartupGallons_(fields) {
  calculatePoolGallons_(fields);
  calculateSpaGallons_(fields);

  const poolEst = srNumber_(fields.pool_gallons_est);
  const poolLow = srNumber_(fields.pool_gallons_low) || poolEst;
  const poolHigh = srNumber_(fields.pool_gallons_high) || poolEst;
  const spaEst = srNumber_(fields.spa_gallons_est);
  const spaLow = srNumber_(fields.spa_gallons_low) || spaEst;
  const spaHigh = srNumber_(fields.spa_gallons_high) || spaEst;

  if (poolEst || spaEst) fields.total_gallons_est = srRoundGallons_(poolEst + spaEst);
  if (poolLow || spaLow) fields.total_gallons_low = srRoundGallons_(poolLow + spaLow);
  if (poolHigh || spaHigh) fields.total_gallons_high = srRoundGallons_(poolHigh + spaHigh);
}

function calculatePoolGallons_(fields) {
  const shape = String(fields.pool_shape || '').toLowerCase();
  const length = srNumber_(fields.pool_length_ft);
  const width = srNumber_(fields.pool_width_ft);
  const minDepth = srNumber_(fields.depth_min_ft);
  const maxDepth = srNumber_(fields.depth_max_ft) || minDepth;
  const avgDepth = minDepth && maxDepth ? (minDepth + maxDepth) / 2 : 0;
  if (!avgDepth) return;

  const lDims = srParseLShape_(fields);
  if (srIsLShape_(shape, String(fields.pool_dimensions || '')) && lDims.count && lDims.length && lDims.width) {
    fields.l_leg_count = srFormatNumber_(lDims.count);
    fields.l_leg_length_ft = srFormatNumber_(lDims.length);
    fields.l_leg_width_ft = srFormatNumber_(lDims.width);
    fields.l_overlap_assumption = String(fields.l_overlap_assumption || '').trim() || 'shared_corner';

    const highArea = lDims.count * lDims.length * lDims.width;
    const lowArea = Math.max(highArea - (lDims.width * lDims.width), 0);
    const useLow = String(fields.l_overlap_assumption).toLowerCase() === 'shared_corner';
    fields.pool_area_sqft = srFormatNumber_(useLow ? lowArea : highArea);
    fields.pool_gallons_low = srRoundGallons_(lowArea * avgDepth * SR_GAL_PER_CUFT);
    fields.pool_gallons_high = srRoundGallons_(highArea * avgDepth * SR_GAL_PER_CUFT);
    fields.pool_gallons_est = useLow ? fields.pool_gallons_low : fields.pool_gallons_high;
    fields.pool_gallons_method = useLow ? 'l_shape_shared_corner' : 'l_shape_no_overlap';
    fields.pool_gallons_confidence = 'review_required';
    fields.pool_gallons_notes = 'L-shape estimate: low assumes shared ' + srFormatNumber_(lDims.width) + 'x' + srFormatNumber_(lDims.width) + ' corner; high assumes two separate legs.';
    return;
  }

  if (!length || !width) return;
  let gallons = 0;
  let area = length * width;
  let method = 'rectangular';
  let confidence = 'medium';
  let notes = '';

  if (shape.indexOf('free') !== -1 || shape.indexOf('kidney') !== -1) {
    area = area * SR_FREEFORM_FACTOR;
    gallons = length * width * avgDepth * SR_GAL_PER_CUFT * SR_FREEFORM_FACTOR;
    method = 'freeform_factor_0.85';
    confidence = 'medium';
  } else if (shape.indexOf('oval') !== -1) {
    area = length * width * Math.PI / 4;
    gallons = length * width * avgDepth * SR_OVAL_GALLON_FACTOR;
    method = 'oval_5.9';
    confidence = 'medium';
  } else if (shape.indexOf('round') !== -1 || shape.indexOf('circle') !== -1) {
    const diameter = Math.max(length, width);
    area = Math.PI * Math.pow(diameter / 2, 2);
    gallons = diameter * diameter * avgDepth * SR_OVAL_GALLON_FACTOR;
    method = 'round_5.9';
    confidence = 'medium';
  } else if (shape.indexOf('l') !== -1) {
    gallons = length * width * avgDepth * SR_GAL_PER_CUFT * SR_FREEFORM_FACTOR;
    area = length * width * SR_FREEFORM_FACTOR;
    method = 'l_shape_freeform_fallback_0.85';
    confidence = 'low';
    notes = 'L-shape leg dimensions not available; used 0.85 shape factor fallback.';
  } else {
    gallons = length * width * avgDepth * SR_GAL_PER_CUFT;
  }

  fields.pool_area_sqft = srFormatNumber_(area);
  fields.pool_gallons_est = srRoundGallons_(gallons);
  fields.pool_gallons_low = fields.pool_gallons_est;
  fields.pool_gallons_high = fields.pool_gallons_est;
  fields.pool_gallons_method = method;
  fields.pool_gallons_confidence = confidence;
  fields.pool_gallons_notes = notes;
}

function srParseLShape_(fields) {
  let count = srNumber_(fields.l_leg_count);
  let length = srNumber_(fields.l_leg_length_ft);
  let width = srNumber_(fields.l_leg_width_ft);
  const nums = String(fields.pool_dimensions || '').match(/\d+(?:\.\d+)?/g) || [];
  if ((!count || !length || !width) && nums.length >= 3) {
    const vals = nums.map(function(n) { return Number(n); });
    if (vals[0] <= 4) {
      count = count || vals[0];
      length = length || Math.max(vals[1], vals[2]);
      width = width || Math.min(vals[1], vals[2]);
    } else if (vals[2] <= 4) {
      count = count || vals[2];
      length = length || Math.max(vals[0], vals[1]);
      width = width || Math.min(vals[0], vals[1]);
    }
  }
  return { count: count, length: length, width: width };
}

function srIsLShape_(shape, dimensions) {
  const s = String(shape || '').toLowerCase().trim();
  if (s === 'l' || s === 'l-shape' || s === 'l shape' || s === 'l-shaped') return true;
  if (s.indexOf('l') !== -1 && s.indexOf('shape') !== -1) return true;
  return (String(dimensions || '').match(/\d+(?:\.\d+)?/g) || []).length >= 3 && s.indexOf('l') !== -1;
}

function calculateSpaGallons_(fields) {
  if (String(fields.spa || '').toLowerCase() !== 'yes') return;
  let shape = String(fields.spa_shape || '').toLowerCase();
  const shapeNums = String(fields.spa_shape || '').match(/\d+(?:\.\d+)?/g) || [];
  if (shapeNums.length && !srNumber_(fields.spa_diameter_ft) && !srNumber_(fields.spa_length_ft)) {
    if (shape.indexOf('round') !== -1 || shape.indexOf('circle') !== -1) {
      fields.spa_diameter_ft = shapeNums[0];
      fields.spa_shape = 'Round';
      shape = 'round';
    } else if (shape.indexOf('square') !== -1) {
      fields.spa_length_ft = shapeNums[0];
      fields.spa_width_ft = shapeNums[1] || shapeNums[0];
      fields.spa_shape = 'Square';
      shape = 'square';
    }
  }
  const depth = srNumber_(fields.spa_depth_ft) || 3.5;
  fields.spa_depth_ft = srFormatNumber_(depth);

  let raw = 0;
  if (shape.indexOf('round') !== -1 || shape.indexOf('circle') !== -1 || srNumber_(fields.spa_diameter_ft)) {
    const diameter = srNumber_(fields.spa_diameter_ft) || Math.max(srNumber_(fields.spa_length_ft), srNumber_(fields.spa_width_ft));
    if (!diameter) return;
    fields.spa_shape = fields.spa_shape || 'Round';
    fields.spa_diameter_ft = srFormatNumber_(diameter);
    raw = diameter * diameter * depth * SR_OVAL_GALLON_FACTOR;
  } else {
    const length = srNumber_(fields.spa_length_ft);
    const width = srNumber_(fields.spa_width_ft) || length;
    if (!length || !width) return;
    fields.spa_shape = fields.spa_shape || (length === width ? 'Square' : 'Rectangular');
    fields.spa_length_ft = srFormatNumber_(Math.max(length, width));
    fields.spa_width_ft = srFormatNumber_(Math.min(length, width));
    raw = length * width * depth * SR_GAL_PER_CUFT;
  }

  fields.spa_gallons_est = srRoundGallons_(raw);
  fields.spa_gallons_low = srRoundGallons_(raw * 0.8);
  fields.spa_gallons_high = srRoundGallons_(raw * 0.9);
}

function srRoundGallons_(value) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return '';
  const step = n < 2000 ? 10 : 100;
  return String(Math.round(n / step) * step);
}

function normalizeStartupCount_(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return '';
  const match = raw.match(/^(\d+)$/);
  if (!match) return raw;
  const n = Number(match[1]);
  if (n === 0) return 'No';
  if (n === 1) return 'Yes';
  return String(n);
}

function normalizeStartupDate_(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return raw;
  const year = m[3].length === 2 ? '20' + m[3] : m[3];
  return year + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
}

function srCleanClaudeJson_(text) {
  const raw = String(text || '').replace(/```json|```/g, '').trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) return raw.substring(first, last + 1);
  return raw;
}

function srClaudeExtraction_(data) {
  const content = data && data.content;
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (block && block.type === 'tool_use' && block.name === 'record_startup_sheet' && block.input) {
        return block.input;
      }
    }
  }

  const text = String(srClaudeText_(data) || '');
  const clean = srCleanClaudeJson_(text);
  return JSON.parse(clean);
}

function srClaudeText_(data) {
  const content = data && data.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    throw new Error('Claude response missing content: ' + JSON.stringify(data).substring(0, 300));
  }

  const parts = content.map(function(block) {
    if (!block) return '';
    if (typeof block === 'string') return block;
    if (typeof block.text === 'string') return block.text;
    if (block.type === 'text' && block.text !== undefined && block.text !== null) return String(block.text);
    return '';
  }).filter(Boolean);

  if (!parts.length) {
    const types = content.map(function(block) { return block && block.type ? block.type : typeof block; }).join(', ');
    throw new Error('Claude returned no extractable text/tool result. stop_reason=' + (data.stop_reason || '') + '; block_types=' + types);
  }
  return parts.join('\n');
}

function handleStartupRequestExtract_(payload) {
  const company = findPoolCompanyByToken_(payload.t);
  if (!company) return { ok: false, error: 'Invalid or inactive link' };
  if (srRateLimitExceeded_('x', payload.t, 10)) {
    return { ok: false, error: 'Too many extraction attempts — please try again in a few minutes.' };
  }

  const photo = payload.photo || {};
  const b64 = String(photo.base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!b64) return { ok: false, error: 'No photo provided' };
  if (b64.length > SR_MAX_PHOTO_B64_LENGTH) return { ok: false, error: 'Photo too large — please retake at lower resolution.' };

  try {
    const fields = extractStartupSheet_(b64, photo.mimeType || 'image/jpeg');
    return { ok: true, fields: fields, raw: JSON.stringify(fields), extract_version: SR_EXTRACT_VERSION };
  } catch (e) {
    Logger.log('handleStartupRequestExtract_: AI extraction failed: ' + e);
    // ok:true with fields:null → the page falls back to a blank manual form
    return { ok: true, fields: null, error: SR_EXTRACT_VERSION + ': ' + srPublicExtractError_(e) };
  }
}

function srPublicExtractError_(e) {
  const msg = String(e && e.message ? e.message : e);
  if (msg.indexOf('no extractable text/tool result') !== -1) {
    return 'Claude did not return the extracted fields. Please retry the photo.';
  }
  return msg.length > 220 ? msg.substring(0, 220) + '...' : msg;
}

// ─── Public: submit ───────────────────────────────────────────────────────────

function saveStartupRequestPhotos_(photos, companyName) {
  const dateStr = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');
  const ROOT_FOLDER_NAME = 'MCPS Startup Requests';

  let rootFolder;
  const rootSearch = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  rootFolder = rootSearch.hasNext() ? rootSearch.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);

  const companyFolderName = normalizeCompanyName_(companyName) || 'Unknown Company';
  let companyFolder;
  const companySearch = rootFolder.getFoldersByName(companyFolderName);
  companyFolder = companySearch.hasNext() ? companySearch.next() : rootFolder.createFolder(companyFolderName);

  let dateFolder;
  const dateSearch = companyFolder.getFoldersByName(dateStr);
  dateFolder = dateSearch.hasNext() ? dateSearch.next() : companyFolder.createFolder(dateStr);

  const urls = [];
  (photos || []).forEach(function(photo, idx) {
    try {
      const b64 = String(photo.base64 || '').replace(/^data:[^;]+;base64,/, '');
      if (!b64 || b64.length > SR_MAX_PHOTO_B64_LENGTH) return;
      const mimeType = photo.mimeType || 'image/jpeg';
      const ext = mimeType.split('/')[1] || 'jpg';
      const fileName = companyFolderName + '_' + dateStr + '_sheet' + (idx + 1) + '.' + ext;
      const blob = Utilities.newBlob(Utilities.base64Decode(b64), mimeType, fileName);
      const file = dateFolder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      const fileId = file.getId();
      urls.push({
        thumb: 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1200',
        file: 'https://drive.google.com/file/d/' + fileId + '/view'
      });
    } catch (e) {
      Logger.log('saveStartupRequestPhotos_: failed photo ' + idx + ': ' + e);
    }
  });
  return urls;
}

function handleStartupRequestSubmit_(payload) {
  const company = findPoolCompanyByToken_(payload.t);
  if (!company) return { ok: false, error: 'Invalid or inactive link' };
  if (srRateLimitExceeded_('sb', payload.t, 10)) {
    return { ok: false, error: 'Too many submissions — please try again in a few minutes.' };
  }

  const fields = normalizeStartupExtraction_(payload.fields || {});
  const hasName = String(fields.first_name || '').trim() || String(fields.last_name || '').trim();
  const hasAddress = String(fields.address || '').trim();
  if (!hasName && !hasAddress) {
    return { ok: false, error: 'Please provide at least the customer name or address.' };
  }

  // Photos are persisted only here — URLs are always server-generated, never taken from the client.
  const photoUrls = saveStartupRequestPhotos_(payload.photos || [], company.company_name);

  const sheet = getStartupRequestsSheet_();
  const requestId = 'SR-' + Utilities.getUuid().substring(0, 8).toUpperCase();
  const now = new Date().toISOString();

  const obj = {
    request_id: requestId,
    status: 'pending_review',
    pool_company_id: company.pool_company_id,
    company_name: company.company_name,
    raw_extraction: typeof payload.raw_extraction === 'string' ? payload.raw_extraction.slice(0, 20000) : '',
    photo_urls: JSON.stringify(photoUrls),
    reviewed_by_builder: payload.reviewed_by_builder === true || String(payload.reviewed_by_builder).toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE',
    submitted_at: now,
    created_at: now,
    updated_at: now
  };
  SR_EDITABLE_FIELDS.forEach(function(f) {
    obj[f] = String(fields[f] !== undefined && fields[f] !== null ? fields[f] : '').slice(0, 500);
  });

  appendObject_(sheet, obj, MCPS_STARTUP_REQUEST_HEADERS);

  const link = srStatusLink_(payload.t, requestId);
  srSendBuilderEmail_(
    fields.email,
    'MCPS Startup Request Received — ' + requestId,
    'Hi' + (fields.first_name ? ' ' + fields.first_name : '') + ',\n\n' +
    'We received your pool startup request. Reference number: ' + requestId + '\n\n' +
    'Mission Custom Pool Solutions will review the details and confirm your startup date soon.' +
    '\n\nCheck your status any time: ' + link +
    '\n\n— Mission Custom Pool Solutions'
  );

  return { ok: true, request_id: requestId };
}

// ─── Admin helpers ────────────────────────────────────────────────────────────

function srRequireAdmin_(tokenStr) {
  const auth = validateToken(tokenStr || '');
  if (!auth.ok) return { ok: false, error: 'Unauthorized' };
  if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) {
    return { ok: false, error: 'Admin access required.' };
  }
  return { ok: true, auth: auth };
}

function srFindRequestRow_(requestId) {
  const sheet = getStartupRequestsSheet_();
  const parsed = sheetToObjects_(sheet);
  const row = parsed.rows.find(function(r) { return String(r.request_id || '').trim() === String(requestId || '').trim(); });
  return { sheet: sheet, headers: parsed.headers, row: row || null };
}

function srSetRowValues_(sheet, headers, rowNum, obj) {
  Object.keys(obj).forEach(function(key) {
    const idx = headers.indexOf(key);
    if (idx !== -1) sheet.getRange(rowNum, idx + 1).setValue(obj[key]);
  });
}

// ─── Admin: list ──────────────────────────────────────────────────────────────

function handleStartupRequestsList_(tokenStr, scope) {
  const gate = srRequireAdmin_(tokenStr);
  if (!gate.ok) return gate;

  const sheet = getStartupRequestsSheet_();
  let rows = sheetToObjects_(sheet).rows;
  if (String(scope || 'pending') === 'pending') {
    rows = rows.filter(function(r) {
      return String(r.status || '') === 'pending_review' ||
        (String(r.status || '') === 'approved' && String(r.change_requested_at || '').trim());
    });
  }
  rows.reverse(); // newest first
  if (rows.length > 100) rows = rows.slice(0, 100);
  rows.forEach(function(r) { delete r._rowNum; });

  // Technician list for the approve card's assignment dropdown. Sourced here
  // rather than from list_users because that action requires the admin role,
  // while this queue also admits managers via srRequireAdmin_.
  let operators = [];
  try { operators = getAllowedRouteOperatorNames_(); } catch (e) {
    Logger.log('handleStartupRequestsList_: operator list unavailable: ' + e);
  }
  return { ok: true, requests: rows, operators: operators };
}

// ─── Startup technician assignment ────────────────────────────────────────────
//
// Startups live only in Scheduled_Visits — they never get a Routes row (see
// addStartupPoolToRoutes_). So the technician must be stamped on the visit rows
// themselves: Routes.operator is not read for these stops, and both the route
// filter (getScheduledVisitsForWeek) and the Jobs tab (handleGetMyJobs) drop
// visits whose assigned_technician doesn't match the viewer.
//
// The single place that writes it, so no caller can half-apply the cache busts.
function srAssignStartupTechnician_(poolId, techName) {
  const pid = String(poolId || '').trim();
  if (!pid) return { ok: false, error: 'pool_id required' };

  // Canonicalize against the active technician list. Route filtering compares
  // lowercased but jobsBustCache_ keys off the name, so a casing or whitespace
  // variant would produce a live row nobody's cache is ever invalidated for.
  const requested = String(techName || '').trim();
  let canonical = '';
  if (requested) {
    let allowed = [];
    try { allowed = getAllowedRouteOperatorNames_(); } catch (e) {
      return { ok: false, error: 'Could not load the technician list.' };
    }
    const target = requested.toLowerCase().replace(/\s+/g, ' ');
    canonical = allowed.find(function(n) {
      return String(n).trim().toLowerCase().replace(/\s+/g, ' ') === target;
    }) || '';
    if (!canonical) return { ok: false, error: requested + ' is not an active technician.' };
  }

  const sheet = ensureScheduledVisitsSheet_();
  if (sheet.getLastRow() < 2) return { ok: true, updated: 0, assigned_technician: canonical };

  const data = sheet.getDataRange().getValues();
  const h = data[0].map(function(x) { return String(x || '').trim().toLowerCase().replace(/ /g, '_'); });
  const pidCol  = h.indexOf('pool_id');
  const vtCol   = h.indexOf('visit_type');
  const techCol = h.indexOf('assigned_technician');
  const dateCol = h.indexOf('scheduled_date');
  const statCol = h.indexOf('status');
  if (pidCol === -1 || vtCol === -1 || techCol === -1) {
    return { ok: false, error: 'Scheduled_Visits is missing a required column.' };
  }

  const affectedTechs = [canonical];
  const affectedWeeks = {};
  let updated = 0;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][pidCol] || '').trim() !== pid) continue;
    if (!/^startup_day_[123]$/.test(String(data[i][vtCol] || '').trim())) continue;
    const stat = statCol !== -1 ? String(data[i][statCol] || '').trim().toLowerCase() : 'scheduled';
    if (stat && stat !== 'scheduled') continue;

    // Every tech this pool is moving OFF also needs their my_jobs cache dropped,
    // or the job lingers on their list for the full TTL. Day 1/2/3 can differ.
    const prev = String(data[i][techCol] || '').trim();
    if (prev && affectedTechs.indexOf(prev) === -1) affectedTechs.push(prev);

    sheet.getRange(i + 1, techCol + 1).setValue(canonical);
    updated++;

    // A 3-day startup can straddle two weeks — bust each one it touches.
    if (dateCol !== -1) {
      let d = data[i][dateCol];
      d = (d instanceof Date) ? Utilities.formatDate(d, RD_TZ, 'yyyy-MM-dd') : String(d || '').trim();
      if (d) {
        try { affectedWeeks[getWeekStartForDate_(d)] = true; } catch (e) {}
      }
    }
  }

  try {
    const cache = CacheService.getScriptCache();
    Object.keys(affectedWeeks).forEach(function(ws) { if (ws) cache.remove('rd:' + ws); });
  } catch (e) {}
  try { jobsBustCache_(affectedTechs); } catch (e) {}

  Logger.log('srAssignStartupTechnician_: ' + pid + ' → "' + canonical + '" (' + updated + ' visits)');
  return { ok: true, updated: updated, assigned_technician: canonical };
}

// Admin/manager: reassign (or clear) the technician on an existing startup.
function handleAssignStartupTechnician_(payload) {
  const gate = srRequireAdmin_(payload.token);
  if (!gate.ok) return gate;
  return srAssignStartupTechnician_(payload.pool_id, payload.assigned_technician);
}

// ─── Admin: update fields ─────────────────────────────────────────────────────

function handleStartupRequestUpdate_(payload) {
  const gate = srRequireAdmin_(payload.token);
  if (!gate.ok) return gate;

  const found = srFindRequestRow_(payload.request_id);
  if (!found.row) return { ok: false, error: 'Request not found' };

  const updates = { updated_at: new Date().toISOString() };
  const fields = payload.fields || {};
  SR_EDITABLE_FIELDS.forEach(function(f) {
    if (fields[f] !== undefined) updates[f] = String(fields[f] === null ? '' : fields[f]).slice(0, 500);
  });
  if (payload.clear_change_request === true) {
    updates.change_requested_date = '';
    updates.change_requested_note = '';
    updates.change_requested_at = '';
  }
  srSetRowValues_(found.sheet, found.headers, found.row._rowNum, updates);
  return { ok: true };
}

// ─── Admin: approve → create the startup pool via the existing quote path ─────

function handleStartupRequestApprove_(payload) {
  const gate = srRequireAdmin_(payload.token);
  if (!gate.ok) return gate;
  const auth = gate.auth;

  const startDate = String(payload.startup_start_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return { ok: false, error: 'startup_start_date (yyyy-mm-dd) is required' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const found = srFindRequestRow_(payload.request_id);
    if (!found.row) return { ok: false, error: 'Request not found' };
    // Idempotency: a double-click or retry must not create a second pool.
    if (String(found.row.status || '') !== 'pending_review') {
      return { ok: false, error: 'Request already ' + (found.row.status || 'processed') + '.' };
    }

    // Merge any last-second admin edits before building the quote payload
    const fieldEdits = payload.fields || {};
    const req = {};
    SR_EDITABLE_FIELDS.forEach(function(f) {
      req[f] = fieldEdits[f] !== undefined
        ? String(fieldEdits[f] === null ? '' : fieldEdits[f])
        : String(found.row[f] || '');
    });
    normalizeStartupExtraction_(req);

    // Look up the company for startup_company fields
    const companySheet = ensureSheet_('Pool_Companies', MCPS_POOL_COMPANY_HEADERS);
    const company = sheetToObjects_(companySheet).rows.find(function(r) {
      return String(r.pool_company_id || '').trim() === String(found.row.pool_company_id || '').trim();
    }) || {};

    const sponsored = payload.sponsored_by_mcp === true || String(payload.sponsored_by_mcp).toUpperCase() === 'TRUE';
    const specs = [
      req.pool_shape ? 'Shape: ' + req.pool_shape : '',
      req.pool_dimensions ? 'Pool: ' + req.pool_dimensions : '',
      req.pool_length_ft && req.pool_width_ft ? 'Normalized Size: ' + req.pool_length_ft + ' x ' + req.pool_width_ft + ' ft' : '',
      req.pool_depth ? 'Depth: ' + req.pool_depth : '',
      req.depth_min_ft && req.depth_max_ft ? 'Normalized Depth: ' + req.depth_min_ft + '-' + req.depth_max_ft + ' ft' : '',
      req.pool_area_sqft ? 'Pool Area: ' + req.pool_area_sqft + ' sq ft' : '',
      req.pool_gallons_est ? 'Pool Gallons Est: ' + req.pool_gallons_est : '',
      req.pool_gallons_low && req.pool_gallons_high && req.pool_gallons_low !== req.pool_gallons_high ? 'Pool Gallons Range: ' + req.pool_gallons_low + '-' + req.pool_gallons_high : '',
      req.pool_gallons_method ? 'Gallons Method: ' + req.pool_gallons_method : '',
      req.pool_gallons_confidence ? 'Gallons Confidence: ' + req.pool_gallons_confidence : '',
      req.pool_gallons_notes ? 'Gallons Notes: ' + req.pool_gallons_notes : '',
      'Spa: ' + (String(req.spa).toLowerCase() === 'yes' ? 'Yes' : 'No'),
      req.spa_shape ? 'Spa Shape: ' + req.spa_shape : '',
      req.spa_diameter_ft ? 'Spa Diameter: ' + req.spa_diameter_ft + ' ft' : '',
      req.spa_length_ft && req.spa_width_ft ? 'Spa Size: ' + req.spa_length_ft + ' x ' + req.spa_width_ft + ' ft' : '',
      req.spa_depth_ft ? 'Spa Depth: ' + req.spa_depth_ft + ' ft' : '',
      req.spa_gallons_est ? 'Spa Gallons Est: ' + req.spa_gallons_est : '',
      req.spa_gallons_low && req.spa_gallons_high ? 'Spa Practical Range: ' + req.spa_gallons_low + '-' + req.spa_gallons_high : '',
      req.total_gallons_est ? 'Total Gallons Est: ' + req.total_gallons_est : '',
      req.total_gallons_low && req.total_gallons_high && req.total_gallons_low !== req.total_gallons_high ? 'Total Gallons Range: ' + req.total_gallons_low + '-' + req.total_gallons_high : '',
      req.water_features ? 'Water Features: ' + req.water_features : '',
      req.sheer_descents ? 'Sheer Descents: ' + req.sheer_descents : '',
      req.plaster_type ? 'Plaster: ' + req.plaster_type : '',
      req.plaster_date ? 'Plaster Date: ' + req.plaster_date : '',
      req.equip_filter ? 'Filter: ' + req.equip_filter : '',
      req.equip_pump ? 'Pump: ' + req.equip_pump : '',
      req.equip_heater ? 'Heater: ' + req.equip_heater : '',
      req.equip_chlorinator ? 'Chlorinator: ' + req.equip_chlorinator : '',
      req.equip_salt_system ? 'Salt System: ' + req.equip_salt_system : '',
      req.equip_booster ? 'Booster: ' + req.equip_booster : '',
      'via startup request ' + found.row.request_id
    ].filter(Boolean).join(', ');

    const quotePayload = {
      first_name: req.first_name, last_name: req.last_name,
      email: req.email, phone: req.phone,
      address: req.address, city: req.city, zip_code: req.zip_code,
      area: req.city || '',
      service: 'Pool Startup',
      pool_type: 'Inground',
      size: req.pool_dimensions || 'startup',
      material: 'Plaster',
      spa: String(req.spa).toLowerCase() === 'yes' ? 'Yes' : 'No',
      finish: req.plaster_type || '',
      debris: '', has_robot: false, high_sun_exposure: false, has_pets: false,
      startup_chemical_work: payload.startup_chemical_work === true,
      startup_programming: payload.startup_programming === true,
      startup_pool_school: payload.startup_pool_school === true,
      startup_company: company.company_name || found.row.company_name || '',
      startup_company_email: company.report_bcc_email || '',
      sponsored_by_mcp: sponsored,
      startup_start_date: startDate,
      startup_total_days: sponsored ? 3 : 0,
      repair_job_type: '', repair_company_name: '', repair_company_address: '',
      repair_job_description: '', repair_invoice_amount: 0, repair_sku: '',
      travel_fee: 0, travel_one_way_miles: 0, travel_round_trip_miles: 0,
      travel_billable_round_trip_miles: 0, distance_source: 'none',
      service_subtotal: payload.service_subtotal,
      discount_type: '', discount_value: 0, discount_amount: 0,
      discounted_service_subtotal: payload.service_subtotal,
      quote_subtotal: payload.quote_subtotal,
      sales_tax: payload.sales_tax,
      total_with_tax: payload.total_with_tax,
      chem_cost_est: payload.chem_cost_est,
      net_profit_est: payload.net_profit_est,
      margin_percent: payload.margin_percent,
      specs_summary: specs,
      quickbooks_skus: payload.quickbooks_skus || '',
      quickbooks_item_names: payload.quickbooks_item_names || '',
      created_by: (auth.user ? auth.user.username : auth.username) + ' (startup request)',
      quote_source: 'startup_request',
      quote_version: '2.0',
      sales_flow: 'operational_override',
      signature_required: 'FALSE',
      activation_method: 'STARTUP_AUTO',
      status: 'ACTIVE_CUSTOMER'
    };

    const result = JSON.parse(handleSaveQuote_(quotePayload).getContent());
    if (!result.ok) return { ok: false, error: result.error || 'Quote creation failed' };

    // Stamp the technician onto the startup visits handleSaveQuote_ just created.
    // Deliberately non-blocking: the pool exists now, so a bad name or a missing
    // visit row must surface as a warning, never as a failed approval that the
    // idempotency guard would then refuse to retry.
    let assignedTech = '';
    let assignmentWarning = '';
    const requestedTech = String(payload.assigned_technician || '').trim();
    if (requestedTech) {
      try {
        const assign = srAssignStartupTechnician_(result.pool_id, requestedTech);
        if (!assign.ok) {
          assignmentWarning = assign.error || 'Could not assign the technician.';
        } else if (!assign.updated) {
          // Quote creation reported success but no startup visits exist to assign —
          // the startup pipeline is broken and must not hide behind a green check.
          assignmentWarning = 'No startup visits found to assign.';
        } else {
          assignedTech = assign.assigned_technician;
        }
      } catch (assignErr) {
        Logger.log('handleStartupRequestApprove_: assignment failed: ' + assignErr);
        assignmentWarning = 'Could not assign the technician.';
      }
    }

    srSetRowValues_(found.sheet, found.headers, found.row._rowNum, Object.assign({
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: auth.user ? auth.user.username : auth.username,
      quote_id: result.quote_id || '',
      pool_id: result.pool_id || '',
      requested_start_date: startDate,
      updated_at: new Date().toISOString()
    }, (function() {
      const edits = {};
      SR_EDITABLE_FIELDS.forEach(function(f) { if (fieldEdits[f] !== undefined) edits[f] = req[f]; });
      return edits;
    })()));

    // Same invalidations as the save_quote route
    try {
      invalidateCrmCache_();
      const c = CacheService.getScriptCache();
      c.remove('unassigned_pools');
      c.remove('weekly_goal');
    } catch (e) {}

    srSendBuilderEmail_(
      req.email,
      'Your MCPS Pool Startup is Confirmed — ' + found.row.request_id,
      'Hi' + (req.first_name ? ' ' + req.first_name : '') + ',\n\n' +
      'Your pool startup has been approved and is scheduled to begin on ' + startDate + '.\n\n' +
      '— Mission Custom Pool Solutions'
    );

    return {
      ok: true,
      quote_id: result.quote_id,
      pool_id: result.pool_id,
      warning: result.warning,
      assigned_technician: assignedTech,
      assignment_warning: assignmentWarning
    };
  } finally {
    lock.releaseLock();
  }
}

// ─── Admin: reject ────────────────────────────────────────────────────────────

function handleStartupRequestReject_(payload) {
  const gate = srRequireAdmin_(payload.token);
  if (!gate.ok) return gate;
  const auth = gate.auth;

  const found = srFindRequestRow_(payload.request_id);
  if (!found.row) return { ok: false, error: 'Request not found' };
  if (String(found.row.status || '') !== 'pending_review') {
    return { ok: false, error: 'Request already ' + (found.row.status || 'processed') + '.' };
  }

  srSetRowValues_(found.sheet, found.headers, found.row._rowNum, {
    status: 'rejected',
    admin_notes: String(payload.note || '').slice(0, 1000),
    approved_by: auth.user ? auth.user.username : auth.username,
    approved_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  srSendBuilderEmail_(
    found.row.email,
    'Update on Your MCPS Pool Startup Request — ' + found.row.request_id,
    'Hi' + (found.row.first_name ? ' ' + found.row.first_name : '') + ',\n\n' +
    'We were unable to move forward with your pool startup request at this time.' +
    (payload.note ? '\n\nNote from MCPS: ' + String(payload.note).slice(0, 1000) : '') +
    '\n\n— Mission Custom Pool Solutions'
  );

  return { ok: true };
}

// ─── Public: builder self-service status + date-change request ───────────────

function handleStartupRequestStatus_(payload) {
  const company = findPoolCompanyByToken_(payload.t);
  if (!company) return { ok: false, error: 'Invalid or inactive link' };
  if (srRateLimitExceeded_('st', payload.t, 30)) {
    return { ok: false, error: 'Too many attempts — please try again in a few minutes.' };
  }
  const found = srFindRequestRow_(payload.request_id);
  if (!found.row || String(found.row.pool_company_id || '').trim() !== String(company.pool_company_id || '').trim()) {
    return { ok: false, error: 'Request not found' };
  }
  const row = found.row;
  const out = {
    ok: true,
    request_id: row.request_id,
    status: row.status,
    requested_start_date: row.requested_start_date || ''
  };
  if (row.status === 'rejected') out.admin_notes = row.admin_notes || '';
  if (String(row.change_requested_at || '').trim()) {
    out.change_requested_date = row.change_requested_date || '';
    out.change_requested_note = row.change_requested_note || '';
    out.change_requested_at = row.change_requested_at;
  }
  return out;
}

function handleStartupRequestRequestChange_(payload) {
  const company = findPoolCompanyByToken_(payload.t);
  if (!company) return { ok: false, error: 'Invalid or inactive link' };
  if (srRateLimitExceeded_('rc', payload.t, 8)) {
    return { ok: false, error: 'Too many requests — please try again in a few minutes.' };
  }
  const found = srFindRequestRow_(payload.request_id);
  if (!found.row || String(found.row.pool_company_id || '').trim() !== String(company.pool_company_id || '').trim()) {
    return { ok: false, error: 'Request not found' };
  }
  const row = found.row;
  if (row.status !== 'pending_review' && row.status !== 'approved') {
    return { ok: false, error: 'This request can no longer be changed.' };
  }
  const requestedDate = String(payload.requested_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return { ok: false, error: 'A valid date (yyyy-mm-dd) is required.' };
  }
  const note = String(payload.note || '').slice(0, 500);
  const now = new Date().toISOString();

  if (row.status === 'pending_review') {
    // Nothing scheduled yet — low risk, safe to update directly.
    srSetRowValues_(found.sheet, found.headers, found.row._rowNum, {
      requested_start_date: requestedDate,
      notes: (String(row.notes || '').trim() ? row.notes + ' | ' : '') +
        'Builder requested date change to ' + requestedDate + (note ? ': ' + note : ''),
      updated_at: now
    });
    return { ok: true, applied: true };
  }

  // Approved — touches live Scheduled_Visits/Routes data. Flag for admin instead
  // of mutating; admin acts via the existing reschedule_startup tooling.
  srSetRowValues_(found.sheet, found.headers, found.row._rowNum, {
    change_requested_date: requestedDate,
    change_requested_note: note,
    change_requested_at: now,
    updated_at: now
  });
  return { ok: true, applied: false };
}
