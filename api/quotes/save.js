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
import { randomUUID } from 'crypto';
import { sendJson, validatePortalSession, hasAdminAccess } from '../_sheets.js';
import { planQuoteWrite } from '../_repo/quote-write.js';
import { loadQuoteContext, toSnapshot, commitPlan } from '../_repo/sheets-driver.js';

export default async function handler(req, res) {
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
