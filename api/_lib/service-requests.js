// ══════════════════════════════════════════════════════════════════════════════
// SERVICE_REQUESTS — schema and pure helpers
//
// The intake sheet for customer-submitted service requests. Modelled on
// Startup_Requests (appscript/StartupRequests.js), which is the working
// precedent in this codebase for a public, unauthenticated form that writes.
//
// ⚠️ THE INVARIANT THAT MAKES THIS SAFE:
//   The public path writes HERE AND NOWHERE ELSE. It cannot append to Quotes,
//   cannot mint a client_id, cannot mint a pool_id. Every CRM and scheduling
//   side effect happens later, from the admin console, behind a session check.
//   A duplicate person is therefore not something the public endpoint is
//   trusted not to do — it is something it cannot do.
//
// Everything in this file is pure. Sheet access lives in the handlers.
// ══════════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';

export const SHEET = 'Service_Requests';

export const HEADERS = [
  'request_id', 'created_at', 'updated_at', 'source', 'campaign_id', 'link_token', 'draft_id',
  'first_name', 'last_name', 'email', 'phone',
  'service_address', 'city', 'state', 'zip_code',
  'category', 'subcategory', 'description', 'photo_urls',
  'timing_preference', 'timing_notes',
  'match_status', 'match_client_id', 'match_quote_id', 'match_location_id', 'match_pool_id',
  'match_confidence', 'match_reasons', 'match_candidates_json', 'is_existing_customer',
  'status', 'reviewed_by', 'reviewed_at', 'review_notes', 'action_log',
  'scheduled_visit_id', 'repair_order_id', 'converted_quote_id',
  'idempotency_key', 'duplicate_of', 'submitter_ip', 'user_agent'
];

// ── Vocabulary ──────────────────────────────────────────────────────────────

// The four things a customer can ask for. `schedulable` marks the ones that can
// become a one-time visit directly; weekly service deliberately cannot — it
// needs a signed agreement, a pool_id and billing, so it routes to the quote
// tool like any other new recurring customer.
export const CATEGORIES = {
  green_to_clean: {
    label: 'Green-to-clean',
    service_type: 'Green-to-Clean Cleaning Service',
    schedulable: true,
    wants_photos: true
  },
  repair: {
    label: 'Repair or equipment',
    service_type: 'Repair',
    schedulable: true,
    creates_repair_order: true,
    wants_photos: true
  },
  weekly_service: {
    label: 'Weekly pool service',
    service_type: 'Weekly Full Service',
    schedulable: false,
    wants_photos: false
  },
  one_time: {
    label: 'One-time clean or other',
    service_type: 'One-Time Service',
    schedulable: true,
    wants_photos: true
  }
};

export const SUBCATEGORIES = {
  repair: ['pump', 'filter', 'heater', 'salt_system', 'chlorinator', 'lights',
           'leak', 'automation', 'plumbing', 'surface', 'other'],
  green_to_clean: ['few_weeks', 'a_month', 'several_months', 'unsure'],
  weekly_service: ['no_current_service', 'switching_companies', 'doing_it_myself', 'unsure'],
  one_time: ['single_clean', 'pre_event_clean', 'filter_clean', 'drain_and_fill',
             'vacation_coverage', 'water_test', 'other']
};

export const TIMING = ['asap', 'this_week', 'next_week', 'flexible'];

export const STATUSES = ['new', 'in_review', 'scheduled', 'quoted', 'declined', 'duplicate'];

// Statuses a repeat submission may quietly fold into. Anything past these has
// been acted on by a human — overwriting it would erase that work, and worse,
// could silently change the details of a job already on a technician's list.
export const OPEN_STATUSES = ['new', 'in_review'];

// ── Sanitising ──────────────────────────────────────────────────────────────

const MAX_FIELD = 500;
const MAX_DESCRIPTION = 2000;

export function clean(value, max = MAX_FIELD) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// Deliberately permissive — this rejects typos, not unusual-but-valid addresses.
// A customer whose real email we refuse is a lost job.
export function isEmail(value) {
  const v = clean(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;
}

export function isPhone(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

/**
 * Turn a raw request body into the fields we are willing to store.
 * An allowlist, not a filter: a key not named here does not reach the sheet,
 * so a client cannot invent a column or overwrite one we own (status,
 * match_*, reviewed_by, scheduled_visit_id...).
 */
export function sanitizeSubmission(body) {
  const b = body || {};
  const errors = [];

  const category = clean(b.category, 40);
  if (!CATEGORIES[category]) errors.push('Please choose what you need help with.');

  const allowedSubs = SUBCATEGORIES[category] || [];
  const subcategory = allowedSubs.includes(clean(b.subcategory, 40)) ? clean(b.subcategory, 40) : '';

  const timing = TIMING.includes(clean(b.timing_preference, 20)) ? clean(b.timing_preference, 20) : 'flexible';

  const email = clean(b.email, 254);
  const phone = clean(b.phone, 40);
  const address = clean(b.service_address || b.address);

  // One contact route is the minimum — without it a request is unanswerable.
  if (!email && !phone) errors.push('Please give us an email address or a phone number so we can reach you.');
  if (email && !isEmail(email)) errors.push('That email address looks incomplete. Please check it.');
  if (phone && !isPhone(phone)) errors.push('That phone number looks incomplete. Please check it.');
  if (!address) errors.push('Please tell us the address of the pool.');

  const fields = {
    first_name: clean(b.first_name, 80),
    last_name: clean(b.last_name, 80),
    email: email.toLowerCase(),
    phone,
    service_address: address,
    city: clean(b.city, 80),
    state: clean(b.state, 20) || 'TX',
    zip_code: clean(b.zip_code, 12),
    category,
    subcategory,
    description: clean(b.description, MAX_DESCRIPTION),
    timing_preference: timing,
    timing_notes: clean(b.timing_notes),
    campaign_id: clean(b.campaign_id, 60),
    draft_id: clean(b.draft_id, 60)
  };

  return { fields, errors };
}

// ── Idempotency ─────────────────────────────────────────────────────────────

/**
 * Stable key for "the same person asking for the same thing".
 *
 * Phone is included alongside email because email is the field most often
 * missing or mistyped on a phone keyboard. Without it, two different people at
 * one address requesting the same category collide into a single request — and
 * one of them silently never gets called.
 *
 * Normalisers are passed in rather than imported so this file stays free of a
 * circular dependency with identity.js.
 */
export function idempotencyKey({ email, phone, address, category }, norm) {
  const parts = [
    norm.normEmail(email),
    norm.normPhone(phone),
    norm.normAddress(address),
    String(category || '').trim().toLowerCase()
  ].join('|');
  return crypto.createHash('sha256').update(parts).digest('hex').slice(0, 32);
}

export function newRequestId() {
  return 'SR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ── Row assembly ────────────────────────────────────────────────────────────

export function rowFromObject(headerRow, obj) {
  return headerRow.map(h => {
    const v = obj[h];
    return v === undefined || v === null ? '' : v;
  });
}

export function appendAction(existingLog, entry) {
  let log = [];
  try {
    const parsed = JSON.parse(existingLog || '[]');
    if (Array.isArray(parsed)) log = parsed;
  } catch (_) { /* a corrupt log must not block the write */ }
  log.push(entry);
  return JSON.stringify(log.slice(-40));
}

// ── Customer-facing status ──────────────────────────────────────────────────

// What the ?r= status view is allowed to say. Coarse on purpose: a reference
// number is not authorisation to read someone's request, so the detail behind
// these words requires the caller to also supply the email or phone on file.
export const PUBLIC_STATUS = {
  new: 'Received',
  in_review: 'In review',
  scheduled: 'Scheduled',
  quoted: 'Quote sent',
  declined: 'Closed',
  duplicate: 'Received'
};
