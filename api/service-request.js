// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC SERVICE-REQUEST INTAKE
//
//   POST /api/service-request            submit a request
//   GET  /api/service-request?k=<token>  prefill for a personalised link
//   GET  /api/service-request?r=<id>     coarse status for a reference number
//
// Public and unauthenticated. Two rules govern everything here:
//
//   1. It writes to Service_Requests and NOWHERE ELSE. No Quotes row, no
//      client_id, no pool_id. Duplicate prevention is structural, not a promise.
//   2. It returns as little as possible. A public endpoint that echoes CRM rows
//      is an enumerator; the prefill returns four display fields and the status
//      view returns one word.
// ══════════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import {
  crmSpreadsheetId, readSheetRange, writeSheetRange, appendSheetRows,
  ensureSheetWithHeaders, rowsToObjects, normalizeHeader, sendJson, getCached
} from './_sheets.js';
import {
  findMatch, normEmail, normPhone, normAddress
} from './_lib/identity.js';
import {
  SHEET, HEADERS, CATEGORIES, OPEN_STATUSES, PUBLIC_STATUS,
  sanitizeSubmission, idempotencyKey, newRequestId, rowFromObject, appendAction, clean
} from './_lib/service-requests.js';

const NORM = { normEmail, normPhone, normAddress };
const MATCH_CACHE_MS = 60 * 1000;
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Kill switch ─────────────────────────────────────────────────────────────
// Flip SERVICE_REQUEST_INTAKE=off in the Vercel dashboard to stop accepting
// submissions without a deploy. Reads stay up so existing reference numbers keep
// working — turning the form off should not break a link already in the wild.
function intakeDisabled() {
  return String(process.env.SERVICE_REQUEST_INTAKE || '').trim().toLowerCase() === 'off';
}

// ── Per-recipient link tokens ───────────────────────────────────────────────
// Stateless: base64url(quote_id).hmac, verified with a secret. No token table to
// mint, expire or clean up. Absent a secret, tokens simply never verify and the
// page falls through to its address form — which is the same path a forwarded
// link takes, so the failure mode is already designed for.
function linkSecret() {
  return process.env.SERVICE_LINK_SECRET || '';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function mintLinkToken(quoteId) {
  const secret = linkSecret();
  if (!secret) return '';
  const payload = b64url(String(quoteId));
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);
  return `${payload}.${sig}`;
}

export function verifyLinkToken(token) {
  const secret = linkSecret();
  const raw = String(token || '').trim();
  if (!secret || !raw.includes('.')) return '';
  const [payload, sig] = raw.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);
  // Constant-time compare. The lengths are fixed, so a mismatch here is a forgery
  // attempt rather than a malformed link, but timing-safe costs nothing.
  const a = Buffer.from(String(sig || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return '';
  try {
    return Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch (_) { return ''; }
}

// ── Rate limiting ───────────────────────────────────────────────────────────
// In-memory, per warm instance. Fluid Compute reuses instances, so this catches
// the realistic case — one person hammering submit — without a datastore. It is
// not a defence against a distributed flood; BotID and the platform sit in front
// of that.
const hits = new Map();
const RATE_MAX = 8;
const RATE_WINDOW_MS = 10 * 60 * 1000;

function rateLimited(ip) {
  const now = Date.now();
  const key = String(ip || 'unknown');
  const list = (hits.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();   // crude ceiling; a cold map is fine
  return list.length > RATE_MAX;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  if (Array.isArray(fwd) && fwd.length) return String(fwd[0]).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
}

function parseBody(body) {
  if (!body) return {};
  if (Buffer.isBuffer(body)) return parseBody(body.toString('utf8'));
  if (typeof body === 'object') return body;
  try { return JSON.parse(body); } catch (_) { return {}; }
}

// ── Sheet access ────────────────────────────────────────────────────────────

async function loadCrmSnapshot() {
  return getCached('sr:crm-snapshot', MATCH_CACHE_MS, async () => {
    const id = crmSpreadsheetId();
    const [quotes, clients, locations] = await Promise.all([
      readSheetRange('Quotes', id).catch(() => []),
      readSheetRange('Clients', id).catch(() => []),
      readSheetRange('Client_Locations', id).catch(() => [])
    ]);
    return {
      quotes: rowsToObjects(quotes),
      clients: rowsToObjects(clients),
      locations: rowsToObjects(locations)
    };
  });
}

async function loadRequests() {
  const header = await ensureSheetWithHeaders(SHEET, HEADERS, crmSpreadsheetId());
  const values = await readSheetRange(SHEET, crmSpreadsheetId());
  const rows = rowsToObjects(values).map((obj, i) => Object.assign(obj, { _row: i + 2 }));
  return { header: header.map(normalizeHeader), rows };
}

// Column letter for a 0-based index, so an update targets the real width of the
// sheet rather than assuming our HEADERS length matches what is there.
function colLetter(index) {
  let n = index, out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}

// ── Photo URL validation ────────────────────────────────────────────────────
// A submission may only claim photos it actually uploaded. The upload endpoint
// stores every blob under service-requests/<draft_id>/, so requiring that prefix
// stops a submission attaching someone else's pool photos by pasting a URL.
function acceptedPhotoUrls(rawList, draftId) {
  if (!draftId) return [];
  const base = process.env.BLOB_PUBLIC_BASE || '';
  const list = Array.isArray(rawList) ? rawList : [];
  return list
    .map(u => clean(u, 600))
    .filter(u => /^https:\/\//i.test(u))
    .filter(u => u.includes(`service-requests/${draftId}/`))
    .filter(u => !base || u.startsWith(base))
    .slice(0, 4);
}

// ── POST: submit ────────────────────────────────────────────────────────────

async function handleSubmit(req, res) {
  if (intakeDisabled()) {
    return sendJson(res, 503, {
      ok: false,
      error: 'Online requests are paused right now. Please call us and we will take care of it.'
    });
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return sendJson(res, 429, {
      ok: false,
      error: 'We already have your request. Please give us a moment before sending another.'
    });
  }

  const body = parseBody(req.body);
  const { fields, errors } = sanitizeSubmission(body);
  if (errors.length) return sendJson(res, 400, { ok: false, error: errors[0], errors });

  // A verified link token identifies the row we mailed. It is evidence, not
  // authority: the match below still runs, and still has to reach two signals.
  const tokenQuoteId = verifyLinkToken(body.k || body.link_token);

  const [snapshot, existing] = await Promise.all([loadCrmSnapshot(), loadRequests()]);

  const matched = findMatch(
    { ...fields, address: fields.service_address },
    snapshot.clients, snapshot.locations, snapshot.quotes
  );

  // The token's quote wins only if the open match agrees or found nothing —
  // never over a confident match on different details, which would mean the link
  // was forwarded to someone else.
  let match = matched.match;
  if (tokenQuoteId && (!match || match.quote_id === tokenQuoteId)) {
    const q = snapshot.quotes.find(r => String(r.quote_id || '').trim() === tokenQuoteId);
    if (q) {
      match = {
        ...(match || {}),
        kind: 'quote',
        client_id: (match && match.client_id) || String(q.client_id || '').trim(),
        quote_id: tokenQuoteId,
        location_id: (match && match.location_id) || String(q.location_id || '').trim(),
        pool_id: (match && match.pool_id) || String(q.pool_id || '').trim(),
        display: [q.first_name, q.last_name].filter(Boolean).join(' ').trim(),
        status: String(q.status || '').trim(),
        reasons: [...new Set([...(match?.reasons || []), 'campaign_link'])],
        score: (match?.score || 0) + 40
      };
    }
  }

  const key = idempotencyKey({
    email: fields.email, phone: fields.phone,
    address: fields.service_address, category: fields.category
  }, NORM);

  const now = new Date().toISOString();
  const photoUrls = acceptedPhotoUrls(body.photo_urls, fields.draft_id);

  const matchFields = {
    match_status: match ? 'confident' : matched.status,
    match_client_id: match ? match.client_id : '',
    match_quote_id: match ? match.quote_id : '',
    match_location_id: match ? match.location_id : '',
    match_pool_id: match ? match.pool_id : '',
    match_confidence: match ? String(match.score) : '',
    match_reasons: match ? (match.reasons || []).join(',') : '',
    match_candidates_json: JSON.stringify((matched.candidates || []).map(c => ({
      kind: c.kind, client_id: c.client_id, quote_id: c.quote_id, pool_id: c.pool_id,
      display: c.display, email: c.email, phone: c.phone, address: c.address,
      status: c.status, score: c.score, reasons: c.reasons
    }))),
    is_existing_customer: match && String(match.status || '').toUpperCase() === 'ACTIVE_CUSTOMER' ? 'TRUE' : 'FALSE'
  };

  // ── Idempotency, status-aware ─────────────────────────────────────────────
  // A repeat folds into the open request. Once a human has acted — scheduled,
  // quoted, declined — the row is frozen and the repeat is appended instead,
  // linked by duplicate_of. Overwriting a scheduled request would silently
  // change a job already on a technician's list.
  const prior = existing.rows
    .filter(r => String(r.idempotency_key || '') === key)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const open = prior.find(r =>
    OPEN_STATUSES.includes(String(r.status || 'new').trim().toLowerCase()) &&
    (Date.now() - Date.parse(r.created_at || 0)) < IDEMPOTENCY_WINDOW_MS
  );

  if (open) {
    const patch = {
      ...open, ...fields, ...matchFields,
      updated_at: now,
      photo_urls: photoUrls.length ? JSON.stringify(photoUrls) : open.photo_urls,
      submitter_ip: ip,
      user_agent: clean(req.headers['user-agent'], 300),
      action_log: appendAction(open.action_log, {
        at: now, actor: 'customer', action: 'resubmit',
        from_status: open.status || 'new', to_status: open.status || 'new'
      })
    };
    delete patch._row;
    const width = existing.header.length;
    await writeSheetRange(
      `${SHEET}!A${open._row}:${colLetter(width - 1)}${open._row}`,
      [rowFromObject(existing.header, patch)],
      crmSpreadsheetId()
    );
    return sendJson(res, 200, {
      ok: true, request_id: open.request_id, updated: true,
      category_label: CATEGORIES[fields.category].label
    });
  }

  const requestId = newRequestId();
  const record = {
    request_id: requestId,
    created_at: now,
    updated_at: now,
    source: 'service_request_page',
    link_token: tokenQuoteId ? 'verified' : '',
    ...fields,
    photo_urls: photoUrls.length ? JSON.stringify(photoUrls) : '',
    ...matchFields,
    status: 'new',
    action_log: JSON.stringify([{ at: now, actor: 'customer', action: 'submit', to_status: 'new' }]),
    idempotency_key: key,
    duplicate_of: prior.length ? String(prior[0].request_id || '') : '',
    submitter_ip: ip,
    user_agent: clean(req.headers['user-agent'], 300)
  };

  await appendSheetRows(SHEET, [rowFromObject(existing.header, record)], crmSpreadsheetId());

  return sendJson(res, 200, {
    ok: true,
    request_id: requestId,
    category_label: CATEGORIES[fields.category].label
  });
}

// ── GET: prefill ────────────────────────────────────────────────────────────
// Four display fields, nothing else. No client_id, no quote_id, no pool_id, no
// email, no phone, no status, no price. The browser has no use for an internal
// id, and anything returned here is returned to whoever holds the link.
async function handlePrefill(res, token) {
  const quoteId = verifyLinkToken(token);
  if (!quoteId) return sendJson(res, 200, { ok: true, prefill: null });

  const snapshot = await loadCrmSnapshot();
  const q = snapshot.quotes.find(r => String(r.quote_id || '').trim() === quoteId);
  if (!q) return sendJson(res, 200, { ok: true, prefill: null });

  return sendJson(res, 200, {
    ok: true,
    prefill: {
      first_name: clean(q.first_name, 80),
      service_address: clean(q.address),
      city: clean(q.city, 80),
      zip_code: clean(q.zip_code, 12)
    }
  });
}

// ── GET: status ─────────────────────────────────────────────────────────────
// One word by default. Details require the caller to also present the email or
// phone on the request — a reference number alone is a guessable string, not
// authorisation to read what someone asked us to fix at their home.
async function handleStatus(res, ref, contact) {
  const { rows } = await loadRequests();
  const row = rows.find(r => String(r.request_id || '').trim().toUpperCase() === String(ref).trim().toUpperCase());
  if (!row) return sendJson(res, 404, { ok: false, error: 'We could not find a request with that reference number.' });

  const status = String(row.status || 'new').trim().toLowerCase();
  const base = { ok: true, request_id: row.request_id, status: PUBLIC_STATUS[status] || 'Received' };

  const supplied = clean(contact, 254);
  const verified = !!supplied && (
    normEmail(supplied) === normEmail(row.email) ||
    (normPhone(supplied).length >= 10 && normPhone(supplied) === normPhone(row.phone))
  );
  if (!verified) return sendJson(res, 200, base);

  return sendJson(res, 200, {
    ...base,
    verified: true,
    category: String(row.category || ''),
    category_label: (CATEGORIES[row.category] || {}).label || '',
    service_address: String(row.service_address || ''),
    submitted_at: String(row.created_at || ''),
    timing_preference: String(row.timing_preference || '')
    // photo_urls deliberately omitted — see the privacy note in the plan.
  });
}

// ── Router ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('allow', 'GET, POST, OPTIONS');
      return res.status(204).end();
    }
    if (req.method === 'POST') return await handleSubmit(req, res);
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.r) return await handleStatus(res, q.r, q.contact);
      if (q.k) return await handlePrefill(res, q.k);
      return sendJson(res, 400, { ok: false, error: 'Missing parameter.' });
    }
    res.setHeader('allow', 'GET, POST, OPTIONS');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('service-request failed', error);
    // Never leak an internal error to a customer mid-form.
    return sendJson(res, 500, {
      ok: false,
      error: 'We could not save your request just now. Please try again in a moment.'
    });
  }
}
