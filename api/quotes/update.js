// POST /api/quotes/update — edit a saved quote.
//
// ⚠️ THERE WAS NO EQUIVALENT. The portal could not change a price after save.
// handleUpdateQuoteInfo_ was hard-limited to seven contact fields and
// handleUpdateLead_ to status/notes/service_end, so a mispriced quote had to be
// rebuilt as a new record with the wrong one left behind in the sheet.
//
// Refuses on a signed agreement — that is an amendment, and Amendments.js owns it.
import { sendJson, validatePortalSession, hasAdminAccess } from '../_sheets.js';
import { planQuoteUpdate, EDITABLE } from '../_repo/quote-update.js';
import { loadQuoteContext, toSnapshot, commitPlan, hydrateQuote } from '../_repo/sheets-driver.js';

export default async function handler(req, res) {
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
