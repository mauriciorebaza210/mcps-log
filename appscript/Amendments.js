// Amendments.gs
// ══════════════════════════════════════════════════════════════════════════════
// AMENDMENTS — upgrades, downgrades, pauses
//
// An amendment is a NEW SIGNED ADDENDUM, never a mutation. Editing a quote must
// never alter an executed agreement; that guarantee is the whole point of the
// Stage 2 scope snapshot, and this extends it to plan changes.
//
// Each amendment gets its OWN full record chain:
//   Proposals            its own row (amends_agreement_id) → own pricing snapshot
//   Service_Agreements   its own row (parent_agreement_id, agreement_type)
//   Proposal_Approvals   its own row + token (target_agreement_id)
//
// ⚠️ The parent is NEVER touched. Not its row, not its PDF, not its quote.
//
// ⚠️ target_agreement_id points at the AMENDMENT row being signed — the one this
// approval will write its audit trail onto. The parent lives ONLY in
// parent_agreement_id. Transposing the two writes a signature onto an executed
// contract, so they are named to be hard to confuse and asserted in the tests.
// ══════════════════════════════════════════════════════════════════════════════

var MCPS_AMENDMENT_TYPES_ = ['upgrade', 'downgrade', 'pause', 'resume', 'other'];

function amEnsureColumns_() {
  var agreements = ensureSheet_('Service_Agreements', MCPS_SERVICE_AGREEMENT_HEADERS);
  ['parent_agreement_id', 'agreement_type', 'amendment_reason'].forEach(function (c) {
    ensureColumn_(agreements, c);
  });
  var approvals = ensureSheet_('Proposal_Approvals', MCPS_PROPOSAL_APPROVAL_HEADERS);
  ensureColumn_(approvals, 'target_agreement_id');
  var proposals = ensureSheet_('Proposals', MCPS_PROPOSAL_HEADERS);
  ensureColumn_(proposals, 'amends_agreement_id');
  return { agreements: agreements, approvals: approvals, proposals: proposals };
}

// ── Create ───────────────────────────────────────────────────────────────────
// Builds the addendum and its signing link. Sends nothing — the caller decides
// when to email it, exactly like a normal proposal.
function handleCreateAmendment_(payload) {
  try {
    ensureNormalizedSalesSheets_();
    var sheets = amEnsureColumns_();

    var parentId = String(payload.parent_agreement_id || '').trim();
    if (!parentId) return { ok: false, error: 'parent_agreement_id required' };

    var parent = findRowByValue_(sheets.agreements, 'agreement_id', parentId);
    if (!parent) return { ok: false, error: 'Agreement not found: ' + parentId };

    // ⚠️ Only an executed agreement can be amended. Amending an unsigned one is a
    // quote edit, not an addendum, and would leave two competing originals.
    var parentType = String(value_(parent, 'agreement_type') || '').trim().toLowerCase();
    if (parentType === 'amendment') {
      return { ok: false, error: 'Cannot amend an amendment. Amend the original agreement.' };
    }
    if (!String(value_(parent, 'signed_at') || '').trim()) {
      return { ok: false, error: 'This agreement is not signed yet — edit the quote instead.' };
    }

    var reason = String(payload.amendment_reason || '').trim();
    var kind = String(payload.amendment_type || 'other').trim().toLowerCase();
    if (MCPS_AMENDMENT_TYPES_.indexOf(kind) === -1) kind = 'other';

    var quoteId = String(value_(parent, 'source_quote_id') || '').trim();
    var hit = quoteId ? getQuoteById_(quoteId) : null;
    if (!hit) return { ok: false, error: 'Source quote not found for this agreement.' };
    var q = hit.object;
    var now = nowIso_();

    // ── Its own proposal: the pricing/scope snapshot for THIS change ─────────
    var proposalId = nextSequence_(sheets.proposals, 'proposal_id', 'PROP', 6);
    var proposalNumber = nextSequence_(sheets.proposals, 'proposal_number', 'AMD', 6);
    appendObject_(sheets.proposals, {
      proposal_id: proposalId,
      proposal_number: proposalNumber,
      legacy_quote_id: quoteId,
      client_id: value_(parent, 'client_id'),
      location_id: value_(parent, 'location_id'),
      status: 'SENT',
      service_type: payload.service_type || value_(parent, 'service_type') || value_(q, 'service'),
      proposal_title: 'Amendment — ' + (reason || kind),
      created_by: String(payload.created_by || '').trim(),
      valid_until: amValidUntil_(),
      subtotal: payload.subtotal || '',
      tax_rate: payload.tax_rate || value_(parent, 'tax_rate') || '',
      sales_tax: payload.sales_tax || '',
      total: payload.total || '',
      amends_agreement_id: parentId,
      created_at: now,
      updated_at: now
    }, MCPS_PROPOSAL_HEADERS);

    // ── Its own agreement row ────────────────────────────────────────────────
    var amendmentId = nextSequence_(sheets.agreements, 'agreement_id', 'AGR', 6);
    var amendmentNumber = nextSequence_(sheets.agreements, 'agreement_number', 'AMD', 6);
    appendObject_(sheets.agreements, {
      agreement_id: amendmentId,
      agreement_number: amendmentNumber,
      client_id: value_(parent, 'client_id'),
      location_id: value_(parent, 'location_id'),
      proposal_id: proposalId,
      source_quote_id: quoteId,
      status: 'SENT',
      signature_required: 'TRUE',
      service_type: payload.service_type || value_(parent, 'service_type'),
      service_name: payload.service_name || value_(parent, 'service_name'),
      monthly_rate: payload.monthly_rate || '',
      tax_rate: payload.tax_rate || value_(parent, 'tax_rate') || '',
      sales_tax: payload.sales_tax || '',
      total: payload.total || '',
      sent_at: now,
      // ⚠️ The PARENT goes here, and only here.
      parent_agreement_id: parentId,
      agreement_type: 'amendment',
      amendment_reason: reason || kind,
      created_at: now,
      updated_at: now
    }, MCPS_SERVICE_AGREEMENT_HEADERS);

    // ── Its own approval + token ─────────────────────────────────────────────
    var token = proposalApprovalToken_();
    var approvalId = nextSequence_(sheets.approvals, 'approval_id', 'APR', 6);
    var expires = new Date();
    expires.setDate(expires.getDate() + 30);
    appendObject_(sheets.approvals, {
      approval_id: approvalId,
      proposal_id: proposalId,
      quote_id: quoteId,
      token: token,
      status: 'SENT',
      sent_at: now,
      expires_at: expires.toISOString(),
      // ⚠️ The AMENDMENT being signed — NOT the parent. sign_amendment resolves
      // the row to write through this field, so a transposition here would stamp
      // a signature onto the executed parent.
      target_agreement_id: amendmentId,
      created_at: now,
      updated_at: now
    }, MCPS_PROPOSAL_APPROVAL_HEADERS);

    return {
      ok: true,
      amendment_id: amendmentId,
      amendment_number: amendmentNumber,
      parent_agreement_id: parentId,
      proposal_id: proposalId,
      approval_id: approvalId,
      sign_url: proposalApprovalUrl_(token, '')
    };
  } catch (e) {
    return { ok: false, error: 'handleCreateAmendment_ Error: ' + e };
  }
}

function amValidUntil_() {
  var d = new Date();
  d.setDate(d.getDate() + 30);
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'America/Chicago', 'yyyy-MM-dd');
}

// ── Rendering an addendum ────────────────────────────────────────────────────
// ⚠️ The signing page and the PDF both read pricing, service and scope from the
// QUOTE object. For an amendment that quote is the PARENT's — so without this the
// addendum would show the original agreement's figures, and the customer would
// sign a document stating the wrong price.
//
// Identity (name, address, phone, pool specs) legitimately comes from the parent:
// it is the same customer and the same property. Money and service come from the
// AMENDMENT's own proposal/agreement snapshot, never the parent.
function amAmendmentQuoteView_(parentQuote, proposal, amendmentRow) {
  var view = {};
  Object.keys(parentQuote || {}).forEach(function (k) { view[k] = parentQuote[k]; });

  var pick = function (a, b) {
    var av = String(a == null ? '' : a).trim();
    return av !== '' ? a : b;
  };

  view.service = pick(value_(amendmentRow, 'service_name'),
                 pick(value_(amendmentRow, 'service_type'), view.service));

  var rate = pick(value_(amendmentRow, 'monthly_rate'), value_(proposal, 'subtotal'));
  view.service_subtotal            = pick(value_(proposal, 'subtotal'), rate);
  view.quote_subtotal              = pick(value_(proposal, 'subtotal'), rate);
  view.discounted_service_subtotal = rate;
  view.sales_tax                   = pick(value_(proposal, 'sales_tax'), value_(amendmentRow, 'sales_tax'));
  view.total_with_tax              = pick(value_(proposal, 'total'), value_(amendmentRow, 'total'));
  // An addendum carries no separate discount or travel line — those belong to the
  // original sale. Blanking them stops the parent's figures leaking through.
  view.discount_amount = '';
  view.travel_fee = '';
  return view;
}

// ── Sign ─────────────────────────────────────────────────────────────────────
// ⚠️ Resolves the target purely from the TOKEN:
//     token → approval → target_agreement_id → agreement row
// It never accepts an agreement_id from the browser. The parent and every
// amendment share a source_quote_id, so a client-supplied id (or a quote-id
// lookup) could land on the executed parent.
//
// ⚠️ Calls signAndRecord_ and NOTHING else. No activation, no work orders, no
// welcome email, no quote mirroring — those live only on the original-signing
// path in handleSignAgreement_, so this function cannot reach them.
function handleSignAmendment_(payload) {
  try {
    ensureNormalizedSalesSheets_();
    var sheets = amEnsureColumns_();

    var token = String(payload.token || '').trim();
    if (!token) return { ok: false, error: 'This signing link is missing its token.' };

    var approval = findRowByValue_(sheets.approvals, 'token', token);
    if (!approval) return { ok: false, error: 'This signing link is invalid.' };

    var targetId = String(value_(approval, 'target_agreement_id') || '').trim();
    if (!targetId) {
      return { ok: false, error: 'This link is not an amendment. Use the standard signing flow.' };
    }

    var current = String(value_(approval, 'status') || '').toUpperCase();
    if (current && current !== 'SENT') {
      return { ok: true, already_responded: true, status: current,
               message: 'This amendment has already been responded to.' };
    }
    var expiresAt = value_(approval, 'expires_at');
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
      softSetCell_(sheets.approvals, approval._rowNum, 'status', 'EXPIRED');
      return { ok: false, expired: true, error: 'This signing link has expired.' };
    }

    var signatureName = String(payload.signature_name || '').trim();
    if (!signatureName) return { ok: false, error: 'A signature name is required.' };
    if (payload.consent !== true && String(payload.consent) !== 'true') {
      return { ok: false, error: 'Consent to electronic signature is required.' };
    }

    var amendment = findRowByValue_(sheets.agreements, 'agreement_id', targetId);
    if (!amendment) return { ok: false, error: 'Amendment not found.' };

    // Defence in depth: if this row is not an amendment, refuse. A misfiled
    // target_agreement_id must never let this path write to an original.
    if (String(value_(amendment, 'agreement_type') || '').trim().toLowerCase() !== 'amendment') {
      return { ok: false, error: 'Target is not an amendment. Refusing to sign.' };
    }

    var proposal = findRowByValue_(sheets.proposals, 'proposal_id', value_(approval, 'proposal_id'));
    // ⚠️ The proposal carries the amendment's pricing snapshot. Without it the
    // rendered addendum would fall back to parent figures, so refuse rather than
    // produce a document stating the wrong price.
    if (!proposal) return { ok: false, error: 'This amendment is no longer available.' };
    var hit = getQuoteById_(value_(approval, 'quote_id'));
    if (!hit) return { ok: false, error: 'This amendment is no longer available.' };

    // ⚠️ Render from the AMENDMENT's snapshot, not the parent quote's pricing.
    var amendmentView = amAmendmentQuoteView_(hit.object, proposal, amendment);

    var signed = signAndRecord_({
      quote: amendmentView,
      quoteId: String(value_(approval, 'quote_id') || ''),
      proposal: proposal, proposals: sheets.proposals,
      approval: approval, approvals: sheets.approvals,
      agreements: sheets.agreements,
      agreementRow: amendment,
      signature: {
        name: signatureName,
        method: String(payload.signature_method || 'typed'),
        data: payload.signature_data || '',
        ip: String(payload.signer_ip || ''),
        userAgent: String(payload.signer_user_agent || '')
      },
      note: String(payload.note || ''),
      now: nowIso_(),
      activationMethod: 'IN_PORTAL_ESIGN_AMENDMENT'
    });

    return {
      ok: true,
      status: 'SIGNED',
      amendment_id: targetId,
      parent_agreement_id: String(value_(amendment, 'parent_agreement_id') || ''),
      signed_pdf_url: (signed.pdf && signed.pdf.url) || '',
      customer_name: signatureName
    };
  } catch (e) {
    return { ok: false, error: 'handleSignAmendment_ Error: ' + e };
  }
}
