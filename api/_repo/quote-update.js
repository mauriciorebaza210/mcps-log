// ══════════════════════════════════════════════════════════════════════════════
// QUOTE UPDATE PLANNER — pure
//
// ⚠️ NOTHING IN THE PORTAL COULD DO THIS. handleUpdateQuoteInfo_ was hard-limited
// to seven contact fields; handleUpdateLead_ covered status, notes and a service
// end date. Price, service type, pool specs, the adjustment and the scope were
// write-once at save. Getting a price wrong meant re-quoting from scratch and
// leaving the wrong row behind in the sheet forever.
//
// Rules this enforces:
//   • A SIGNED agreement is never edited. That is an amendment, and
//     appscript/Amendments.js already owns it — an amendment is a new signed
//     addendum that leaves the parent untouched.
//   • The server re-prices. An edit cannot smuggle in a total.
//   • Every change is appended to change_log with who, when, and old -> new.
//   • Superseded line items are marked, not deleted, so an already-sent document
//     stays reproducible.
// ══════════════════════════════════════════════════════════════════════════════

import { createRequire } from 'module';
import { ENTITIES, COMPAT_SHEET } from './schema.js';
import { toPricingInput, buildLineItems } from './quote-write.js';

const require = createRequire(import.meta.url);
const PRICING = require('../../js/lib/pricing.js');

const s = v => String(v === undefined || v === null ? '' : v).trim();
const n = v => { const x = Number(s(v).replace(/[$,]/g, '')); return Number.isFinite(x) ? x : 0; };

// Fields an operator may change. Anything outside this list is ignored rather
// than written — an allow-list, so a stray key in a payload can never reach a
// column it was not meant to.
export const EDITABLE = [
  'first_name', 'last_name', 'email', 'phone',
  'address', 'city', 'zip_code', 'area',
  'service_key', 'size', 'pool_type', 'material', 'spa', 'finish', 'debris',
  'has_robot', 'high_sun_exposure', 'has_pets',
  'startup_chemical', 'startup_programming', 'startup_pool_school',
  'startup_company', 'startup_company_email', 'startup_start_date',
  'repair_type', 'repair_company', 'repair_issue', 'repair_parts',
  'manual_price', 'adjustment_type', 'adjustment_value',
  'travel_fee', 'void_travel', 'distance_source',
  'scope_items', 'plan_options', 'notes'
];

// What the operator is looking at, as pricing input — the stored record with the
// patch applied on top. Re-pricing from the merge rather than from the patch is
// what stops "change the size" from silently dropping the spa surcharge.
function mergedInput(rec, patch) {
  const p = rec.proposal || {}, c = rec.client || {}, l = rec.location || {};
  const base = {
    service_key: s(p.service_key) || s(p.service_type),
    size: s(l.pool_size) || 'medium',
    pool_type: s(l.pool_type),
    material: s(l.material),
    spa: l.spa, finish: l.finish, debris: l.debris_level,
    has_robot: l.robot_on_site, high_sun_exposure: l.sun_exposure, has_pets: l.pets_on_property,
    first_name: s(c.first_name), last_name: s(c.last_name),
    email: s(c.email), phone: s(c.phone),
    address: s(l.service_address), city: s(l.city), zip_code: s(l.zip_code), area: s(l.area),
    adjustment_type: s(p.adjustment_type) || 'none',
    adjustment_value: s(p.adjustment_value),
    manual_price: n(p.manual_price),
    travel_fee: n(p.travel_fee),
    distance_source: s(p.distance_source),
    repair_type: s(p.repair_type),
    notes: s(p.notes)
  };
  const merged = Object.assign({}, base);
  EDITABLE.forEach(k => { if (patch[k] !== undefined) merged[k] = patch[k]; });
  return merged;
}

export function planQuoteUpdate(opts) {
  const rec = opts.record;
  const patch = opts.patch || {};
  const now = opts.now;
  const actor = s(opts.actor) || 'portal';

  if (!rec || !rec.proposal) return fail('Quote not found.');
  if (!now) return fail('now is required — the planner must not read the clock');

  // ── The one hard stop ──────────────────────────────────────────────────────
  const agreementStatus = s(rec.agreement && rec.agreement.status).toUpperCase();
  if (agreementStatus === 'SIGNED') {
    return fail('This agreement is signed and cannot be edited. Raise a plan change instead.', 'SIGNED');
  }

  const unknown = Object.keys(patch).filter(k =>
    EDITABLE.indexOf(k) === -1 && k !== 'token' && k !== 'quote_id' && k !== 'idempotency_key');
  const merged = mergedInput(rec, patch);
  const pricingInput = toPricingInput(merged);
  const priced = PRICING.priceQuote(pricingInput);
  if (!priced.pricing_ready) {
    return fail(priced.adjustment_error || (priced.warnings[0] || 'The edited configuration cannot be priced.'));
  }
  const specs = PRICING.buildSpecsSummary(pricingInput, priced);

  const p = rec.proposal;
  const before = {
    service_key: s(p.service_key),
    subtotal: n(p.subtotal),
    adjusted: n(p.discounted_subtotal),
    total: n(p.total),
    adjustment_kind: s(p.adjustment_kind) || 'none',
    travel_fee: n(p.travel_fee)
  };
  const after = {
    service_key: priced.service_key,
    subtotal: priced.service_subtotal,
    adjusted: priced.adjusted_service,
    total: priced.total_with_tax,
    adjustment_kind: priced.adjustment_kind,
    travel_fee: priced.travel_fee
  };

  const changes = [];
  Object.keys(after).forEach(k => {
    if (String(before[k]) !== String(after[k])) changes.push({ field: k, from: before[k], to: after[k] });
  });
  // Non-money edits are recorded too, so "who changed the address" is answerable.
  ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'zip_code', 'area'].forEach(k => {
    if (patch[k] === undefined) return;
    const from = k === 'address' ? s(rec.location && rec.location.service_address)
      : ['city', 'zip_code', 'area'].includes(k) ? s(rec.location && rec.location[k === 'zip_code' ? 'zip_code' : k])
      : s(rec.client && rec.client[k]);
    if (s(patch[k]) !== from) changes.push({ field: k, from, to: s(patch[k]) });
  });

  // Scope and plan options change nothing about the price, so a money diff will
  // never see them — but they change what the customer signs, which is the whole
  // reason they are stored per quote. Diffed explicitly.
  const scopeItems = Array.isArray(patch.scope_items)
    ? patch.scope_items.map(s).filter(Boolean)
    : null;
  if (scopeItems) {
    const beforeScope = readJsonList(p.scope_items_json, 'items').join(' | ');
    const afterScope = scopeItems.join(' | ');
    if (beforeScope !== afterScope) {
      changes.push({ field: 'scope_items', from: beforeScope || '(defaults)', to: afterScope || '(none)' });
    }
  }
  if (patch.plan_options !== undefined) {
    const beforePlan = s(p.plan_options_json);
    const afterPlan = JSON.stringify(patch.plan_options || {});
    if (beforePlan !== afterPlan) {
      changes.push({ field: 'plan_options', from: beforePlan || '(defaults)', to: afterPlan });
    }
  }
  if (patch.notes !== undefined && s(patch.notes) !== s(p.notes)) {
    changes.push({ field: 'notes', from: s(p.notes), to: s(patch.notes) });
  }

  if (!changes.length) {
    return { ok: true, noop: true, changes: [], updates: [], inserts: {}, priced, specs, unknown_fields: unknown };
  }

  const log = appendLog(p.change_log, {
    at: now, by: actor, action: 'edited',
    changes: changes.map(c => c.field + ': ' + c.from + ' → ' + c.to)
  });

  const updates = [];
  const inserts = {};

  // ── Proposal ───────────────────────────────────────────────────────────────
  const proposalPatch = {
    service_type: priced.service_label, service_key: priced.service_key,
    proposal_title: priced.service_label,
    subtotal: priced.service_subtotal,
    discount_type: priced.adjustment_kind === 'discount' ? s(merged.adjustment_type) : '',
    discount_value: priced.adjustment_kind === 'discount' ? s(merged.adjustment_value) : '',
    discount_amount: priced.adjustment_kind === 'discount' ? priced.adjustment_amount : 0,
    premium_amount: priced.adjustment_kind === 'premium' ? priced.adjustment_amount : 0,
    adjustment_kind: priced.adjustment_kind,
    adjustment_type: s(merged.adjustment_type),
    adjustment_value: s(merged.adjustment_value),
    discounted_subtotal: priced.adjusted_service,
    travel_fee: priced.travel_fee,
    distance_source: s(merged.distance_source) || 'none',
    tax_rate: priced.tax_rate, sales_tax: priced.sales_tax, total: priced.total_with_tax,
    chem_cost_est: priced.chem_cost_est, net_profit_est: priced.net_profit_est,
    margin_percent: priced.margin_percent,
    specs_summary: specs,
    manual_price: priced.requires_manual_price ? priced.service_subtotal : '',
    pricing_source: 'server',
    updated_at: now,
    change_log: log
  };
  if (scopeItems) proposalPatch.scope_items_json = scopeItems.length ? JSON.stringify({ items: scopeItems }) : '';
  if (patch.plan_options !== undefined) proposalPatch.plan_options_json = JSON.stringify(patch.plan_options || {});
  if (patch.notes !== undefined) proposalPatch.notes = s(patch.notes);

  // ⚠️ A previously-sent proposal goes back to DRAFT on edit. Leaving it SENT
  // would mean the customer is holding a link to superseded pricing while the
  // record claims they were sent what they are now looking at.
  if (s(p.status).toUpperCase() === 'SENT') {
    proposalPatch.status = 'DRAFT';
    proposalPatch.sent_at = '';
  }

  updates.push({ sheet: ENTITIES.proposals.sheet, id: s(p.proposal_id), idColumn: 'proposal_id', patch: proposalPatch });

  // ── Line items: supersede, then rewrite ────────────────────────────────────
  (rec.items || [])
    .filter(i => s(i.status).toLowerCase() !== 'superseded')
    .forEach(i => {
      updates.push({
        sheet: ENTITIES.proposalItems.sheet, id: s(i.proposal_item_id), idColumn: 'proposal_item_id',
        patch: { status: 'superseded', superseded_at: now, updated_at: now }
      });
    });

  const nextItemSeq = maxSeq(rec.allItems || rec.items || [], 'proposal_item_id', 'PIT');
  buildLineItems(merged, priced, specs).forEach((item, idx) => {
    (inserts[ENTITIES.proposalItems.sheet] = inserts[ENTITIES.proposalItems.sheet] || []).push(
      Object.assign({
        proposal_item_id: 'PIT-' + String(nextItemSeq + idx + 1).padStart(6, '0'),
        proposal_id: s(p.proposal_id),
        status: 'active', superseded_at: '',
        created_at: now, updated_at: now
      }, item)
    );
  });

  // ── Location specs and contact ─────────────────────────────────────────────
  if (rec.location) {
    const locPatch = { updated_at: now };
    if (patch.size !== undefined || patch.service_key !== undefined) locPatch.pool_size = pricingInput.size;
    if (patch.pool_type !== undefined) locPatch.pool_type = pricingInput.pool_type;
    if (patch.material !== undefined) locPatch.material = pricingInput.material;
    if (patch.spa !== undefined) locPatch.spa = pricingInput.spa ? 'TRUE' : 'FALSE';
    if (patch.finish !== undefined) locPatch.finish = pricingInput.finish;
    if (patch.debris !== undefined) locPatch.debris_level = pricingInput.debris;
    if (patch.has_robot !== undefined) locPatch.robot_on_site = pricingInput.has_robot ? 'TRUE' : 'FALSE';
    if (patch.high_sun_exposure !== undefined) locPatch.sun_exposure = pricingInput.high_sun_exposure ? 'TRUE' : 'FALSE';
    if (patch.has_pets !== undefined) locPatch.pets_on_property = pricingInput.has_pets ? 'TRUE' : 'FALSE';
    if (patch.address !== undefined) locPatch.service_address = s(patch.address);
    if (patch.city !== undefined) locPatch.city = s(patch.city);
    if (patch.zip_code !== undefined) locPatch.zip_code = s(patch.zip_code);
    if (patch.area !== undefined) locPatch.area = s(patch.area);
    if (Object.keys(locPatch).length > 1) {
      updates.push({ sheet: ENTITIES.locations.sheet, id: s(rec.location.location_id), idColumn: 'location_id', patch: locPatch });
    }
  }

  if (rec.client) {
    const cliPatch = { updated_at: now };
    ['first_name', 'last_name', 'email', 'phone'].forEach(k => {
      if (patch[k] !== undefined) cliPatch[k] = s(patch[k]);
    });
    if (patch.first_name !== undefined || patch.last_name !== undefined) {
      cliPatch.display_name = [
        patch.first_name !== undefined ? s(patch.first_name) : s(rec.client.first_name),
        patch.last_name !== undefined ? s(patch.last_name) : s(rec.client.last_name)
      ].filter(Boolean).join(' ');
    }
    if (Object.keys(cliPatch).length > 1) {
      updates.push({ sheet: ENTITIES.clients.sheet, id: s(rec.client.client_id), idColumn: 'client_id', patch: cliPatch });
    }
  }

  // ── Agreement + service account keep the money in step ─────────────────────
  if (rec.agreement) {
    updates.push({
      sheet: ENTITIES.agreements.sheet, id: s(rec.agreement.agreement_id), idColumn: 'agreement_id',
      patch: {
        service_type: priced.service_key, service_name: priced.service_label,
        monthly_rate: priced.adjusted_service,
        startup_fee: priced.service_key === 'pool_startup' ? priced.adjusted_service : 0,
        travel_fee: priced.travel_fee, tax_rate: priced.tax_rate,
        sales_tax: priced.sales_tax, total: priced.total_with_tax,
        updated_at: now
      }
    });
  }
  if (rec.service_account) {
    updates.push({
      sheet: ENTITIES.serviceAccounts.sheet, id: s(rec.service_account.service_account_id),
      idColumn: 'service_account_id',
      patch: { service_type: priced.service_key, service_name: priced.service_label,
               monthly_rate: priced.adjusted_service, tax_rate: priced.tax_rate, updated_at: now }
    });
  }

  // ── The one-way compatibility export ──────────────────────────────────────
  // The legacy row is refreshed so the proposal PDF, the signing page, Comms and
  // the sheet reports see the edit. Still an export, still never read for logic.
  const compatPatch = {
    service: priced.service_label, service_key: priced.service_key,
    size: priced.service_key === 'pool_startup' ? 'startup' : pricingInput.size,
    pool_type: PRICING.poolTypeLabel(pricingInput.pool_type),
    material: PRICING.materialLabel(pricingInput.material),
    spa: pricingInput.spa ? 'Yes' : 'No',
    finish: pricingInput.finish === 'dark' ? 'Dark' : 'Light',
    debris: pricingInput.debris === 'heavy' ? 'Heavy' : 'Light',
    has_robot: pricingInput.has_robot, high_sun_exposure: pricingInput.high_sun_exposure,
    has_pets: pricingInput.has_pets,
    service_subtotal: priced.service_subtotal,
    discount_type: priced.adjustment_kind === 'discount' ? s(merged.adjustment_type) : '',
    discount_value: priced.adjustment_kind === 'discount' ? s(merged.adjustment_value) : 0,
    discount_amount: priced.adjustment_kind === 'discount' ? priced.adjustment_amount : 0,
    premium_amount: priced.adjustment_kind === 'premium' ? priced.adjustment_amount : 0,
    adjustment_kind: priced.adjustment_kind,
    discounted_service_subtotal: priced.adjusted_service,
    travel_fee: priced.travel_fee,
    quote_subtotal: priced.quote_subtotal, sales_tax: priced.sales_tax,
    total_with_tax: priced.total_with_tax, tax_rate: priced.tax_rate,
    chem_cost_est: priced.chem_cost_est, net_profit_est: priced.net_profit_est,
    margin_percent: priced.margin_percent,
    specs_summary: specs,
    quickbooks_skus: priced.qb_skus.join(', '),
    quickbooks_item_names: priced.qb_names.join(', '),
    pricing_source: 'server'
  };
  ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'zip_code', 'area'].forEach(k => {
    if (patch[k] !== undefined) compatPatch[k] = s(patch[k]);
  });
  if (scopeItems) compatPatch.scope_items_json = scopeItems.length ? JSON.stringify({ items: scopeItems }) : '';
  updates.push({ sheet: COMPAT_SHEET, id: s(rec.quote_id), idColumn: 'quote_id', patch: compatPatch });

  return { ok: true, noop: false, changes, updates, inserts, priced, specs, unknown_fields: unknown };
}

function readJsonList(raw, key) {
  try {
    const parsed = JSON.parse(s(raw) || '{}');
    if (Array.isArray(parsed)) return parsed.map(s);
    if (parsed && Array.isArray(parsed[key])) return parsed[key].map(s);
    return [];
  } catch (_) { return []; }
}

function maxSeq(rows, column, prefix) {
  let max = 0;
  const re = new RegExp('^' + prefix + '-(\\d+)$', 'i');
  (rows || []).forEach(r => { const m = re.exec(s(r[column])); if (m) max = Math.max(max, parseInt(m[1], 10)); });
  return max;
}

function appendLog(raw, entry) {
  let arr = [];
  try { const p = JSON.parse(s(raw) || '[]'); if (Array.isArray(p)) arr = p; } catch (_) { arr = []; }
  arr.push(entry);
  // Bounded so a heavily-edited quote cannot outgrow a cell (Sheets caps at 50k
  // characters and would reject the whole row write, losing the edit itself).
  while (arr.length > 40) arr.shift();
  return JSON.stringify(arr);
}

function fail(error, code) { return { ok: false, error, code: code || '', updates: [], inserts: {}, changes: [] }; }
