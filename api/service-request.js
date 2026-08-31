// ══════════════════════════════════════════════════════════════════════════════
// SERVICE REQUESTS — the feature's single serverless function
//
//   PUBLIC
//     POST /api/service-request               submit a request
//     POST /api/service-request?op=upload     attach a photo
//     GET  /api/service-request?k=<token>     prefill for a personalised link
//     GET  /api/service-request?r=<id>        coarse status for a reference number
//     GET  /api/service-request?warm=1        warm the caches
//
//   ADMIN (portal session)
//     GET  /api/service-request?op=review     the review queue
//     POST /api/service-request?op=review     link / create lead / schedule / decline
//     GET  /api/service-request?op=view       read a private customer photo
//
// ⚠️ WHY ONE FUNCTION AND NOT FOUR. The Hobby plan allows 12 serverless
// functions per deployment and the portal already uses 12, so four more failed
// the deploy outright. The handlers still live in separate files under
// api/_lib/ — which Vercel does not count, being underscore-prefixed — and this
// dispatches to them. The split is by module, not by file-per-route.
//
// ⚠️ AUTH IS ENFORCED HERE, ONCE, FROM THE TABLE BELOW — never inside the
// handlers. Public and admin routes now share an entry point, and the way that
// goes wrong is a new op added without its check. Making the dispatcher the
// only gate means forgetting is not possible: an op with no table entry is a
// 400, not an open door.
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
  ensureSheetWithHeaders, rowsToObjects, normalizeHeader, sendJson, getCached,
  requireAdminPortalToken
} from './_sheets.js';
import {
  findMatch, normEmail, normPhone, normAddress
} from './_lib/identity.js';
import {
  SHEET, HEADERS, CATEGORIES, OPEN_STATUSES, PUBLIC_STATUS,
  sanitizeSubmission, idempotencyKey, newRequestId, rowFromObject, appendAction, clean
} from './_lib/service-requests.js';
import { notifyCustomer, notifyOffice } from './_lib/notify.js';

const NORM = { normEmail, normPhone, normAddress };

// Five minutes, not one. Profiling the submit path: minting the Google OAuth
// token costs ~640ms cold and the three sheet reads ~330ms, while the match
// itself is under a millisecond — so nearly all of a customer's wait is warming
// up, and a longer cache removes it for everyone after the first.
//
// Staleness cannot produce a WRONG match, only a missed one: a client added in
// the last five minutes simply isn't matched, and an unmatched request goes to
// the review queue for a human anyway. "Create lead" re-runs the match against
// live data before it writes, which is where a stale miss gets caught.
const MATCH_CACHE_MS = 5 * 60 * 1000;
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

function bucket(map, ip, max, windowMs) {
  const now = Date.now();
  const key = String(ip || 'unknown');
  const list = (map.get(key) || []).filter(t => now - t < windowMs);
  list.push(now);
  map.set(key, list);
  if (map.size > 5000) map.clear();   // crude ceiling; a cold map is fine
  return list.length > max;
}

function rateLimited(ip) { return bucket(hits, ip, RATE_MAX, RATE_WINDOW_MS); }

const reads = new Map();
function readLimited(ip) { return bucket(reads, ip, 60, RATE_WINDOW_MS); }

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

// One round trip on the common path.
//
// ensureSheetWithHeaders costs a metadata fetch plus a header read before the
// data read even starts — three sequential calls to Google, ~250ms of a
// customer's wait, to answer a question the data read already answers: the tab
// exists and row 0 is its header. So read first, and only fall back to creating
// the tab when the read comes back with nothing, which happens exactly once in
// the lifetime of the sheet.
async function loadRequests() {
  const id = crmSpreadsheetId();
  let values = await readSheetRange(SHEET, id).catch(() => null);

  if (!values || !values.length || !(values[0] || []).length) {
    const header = await ensureSheetWithHeaders(SHEET, HEADERS, id);
    return { header: header.map(normalizeHeader), rows: [] };
  }

  let header = values[0].map(normalizeHeader);

  // ⚠️ ensureSheetWithHeaders does NOT repair a partial header row — it returns
  // whatever is there. So a column someone deleted, renamed or reordered by hand
  // becomes a SILENT DROP on every write: the value goes nowhere and nothing
  // errors. That is exactly how scope_items_json went missing for months on the
  // Apps Script side (see the note in api/_repo/sheets-driver.js). Appending the
  // missing columns costs one extra request and only on a sheet that is actually
  // broken.
  const missing = HEADERS.map(normalizeHeader).filter(h => header.indexOf(h) === -1);
  if (missing.length) {
    header = header.concat(missing);
    await writeSheetRange(`${SHEET}!A1:${colLetter(header.length - 1)}1`, [header], id);
    console.warn('Service_Requests header repaired, added:', missing.join(', '));
  }

  const rows = rowsToObjects(values).map((obj, i) => Object.assign(obj, { _row: i + 2 }));
  return { header, rows };
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
// A submission may only claim photos it actually uploaded.
//
// These are pathnames, not URLs, which makes the check both simpler and
// stronger than the host allowlist a URL would need: a pathname cannot point at
// another host at all. All that is left is proving the photo belongs to THIS
// draft, so one draft cannot attach another's photos by guessing.
function acceptedPhotoPaths(rawList, draftId) {
  if (!draftId) return [];
  const prefix = `service-requests/${draftId}/`;
  const list = Array.isArray(rawList) ? rawList : [];
  const out = [];
  for (const raw of list) {
    const value = clean(raw, 300);
    if (!value.startsWith(prefix)) continue;
    // No traversal, and only the characters the upload endpoint generates.
    if (!/^service-requests\/[a-z0-9]{8,40}\/[A-Za-z0-9._-]{1,80}$/.test(value)) continue;
    out.push(value);
    if (out.length === 4) break;
  }
  return out;
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
  const photoUrls = acceptedPhotoPaths(body.photo_urls || body.photo_paths, fields.draft_id);

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

  // ⚠️ Best effort, and awaited on purpose. Awaited because a serverless
  // instance can be frozen the moment the response is sent, so a floating
  // promise here would be silently dropped — the customer would get no receipt
  // and the office no alert. Best effort because the row is already saved: a
  // mail failure must never turn into an error the customer sees, or they will
  // send the whole thing again.
  const notes = await Promise.allSettled([
    notifyCustomer(record, CATEGORIES[fields.category].label),
    notifyOffice(record, CATEGORIES[fields.category].label, matchSummary(match, matched))
  ]);
  notes.forEach(n => {
    const v = n.status === 'fulfilled' ? n.value : { error: String(n.reason) };
    if (v && v.error) console.warn('service-request notification failed:', v.error);
  });

  return sendJson(res, 200, {
    ok: true,
    request_id: requestId,
    category_label: CATEGORIES[fields.category].label
  });
}

// One line an office reader can act on, rather than a confidence score.
function matchSummary(match, matched) {
  if (match && String(match.status || '').toUpperCase() === 'ACTIVE_CUSTOMER') {
    return `ALREADY A CUSTOMER — ${match.display || match.quote_id} (${match.quote_id || match.client_id})`;
  }
  if (match) {
    return `Matched ${match.display || match.quote_id || match.client_id} on ${(match.reasons || []).join(', ')}` +
      (match.pool_id ? ` · pool ${match.pool_id}` : ' · no pool ID yet');
  }
  if (matched.status === 'ambiguous') {
    return `Needs review — ${matched.candidates.length} possible match(es), none certain`;
  }
  return 'No match — nobody in the CRM looks like this person';
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

// ── GET: warm ───────────────────────────────────────────────────────────────
// Called once when the page loads. It mints the Google OAuth token and fills the
// match snapshot, so by the time the customer finishes the form — a minute or
// more later — submitting is a write rather than a cold start. Returns nothing
// about anybody; it exists purely for the timing.
async function handleWarm(res) {
  try { await loadCrmSnapshot(); } catch (_) { /* warming must never surface an error */ }
  return sendJson(res, 200, { ok: true });
}

// ── Router ──────────────────────────────────────────────────────────────────

// The whole access-control surface, in one readable table. `admin: true` sends
// the request through requireAdminPortalToken before the handler ever runs.
const OPS = {
  upload: { admin: false, load: () => import('./_lib/photo-upload.js') },
  review: { admin: true,  load: () => import('./_lib/review.js') },
  view:   { admin: true,  load: () => import('./_lib/photo-read.js') }
};

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('allow', 'GET, POST, OPTIONS');
      return res.status(204).end();
    }

    const q = req.query || {};
    const op = String(q.op || '').trim();

    if (op) {
      const route = OPS[op];
      // An unknown op is refused rather than falling through to the public
      // intake — a typo must not silently become a submission.
      if (!route) return sendJson(res, 400, { ok: false, error: 'Unknown operation.' });
      if (route.admin) {
        const session = await requireAdminPortalToken(req, res);
        if (!session) return;   // requireAdminPortalToken already answered
        req.session = session;
      }
      const mod = await route.load();
      return await mod.handler(req, res);
    }

    if (req.method === 'POST') return await handleSubmit(req, res);
    if (req.method === 'GET') {
      if (q.warm) return await handleWarm(res);

      // Reads are rate limited too. A reference number is eight hex characters,
      // and an unthrottled lookup that answers 404 for unknown and 200 for known
      // is an enumerator — slow, but there is no reason to leave it open.
      if (readLimited(clientIp(req))) {
        return sendJson(res, 429, { ok: false, error: 'Too many lookups. Please wait a moment.' });
      }
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
