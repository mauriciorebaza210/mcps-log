// ══════════════════════════════════════════════════════════════════════════════
// QUOTE WRITE PLANNER — pure
//
// Takes a snapshot of the relational tabs plus an operator's input, and returns
// the exact rows to insert and cells to update. Touches no network, no clock and
// no randomness: `now`, `actor` and `idempotencyKey` are arguments.
//
// ⚠️ WHY PURE. Apps Script cannot run on a developer machine, so every bug in
// handleSaveQuote_ was only findable in production. This planner is the same
// logic as plain JavaScript, so the entire write path — id minting, find-or-
// create, pricing authority, the compatibility export — is covered by
// `node tests/quote-write.test.js` before anything reaches a spreadsheet.
//
// It is also the seam for Postgres. The planner emits inserts and updates as
// data; a Sheets driver turns them into batchGet/batchUpdate today, and a pg
// driver turns them into INSERT/UPDATE later. Neither one changes this file.
// ══════════════════════════════════════════════════════════════════════════════

import { ENTITIES, COMPAT_SHEET, SEQUENCES } from './schema.js';
// The SAME engine the browser runs. Not a reimplementation — that is the point.
//
// ⚠️ A STATIC IMPORT, DELIBERATELY — do not put createRequire back.
// This was `createRequire(import.meta.url)` + `require('../../js/lib/pricing.js')`.
// Vercel's Node builder transpiles this file down to CommonJS (exports.x = ...)
// but leaves `import.meta.url` in place, producing a file that is neither valid
// CJS (import.meta is a syntax error there) nor valid ESM (exports is undefined
// there). Node fails to parse it as CJS, reparses as ESM, and the function dies
// at load with "exports is not defined in ES module scope" — every quote save
// returning FUNCTION_INVOCATION_FAILED in production while working locally under
// `vercel dev`, which runs from source and never transpiles.
// pricing.js is UMD, so a default import yields its module.exports.
import PRICING from '../../js/lib/pricing.js';

const clean = v => String(v === undefined || v === null ? '' : v).trim();
const lower = v => clean(v).toLowerCase();

// ── id minting from the snapshot ──────────────────────────────────────────────
// The old backend re-read an entire sheet per id (nextSequence_), and minted six
// or more ids per save. Here the rows are already in hand, so a mint is a scan of
// memory. `minted` carries forward so two ids in one save cannot collide.
export function makeMinter(snapshot) {
  const minted = {};
  return function mint(sheet, column, prefix, width) {
    const cacheKey = sheet + '.' + column;
    if (minted[cacheKey] === undefined) {
      let max = 0;
      const re = new RegExp('^' + prefix + '-(\\d+)$', 'i');
      (snapshot[sheet] || []).forEach(row => {
        const m = re.exec(clean(row[column]));
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      minted[cacheKey] = max;
    }
    minted[cacheKey] += 1;
    return prefix + '-' + String(minted[cacheKey]).padStart(width, '0');
  };
}

// ── find-or-create ────────────────────────────────────────────────────────────
// Matching order is explicit id → email → name+phone. Email first because it is
// the one field the customer themselves supplies consistently; name alone is not
// identifying (two Tony Sillers) and matching on it would merge real people.
export function findClient(snapshot, input) {
  const rows = snapshot[ENTITIES.clients.sheet] || [];
  const explicit = clean(input.client_id);
  if (explicit) {
    const hit = rows.find(r => clean(r.client_id) === explicit);
    if (hit) return hit;
  }
  const email = lower(input.email);
  if (email) {
    const hit = rows.find(r => lower(r.email) === email);
    if (hit) return hit;
  }
  const first = lower(input.first_name), last = lower(input.last_name), phone = digits(input.phone);
  if (first && last && phone) {
    const hit = rows.find(r =>
      lower(r.first_name) === first && lower(r.last_name) === last && digits(r.phone) === phone);
    if (hit) return hit;
  }
  return null;
}

function digits(v) { return clean(v).replace(/\D/g, ''); }

// Address match is normalised, because "123 Pool Ln" and "123 pool lane." are the
// same property and creating a second location for it is how one customer ends up
// with two pool_ids and a phantom stop on the route board.
function normAddress(v) {
  return lower(v)
    .replace(/[.,#]/g, ' ')
    .replace(/\b(street|st)\b/g, 'st')
    .replace(/\b(avenue|ave)\b/g, 'ave')
    .replace(/\b(road|rd)\b/g, 'rd')
    .replace(/\b(drive|dr)\b/g, 'dr')
    .replace(/\b(lane|ln)\b/g, 'ln')
    .replace(/\b(court|ct)\b/g, 'ct')
    .replace(/\b(boulevard|blvd)\b/g, 'blvd')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findLocation(snapshot, clientId, input) {
  const rows = snapshot[ENTITIES.locations.sheet] || [];
  const explicit = clean(input.location_id);
  if (explicit) {
    const hit = rows.find(r => clean(r.location_id) === explicit);
    if (hit) return hit;
  }
  const addr = normAddress(input.address);
  if (clientId && addr) {
    const hit = rows.find(r => clean(r.client_id) === clean(clientId) && normAddress(r.service_address) === addr);
    if (hit) return hit;
  }
  return null;
}

// ── line items ────────────────────────────────────────────────────────────────
// Proposal_Items existed and was populated by reverse-engineering a flat total,
// so nothing could be itemised and repair parts could never affect the price.
// Built forward from the priced result instead.
export function buildLineItems(input, priced, specs) {
  const items = [];
  let sort = 1;
  const push = (o) => items.push(Object.assign({ sort_order: sort++, taxable: 'TRUE', quantity: 1 }, o));

  push({
    line_type: 'service',
    product_service_name: priced.service_label,
    description: specs || '',
    rate: priced.service_subtotal,
    amount: priced.service_subtotal,
    quickbooks_sku: priced.qb_skus[0] || '',
    quickbooks_item_name: priced.qb_names[0] || priced.service_label
  });

  if (priced.adjustment_kind === 'discount') {
    push({
      line_type: 'discount',
      product_service_name: 'Discount',
      description: adjustmentDescription(input, priced),
      rate: -priced.adjustment_amount,
      amount: -priced.adjustment_amount,
      quickbooks_sku: 'DISCOUNT'
    });
  } else if (priced.adjustment_kind === 'premium') {
    // A premium was previously unrepresentable: the flat sheet had only a
    // discount column, so the figure was clamped to the rate card and lost.
    push({
      line_type: 'premium',
      product_service_name: 'Price Adjustment',
      description: adjustmentDescription(input, priced),
      rate: priced.adjustment_amount,
      amount: priced.adjustment_amount,
      quickbooks_sku: 'PRICE-ADJ'
    });
  }

  if (priced.travel_fee > 0) {
    push({
      line_type: 'travel',
      product_service_name: 'Travel Fee',
      description: clean(input.distance_source) ? 'Distance source: ' + clean(input.distance_source) : '',
      rate: priced.travel_fee,
      amount: priced.travel_fee,
      quickbooks_sku: 'TRAVEL'
    });
  }

  // Repair parts, itemised at zero because the job price is quoted as a whole.
  // They are recorded as lines so the work order and the customer document agree
  // on what was included — today they vanish into a JSON blob nothing renders.
  parseParts(input.repair_parts).forEach(part => {
    push({
      line_type: 'part',
      product_service_name: clean(part.name),
      description: 'Included in job price',
      quantity: Number(part.qty) || 1,
      rate: 0,
      amount: 0,
      taxable: 'FALSE',
      quickbooks_sku: 'PART'
    });
  });

  return items;
}

function adjustmentDescription(input, priced) {
  const t = lower(input.adjustment_type);
  if (t === 'percentage') return priced.adjustment_percent + '% off $' + priced.service_subtotal.toFixed(2);
  if (t === 'dollar') return '$' + priced.adjustment_amount.toFixed(2) + ' off $' + priced.service_subtotal.toFixed(2);
  return 'Rate card $' + priced.service_subtotal.toFixed(2) + ' → agreed $' + priced.adjusted_service.toFixed(2);
}

function parseParts(raw) {
  if (Array.isArray(raw)) return raw.filter(p => p && clean(p.name));
  try {
    const parsed = JSON.parse(clean(raw) || '[]');
    return Array.isArray(parsed) ? parsed.filter(p => p && clean(p.name)) : [];
  } catch (_) {
    return [];
  }
}

// ── the plan ──────────────────────────────────────────────────────────────────
export function planQuoteWrite(opts) {
  const snapshot = opts.snapshot || {};
  const input = opts.input || {};
  const now = opts.now;
  const actor = clean(opts.actor) || 'portal';
  const idemKey = clean(opts.idempotencyKey);

  if (!now) return fail('now is required — the planner must not read the clock');

  // ── 1. Idempotency, before anything is minted ──────────────────────────────
  // A double-click used to mint two quote ids, two proposal numbers and (for a
  // startup or G2C) two pool_ids — a phantom customer on the route board.
  if (idemKey) {
    const dup = (snapshot[ENTITIES.proposals.sheet] || [])
      .find(r => clean(r.idempotency_key) === idemKey);
    if (dup) {
      return {
        ok: true,
        replayed: true,
        ids: {
          quote_id: clean(dup.legacy_quote_id),
          proposal_id: clean(dup.proposal_id),
          proposal_number: clean(dup.proposal_number),
          client_id: clean(dup.client_id),
          location_id: clean(dup.location_id)
        },
        inserts: {}, updates: [], compat: null, priced: null
      };
    }
  }

  // ── 2. Price it. The server decides. ───────────────────────────────────────
  const pricingInput = toPricingInput(input);
  const priced = PRICING.priceQuote(pricingInput);
  if (!priced.pricing_ready) {
    return fail(priced.adjustment_error || (priced.warnings[0] || 'This configuration cannot be priced.'));
  }

  // What the browser claimed, for the record. The stored figures are ours either
  // way; a mismatch is reported so a stale or tampered client is visible.
  const verification = PRICING.verifyQuote(pricingInput, input);
  const specs = PRICING.buildSpecsSummary(pricingInput, priced);

  if (!clean(input.first_name) && !clean(input.last_name) && !clean(input.email)) {
    return fail('A customer name or email is required.');
  }

  const mint = makeMinter(snapshot);
  const inserts = {};
  const updates = [];
  const addInsert = (sheet, row) => { (inserts[sheet] = inserts[sheet] || []).push(row); };

  // ── 3. Client ──────────────────────────────────────────────────────────────
  const existingClient = findClient(snapshot, input);
  let clientId;
  if (existingClient) {
    clientId = clean(existingClient.client_id);
    const patch = { updated_at: now, legacy_quote_ids: pushUnique(existingClient.legacy_quote_ids, '') };
    if (!clean(existingClient.email) && clean(input.email)) patch.email = clean(input.email);
    if (!clean(existingClient.phone) && clean(input.phone)) patch.phone = clean(input.phone);
    delete patch.legacy_quote_ids; // filled in below once the quote id exists
    updates.push({ sheet: ENTITIES.clients.sheet, id: clientId, idColumn: 'client_id', patch });
  } else {
    clientId = mint(ENTITIES.clients.sheet, 'client_id', ENTITIES.clients.prefix, ENTITIES.clients.width);
  }

  // ── 4. Location ────────────────────────────────────────────────────────────
  const existingLocation = findLocation(snapshot, clientId, input);
  let locationId;
  if (existingLocation) {
    locationId = clean(existingLocation.location_id);
    updates.push({
      sheet: ENTITIES.locations.sheet, id: locationId, idColumn: 'location_id',
      patch: {
        updated_at: now, active: 'TRUE',
        pool_type: pricingInput.pool_type, pool_size: pricingInput.size,
        material: pricingInput.material, spa: input.spa ? 'TRUE' : 'FALSE',
        finish: pricingInput.finish, debris_level: pricingInput.debris,
        sun_exposure: input.high_sun_exposure ? 'TRUE' : 'FALSE',
        pets_on_property: input.has_pets ? 'TRUE' : 'FALSE',
        robot_on_site: input.has_robot ? 'TRUE' : 'FALSE',
        area: clean(input.area) || clean(existingLocation.area)
      }
    });
  } else {
    locationId = mint(ENTITIES.locations.sheet, 'location_id', ENTITIES.locations.prefix, ENTITIES.locations.width);
  }

  // ── 5. Ids ─────────────────────────────────────────────────────────────────
  const quoteId = 'Q-' + clean(opts.quoteSuffix || '').toUpperCase();
  if (!clean(opts.quoteSuffix)) return fail('quoteSuffix is required — the planner must not generate randomness');

  const proposalId = mint(ENTITIES.proposals.sheet, 'proposal_id', ENTITIES.proposals.prefix, ENTITIES.proposals.width);
  const proposalNumber = mint(SEQUENCES.proposal_number.sheet, 'proposal_number', SEQUENCES.proposal_number.prefix, SEQUENCES.proposal_number.width);
  const agreementId = mint(ENTITIES.agreements.sheet, 'agreement_id', ENTITIES.agreements.prefix, ENTITIES.agreements.width);
  const agreementNumber = mint(SEQUENCES.agreement_number.sheet, 'agreement_number', SEQUENCES.agreement_number.prefix, SEQUENCES.agreement_number.width);
  const serviceAccountId = mint(ENTITIES.serviceAccounts.sheet, 'service_account_id', ENTITIES.serviceAccounts.prefix, ENTITIES.serviceAccounts.width);

  // Operational services get a pool id at save; a signature-gated weekly does not
  // get one until it is signed, matching the existing lifecycle.
  const autoOperational = priced.service_key === 'pool_startup' || priced.service_key === 'green_to_clean';
  const overridden = lower(input.sales_flow) === 'operational_override' || clean(input.signature_required).toUpperCase() === 'FALSE';
  const needsPoolId = autoOperational || overridden;
  // ⚠️ A startup with no start date used to get neither a pool id nor visits, and
  // said nothing. Now it is refused up front.
  if (priced.service_key === 'pool_startup' && !clean(input.startup_start_date)) {
    return fail('A startup needs a start date before it can be scheduled.');
  }
  const poolId = needsPoolId
    ? mint(SEQUENCES.pool_id.sheet, 'pool_id', SEQUENCES.pool_id.prefix, SEQUENCES.pool_id.width)
    : clean(input.pool_id);

  if (!existingClient) {
    addInsert(ENTITIES.clients.sheet, {
      client_id: clientId,
      first_name: clean(input.first_name), last_name: clean(input.last_name),
      display_name: [clean(input.first_name), clean(input.last_name)].filter(Boolean).join(' '),
      email: clean(input.email), phone: clean(input.phone),
      billing_address: clean(input.address), billing_city: clean(input.city),
      billing_state: clean(input.state) || 'TX', billing_zip: clean(input.zip_code),
      status: needsPoolId ? 'active' : 'prospect',
      created_at: now, updated_at: now,
      legacy_quote_ids: JSON.stringify([quoteId]), notes: ''
    });
  } else {
    updates.push({
      sheet: ENTITIES.clients.sheet, id: clientId, idColumn: 'client_id',
      patch: { legacy_quote_ids: pushUnique(existingClient.legacy_quote_ids, quoteId) }
    });
  }

  if (!existingLocation) {
    addInsert(ENTITIES.locations.sheet, {
      location_id: locationId, client_id: clientId, pool_id: poolId,
      service_address: clean(input.address), city: clean(input.city),
      state: clean(input.state) || 'TX', zip_code: clean(input.zip_code),
      area: clean(input.area),
      pool_type: pricingInput.pool_type, pool_size: pricingInput.size,
      material: pricingInput.material, spa: input.spa ? 'TRUE' : 'FALSE',
      finish: pricingInput.finish, debris_level: pricingInput.debris,
      sun_exposure: input.high_sun_exposure ? 'TRUE' : 'FALSE',
      pets_on_property: input.has_pets ? 'TRUE' : 'FALSE',
      robot_on_site: input.has_robot ? 'TRUE' : 'FALSE',
      year_built: clean(input.year_built), active: 'TRUE',
      created_at: now, updated_at: now, notes: ''
    });
  } else if (poolId) {
    updates.push({
      sheet: ENTITIES.locations.sheet, id: locationId, idColumn: 'location_id',
      patch: { pool_id: poolId }
    });
  }

  // ── 6. Proposal ────────────────────────────────────────────────────────────
  const scopeItems = Array.isArray(input.scope_items)
    ? input.scope_items.map(clean).filter(Boolean) : [];

  addInsert(ENTITIES.proposals.sheet, {
    proposal_id: proposalId, proposal_number: proposalNumber, legacy_quote_id: quoteId,
    client_id: clientId, location_id: locationId,
    status: 'DRAFT', service_type: priced.service_label,
    proposal_title: priced.service_label, created_by: actor,
    quote_source: clean(input.quote_source) || 'portal',
    quote_version: '3.0',
    valid_until: clean(input.valid_until),
    travel_fee: priced.travel_fee,
    travel_one_way_miles: num(input.travel_one_way_miles),
    travel_round_trip_miles: num(input.travel_round_trip_miles),
    travel_billable_round_trip_miles: num(input.travel_billable_round_trip_miles),
    distance_source: clean(input.distance_source) || 'none',
    subtotal: priced.service_subtotal,
    // Legacy discount columns keep their old meaning: a premium is NOT written as
    // a negative discount, it gets its own column.
    discount_type: priced.adjustment_kind === 'discount' ? clean(input.adjustment_type) : '',
    discount_value: priced.adjustment_kind === 'discount' ? clean(input.adjustment_value) : '',
    discount_amount: priced.adjustment_kind === 'discount' ? priced.adjustment_amount : 0,
    discounted_subtotal: priced.adjusted_service,
    tax_rate: priced.tax_rate, sales_tax: priced.sales_tax, total: priced.total_with_tax,
    chem_cost_est: priced.chem_cost_est, net_profit_est: priced.net_profit_est,
    margin_percent: priced.margin_percent,
    specs_summary: specs,
    proposal_pdf_url: '', contract_url: '', proposal_image_url: '',
    sent_at: '', accepted_at: '', declined_at: '', expired_at: '', converted_at: '',
    created_at: now, updated_at: now, notes: clean(input.notes),
    adjustment_kind: priced.adjustment_kind,
    adjustment_type: clean(input.adjustment_type),
    adjustment_value: clean(input.adjustment_value),
    premium_amount: priced.adjustment_kind === 'premium' ? priced.adjustment_amount : 0,
    service_key: priced.service_key,
    scope_items_json: scopeItems.length ? JSON.stringify({ items: scopeItems }) : '',
    plan_options_json: input.plan_options ? JSON.stringify(input.plan_options) : '',
    manual_price: priced.requires_manual_price ? priced.service_subtotal : '',
    pricing_source: 'server',
    idempotency_key: idemKey,
    change_log: JSON.stringify([{ at: now, by: actor, action: 'created' }])
  });

  buildLineItems(input, priced, specs).forEach(item => {
    addInsert(ENTITIES.proposalItems.sheet, Object.assign({
      proposal_item_id: mint(ENTITIES.proposalItems.sheet, 'proposal_item_id', ENTITIES.proposalItems.prefix, ENTITIES.proposalItems.width),
      proposal_id: proposalId,
      created_at: now, updated_at: now
    }, item));
  });

  // ── 7. Agreement (unsigned) ────────────────────────────────────────────────
  const signatureRequired = !needsPoolId;
  addInsert(ENTITIES.agreements.sheet, {
    agreement_id: agreementId, agreement_number: agreementNumber,
    client_id: clientId, location_id: locationId, proposal_id: proposalId,
    service_account_id: serviceAccountId, source_quote_id: quoteId,
    status: signatureRequired ? 'DRAFT' : 'NOT_REQUIRED',
    signature_required: signatureRequired ? 'TRUE' : 'FALSE',
    activation_method: activationMethod(priced.service_key, input, needsPoolId),
    service_type: priced.service_key, service_name: priced.service_label,
    monthly_rate: priced.adjusted_service, startup_fee: priced.service_key === 'pool_startup' ? priced.adjusted_service : 0,
    travel_fee: priced.travel_fee, tax_rate: priced.tax_rate,
    sales_tax: priced.sales_tax, total: priced.total_with_tax,
    billing_start: '', service_start: '', invoice_day: '',
    agreement_pdf_url: '', contract_url: '', contract_file_id: '', signrequest_id: '',
    sent_at: '', signed_at: '', declined_at: '',
    activated_at: needsPoolId ? now : '',
    created_by: actor, created_at: now, updated_at: now, notes: '',
    agreement_type: 'original', target_agreement_id: ''
  });

  // ── 8. Service account ─────────────────────────────────────────────────────
  addInsert(ENTITIES.serviceAccounts.sheet, {
    service_account_id: serviceAccountId, client_id: clientId, location_id: locationId,
    source_proposal_id: proposalId, source_agreement_id: agreementId, source_quote_id: quoteId,
    pool_id: poolId, service_type: priced.service_key, service_name: priced.service_label,
    status: needsPoolId ? 'ACTIVE' : 'PENDING',
    schedule_type: scheduleType(priced.service_key),
    route_status: routeStatus(priced.service_key, needsPoolId),
    billing_type: priced.service_key === 'repair_job' ? 'one_time' : 'recurring',
    monthly_rate: priced.adjusted_service, tax_rate: priced.tax_rate,
    invoice_day: '', billing_start: '', service_start: '', service_end: '',
    payment_log: '', contract_status: signatureRequired ? '' : 'NOT_REQUIRED',
    contract_url: '', created_at: now, updated_at: now, notes: ''
  });

  return {
    ok: true,
    replayed: false,
    ids: {
      quote_id: quoteId, client_id: clientId, location_id: locationId,
      proposal_id: proposalId, proposal_number: proposalNumber,
      agreement_id: agreementId, agreement_number: agreementNumber,
      service_account_id: serviceAccountId, pool_id: poolId
    },
    priced,
    specs,
    verification,
    inserts,
    updates,
    compat: buildCompatRow({ input, priced, specs, now, actor, quoteId, clientId, locationId,
                             proposalId, proposalNumber, agreementId, agreementNumber,
                             serviceAccountId, poolId, needsPoolId, signatureRequired, scopeItems, idemKey })
  };
}

function activationMethod(serviceKey, input, needsPoolId) {
  if (serviceKey === 'pool_startup') return 'STARTUP_AUTO';
  if (serviceKey === 'green_to_clean') return 'GTC_AUTO';
  if (needsPoolId) return 'ADMIN_OVERRIDE';
  return 'SIGNED_AGREEMENT';
}

function scheduleType(serviceKey) {
  if (serviceKey === 'weekly_full') return 'weekly';
  if (serviceKey === 'biweekly_maint') return 'biweekly';
  if (serviceKey === 'pool_startup') return 'startup';
  if (serviceKey === 'green_to_clean') return 'one_time';
  return 'one_time';
}

function routeStatus(serviceKey, needsPoolId) {
  if (serviceKey === 'pool_startup') return 'startup';
  if (serviceKey === 'green_to_clean') return 'gtc';
  if (serviceKey === 'repair_job') return 'repair';
  return needsPoolId ? 'active' : 'pending';
}

// ── the one-way compatibility export ─────────────────────────────────────────
// Written on every save so the proposal PDF, the signing page, Comms targeting,
// the Home dashboard and the spreadsheet reports keep working untouched. Derived,
// never read back for logic.
function buildCompatRow(c) {
  const p = c.priced;
  return {
    quote_id: c.quoteId,
    first_name: clean(c.input.first_name), last_name: clean(c.input.last_name),
    email: clean(c.input.email), phone: clean(c.input.phone),
    address: clean(c.input.address), city: clean(c.input.city),
    zip_code: clean(c.input.zip_code), area: clean(c.input.area),

    service: p.service_label,
    service_key: p.service_key,
    pool_type: PRICING.poolTypeLabel(c.input.pool_type),
    size: p.service_key === 'pool_startup' ? 'startup' : clean(c.input.size) || 'medium',
    material: PRICING.materialLabel(c.input.material),
    spa: c.input.spa ? 'Yes' : 'No',
    finish: clean(c.input.finish) === 'dark' ? 'Dark' : 'Light',
    debris: clean(c.input.debris) === 'heavy' ? 'Heavy' : 'Light',
    has_robot: !!c.input.has_robot, high_sun_exposure: !!c.input.high_sun_exposure,
    has_pets: !!c.input.has_pets,

    startup_chemical_work: !!c.input.startup_chemical,
    startup_programming: !!c.input.startup_programming,
    startup_pool_school: !!c.input.startup_pool_school,
    startup_company: clean(c.input.startup_company),
    startup_company_email: clean(c.input.startup_company_email),
    sponsored_by_mcp: !!c.input.sponsored_by_mcp,
    startup_start_date: clean(c.input.startup_start_date),
    startup_total_days: c.input.sponsored_by_mcp ? 3 : 0,

    repair_job_type: clean(c.input.repair_type),
    repair_company_name: clean(c.input.repair_company),
    repair_company_address: clean(c.input.address),
    repair_job_description: clean(c.input.repair_issue),
    repair_invoice_amount: p.service_key === 'repair_job' ? p.service_subtotal : 0,
    repair_sku: p.qb_skus[0] || '',

    client_id: c.clientId, location_id: c.locationId,
    proposal_id: c.proposalId, proposal_number: c.proposalNumber,
    agreement_id: c.agreementId, agreement_number: c.agreementNumber,
    service_account_id: c.serviceAccountId,
    pool_id: c.poolId,

    travel_fee: p.travel_fee,
    travel_one_way_miles: num(c.input.travel_one_way_miles),
    travel_round_trip_miles: num(c.input.travel_round_trip_miles),
    travel_billable_round_trip_miles: num(c.input.travel_billable_round_trip_miles),
    distance_source: clean(c.input.distance_source) || 'none',

    service_subtotal: p.service_subtotal,
    discount_type: p.adjustment_kind === 'discount' ? clean(c.input.adjustment_type) : '',
    discount_value: p.adjustment_kind === 'discount' ? clean(c.input.adjustment_value) : 0,
    discount_amount: p.adjustment_kind === 'discount' ? p.adjustment_amount : 0,
    premium_amount: p.adjustment_kind === 'premium' ? p.adjustment_amount : 0,
    adjustment_kind: p.adjustment_kind,
    discounted_service_subtotal: p.adjusted_service,
    quote_subtotal: p.quote_subtotal, sales_tax: p.sales_tax,
    total_with_tax: p.total_with_tax, tax_rate: p.tax_rate,
    chem_cost_est: p.chem_cost_est, net_profit_est: p.net_profit_est,
    margin_percent: p.margin_percent,

    specs_summary: c.specs,
    quickbooks_skus: p.qb_skus.join(', '),
    quickbooks_item_names: p.qb_names.join(', '),
    scope_items_json: c.scopeItems.length ? JSON.stringify({ items: c.scopeItems }) : '',

    created_by: c.actor, quote_source: clean(c.input.quote_source) || 'portal',
    quote_version: '3.0',
    sales_flow: clean(c.input.sales_flow) || 'proposal_first',
    signature_required: c.signatureRequired ? 'TRUE' : 'FALSE',
    activation_method: activationMethod(p.service_key, c.input, c.needsPoolId),
    status: c.needsPoolId ? 'ACTIVE_CUSTOMER' : 'UNSENT',
    contract_status: c.signatureRequired ? '' : 'NOT_REQUIRED',
    contact_log: '[]',
    timestamp: c.now,
    source_sheet: 'Proposals',       // provenance: this row is DERIVED
    pricing_source: 'server',
    idempotency_key: c.idemKey,
    migration_status: 'RELATIONAL'
  };
}

// The quote-tool payload uses its own field names; the engine has its own. One
// translation, here, so a rename fails loudly instead of mispricing quietly.
export function toPricingInput(input) {
  return {
    service: input.service_key || input.service,
    size: clean(input.size) || 'medium',
    pool_type: clean(input.pool_type) === 'above_ground' || /above/i.test(clean(input.pool_type))
      ? 'above_ground' : 'inground',
    material: lower(input.material) || 'plaster',
    spa: truthy(input.spa),
    finish: /dark/i.test(clean(input.finish)) ? 'dark' : 'light',
    debris: /heavy/i.test(clean(input.debris)) ? 'heavy' : 'light',
    has_robot: truthy(input.has_robot),
    high_sun_exposure: truthy(input.high_sun_exposure),
    has_pets: truthy(input.has_pets),
    startup_chemical: truthy(input.startup_chemical ?? input.startup_chemical_work),
    startup_programming: truthy(input.startup_programming),
    startup_pool_school: truthy(input.startup_pool_school),
    repair_type: clean(input.repair_type) || 'repair_replacement',
    repair_company: clean(input.repair_company),
    address: clean(input.address),
    first_name: clean(input.first_name), last_name: clean(input.last_name),
    startup_company: clean(input.startup_company),
    manual_price: num(input.manual_price ?? input.repair_invoice_amount ?? input.repair_amount),
    adjustment_type: clean(input.adjustment_type) || 'none',
    adjustment_value: input.adjustment_value,
    travel_fee: num(input.travel_fee),
    void_travel: truthy(input.void_travel)
  };
}

function truthy(v) {
  if (typeof v === 'boolean') return v;
  const s = lower(v);
  return s === 'true' || s === 'yes' || s === '1';
}
function num(v) { const n = Number(clean(v).replace(/[$,]/g, '')); return Number.isFinite(n) ? n : 0; }
function pushUnique(rawJson, value) {
  let arr = [];
  try { const p = JSON.parse(clean(rawJson) || '[]'); if (Array.isArray(p)) arr = p.map(clean); } catch (_) { arr = []; }
  const v = clean(value);
  if (v && arr.indexOf(v) === -1) arr.push(v);
  return JSON.stringify(arr);
}
function fail(error) { return { ok: false, error, inserts: {}, updates: [], compat: null }; }
