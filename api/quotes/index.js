// Every quote endpoint, behind one Vercel Function.
//
// ⚠️ WHY THIS IS ONE FILE. Hobby allows 12 Vercel Functions per deployment and
// without a framework every file under api/ becomes one. The repo was at exactly
// 12; folding get/save/update together frees two slots, one of which the
// Lifecycle Email Engine's api/email.js uses (email-engine/docs/PLAN.md →
// Decisions → Functions).
//
// The public URLs did NOT change. A rewrite in vercel.json maps
// /api/quotes/<op> → /api/quotes?op=<op>, so js/features/quotes.js still calls
// /api/quotes/save, /api/quotes/get and /api/quotes/update exactly as before.
// Same pattern as api/qbo/index.js.
//
// Each op below is its former file's handler, moved verbatim. The only change
// is the wrapper: they are named functions now instead of default exports.
import { randomUUID } from 'crypto';
import { sendJson, validatePortalSession, hasAdminAccess } from '../_sheets.js';
import { planQuoteWrite } from '../_repo/quote-write.js';
import { planQuoteUpdate, EDITABLE } from '../_repo/quote-update.js';
import { loadQuoteContext, toSnapshot, hydrateQuote, commitPlan } from '../_repo/sheets-driver.js';

// GET /api/quotes/get?quote_id=Q-XXXX — read one quote back, fully joined.
//
// ⚠️ THIS ENDPOINT DID NOT EXIST IN ANY FORM. There was no `get_quote` action
// anywhere in WebhookReceiver.js, and _qS.saved_id was set in exactly one place:
// immediately after a successful save. Everything the quote tool rendered
// afterwards — scope chips, plan chips, the pool photo, Generate Packet, Send for
// Signature, the edit panel — lived only in that browser tab's memory. A reload
// lost access to it permanently, for the life of the quote.
const n = v => { const x = Number(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(x) ? x : 0; };
const s = v => String(v ?? '').trim();
const truthy = v => ['true', 'yes', '1'].includes(s(v).toLowerCase());

function parseJsonList(raw, key) {
  try {
    const p = JSON.parse(s(raw) || '{}');
    if (Array.isArray(p)) return p;
    if (p && Array.isArray(p[key])) return p[key];
    return [];
  } catch (_) { return []; }
}

// Rebuild the quote tool's own state shape, so reopening is an assignment rather
// than a screen-by-screen remapping that can drift from what save sends.
function toQuoteToolState(rec) {
  const p = rec.proposal || {}, c = rec.client || {}, l = rec.location || {};
  const poolType = /above/i.test(s(l.pool_type)) ? 'above_ground' : 'inground';
  return {
    saved_id: rec.quote_id,
    service: s(p.service_key) || s(p.service_type),
    size: s(l.pool_size) || 'medium',
    pool_type: poolType,
    material: s(l.material).toLowerCase() || 'plaster',
    spa: truthy(l.spa),
    finish: /dark/i.test(s(l.finish)) ? 'dark' : 'light',
    debris: /heavy/i.test(s(l.debris_level)) ? 'heavy' : 'light',
    has_robot: truthy(l.robot_on_site),
    high_sun_exposure: truthy(l.sun_exposure),
    has_pets: truthy(l.pets_on_property),

    first_name: s(c.first_name), last_name: s(c.last_name),
    email: s(c.email), phone: s(c.phone),
    address: s(l.service_address), city: s(l.city),
    zip_code: s(l.zip_code), area: s(l.area),

    client_id: s(p.client_id), location_id: s(p.location_id), pool_id: s(l.pool_id),

    adjustment_type: s(p.adjustment_type) || 'none',
    adjustment_value: s(p.adjustment_value),
    manual_price: n(p.manual_price),

    scope_items: parseJsonList(p.scope_items_json, 'items'),
    plan_options: (() => { try { return JSON.parse(s(p.plan_options_json) || '{}'); } catch (_) { return {}; } })(),

    // The photo is already stored on the proposal and already reused when a
    // packet is regenerated — it was just never handed back to the browser, so
    // the preview appeared empty and looked like it had been lost.
    proposal_image_url: s(p.proposal_image_url),
    proposal_pdf_url: s(p.proposal_pdf_url),
    // ⚠️ BOTH NAMES, DELIBERATELY. The quote tool's saved card gates every
    // proposal control on `_qS.proposal_url` (js/features/quotes.js), which is
    // the name qGenerateProposal writes. Returning only proposal_pdf_url meant a
    // reopened quote reported proposal_status:'generated' while proposal_url was
    // empty — so `proposalReady` was false and View Packet, Preview Agreement
    // and Send for Signature all vanished on a quote whose PDF existed. Sending
    // an already-built proposal from the Quote Tool was impossible.
    proposal_url: s(p.proposal_pdf_url),
    proposal_number: s(p.proposal_number),
    proposal_sent_at: s(p.sent_at),
    proposal_status: s(p.proposal_pdf_url) ? 'generated' : 'none',
    proposal_send_status: s(p.sent_at) ? 'sent' : 'none',

    travel: n(p.travel_fee) ? {
      travel_fee: n(p.travel_fee),
      one_way_miles: n(p.travel_one_way_miles),
      round_trip_miles: n(p.travel_round_trip_miles),
      billable_round_trip_miles: n(p.travel_billable_round_trip_miles),
      distance_source: s(p.distance_source)
    } : null
  };
}

async function opGet(req, res) {
  const started = Date.now();
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const session = await validatePortalSession(req.query.token);
    if (!session) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    if (!hasAdminAccess(session)) return sendJson(res, 403, { ok: false, error: 'Admin access required.' });

    const quoteId = s(req.query.quote_id);
    if (!quoteId) return sendJson(res, 400, { ok: false, error: 'quote_id required' });

    const ctx = await loadQuoteContext();
    const rec = hydrateQuote(toSnapshot(ctx), quoteId);
    if (!rec) return sendJson(res, 404, { ok: false, error: 'Quote not found: ' + quoteId });

    const editable = !(rec.agreement && s(rec.agreement.status).toUpperCase() === 'SIGNED');

    return sendJson(res, 200, {
      ok: true,
      quote_id: rec.quote_id,
      state: toQuoteToolState(rec),
      // Money is returned as stored, not recomputed, so reopening a historical
      // quote shows what was actually agreed even if the rate card has moved on.
      totals: {
        service_subtotal: n(rec.proposal.subtotal),
        adjustment_kind: s(rec.proposal.adjustment_kind) || 'none',
        adjustment_amount: n(rec.proposal.premium_amount) || n(rec.proposal.discount_amount),
        adjusted_service: n(rec.proposal.discounted_subtotal),
        travel_fee: n(rec.proposal.travel_fee),
        sales_tax: n(rec.proposal.sales_tax),
        total_with_tax: n(rec.proposal.total),
        margin_percent: n(rec.proposal.margin_percent)
      },
      items: rec.items.map(i => ({
        line_type: s(i.line_type), name: s(i.product_service_name),
        description: s(i.description), quantity: n(i.quantity) || 1,
        rate: n(i.rate), amount: n(i.amount), sku: s(i.quickbooks_sku)
      })),
      agreement: rec.agreement ? {
        agreement_id: s(rec.agreement.agreement_id),
        agreement_number: s(rec.agreement.agreement_number),
        status: s(rec.agreement.status),
        signed_at: s(rec.agreement.signed_at),
        signed_pdf_url: s(rec.agreement.signed_pdf_url) || s(rec.agreement.agreement_pdf_url)
      } : null,
      amendment_count: rec.amendments.length,
      service_account: rec.service_account ? {
        service_account_id: s(rec.service_account.service_account_id),
        status: s(rec.service_account.status),
        pool_id: s(rec.service_account.pool_id),
        route_status: s(rec.service_account.route_status)
      } : null,
      // An executed document is never edited. A change to a signed agreement is
      // an amendment — appscript/Amendments.js already owns that path.
      editable,
      edit_blocked_reason: editable ? '' : 'This agreement is signed. Raise a plan change instead.',
      change_log: parseJsonList(rec.proposal.change_log, 'entries'),
      ms: Date.now() - started
    }, 0);
  } catch (error) {
    console.error('quotes/get failed', error);
    return sendJson(res, 500, { ok: false, error: error.message || 'Quote read failed' });
  }
}

// POST /api/quotes/save — create a quote against the relational model.
//
// Replaces the `save_quote` Apps Script action for the quote tool. What changed,
// beyond speed:
//
//   • THE SERVER PRICES IT. handleSaveQuote_ wrote whatever money figures the
//     browser sent, unchecked, and those figures end up on a signed agreement.
//     Here the browser's numbers are recorded as a claim and the stored values
//     are recomputed from the inputs with js/lib/pricing.js.
//   • IDEMPOTENT. A double-click used to mint two quote ids and, for a startup or
//     G2C, two pool_ids — a phantom customer on the route board.
//   • ONE ROUND TRIP TO READ. Seven tabs in a single values:batchGet.
async function opSave(req, res) {
  const started = Date.now();
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const session = await validatePortalSession(body.token);
    if (!session) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    // Quotes carry pricing and margin. The quote tool is already admin/manager
    // only in ROLE_PAGES; this enforces it on the route rather than trusting the
    // sidebar to have hidden the page.
    if (!hasAdminAccess(session)) return sendJson(res, 403, { ok: false, error: 'Admin access required.' });

    const ctx = await loadQuoteContext();
    const plan = planQuoteWrite({
      snapshot: toSnapshot(ctx),
      input: body,
      now: new Date().toISOString(),
      actor: session.name || session.username || 'portal',
      // Supplied here, not generated in the planner, so the planner stays pure
      // and every test is deterministic.
      quoteSuffix: randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase(),
      idempotencyKey: String(body.idempotency_key || '').trim()
    });

    if (!plan.ok) return sendJson(res, 400, { ok: false, error: plan.error });

    if (plan.replayed) {
      return sendJson(res, 200, {
        ok: true, replayed: true, ...plan.ids,
        note: 'This request was already processed.',
        ms: Date.now() - started
      });
    }

    const stats = await commitPlan(plan, ctx);

    // A mismatch is not an error — the stored figures are the server's either
    // way — but it is reported so a stale tab or a tampered payload is visible
    // rather than silently accepted.
    if (plan.verification && !plan.verification.ok) {
      console.warn('quotes/save price mismatch', {
        quote_id: plan.ids.quote_id,
        actor: session.username,
        mismatches: plan.verification.mismatches
      });
    }

    return sendJson(res, 200, {
      ok: true,
      ...plan.ids,
      pricing: {
        service_subtotal: plan.priced.service_subtotal,
        adjustment_kind: plan.priced.adjustment_kind,
        adjustment_amount: plan.priced.adjustment_amount,
        adjusted_service: plan.priced.adjusted_service,
        travel_fee: plan.priced.travel_fee,
        sales_tax: plan.priced.sales_tax,
        total_with_tax: plan.priced.total_with_tax,
        margin_percent: plan.priced.margin_percent
      },
      specs_summary: plan.specs,
      price_mismatch: plan.verification && !plan.verification.ok
        ? plan.verification.mismatches : null,
      sheets_requests: stats.requests,
      ms: Date.now() - started
    });
  } catch (error) {
    console.error('quotes/save failed', error);
    return sendJson(res, 500, { ok: false, error: error.message || 'Save failed' });
  }
}

// POST /api/quotes/update — edit a saved quote.
//
// ⚠️ THERE WAS NO EQUIVALENT. The portal could not change a price after save.
// handleUpdateQuoteInfo_ was hard-limited to seven contact fields and
// handleUpdateLead_ to status/notes/service_end, so a mispriced quote had to be
// rebuilt as a new record with the wrong one left behind in the sheet.
//
// Refuses on a signed agreement — that is an amendment, and Amendments.js owns it.
async function opUpdate(req, res) {
  const started = Date.now();
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const session = await validatePortalSession(body.token);
    if (!session) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    if (!hasAdminAccess(session)) return sendJson(res, 403, { ok: false, error: 'Admin access required.' });

    const quoteId = String(body.quote_id || '').trim();
    if (!quoteId) return sendJson(res, 400, { ok: false, error: 'quote_id required' });

    const ctx = await loadQuoteContext();
    const snapshot = toSnapshot(ctx);
    const record = hydrateQuote(snapshot, quoteId);
    if (!record) return sendJson(res, 404, { ok: false, error: 'Quote not found: ' + quoteId });

    // Every line for this proposal, including already-superseded ones, so a new
    // item id cannot collide with one that was retired by an earlier edit.
    record.allItems = (snapshot['Proposal_Items'] || [])
      .filter(r => String(r.proposal_id || '').trim() === String(record.proposal.proposal_id || '').trim());

    const patch = {};
    EDITABLE.forEach(k => { if (body[k] !== undefined) patch[k] = body[k]; });

    const plan = planQuoteUpdate({
      record, patch,
      now: new Date().toISOString(),
      actor: session.name || session.username || 'portal'
    });

    if (!plan.ok) {
      // 409 for the signed case: the request was well-formed, the record's state
      // forbids it. A 400 would read as "you sent something wrong".
      return sendJson(res, plan.code === 'SIGNED' ? 409 : 400,
        { ok: false, error: plan.error, code: plan.code || '' });
    }

    if (plan.noop) {
      return sendJson(res, 200, {
        ok: true, quote_id: quoteId, changed: false,
        note: 'Nothing changed.', unknown_fields: plan.unknown_fields, ms: Date.now() - started
      });
    }

    const stats = await commitPlan(plan, ctx);

    return sendJson(res, 200, {
      ok: true,
      quote_id: quoteId,
      changed: true,
      changes: plan.changes,
      pricing: {
        service_subtotal: plan.priced.service_subtotal,
        adjustment_kind: plan.priced.adjustment_kind,
        adjustment_amount: plan.priced.adjustment_amount,
        adjusted_service: plan.priced.adjusted_service,
        travel_fee: plan.priced.travel_fee,
        sales_tax: plan.priced.sales_tax,
        total_with_tax: plan.priced.total_with_tax,
        margin_percent: plan.priced.margin_percent
      },
      specs_summary: plan.specs,
      unknown_fields: plan.unknown_fields,
      sheets_requests: stats.requests,
      ms: Date.now() - started
    });
  } catch (error) {
    console.error('quotes/update failed', error);
    return sendJson(res, 500, { ok: false, error: error.message || 'Update failed' });
  }
}

// ── dispatch ──────────────────────────────────────────────────────────────────
// `op` arrives from the vercel.json rewrite, so it is the old path segment.
// An unknown op is a 404 rather than a fallthrough.
const OPS = { get: opGet, save: opSave, update: opUpdate };

export default async function handler(req, res) {
  const op = String((req.query && req.query.op) || '').trim();
  const fn = OPS[op];
  if (!fn) return sendJson(res, 404, { ok: false, error: 'Unknown quote operation.' });
  return fn(req, res);
}
