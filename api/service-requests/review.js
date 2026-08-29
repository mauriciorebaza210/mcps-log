// ══════════════════════════════════════════════════════════════════════════════
// SERVICE-REQUEST REVIEW — the staff side
//
//   GET  ?token=…                     list open requests + technicians
//   POST { action: 'link' }           attach a request to an existing client
//   POST { action: 'create_lead' }    make a CRM lead — no match only
//   POST { action: 'schedule' }       write a real Scheduled_Visits row
//   POST { action: 'repair_order' }   write a real Repair_Orders row
//   POST { action: 'decline' }        close with a reason
//   POST { action: 'note' }           add a review note / move to in_review
//
// Admin or manager session required. This is the ONLY place a service request
// turns into CRM or scheduling data — the public endpoint cannot, by design.
//
// Two rules every action follows:
//
//   RE-READ BEFORE WRITE. The row is fetched again and its status checked
//   against the legal from-states for the action. A stale browser tab cannot
//   schedule a request somebody already declined.
//
//   IDEMPOTENT. If the result already exists (scheduled_visit_id set,
//   converted_quote_id set) the existing result is returned instead of a second
//   one being created. A double-click cannot put two visits on the schedule.
// ══════════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import {
  crmSpreadsheetId, readSheetRange, writeSheetRange, appendSheetRows,
  rowsToObjects, normalizeHeader, sendJson, requireAdminPortalToken, getCached
} from '../_sheets.js';
import { routesSpreadsheetId, authSpreadsheetId } from '../_lib/ids.js';
import { findMatch } from '../_lib/identity.js';
import {
  SHEET, HEADERS, CATEGORIES, STATUSES, clean, appendAction, rowFromObject
} from '../_lib/service-requests.js';

const VISITS_SHEET = 'Scheduled_Visits';
const REPAIRS_SHEET = 'Repair_Orders';

// Positional on insert, resolved by header name on read — the shape declared in
// appscript/ScheduledVisits.js:21-36. Verified against the live sheet.
const VISIT_HEADERS = [
  'scheduled_visit_id', 'pool_id', 'customer_name', 'service_type', 'visit_type',
  'scheduled_date', 'assigned_technician', 'status', 'completed_at', 'completed_by',
  'chem_log_ref', 'notes', 'created_at', 'created_by'
];

// appscript/Jobs.js:23-28.
const REPAIR_HEADERS = [
  'order_id', 'quote_ref', 'pool_id', 'customer_name', 'address', 'city',
  'job_name', 'description', 'equipment', 'issue', 'priority', 'parts_json',
  'photo_url', 'status', 'assignee_type', 'assigned_to', 'reported_at',
  'scheduled_date', 'scheduled_visit_id', 'completed_at', 'updated_at', 'updated_by'
];

// Which statuses each action may act on. Anything else is refused with a message
// naming the current state, so a stale tab gets an explanation rather than a
// silent no-op.
const ALLOWED_FROM = {
  link:         ['new', 'in_review'],
  create_lead:  ['new', 'in_review'],
  schedule:     ['new', 'in_review'],
  repair_order: ['new', 'in_review'],
  note:         ['new', 'in_review', 'scheduled', 'quoted'],
  decline:      ['new', 'in_review', 'scheduled', 'quoted']
};

function colLetter(index) {
  let n = index, out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}

function parseBody(body) {
  if (!body) return {};
  if (Buffer.isBuffer(body)) return parseBody(body.toString('utf8'));
  if (typeof body === 'object') return body;
  try { return JSON.parse(body); } catch (_) { return {}; }
}

function actorName(session) {
  return String(
    (session && (session.operator_name || session.name || session.username)) ||
    (session && session.user && (session.user.name || session.user.username)) || 'staff'
  ).trim();
}

async function loadRequests() {
  const id = crmSpreadsheetId();
  const values = await readSheetRange(SHEET, id).catch(() => []);
  if (!values.length || !(values[0] || []).length) return { header: HEADERS.map(normalizeHeader), rows: [] };

  // Same header-repair guard as the intake path. A column missing from the sheet
  // is a silent drop on write, and this side writes the fields that matter most
  // — scheduled_visit_id, converted_quote_id, action_log. Losing one of those
  // would break idempotency without any error to notice.
  let header = values[0].map(normalizeHeader);
  const missing = HEADERS.map(normalizeHeader).filter(h => header.indexOf(h) === -1);
  if (missing.length) {
    header = header.concat(missing);
    await writeSheetRange(`${SHEET}!A1:${colLetter(header.length - 1)}1`, [header], id);
    console.warn('Service_Requests header repaired, added:', missing.join(', '));
  }

  return {
    header,
    rows: rowsToObjects(values).map((obj, i) => Object.assign(obj, { _row: i + 2 }))
  };
}

async function saveRequest(header, row, patch) {
  const merged = Object.assign({}, row, patch);
  delete merged._row;
  await writeSheetRange(
    `${SHEET}!A${row._row}:${colLetter(header.length - 1)}${row._row}`,
    [rowFromObject(header, merged)],
    crmSpreadsheetId()
  );
  return merged;
}

async function technicians() {
  return getCached('sr:techs', 5 * 60 * 1000, async () => {
    const rows = rowsToObjects(await readSheetRange('Users', authSpreadsheetId()).catch(() => []));
    return rows
      .filter(u => String(u.active || '').toUpperCase() !== 'FALSE')
      .filter(u => /technician/i.test(String(u.roles || '')))
      .map(u => String(u.operator_name || u.name || u.username || '').trim())
      .filter(Boolean)
      .sort();
  });
}

// ── GET: the queue ──────────────────────────────────────────────────────────

async function handleList(req, res) {
  const showAll = ['1', 'true', 'yes'].includes(String((req.query || {}).all || '').toLowerCase());
  const { rows } = await loadRequests();

  const live = rows.filter(r => String(r.request_id || '').trim());
  const visible = showAll
    ? live
    : live.filter(r => ['new', 'in_review'].includes(String(r.status || 'new').trim().toLowerCase()));

  const items = visible.map(r => {
    let candidates = [];
    try { candidates = JSON.parse(r.match_candidates_json || '[]'); } catch (_) {}
    let log = [];
    try { log = JSON.parse(r.action_log || '[]'); } catch (_) {}
    const cat = CATEGORIES[r.category] || {};
    let photos = [];
    try { photos = JSON.parse(r.photo_urls || '[]'); } catch (_) {}

    return {
      request_id: r.request_id,
      created_at: r.created_at,
      status: String(r.status || 'new').trim().toLowerCase(),
      category: r.category,
      category_label: cat.label || r.category,
      schedulable: !!cat.schedulable,
      creates_repair_order: !!cat.creates_repair_order,
      subcategory: r.subcategory,
      description: r.description,
      photos,
      timing_preference: r.timing_preference,
      timing_notes: r.timing_notes,
      first_name: r.first_name, last_name: r.last_name,
      email: r.email, phone: r.phone,
      service_address: r.service_address, city: r.city, zip_code: r.zip_code,
      match_status: r.match_status || 'none',
      match_client_id: r.match_client_id, match_quote_id: r.match_quote_id,
      match_pool_id: r.match_pool_id, match_reasons: r.match_reasons,
      match_confidence: r.match_confidence,
      is_existing_customer: String(r.is_existing_customer || '').toUpperCase() === 'TRUE',
      candidates,
      campaign_id: r.campaign_id,
      duplicate_of: r.duplicate_of,
      idempotency_key: r.idempotency_key,
      scheduled_visit_id: r.scheduled_visit_id,
      repair_order_id: r.repair_order_id,
      converted_quote_id: r.converted_quote_id,
      review_notes: r.review_notes,
      action_log: log
    };
  }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  // Same-key rows are surfaced together rather than silently collapsed, so a
  // race between two serverless instances is visible instead of looking like
  // two unrelated requests.
  const keyCounts = {};
  live.forEach(r => {
    const k = String(r.idempotency_key || '');
    if (k) keyCounts[k] = (keyCounts[k] || 0) + 1;
  });
  items.forEach(i => { i.same_key_count = keyCounts[i.idempotency_key] || 1; });

  return sendJson(res, 200, {
    ok: true,
    items,
    technicians: await technicians(),
    counts: {
      open: live.filter(r => ['new', 'in_review'].includes(String(r.status || 'new').toLowerCase())).length,
      total: live.length
    }
  });
}

// ── Action plumbing ─────────────────────────────────────────────────────────

async function locate(requestId) {
  const { header, rows } = await loadRequests();
  const row = rows.find(r => String(r.request_id || '').trim().toUpperCase() === String(requestId || '').trim().toUpperCase());
  return { header, rows, row };
}

function guard(row, action) {
  const status = String(row.status || 'new').trim().toLowerCase();
  const allowed = ALLOWED_FROM[action] || [];
  if (allowed.includes(status)) return null;
  return `This request is already marked "${status}". Reload the queue to see its current state.`;
}

function stamp(row, session, action, toStatus, extra) {
  const now = new Date().toISOString();
  return Object.assign({
    updated_at: now,
    reviewed_by: actorName(session),
    reviewed_at: now,
    status: toStatus || row.status,
    action_log: appendAction(row.action_log, {
      at: now, actor: actorName(session), action,
      from_status: String(row.status || 'new'), to_status: toStatus || String(row.status || 'new')
    })
  }, extra || {});
}

// ── link ────────────────────────────────────────────────────────────────────

// Quotes, Clients and Client_Locations behind one short cache.
//
// Every action here was re-reading all three: create_lead for its re-match,
// poolIdExists for its check. An admin working down a queue of ten made thirty
// full-sheet reads in under a minute, which is enough to hit the Sheets
// per-minute read quota — it did, during testing, and the endpoint fails hard
// when it does.
//
// Fifteen seconds is deliberately short. create_lead's re-match has to see
// current data to be worth anything, but what it guards against is a client
// created hours ago, not fifteen seconds ago, so this collapses the burst
// without weakening the check.
function crmSnapshot() {
  return getCached('sr:review-crm', 15 * 1000, async () => {
    const id = crmSpreadsheetId();
    const [quotes, clients, locations] = await Promise.all([
      readSheetRange('Quotes', id).catch(() => []),
      readSheetRange('Clients', id).catch(() => []),
      readSheetRange('Client_Locations', id).catch(() => [])
    ]);
    return { quotes, clients, locations };
  });
}

// The whole pool_id preflight rests on the id being real. It arrives from a
// button the console rendered, but a stale tab or a hand-made request could
// carry one that no longer exists — and a visit pointing at a missing pool is
// the nameless stop on the tech board that the preflight exists to prevent.
async function poolIdExists(poolId) {
  const id = String(poolId || '').trim();
  if (!id) return true;   // no id is a valid state; scheduling is blocked separately
  const snap = await crmSnapshot();
  const match = r => String(r.pool_id || '').trim().toUpperCase() === id.toUpperCase();
  return rowsToObjects(snap.quotes).some(match) || rowsToObjects(snap.locations).some(match);
}

async function actionLink(req, res, session, body) {
  const { header, row } = await locate(body.request_id);
  if (!row) return sendJson(res, 404, { ok: false, error: 'Request not found.' });
  const blocked = guard(row, 'link'); if (blocked) return sendJson(res, 409, { ok: false, error: blocked });

  const poolId = clean(body.pool_id, 40);
  if (poolId && !(await poolIdExists(poolId))) {
    return sendJson(res, 400, {
      ok: false,
      error: `Pool ID ${poolId} does not exist. Reload the queue — this match may be out of date.`
    });
  }

  const patch = stamp(row, session, 'link', 'in_review', {
    match_status: 'confident',
    match_client_id: clean(body.client_id, 40),
    match_quote_id: clean(body.quote_id, 40),
    match_location_id: clean(body.location_id, 40),
    match_pool_id: poolId,
    match_reasons: 'linked_by_' + actorName(session)
  });
  await saveRequest(header, row, patch);
  return sendJson(res, 200, { ok: true, request_id: row.request_id, pool_id: patch.match_pool_id });
}

// ── create_lead ─────────────────────────────────────────────────────────────

async function actionCreateLead(req, res, session, body) {
  const { header, row } = await locate(body.request_id);
  if (!row) return sendJson(res, 404, { ok: false, error: 'Request not found.' });

  // Idempotent: a second click returns the lead the first one made.
  if (String(row.converted_quote_id || '').trim()) {
    return sendJson(res, 200, { ok: true, request_id: row.request_id, quote_id: row.converted_quote_id, existing: true });
  }
  const blocked = guard(row, 'create_lead'); if (blocked) return sendJson(res, 409, { ok: false, error: blocked });

  const crmId = crmSpreadsheetId();
  const snap = await crmSnapshot();
  const quoteValues = snap.quotes, clientValues = snap.clients, locationValues = snap.locations;

  // ⚠️ RE-MATCH AT CLICK TIME, not just at submit.
  // The match stored on the row is a snapshot from when the customer sent it.
  // A client row may have been created or linked in the hours since, and
  // creating a lead on top of it is exactly the duplicate this whole feature
  // exists to prevent. The submit-time match is a triage hint; this is the
  // decision.
  const fresh = findMatch(
    { first_name: row.first_name, last_name: row.last_name, email: row.email,
      phone: row.phone, address: row.service_address, zip_code: row.zip_code },
    rowsToObjects(clientValues), rowsToObjects(locationValues), rowsToObjects(quoteValues)
  );
  if (fresh.status === 'confident' && !body.force) {
    return sendJson(res, 409, {
      ok: false, code: 'match_found',
      error: 'This person is already in the CRM. Link the request instead of creating a second record.',
      match: fresh.match
    });
  }

  const quoteHeader = (quoteValues[0] || []).map(normalizeHeader);
  const quoteId = 'Q-' + crypto.randomBytes(4).toString('hex');
  const now = new Date().toISOString();

  // Only columns that exist on the sheet are written. lead_source is added
  // lazily by ensureColumn_ on the Apps Script side and may not be present yet;
  // writing to a column that does not exist is a silent drop, so it is recorded
  // in notes as well rather than trusted to land.
  const lead = {
    quote_id: quoteId,
    first_name: row.first_name, last_name: row.last_name,
    email: row.email, phone: row.phone,
    address: row.service_address, city: row.city, zip_code: row.zip_code,
    status: 'LEAD',
    timestamp: now,
    quote_source: 'service_request',
    lead_source: row.campaign_id ? 'service_request:' + row.campaign_id : 'service_request',
    contact_log: '[]',
    notes: [
      'Created from service request ' + row.request_id,
      (CATEGORIES[row.category] || {}).label || row.category,
      row.description
    ].filter(Boolean).join(' — ').slice(0, 900)
  };

  await appendSheetRows('Quotes', [rowFromObject(quoteHeader, lead)], crmId);

  const patch = stamp(row, session, 'create_lead', 'in_review', {
    converted_quote_id: quoteId,
    match_status: 'confident',
    match_quote_id: quoteId,
    match_reasons: 'lead_created_by_' + actorName(session)
  });
  await saveRequest(header, row, patch);

  return sendJson(res, 200, { ok: true, request_id: row.request_id, quote_id: quoteId });
}

// ── schedule ────────────────────────────────────────────────────────────────

async function actionSchedule(req, res, session, body) {
  const { header, row } = await locate(body.request_id);
  if (!row) return sendJson(res, 404, { ok: false, error: 'Request not found.' });

  if (String(row.scheduled_visit_id || '').trim()) {
    return sendJson(res, 200, { ok: true, request_id: row.request_id, scheduled_visit_id: row.scheduled_visit_id, existing: true });
  }
  const blocked = guard(row, 'schedule'); if (blocked) return sendJson(res, 409, { ok: false, error: blocked });

  const cat = CATEGORIES[row.category] || {};
  if (!cat.schedulable) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Weekly service needs a signed agreement and a route slot. Send this to the quote tool instead.'
    });
  }

  // ⚠️ THE PREFLIGHT. Scheduled_Visits joins its address, customer name and map
  // pin from Routes/Quotes by pool_id. A visit without one renders on the
  // technician's board as a nameless stop with no address — worse than not
  // scheduling it. pool_id is minted by the quote/activation pipeline
  // (_mcpsNextPoolId_ in SalesHub.js), never here, so the only correct move is
  // to refuse and make the admin resolve identity first.
  const poolId = clean(row.match_pool_id, 40);
  if (!poolId) {
    return sendJson(res, 400, {
      ok: false, code: 'no_pool_id',
      error: 'This property has no pool ID yet. Link the request to an existing customer, or send it to the quote tool to set one up, before scheduling.'
    });
  }

  // A regex alone accepts 2026-13-45. Round-tripping through Date catches a day
  // that does not exist, and the past check catches the far more likely slip —
  // a date picker left on last month.
  const date = clean(body.scheduled_date, 12);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return sendJson(res, 400, { ok: false, error: 'Choose a date for the visit.' });
  }
  const parsed = new Date(date + 'T12:00:00Z');
  if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    return sendJson(res, 400, { ok: false, error: `${date} is not a real date.` });
  }
  const today = new Date();
  const todayIso = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 12))
    .toISOString().slice(0, 10);
  if (date < todayIso) {
    return sendJson(res, 400, { ok: false, error: `${date} is in the past. Pick a day from today onward.` });
  }

  const tech = clean(body.assigned_technician, 80);

  const now = new Date().toISOString();
  const visitId = crypto.randomUUID();
  const customerName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();

  const visit = {
    scheduled_visit_id: visitId,
    pool_id: poolId,
    customer_name: customerName,
    service_type: cat.service_type,
    visit_type: 'one_time',
    scheduled_date: date,
    assigned_technician: tech,
    status: 'scheduled',
    completed_at: '', completed_by: '', chem_log_ref: '',
    notes: ['Service request ' + row.request_id,
            row.subcategory, row.description].filter(Boolean).join(' — ').slice(0, 500),
    created_at: now,
    created_by: actorName(session)
  };

  await appendSheetRows(VISITS_SHEET, [rowFromObject(VISIT_HEADERS, visit)], routesSpreadsheetId());

  const patch = stamp(row, session, 'schedule', 'scheduled', {
    scheduled_visit_id: visitId,
    review_notes: clean(body.review_notes || row.review_notes, 500)
  });
  await saveRequest(header, row, patch);

  return sendJson(res, 200, {
    ok: true, request_id: row.request_id, scheduled_visit_id: visitId,
    scheduled_date: date, assigned_technician: tech
  });
}

// ── repair_order ────────────────────────────────────────────────────────────

async function actionRepairOrder(req, res, session, body) {
  const { header, row } = await locate(body.request_id);
  if (!row) return sendJson(res, 404, { ok: false, error: 'Request not found.' });

  if (String(row.repair_order_id || '').trim()) {
    return sendJson(res, 200, { ok: true, request_id: row.request_id, order_id: row.repair_order_id, existing: true });
  }
  const blocked = guard(row, 'repair_order'); if (blocked) return sendJson(res, 409, { ok: false, error: blocked });

  const poolId = clean(row.match_pool_id, 40);
  if (!poolId) {
    return sendJson(res, 400, {
      ok: false, code: 'no_pool_id',
      error: 'This property has no pool ID yet. Link the request to an existing customer first.'
    });
  }

  let photos = [];
  try { photos = JSON.parse(row.photo_urls || '[]'); } catch (_) {}

  const now = new Date().toISOString();
  const orderId = 'RO-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  // status 'new', deliberately. The existing Jobs hub owns approval and
  // scheduling from here (Jobs.js handleUpdateRepairOrder), and that path is the
  // one that mints the visit and stamps scheduled_visit_id back. Reimplementing
  // it would give repairs two schedulers that disagree.
  const order = {
    order_id: orderId,
    quote_ref: clean(row.match_quote_id, 40),
    pool_id: poolId,
    customer_name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim(),
    address: row.service_address, city: row.city,
    job_name: clean(body.job_name, 120) || ('Repair: ' + (row.subcategory || 'customer request')),
    description: clean(row.description, 900),
    equipment: clean(row.subcategory, 60),
    issue: clean(row.description, 300),
    priority: clean(body.priority, 20) || (row.timing_preference === 'asap' ? 'high' : 'medium'),
    parts_json: '[]',
    photo_url: photos[0] || '',
    status: 'new',
    assignee_type: '', assigned_to: clean(body.assigned_to, 80),
    reported_at: row.created_at || now,
    scheduled_date: '', scheduled_visit_id: '', completed_at: '',
    updated_at: now, updated_by: actorName(session)
  };

  await appendSheetRows(REPAIRS_SHEET, [rowFromObject(REPAIR_HEADERS, order)], routesSpreadsheetId());

  const patch = stamp(row, session, 'repair_order', 'in_review', { repair_order_id: orderId });
  await saveRequest(header, row, patch);

  return sendJson(res, 200, { ok: true, request_id: row.request_id, order_id: orderId });
}

// ── decline / note ──────────────────────────────────────────────────────────

async function actionDecline(req, res, session, body) {
  const { header, row } = await locate(body.request_id);
  if (!row) return sendJson(res, 404, { ok: false, error: 'Request not found.' });
  const blocked = guard(row, 'decline'); if (blocked) return sendJson(res, 409, { ok: false, error: blocked });

  const asDuplicate = !!body.duplicate;
  const patch = stamp(row, session, asDuplicate ? 'mark_duplicate' : 'decline',
    asDuplicate ? 'duplicate' : 'declined',
    { review_notes: clean(body.review_notes, 500) });
  await saveRequest(header, row, patch);
  return sendJson(res, 200, { ok: true, request_id: row.request_id, status: patch.status });
}

async function actionNote(req, res, session, body) {
  const { header, row } = await locate(body.request_id);
  if (!row) return sendJson(res, 404, { ok: false, error: 'Request not found.' });
  const blocked = guard(row, 'note'); if (blocked) return sendJson(res, 409, { ok: false, error: blocked });

  const status = String(row.status || 'new').toLowerCase() === 'new' ? 'in_review' : row.status;
  const patch = stamp(row, session, 'note', status, { review_notes: clean(body.review_notes, 500) });
  await saveRequest(header, row, patch);
  return sendJson(res, 200, { ok: true, request_id: row.request_id, status: patch.status });
}

const ACTIONS = {
  link: actionLink,
  create_lead: actionCreateLead,
  schedule: actionSchedule,
  repair_order: actionRepairOrder,
  decline: actionDecline,
  note: actionNote
};

// ── Router ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('allow', 'GET, POST, OPTIONS');
      return res.status(204).end();
    }

    const session = await requireAdminPortalToken(req, res);
    if (!session) return;   // requireAdminPortalToken already answered

    if (req.method === 'GET') return await handleList(req, res);

    if (req.method === 'POST') {
      const body = parseBody(req.body);
      const action = String(body.action || '').trim();
      const run = ACTIONS[action];
      if (!run) return sendJson(res, 400, { ok: false, error: 'Unknown action.' });
      if (!body.request_id) return sendJson(res, 400, { ok: false, error: 'Missing request_id.' });
      return await run(req, res, session, body);
    }

    res.setHeader('allow', 'GET, POST, OPTIONS');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('service-requests/review failed', error);
    return sendJson(res, 500, { ok: false, error: error.message || 'Review action failed.' });
  }
}

export { VISIT_HEADERS, REPAIR_HEADERS, ALLOWED_FROM, STATUSES };
