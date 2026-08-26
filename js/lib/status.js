// ══════════════════════════════════════════════════════════════════════════════
// QUOTE LIFECYCLE — the single status vocabulary
//
// Loads three ways, like js/lib/pricing.js: <script>, require, createRequire.
//
// ⚠️ WHY THIS EXISTS. There were three overlapping vocabularies and no source of
// truth:
//   crm.js:307    LEAD UNSENT SENT SIGNED ACTIVE_CUSTOMER LOST COMPLETED_JOB
//   comms.js:23   LEAD SENT SIGNED ACTIVE_CUSTOMER PAUSED LOST COMPLETED_JOB
//   the backend also writes DECLINED, EXPIRED, APPROVED, NOT_REQUIRED, CANCELLED
//
// Consequences that were live:
//   • A DECLINED or EXPIRED quote counted in "All" and appeared under NO pill,
//     filterable by nothing — the customer who said no was invisible.
//   • The Completed filter matched nothing: the <option> value was COMPLETED
//     while the stored value is COMPLETED_JOB.
//   • PAUSED could be targeted by a Comms campaign but set by nothing.
//   • home.js filtered on 'QUOTED', a status never written anywhere, so pipeline
//     value and the funnel's middle stage were structurally zero.
//
// ⚠️ DESIGN NOTE: this does NOT migrate stored data. SIGNED has always been
// DERIVED (status ACTIVE_CUSTOMER + contract_status SIGNED) rather than stored,
// and rewriting a live Quotes sheet to change that would be a far riskier change
// than agreeing on one derivation. So: normalise the aliases, derive the
// effective state, and have every screen ask this module instead of guessing.
// ══════════════════════════════════════════════════════════════════════════════

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MCPS_STATUS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Ordered as the deal actually progresses, so any UI can sort by `order` and
  // get a pipeline rather than an alphabetical list.
  var META = {
    LEAD: {
      order: 10, label: 'Lead', short: 'Lead',
      hint: 'Imported or called in. No priced quote yet.',
      open: true, color: '#475569', bg: '#e2e8f0'
    },
    UNSENT: {
      order: 20, label: 'Draft Quote', short: 'Draft',
      hint: 'Priced and saved, not sent to the customer.',
      open: true, color: '#7c5c10', bg: '#fdf6e3'
    },
    SENT: {
      order: 30, label: 'Awaiting Signature', short: 'Sent',
      hint: 'Agreement link sent. Waiting on the customer.',
      open: true, color: '#075985', bg: '#e0f2fe'
    },
    VIEWED: {
      order: 35, label: 'Viewed', short: 'Viewed',
      hint: 'The customer has opened the agreement.',
      open: true, color: '#0369a1', bg: '#dbeafe'
    },
    CHANGES_REQUESTED: {
      order: 40, label: 'Changes Requested', short: 'Changes',
      hint: 'The customer asked for a change before signing.',
      open: true, needsAction: true, color: '#9a3412', bg: '#ffedd5'
    },
    SIGNED: {
      order: 50, label: 'Signed', short: 'Signed',
      hint: 'Agreement executed.',
      won: true, color: '#065f46', bg: '#d1fae5'
    },
    ACTIVE_CUSTOMER: {
      order: 60, label: 'Active Customer', short: 'Active',
      hint: 'On the route and being served.',
      won: true, active: true, color: '#14532d', bg: '#bbf7d0'
    },
    PAUSED: {
      order: 70, label: 'Paused', short: 'Paused',
      hint: 'Service temporarily suspended. Still a customer.',
      won: true, color: '#854d0e', bg: '#fef9c3'
    },
    COMPLETED_JOB: {
      order: 80, label: 'Completed', short: 'Done',
      hint: 'One-time job finished. Startups, G2C and repairs land here.',
      closed: true, color: '#475569', bg: '#e2e8f0'
    },
    CHANGES_DECLINED: {
      order: 85, label: 'Declined', short: 'Declined',
      hint: 'The customer declined the agreement.',
      closed: true, lost: true, needsAction: true, color: '#9f1239', bg: '#ffe4e6'
    },
    EXPIRED: {
      order: 90, label: 'Expired', short: 'Expired',
      hint: 'The signing link lapsed before the customer acted.',
      closed: true, lost: true, needsAction: true, color: '#9a3412', bg: '#fff7ed'
    },
    LOST: {
      order: 100, label: 'Lost', short: 'Lost',
      hint: 'Not proceeding.',
      closed: true, lost: true, color: '#991b1b', bg: '#fee2e2'
    }
  };

  // 'DECLINED' is the value the backend actually writes; CHANGES_DECLINED above
  // is the internal key. Alias table keeps both readable.
  var ALIASES = {
    // Written by the backend or by Zapier historically.
    DECLINED: 'CHANGES_DECLINED',
    CHANGES_DECLINED: 'CHANGES_DECLINED',
    APPROVED: 'SIGNED',
    // The Contracts page and mapAgreementStatusFromQuote_ vocabulary.
    NOT_REQUIRED: 'ACTIVE_CUSTOMER',
    DRAFT: 'UNSENT',
    GENERATED: 'UNSENT',
    ACCEPTED: 'SIGNED',
    CONVERTED_TO_SERVICE: 'ACTIVE_CUSTOMER',
    CONVERTED_TO_INVOICE: 'COMPLETED_JOB',
    // ⚠️ The dead ones. 'COMPLETED' was the <option> value in the status filter
    // while COMPLETED_JOB is what is stored, so the filter matched nothing.
    // 'QUOTED' is filtered on in home.js and has never been written by anything.
    COMPLETED: 'COMPLETED_JOB',
    QUOTED: 'SENT',
    CANCELLED: 'LOST',
    PENDING: 'UNSENT',
    ACTIVE: 'ACTIVE_CUSTOMER',
    SIGNED_CUSTOMER: 'ACTIVE_CUSTOMER'
  };

  var ORDER = Object.keys(META).sort(function (a, b) { return META[a].order - META[b].order; });

  function normalize(raw) {
    var s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!s) return '';
    if (META[s]) return s;
    if (ALIASES[s]) return ALIASES[s];
    return '';
  }

  // ── The effective state ─────────────────────────────────────────────────────
  // SIGNED is not a stored value. Every screen used to re-derive it, each
  // slightly differently, which is why the Sales Hub stat pills double-counted
  // the same customers as both Signed and Active with no label saying so.
  //
  // Precedence is deliberate: a declined or expired signing outranks a stale
  // pipeline status, because "the customer said no" is the fact that matters.
  function derive(row) {
    row = row || {};
    var status = normalize(row.status);
    var contract = String(row.contract_status == null ? '' : row.contract_status).trim().toUpperCase();
    var proposal = row.proposal || {};

    if (row.proposal_declined_at || contract === 'DECLINED') return 'CHANGES_DECLINED';
    if (row.proposal_change_requested_at && !row.signed_at && contract !== 'SIGNED') {
      return 'CHANGES_REQUESTED';
    }

    if (contract === 'SIGNED' || row.signed_at) {
      // Signed AND on the route is Active; signed and not yet placed is Signed.
      return status === 'ACTIVE_CUSTOMER' && String(row.pool_id || '').trim()
        ? 'ACTIVE_CUSTOMER' : 'SIGNED';
    }

    if (status === 'ACTIVE_CUSTOMER') return 'ACTIVE_CUSTOMER';
    if (status) {
      // A SENT quote whose link has lapsed reads EXPIRED, so the expiring-quote
      // worklist and the pipeline agree.
      if (status === 'SENT' && row.expired_at) return 'EXPIRED';
      if (status === 'SENT' && row.viewed_at) return 'VIEWED';
      return status;
    }

    if (proposal.sent_at || row.proposal_sent_at) return 'SENT';
    return 'UNSENT';
  }

  function meta(key) { return META[normalize(key) || 'UNSENT'] || META.UNSENT; }
  function label(key) { return meta(key).label; }
  function shortLabel(key) { return meta(key).short; }

  // ── Filter pills ────────────────────────────────────────────────────────────
  // STAGE_PILLS are mutually exclusive lifecycle homes. FACET_PILLS are rollups
  // such as Open and Needs You; they deliberately overlap stages and must be
  // rendered as summaries, not as peers of the lifecycle tabs.
  var STAGE_PILLS = [
    { key: 'all',      label: 'All',      states: ORDER.slice() },
    { key: 'LEAD',     label: 'Leads',    states: ['LEAD'] },
    { key: 'UNSENT',   label: 'Drafts',   states: ['UNSENT'] },
    { key: 'SENT',     label: 'Sent',     states: ['SENT', 'VIEWED'] },
    { key: 'CHANGES_REQUESTED', label: 'Changes', states: ['CHANGES_REQUESTED'] },
    { key: 'SIGNED',   label: 'Signed',   states: ['SIGNED'] },
    { key: 'ACTIVE_CUSTOMER', label: 'Active', states: ['ACTIVE_CUSTOMER', 'PAUSED'] },
    { key: 'COMPLETED_JOB',   label: 'Completed', states: ['COMPLETED_JOB'] },
    { key: 'lost',     label: 'Lost',     states: ['LOST', 'CHANGES_DECLINED', 'EXPIRED'] }
  ];

  var FACET_PILLS = [
    { key: 'open',     label: 'Open Pipeline', states: ORDER.filter(function (k) { return META[k].open; }) },
    { key: 'action',   label: 'Needs You',     states: ORDER.filter(function (k) { return META[k].needsAction; }) }
  ];

  var PILLS = STAGE_PILLS.concat(FACET_PILLS);

  function pillFor(state) {
    var s = normalize(state);
    for (var i = 1; i < STAGE_PILLS.length; i++) {
      if (STAGE_PILLS[i].states.indexOf(s) !== -1) return STAGE_PILLS[i].key;
    }
    return 'all';
  }

  function matchesPill(pillKey, state) {
    if (pillKey === 'all' || !pillKey) return true;
    var pill = PILLS.find(function (p) { return p.key === pillKey; });
    if (!pill) return normalize(state) === normalize(pillKey);
    return pill.states.indexOf(normalize(state)) !== -1;
  }

  function counts(rows) {
    var out = {};
    PILLS.forEach(function (p) { out[p.key] = 0; });
    (rows || []).forEach(function (r) {
      var s = derive(r);
      PILLS.forEach(function (p) { if (matchesPill(p.key, s)) out[p.key]++; });
    });
    return out;
  }

  // ── Legal transitions ───────────────────────────────────────────────────────
  // handleUpdateLead_ wrote payload.status with NO enum check and no role gate,
  // so any authenticated token could set any value — including one no screen can
  // render — on any quote.
  var TRANSITIONS = {
    LEAD:              ['UNSENT', 'LOST'],
    UNSENT:            ['SENT', 'ACTIVE_CUSTOMER', 'LOST'],
    SENT:              ['VIEWED', 'SIGNED', 'CHANGES_REQUESTED', 'CHANGES_DECLINED', 'EXPIRED', 'LOST', 'UNSENT'],
    VIEWED:            ['SIGNED', 'CHANGES_REQUESTED', 'CHANGES_DECLINED', 'EXPIRED', 'LOST', 'SENT'],
    CHANGES_REQUESTED: ['UNSENT', 'SENT', 'LOST'],
    EXPIRED:           ['UNSENT', 'SENT', 'LOST'],
    CHANGES_DECLINED:  ['UNSENT', 'SENT', 'LOST'],
    SIGNED:            ['ACTIVE_CUSTOMER', 'COMPLETED_JOB', 'LOST'],
    ACTIVE_CUSTOMER:   ['PAUSED', 'COMPLETED_JOB', 'LOST'],
    PAUSED:            ['ACTIVE_CUSTOMER', 'COMPLETED_JOB', 'LOST'],
    COMPLETED_JOB:     ['ACTIVE_CUSTOMER'],
    LOST:              ['LEAD', 'UNSENT']
  };

  function canTransition(from, to) {
    var f = normalize(from), t = normalize(to);
    if (!t) return false;
    if (!f) return true;          // nothing recorded yet: any valid state is fine
    if (f === t) return true;     // idempotent
    return (TRANSITIONS[f] || []).indexOf(t) !== -1;
  }

  // Statuses an operator may set by hand. Signing outcomes are recorded by the
  // signing flow, not typed in — offering them as buttons invites a human to
  // claim a signature that never happened.
  var MANUAL = ['LEAD', 'UNSENT', 'SENT', 'ACTIVE_CUSTOMER', 'PAUSED', 'COMPLETED_JOB', 'LOST'];

  function allowedNext(from) {
    var f = normalize(from);
    if (!f) return MANUAL.slice();
    return MANUAL.filter(function (t) { return t !== f && canTransition(f, t); });
  }

  // ── Pipeline reporting ──────────────────────────────────────────────────────
  // home.js counted 'QUOTED' — never written — so "Open Opportunities" only ever
  // saw LEAD and "Quotes Sent" was permanently 0.
  function pipeline(rows) {
    var out = { leads: 0, quoted: 0, signed: 0, active: 0, lost: 0, open_value: 0, won_value: 0 };
    (rows || []).forEach(function (r) {
      var s = derive(r);
      var value = Number(String(r.total_with_tax == null ? 0 : r.total_with_tax).replace(/[$,]/g, '')) || 0;
      if (s === 'LEAD') out.leads++;
      if (s === 'UNSENT' || s === 'SENT' || s === 'VIEWED' || s === 'CHANGES_REQUESTED') out.quoted++;
      if (s === 'SIGNED') out.signed++;
      if (s === 'ACTIVE_CUSTOMER' || s === 'PAUSED') out.active++;
      if (META[s] && META[s].lost) out.lost++;
      if (META[s] && META[s].open) out.open_value += value;
      if (META[s] && META[s].won) out.won_value += value;
    });
    out.open_value = Math.round(out.open_value * 100) / 100;
    out.won_value = Math.round(out.won_value * 100) / 100;
    return out;
  }

  return {
    META: META, ALIASES: ALIASES, ORDER: ORDER,
    STAGE_PILLS: STAGE_PILLS, FACET_PILLS: FACET_PILLS, PILLS: PILLS,
    TRANSITIONS: TRANSITIONS, MANUAL: MANUAL,
    normalize: normalize, derive: derive,
    meta: meta, label: label, shortLabel: shortLabel,
    pillFor: pillFor, matchesPill: matchesPill, counts: counts,
    canTransition: canTransition, allowedNext: allowedNext,
    pipeline: pipeline
  };
});
