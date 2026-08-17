// ActionQueue.gs
// ══════════════════════════════════════════════════════════════════════════════
// One inbox for everything that needs a human decision.
//
// WHY: three of these four events previously had nowhere to surface in the portal.
//   * Change requests — handleRespondToProposal_ writes status CHANGES_REQUESTED
//     and the customer's note to the Proposal_Approvals sheet, and NO UI reads it.
//     A customer could ask for a change and it would sit in a spreadsheet cell
//     nobody was watching.
//   * Expiring quotes — valid_until is set to +30 days automatically, so quotes
//     lapse on a timer, but nothing warned anyone before it happened.
//   * Expired-link recovery requests — a customer asking for a fresh quote after
//     their link died.
//   * Start-date requests — new in Stage 4; the customer's preferred date needs
//     an admin to confirm it.
//
// Read-only aggregation: this file surfaces existing records, it does not own
// them. Acting on a card routes to the feature that does.
// ══════════════════════════════════════════════════════════════════════════════

var AQ_EXPIRING_SOON_DAYS = 5;

function aqDaysBetween_(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function aqParseDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v).trim();
  if (!s) return null;
  var d = new Date(s.length === 10 ? s + 'T00:00:00' : s);
  return isNaN(d.getTime()) ? null : d;
}

function aqCustomerName_(row, h) {
  var first = aqCell_(row, h, 'first_name');
  var last = aqCell_(row, h, 'last_name');
  var full = [first, last].filter(Boolean).join(' ').trim();
  return full || aqCell_(row, h, 'customer_name') || 'Customer';
}

function aqCell_(row, h, field) {
  var i = h.indexOf(field);
  return i === -1 ? '' : String(row[i] == null ? '' : row[i]).trim();
}

// ── The queue ────────────────────────────────────────────────────────────────
function handleGetActionQueue_(payload) {
  try {
    ensureNormalizedSalesSheets_();
    var now = new Date();
    var items = [];

    var quotes = getCrmSheet_();
    var qData = quotes && quotes.getLastRow() > 1 ? quotes.getDataRange().getValues() : [];
    var qh = qData.length ? qData[0].map(function (x) {
      return String(x || '').trim().toLowerCase().replace(/ /g, '_');
    }) : [];

    // Index quotes by id so the approval-driven cards can enrich themselves.
    var quoteById = {};
    for (var i = 1; i < qData.length; i++) {
      var qid = aqCell_(qData[i], qh, 'quote_id');
      if (qid) quoteById[qid] = { row: qData[i], rowNum: i + 1 };
    }

    // ── 1. Start-date requests awaiting confirmation ────────────────────────
    // requested_start_date set, but no service_start yet => nobody has confirmed.
    for (var r = 1; r < qData.length; r++) {
      var requested = aqCell_(qData[r], qh, 'requested_start_date');
      if (!requested) continue;
      var confirmed = aqCell_(qData[r], qh, 'service_start');
      if (confirmed) continue;
      var reqAt = aqParseDate_(aqCell_(qData[r], qh, 'requested_start_at'));
      items.push({
        id: 'start:' + aqCell_(qData[r], qh, 'quote_id'),
        type: 'start',
        kind: 'Start Date Requested',
        title: aqCustomerName_(qData[r], qh) + ' asked to start ' + requested,
        detail: [aqCell_(qData[r], qh, 'service'), aqCell_(qData[r], qh, 'address')].filter(Boolean).join(' · '),
        quote_id: aqCell_(qData[r], qh, 'quote_id'),
        pool_id: aqCell_(qData[r], qh, 'pool_id'),
        requested_start_date: requested,
        when: reqAt ? reqAt.toISOString() : '',
        sort: reqAt ? reqAt.getTime() : 0
      });
    }

    // ── 2. Change requests — previously a dead end ──────────────────────────
    var approvals = ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
    var aData = approvals.getLastRow() > 1 ? approvals.getDataRange().getValues() : [];
    var ah = aData.length ? aData[0].map(function (x) {
      return String(x || '').trim().toLowerCase().replace(/ /g, '_');
    }) : [];

    for (var a = 1; a < aData.length; a++) {
      var status = aqCell_(aData[a], ah, 'status').toUpperCase();
      var quoteId = aqCell_(aData[a], ah, 'quote_id');
      var linked = quoteById[quoteId];
      var respondedAt = aqParseDate_(aqCell_(aData[a], ah, 'responded_at'));

      // ── 2a. Expired-link recovery — a customer actively asking for a new
      //     quote. Ranked above everything else: they are waiting on us, and
      //     they had to go out of their way to ask.
      var updReq = aqParseDate_(aqCell_(aData[a], ah, 'update_requested_at'));
      if (updReq) {
        // Resolved once a newer proposal has gone out for this quote.
        var reissuedAt = linked ? aqParseDate_(aqCell_(linked.row, qh, 'proposal_sent_at')) : null;
        if (!(reissuedAt && reissuedAt.getTime() > updReq.getTime())) {
          items.push({
            id: 'recovery:' + aqCell_(aData[a], ah, 'approval_id'),
            type: 'recovery',
            kind: 'Update Requested',
            title: (linked ? aqCustomerName_(linked.row, qh) : 'A customer') + ' asked for an updated quote',
            detail: linked
              ? [aqCell_(linked.row, qh, 'service'), aqCell_(linked.row, qh, 'address')].filter(Boolean).join(' · ')
              : 'Quote ' + quoteId,
            note: aqCell_(aData[a], ah, 'update_request_note'),
            quote_id: quoteId,
            when: updReq.toISOString(),
            sort: Number.MAX_SAFE_INTEGER
          });
          // Don't also emit an expiring/expired card for the same approval.
          continue;
        }
      }

      if (status === 'CHANGES_REQUESTED') {
        // Resolved once a newer proposal has gone out for this quote.
        var resentAt = linked ? aqParseDate_(aqCell_(linked.row, qh, 'proposal_sent_at')) : null;
        if (resentAt && respondedAt && resentAt.getTime() > respondedAt.getTime()) continue;
        items.push({
          id: 'change:' + aqCell_(aData[a], ah, 'approval_id'),
          type: 'change',
          kind: 'Change Requested',
          title: (linked ? aqCustomerName_(linked.row, qh) : 'A customer') + ' wants a change before signing',
          detail: linked
            ? [aqCell_(linked.row, qh, 'service'), aqCell_(linked.row, qh, 'address')].filter(Boolean).join(' · ')
            : 'Quote ' + quoteId,
          note: aqCell_(aData[a], ah, 'customer_note'),
          quote_id: quoteId,
          when: respondedAt ? respondedAt.toISOString() : '',
          sort: respondedAt ? respondedAt.getTime() : 0
        });
        continue;
      }

      // ── 3. Sent but unsigned: expiring soon, or already expired ───────────
      // 'EXPIRED' is included because handleRespondToProposal_ stamps that status
      // when a customer acts on a lapsed link; without it those rows would fall
      // out of the queue entirely, which is exactly when someone should see them.
      if (status === 'SENT' || status === 'EXPIRED') {
        var expires = aqParseDate_(aqCell_(aData[a], ah, 'expires_at'));
        if (!expires) continue;
        var daysLeft = aqDaysBetween_(now, expires);
        if (daysLeft > AQ_EXPIRING_SOON_DAYS) continue;
        var expired = daysLeft < 0;
        items.push({
          id: 'expiring:' + aqCell_(aData[a], ah, 'approval_id'),
          type: 'expiring',
          kind: expired ? 'Expired' : 'Expiring Soon',
          title: (linked ? aqCustomerName_(linked.row, qh) : 'A customer') +
                 (expired ? '’s quote has expired' : '’s quote expires in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's')),
          detail: linked
            ? [aqCell_(linked.row, qh, 'service'), aqCell_(linked.row, qh, 'address')].filter(Boolean).join(' · ')
            : 'Quote ' + quoteId,
          quote_id: quoteId,
          expires_at: expires.toISOString(),
          when: expires.toISOString(),
          // Expired sorts above expiring-soon; both above routine items.
          sort: expired ? Number.MAX_SAFE_INTEGER - 1 : (Number.MAX_SAFE_INTEGER - 1000 - daysLeft)
        });
      }
    }

    items.sort(function (x, y) { return (y.sort || 0) - (x.sort || 0); });

    var counts = { all: items.length, start: 0, change: 0, expiring: 0, recovery: 0 };
    items.forEach(function (it) { counts[it.type] = (counts[it.type] || 0) + 1; });

    return { ok: true, items: items, counts: counts };
  } catch (e) {
    return { ok: false, error: 'handleGetActionQueue_ Error: ' + e };
  }
}

// ── Expired-link recovery ────────────────────────────────────────────────────
// A customer whose signing link has lapsed can ask for a fresh one. Without this
// the expired page is a dead end, and valid_until runs on a 30-day timer — links
// lapse routinely, so the customer's only recourse was to phone in.
//
// Auth is the Proposal_Approvals token, the same public token the signing page
// already holds. The quote is re-resolved from that token server-side and never
// taken from the client, so an expired link can only ever request an update for
// its own quote, and an unknown token gets nothing.
function handleRequestQuoteUpdate_(payload) {
  try {
    ensureNormalizedSalesSheets_();
    var token = String(payload.token || '').trim();
    if (!token) return { ok: false, error: 'This request is missing its link token.' };

    var approvals = ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
    var approval = findRowByValue_(approvals, 'token', token);
    // Unknown and malformed tokens get the identical reply — a differing message
    // would let someone probe which tokens exist.
    if (!approval) {
      return { ok: false, error: 'This link is no longer valid. Please contact us and we will send you a new quote.' };
    }

    var status = String(value_(approval, 'status') || '').toUpperCase();
    if (status === 'APPROVED' || status === 'SIGNED') {
      return { ok: false, error: 'This agreement has already been signed.' };
    }

    ensureColumn_(approvals, 'update_requested_at');
    ensureColumn_(approvals, 'update_request_note');
    // Re-read: the row object above was built before those columns existed, so on
    // the very first request it cannot see them.
    approval = findRowByValue_(approvals, 'token', token) || approval;

    var already = String(value_(approval, 'update_requested_at') || '').trim();
    var note = String(payload.note || '').trim().slice(0, 1000);

    softSetCell_(approvals, approval._rowNum, 'update_requested_at', nowIso_());
    // Only overwrite the note when one was given, so a second click that adds no
    // detail cannot erase what the customer said the first time.
    if (note) softSetCell_(approvals, approval._rowNum, 'update_request_note', note);

    return { ok: true, already: !!already };
  } catch (e) {
    return { ok: false, error: 'handleRequestQuoteUpdate_ Error: ' + e };
  }
}

// ── Confirming a requested start date ────────────────────────────────────────
// THIS is what sets service_start — never the customer's click. Optionally moves
// the pool onto the weekday implied by the confirmed date.
function handleConfirmStartDate_(payload) {
  try {
    ensureNormalizedSalesSheets_();
    var quoteId = String(payload.quote_id || '').trim();
    if (!quoteId) return { ok: false, error: 'quote_id required' };

    var confirmed = String(payload.confirmed_start_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(confirmed)) {
      return { ok: false, error: 'Expected a date as YYYY-MM-DD.' };
    }

    var hit = getQuoteById_(quoteId);
    if (!hit) return { ok: false, error: 'Quote not found: ' + quoteId };

    ensureColumn_(hit.sheet, 'service_start');
    softSetCell_(hit.sheet, hit.rowNum, 'service_start', confirmed);
    // ⚠️ billing_start is deliberately NOT set here. It stays a separate,
    // explicit decision so confirming a visit date can never start billing.

    return { ok: true, quote_id: quoteId, service_start: confirmed };
  } catch (e) {
    return { ok: false, error: 'handleConfirmStartDate_ Error: ' + e };
  }
}
