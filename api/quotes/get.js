// GET /api/quotes/get?quote_id=Q-XXXX — read one quote back, fully joined.
//
// ⚠️ THIS ENDPOINT DID NOT EXIST IN ANY FORM. There was no `get_quote` action
// anywhere in WebhookReceiver.js, and _qS.saved_id was set in exactly one place:
// immediately after a successful save. Everything the quote tool rendered
// afterwards — scope chips, plan chips, the pool photo, Generate Packet, Send for
// Signature, the edit panel — lived only in that browser tab's memory. A reload
// lost access to it permanently, for the life of the quote.
import { sendJson, validatePortalSession, hasAdminAccess } from '../_sheets.js';
import { loadQuoteContext, toSnapshot, hydrateQuote } from '../_repo/sheets-driver.js';

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

export default async function handler(req, res) {
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
