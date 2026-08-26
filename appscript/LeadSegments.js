// LeadSegments.js — cold-list segmentation over the dormant CRM.
//
// The portal could always SEND to a list; what it could never do was answer
// "who have we never actually reached out to, and which of them is worth a call
// first?". That question is the whole point of a reactivation campaign, and it
// could not be asked because the two facts it needs were missing:
//
//   • Imported leads carried no creation date at all, so nothing could be aged.
//     Fixed forward in handleImportLeads_ (SalesHub.js); leadBackfillTimestamps()
//     below repairs the rows that predate that fix.
//   • "Last contacted" existed only inside contact_log, whose `date` field comes
//     from an editable <input type="date"> — a human's recollection, freely
//     backdated. Useful as narrative, useless as a recency signal.
//
// So recency here is computed ONLY from timestamps the server wrote itself, and
// contact_log is consulted for *whether* and *how* someone responded, never for
// *when*. That distinction is the difference between a segment you can trust and
// one that quietly mails people you spoke to yesterday.
//
// Segments are stored as FILTERS, never as member lists. That is deliberate: the
// compose screen's late-binding contract (js/features/comms.js) means an
// uncurated send transmits the filter and re-resolves at send time, so a campaign
// scheduled for Tuesday picks up whoever has gone cold by Tuesday. Materialising
// members would break that on day one.

// ─── Thresholds ──────────────────────────────────────────────────────────────
// One tunable block rather than magic numbers scattered through the predicates.
// These are judgement calls about pool-service sales cycles, not laws.
var LEAD_THRESHOLDS = {
  STALE_DAYS:  30,   // proposal delivered, still silent
  DARK_DAYS:   45,   // said "interested", then nothing
  REVIVE_DAYS: 180   // a LOST lead worth one more try
};

// Not cold leads: these are customers or in-flight deals, and mailing them
// reactivation copy would be embarrassing.
var LEAD_COLD_EXCLUDED = ['ACTIVE_CUSTOMER', 'SIGNED', 'COMPLETED_JOB', 'PAUSED'];

// Explicitly closed by a human or by expiry. These are handled as ONE case and
// never fall through to the other buckets: telling a rep that somebody they
// personally marked Lost was "never contacted" is worse than saying nothing.
var LEAD_CLOSED_LOST = ['LOST', 'CHANGES_DECLINED', 'EXPIRED'];

// DISPLAY order: most-actionable first, which is what a rep should work down.
// This is deliberately NOT the same as classification precedence in
// leadColdBucketFor_, where terminal statuses are resolved first so a closed deal
// can never be mislabelled. A row still lands in exactly ONE bucket either way,
// so the counts add up and nobody is worked twice.
var LEAD_COLD_BUCKETS = [
  { key: 'quoted_never_sent',   label: 'Quoted, never sent' },
  { key: 'interested_went_dark',label: 'Interested, went dark' },
  { key: 'sent_no_response',    label: 'Proposal sent, no reply' },
  { key: 'never_contacted',     label: 'Never contacted' },
  { key: 'lost_revivable',      label: 'Lost, worth reviving' }
];

// ─── Primitives ──────────────────────────────────────────────────────────────
function leadNorm_(v) { return String(v == null ? '' : v).trim(); }

// Sheet cells arrive as Date objects OR ISO strings OR '' depending on how the
// column was written, so every read goes through here. Returns 0 for "no date",
// which callers treat as "unknown", never as 1970.
function leadParseDate_(v) {
  if (!v) return 0;
  if (v instanceof Date) { var t = v.getTime(); return isNaN(t) ? 0 : t; }
  var p = Date.parse(String(v));
  return isNaN(p) ? 0 : p;
}

function leadDaysSince_(ms, nowMs) {
  if (!ms) return -1;                       // -1 = unknown, distinct from 0 days
  return Math.floor(((nowMs || Date.now()) - ms) / 86400000);
}

function leadIso_(ms) {
  if (!ms) return '';
  try { return new Date(ms).toISOString().slice(0, 10); } catch (e) { return ''; }
}

function leadStatus_(r) {
  var raw = leadNorm_(r && r.status);
  if (typeof mcpsNormalizeStatus_ === 'function') {
    return mcpsNormalizeStatus_(raw) || raw.toUpperCase();
  }
  return raw.toUpperCase();
}

// contact_log is a JSON array string on the Quotes row. It arrives already parsed
// when it came through api/_sheets.js parseCell, and as a raw string from GAS —
// handle both rather than assuming the caller's path.
function leadContactLog_(r) {
  var v = r && r.contact_log;
  if (!v) return [];
  if (Object.prototype.toString.call(v) === '[object Array]') return v;
  try {
    var parsed = JSON.parse(String(v));
    return Object.prototype.toString.call(parsed) === '[object Array]' ? parsed : [];
  } catch (e) { return []; }
}

var LEAD_TRUTHY_RE = /^(true|yes|y|1)$/i;
function leadIsTrue_(v) {
  if (v === true) return true;
  return LEAD_TRUTHY_RE.test(leadNorm_(v));
}

// ─── Recency, from server-written timestamps only ────────────────────────────
// contact_log[].date is deliberately absent from this list. See the file header.
var LEAD_TOUCH_FIELDS = ['last_contact_logged_at', 'last_emailed_at',
                         'proposal_sent_at', 'sent_at', 'signed_at'];

function leadLastTouchedAt_(r) {
  var best = 0;
  LEAD_TOUCH_FIELDS.forEach(function (f) {
    var t = leadParseDate_(r && r[f]);
    if (t > best) best = t;
  });
  return best;
}

// "Never contacted" is the union of every contact signal we have, including the
// un-timestamped one: a non-empty contact_log counts as contacted even without a
// server stamp. That is the pre-migration backstop and it fails SAFE — a lead
// somebody already worked by phone never receives cold-open copy.
function leadNeverContacted_(r) {
  if (leadLastTouchedAt_(r)) return false;
  if (leadContactLog_(r).length) return false;
  return true;
}

function leadRespondedToProposal_(r) {
  return !!(leadParseDate_(r.proposal_accepted_at) ||
            leadParseDate_(r.proposal_declined_at) ||
            leadParseDate_(r.proposal_change_requested_at) ||
            leadParseDate_(r.signed_at));
}

var LEAD_INTEREST_RE = /interested|follow\s*up/i;
function leadShowedInterest_(r) {
  return leadContactLog_(r).some(function (e) {
    return e && LEAD_INTEREST_RE.test(leadNorm_(e.outcome));
  });
}

// ─── Bucket classification ───────────────────────────────────────────────────
// Returns { bucket, label, why, last_touched_at, days_since } or null when the
// row is not a cold lead at all. `why` exists so the UI can justify every row it
// puts in front of a human — an unexplained list does not get worked.
function leadColdBucketFor_(r, nowMs) {
  nowMs = nowMs || Date.now();
  if (!r || !leadNorm_(r.quote_id)) return null;
  if (leadIsTrue_(r.do_not_contact)) return null;

  var status = leadStatus_(r);
  if (LEAD_COLD_EXCLUDED.indexOf(status) !== -1) return null;

  var touched = leadLastTouchedAt_(r);
  var since = leadDaysSince_(touched, nowMs);
  var out = function (bucket, why) {
    var def = LEAD_COLD_BUCKETS.filter(function (b) { return b.key === bucket; })[0];
    return { bucket: bucket, label: def ? def.label : bucket, why: why,
             last_touched_at: leadIso_(touched), days_since: since };
  };

  // 1. Terminal first. A quote somebody closed, declined or let expire is
  //    resolved here in full — either it is old enough to revisit or it is left
  //    alone — so it can never be re-described by a later branch as a proposal
  //    still awaiting a reply, or as a lead nobody ever contacted.
  if (LEAD_CLOSED_LOST.indexOf(status) !== -1) {
    var lostMs = leadParseDate_(r.lost_at) || touched;
    var sinceLost = leadDaysSince_(lostMs, nowMs);
    if (sinceLost === -1 || sinceLost < LEAD_THRESHOLDS.REVIVE_DAYS) return null;
    return out('lost_revivable',
      (status === 'EXPIRED' ? 'Quote expired ' : 'Closed ') + sinceLost + ' days ago');
  }

  // 2. We priced it and never delivered it. The work is already done.
  if (status === 'UNSENT') {
    var built = leadParseDate_(r.timestamp);
    return out('quoted_never_sent',
      built ? ('Quote built ' + leadIso_(built) + ', never sent') : 'Quote built, never sent');
  }

  // 3. They told us they were interested and we let it go quiet.
  if (leadShowedInterest_(r) && !leadRespondedToProposal_(r) &&
      (since === -1 || since >= LEAD_THRESHOLDS.DARK_DAYS)) {
    return out('interested_went_dark',
      since === -1 ? 'Logged as interested, no dated follow-up'
                   : ('Logged as interested, quiet ' + since + ' days'));
  }

  // 4. Proposal went out, silence since.
  var sentAt = Math.max(leadParseDate_(r.proposal_sent_at), leadParseDate_(r.sent_at));
  if (sentAt && !leadRespondedToProposal_(r)) {
    var sinceSent = leadDaysSince_(sentAt, nowMs);
    if (sinceSent >= LEAD_THRESHOLDS.STALE_DAYS) {
      return out('sent_no_response', 'Proposal sent ' + sinceSent + ' days ago, no reply');
    }
    return null;                            // still inside the normal reply window
  }

  // 5. Nobody ever reached out.
  if (leadNeverContacted_(r)) {
    var created = leadParseDate_(r.timestamp);
    return out('never_contacted',
      created ? ('In the CRM since ' + leadIso_(created) + ', never contacted')
              : 'Never contacted, no creation date on record');
  }

  return null;
}

// ─── Segment predicates ──────────────────────────────────────────────────────
// A flat predicate object, not a query language. Everything AND-s together;
// list-valued predicates OR within themselves. One level, on purpose — arbitrary
// nesting is a UI swamp nobody at this scale needs.
//
//   { statuses:[], areas:[], cold_buckets:[], never_contacted:true,
//     not_touched_days:90, created_before:'2026-01-01', created_after:'…',
//     has_email:true, exclude_dnc:true, min_year_built:1990, max_year_built:2020 }
// Keys that actually NARROW the audience. has_email and exclude_dnc are defaults
// applied to every segment, so a definition containing only those still means
// "everyone" and must not be mistaken for a real filter.
var LEAD_NARROWING_KEYS = ['statuses', 'areas', 'cold_buckets', 'never_contacted',
  'not_touched_days', 'created_before', 'created_after', 'min_year_built', 'max_year_built'];

// ⚠️ An empty definition matches every emailable lead. That is correct as
// set logic and catastrophic as a default: selecting "Saved segment" and not
// choosing one would otherwise blast the entire CRM. Callers must refuse to
// resolve a segment that narrows nothing.
function leadSegmentHasPredicate_(def) {
  if (!def || typeof def !== 'object') return false;
  return LEAD_NARROWING_KEYS.some(function (k) {
    var v = def[k];
    if (v === undefined || v === null || v === '') return false;
    if (Object.prototype.toString.call(v) === '[object Array]') return v.length > 0;
    if (v === false) return false;
    return true;
  });
}

function leadSegmentMatches_(r, def, nowMs) {
  def = def || {};
  nowMs = nowMs || Date.now();
  if (!r || !leadNorm_(r.quote_id)) return false;

  // Suppression first: cheapest, and it must never be overridable by a filter.
  if (def.exclude_dnc !== false && leadIsTrue_(r.do_not_contact)) return false;

  if (def.has_email !== false && !leadNorm_(r.email)) return false;

  if (def.statuses && def.statuses.length) {
    var want = def.statuses.map(function (s) { return leadNorm_(s).toUpperCase(); });
    if (want.indexOf(leadStatus_(r)) === -1) return false;
  }

  if (def.areas && def.areas.length) {
    var areas = def.areas.map(function (a) { return leadNorm_(a).toLowerCase(); });
    if (areas.indexOf(leadNorm_(r.area).toLowerCase()) === -1) return false;
  }

  if (def.cold_buckets && def.cold_buckets.length) {
    var b = leadColdBucketFor_(r, nowMs);
    if (!b || def.cold_buckets.indexOf(b.bucket) === -1) return false;
  }

  if (def.never_contacted === true && !leadNeverContacted_(r)) return false;

  if (def.not_touched_days != null && def.not_touched_days !== '') {
    var n = Number(def.not_touched_days);
    if (!isNaN(n)) {
      var since = leadDaysSince_(leadLastTouchedAt_(r), nowMs);
      // Never touched satisfies "not touched in N days" for any N — it is the
      // most extreme case of the thing being asked for, not an exclusion.
      if (since !== -1 && since < n) return false;
    }
  }

  var created = leadParseDate_(r.timestamp);
  if (def.created_before) {
    var cb = leadParseDate_(def.created_before);
    if (cb && (!created || created >= cb)) return false;
  }
  if (def.created_after) {
    var ca = leadParseDate_(def.created_after);
    if (ca && (!created || created <= ca)) return false;
  }

  var yb = Number(leadNorm_(r.year_built));
  if (def.min_year_built && (!yb || yb < Number(def.min_year_built))) return false;
  if (def.max_year_built && (!yb || yb > Number(def.max_year_built))) return false;

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Cold audit — "show me who we never reached out to"
// ═══════════════════════════════════════════════════════════════════════════
// Read-only. Returns every cold bucket with its count plus the leads inside it,
// most-recently-touched first, each carrying the reason it qualified.
//
// Ordered by recency rather than scored: a single number nobody can explain does
// not survive its first argument with a sales rep, and the strongest signal a
// real score would want (does this ZIP fall in a serviceable zone) is unavailable
// while imported leads have no zip_code at all.
function handleLeadColdAudit_(payload) {
  payload = payload || {};
  var limit = Math.min(Math.max(Number(payload.limit) || 50, 1), 500);
  var crm = handleGetCRMData();
  if (!crm || !crm.ok) return { ok: false, error: 'Could not read the CRM.' };
  var rows = crm.data || [];
  var nowMs = Date.now();

  var buckets = {};
  LEAD_COLD_BUCKETS.forEach(function (b) {
    buckets[b.key] = { bucket: b.key, label: b.label, count: 0, no_email: 0, leads: [] };
  });

  var totalCold = 0, totalReachable = 0;
  rows.forEach(function (r) {
    var hit = leadColdBucketFor_(r, nowMs);
    if (!hit) return;
    var b = buckets[hit.bucket];
    totalCold++;
    b.count++;
    var email = leadNorm_(r.email);
    // Counted separately rather than hidden: "we have 40 cold leads but no way to
    // email 12 of them" is an actionable fact about the data, not a rendering
    // detail. It tells you to go find addresses.
    if (!email) { b.no_email++; return; }
    totalReachable++;
    b.leads.push({
      quote_id: r.quote_id,
      name: [leadNorm_(r.first_name), leadNorm_(r.last_name)].filter(String).join(' ')
            || leadNorm_(r.client_name) || leadNorm_(r.customer_name),
      email: email, phone: leadNorm_(r.phone), city: leadNorm_(r.city), area: leadNorm_(r.area),
      status: leadStatus_(r), why: hit.why,
      last_touched_at: hit.last_touched_at, days_since: hit.days_since,
      value: Number(r.total_with_tax) || 0
    });
  });

  var list = LEAD_COLD_BUCKETS.map(function (def) {
    var b = buckets[def.key];
    // Unknown recency (-1) sorts last: those are the ones with no dated evidence
    // at all, so they are the least defensible thing to open a call with.
    b.leads.sort(function (x, y) {
      if (x.days_since === -1 && y.days_since === -1) return 0;
      if (x.days_since === -1) return 1;
      if (y.days_since === -1) return -1;
      return x.days_since - y.days_since;
    });
    b.truncated = b.leads.length > limit;
    b.leads = b.leads.slice(0, limit);
    return b;
  });

  return { ok: true, buckets: list, total_cold: totalCold, total_reachable: totalReachable,
           thresholds: LEAD_THRESHOLDS, generated_at: new Date().toISOString() };
}

// ═══════════════════════════════════════════════════════════════════════════
// Segment CRUD
// ═══════════════════════════════════════════════════════════════════════════
function handleLeadSaveSegment_(auth, payload) {
  commsEnsureSheets_();
  var seg = payload.segment || {};
  var name = leadNorm_(seg.name);
  if (!name) return { ok: false, error: 'Segment name is required.' };
  var def = seg.definition || {};
  if (typeof def !== 'object') return { ok: false, error: 'definition must be an object.' };

  var now = new Date().toISOString();
  var by = (auth && (auth.name || auth.username)) || '';
  var count = leadCountSegment_(def);

  if (seg.segment_id) {
    var ok = commsUpdateRowById_('segments', 'segment_id', seg.segment_id, {
      name: name, definition_json: JSON.stringify(def), updated_at: now,
      last_count: count, last_counted_at: now
    });
    if (!ok) return { ok: false, error: 'Segment not found' };
    return { ok: true, segment_id: seg.segment_id, count: count };
  }
  var id = Utilities.getUuid();
  commsAppendRow_('segments', {
    segment_id: id, name: name, definition_json: JSON.stringify(def),
    created_by: by, created_at: now, updated_at: now,
    last_count: count, last_counted_at: now
  });
  return { ok: true, segment_id: id, count: count };
}

function handleLeadListSegments_() {
  commsEnsureSheets_();
  return { ok: true, segments: commsSheetRows_('segments').map(function (r) {
    var def = {};
    try { def = JSON.parse(r.definition_json || '{}'); } catch (e) {}
    return { segment_id: r.segment_id, name: r.name, definition: def,
             created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
             last_count: Number(r.last_count) || 0, last_counted_at: r.last_counted_at };
  }) };
}

function handleLeadDeleteSegment_(payload) {
  commsEnsureSheets_();
  var id = payload.segment_id || (payload.segment && payload.segment.segment_id);
  if (!id) return { ok: false, error: 'segment_id required' };
  return { ok: !!commsDeleteRowById_('segments', 'segment_id', id) };
}

// Live count for the editor, so a definition can be tuned before it is saved.
function handleLeadCountSegment_(payload) {
  var def = payload.definition;
  if (!def && payload.segment_id) def = leadSegmentDefinition_(payload.segment_id);
  if (!def) return { ok: false, error: 'definition or segment_id required' };
  var c = leadCountSegment_(def, true);
  return { ok: true, count: c.total, reachable: c.reachable, no_email: c.no_email };
}

function leadSegmentDefinition_(segmentId) {
  commsEnsureSheets_();
  var row = commsSheetRows_('segments').filter(function (r) {
    return String(r.segment_id) === String(segmentId);
  })[0];
  if (!row) return null;
  try { return JSON.parse(row.definition_json || '{}'); } catch (e) { return {}; }
}

function leadCountSegment_(def, detailed) {
  var crm = handleGetCRMData();
  var rows = (crm && crm.ok && crm.data) ? crm.data : [];
  var nowMs = Date.now();
  var total = 0, reachable = 0;
  rows.forEach(function (r) {
    if (!leadSegmentMatches_(r, def, nowMs)) return;
    total++;
    if (leadNorm_(r.email)) reachable++;
  });
  if (detailed) return { total: total, reachable: reachable, no_email: total - reachable };
  return total;
}

// ═══════════════════════════════════════════════════════════════════════════
// One-time migration: give un-aged leads a defensible creation date
// ═══════════════════════════════════════════════════════════════════════════
// The Quotes sheet is strictly append-only — handleImportLeads_ writes at
// getLastRow()+1 and handleSaveQuote_ uses appendRow — so row order IS creation
// order and any real timestamps run monotonically down the sheet. That is what
// makes interpolation defensible rather than invented.
//
// Every value written here is marked in timestamp_source, so a report can exclude
// or caveat estimates. Backfilling silently would poison every cohort comparison
// built on it afterwards, which is worse than leaving the column blank.
//
// Run leadBackfillTimestamps() first — it changes nothing and prints the plan.
function leadBackfillTimestamps() { return leadBackfillTimestamps_(true); }
function leadBackfillTimestampsApply() { return leadBackfillTimestamps_(false); }

function leadBackfillTimestamps_(dryRun) {
  var sheet = getCrmSheet_();
  ensureColumn_(sheet, 'timestamp');
  ensureColumn_(sheet, 'timestamp_source');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var lower = headers.map(function (h) { return String(h).toLowerCase().trim(); });
  var idx = function (n) { return lower.indexOf(n); };
  var iTs = idx('timestamp'), iSrc = idx('timestamp_source'), iQid = idx('quote_id');
  var iSent = idx('proposal_sent_at'), iSent2 = idx('sent_at'), iSigned = idx('signed_at');

  var last = sheet.getLastRow();
  if (last < 2) return { ok: true, rows: 0, note: 'empty sheet' };
  var vals = sheet.getRange(2, 1, last - 1, headers.length).getValues();

  // Pass 1 — what we already know, per row.
  var known = vals.map(function (row) {
    if (iQid !== -1 && !leadNorm_(row[iQid])) return null;   // skip blank rows
    return leadParseDate_(row[iTs]) || 0;
  });

  var plan = [], counts = { derived: 0, interpolated: 0, floor: 0, unknown: 0, already: 0, skipped: 0 };

  vals.forEach(function (row, i) {
    if (known[i] === null) { counts.skipped++; return; }
    if (known[i]) { counts.already++; return; }

    // (a) Direct evidence: the row was demonstrably alive by this date. Creation
    //     is necessarily at or before it, so it is an upper bound, not a guess.
    var evidence = 0;
    [iSent, iSent2, iSigned].forEach(function (c) {
      if (c === -1) return;
      var t = leadParseDate_(row[c]);
      if (t && (!evidence || t < evidence)) evidence = t;
    });
    if (evidence) {
      plan.push({ row: i + 2, ms: evidence, source: 'derived' });
      counts.derived++; return;
    }

    // (b) Bracket between the nearest real timestamps above and below.
    var above = 0, below = 0;
    for (var a = i - 1; a >= 0; a--) { if (known[a]) { above = known[a]; break; } }
    for (var b = i + 1; b < known.length; b++) { if (known[b]) { below = known[b]; break; } }

    if (above && below) {
      // Midpoint of a known-good interval: the tightest honest statement available.
      plan.push({ row: i + 2, ms: Math.floor((above + below) / 2), source: 'interpolated' });
      counts.interpolated++;
    } else if (below) {
      // Leading blanks: older than the first thing we can date. Use that as a
      // ceiling rather than inventing an earlier date out of nothing.
      plan.push({ row: i + 2, ms: below, source: 'floor' });
      counts.floor++;
    } else if (above) {
      plan.push({ row: i + 2, ms: above, source: 'floor' });
      counts.floor++;
    } else {
      // No dated row anywhere. Leaving it blank is the honest answer.
      counts.unknown++;
    }
  });

  if (!dryRun && plan.length) {
    plan.forEach(function (p) {
      sheet.getRange(p.row, iTs + 1).setValue(new Date(p.ms).toISOString());
      sheet.getRange(p.row, iSrc + 1).setValue(p.source);
    });
    try { invalidateCrmCache_(); } catch (e) {}
  }

  var res = { ok: true, dry_run: !!dryRun, rows_examined: vals.length,
              would_write: plan.length, counts: counts,
              sample: plan.slice(0, 10).map(function (p) {
                return { row: p.row, date: leadIso_(p.ms), source: p.source };
              }) };
  Logger.log(JSON.stringify(res, null, 2));
  return res;
}

// ═══════════════════════════════════════════════════════════════════════════
// Post-send write-back — what stops a segment mailing the same people twice
// ═══════════════════════════════════════════════════════════════════════════
// leadLastTouchedAt_ reads last_emailed_at, so without this the cold buckets
// would never learn that a campaign happened: every lead would still look
// untouched, and the next reactivation send would hit the same list again.
//
// Batched deliberately. Doing it per recipient would mean scanning the Quotes
// sheet once per send — fifty scans in a single sweep — so the sweeper collects
// quote_ids and this runs once at the end: two column reads, two column writes.
function leadRecordEmailed_(quoteIds, iso) {
  if (!quoteIds || !quoteIds.length) return 0;

  var want = {};
  var n = 0;
  quoteIds.forEach(function (q) {
    var k = leadNorm_(q);
    if (k) { want[k] = true; n++; }
  });
  if (!n) return 0;

  var sheet;
  try { sheet = getCrmSheet_(); } catch (e) { return 0; }
  ensureColumn_(sheet, 'last_emailed_at');
  ensureColumn_(sheet, 'email_count');

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var lower = headers.map(function (h) { return String(h).toLowerCase().trim(); });
  var iQid = lower.indexOf('quote_id');
  var iLast = lower.indexOf('last_emailed_at');
  var iCount = lower.indexOf('email_count');
  if (iQid === -1 || iLast === -1 || iCount === -1) return 0;

  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var height = last - 1;

  var qids = sheet.getRange(2, iQid + 1, height, 1).getValues();
  var lastVals = sheet.getRange(2, iLast + 1, height, 1).getValues();
  var countVals = sheet.getRange(2, iCount + 1, height, 1).getValues();

  var touched = 0;
  for (var i = 0; i < height; i++) {
    if (!want[leadNorm_(qids[i][0])]) continue;
    lastVals[i][0] = iso;
    countVals[i][0] = (Number(countVals[i][0]) || 0) + 1;
    touched++;
  }

  if (touched) {
    sheet.getRange(2, iLast + 1, height, 1).setValues(lastVals);
    sheet.getRange(2, iCount + 1, height, 1).setValues(countVals);
    // The cold audit reads through the cached CRM, so without this the buckets
    // would keep showing leads that were emailed minutes ago.
    try { invalidateCrmCache_(); } catch (e) {}
  }
  return touched;
}
