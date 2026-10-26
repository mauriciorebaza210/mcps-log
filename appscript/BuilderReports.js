// ══════════════════════════════════════════════════════════════════════════════
// BuilderReports.gs — recurring startup progress reports for pool builders (MCP first)
//
// PHASE 1a ONLY: the audit. Nothing in this file writes anything, anywhere.
//
// Before a single line of report code is worth writing, we have to be able to
// answer three questions about every record, without guessing:
//
//   1. Whose pool is this?          → is there a real pool_company_id, or are we
//                                      string-matching a company name?
//   2. Is this a startup, and which day?
//                                   → does the log resolve to a specific
//                                      startup_day_N, and by which signal?
//   3. Do these photos belong here? → does the Drive folder map to exactly one pool?
//
// The answers are all currently "sometimes". This file measures how often, so the
// scale of the fix is a number instead of a fear. Run runBuilderReportAudit() from
// the Apps Script editor and read the log.
//
// Everything here is deliberately defensive: columns that do not exist yet
// (pool_company_id on Quotes) must read as absent, not throw.
// ══════════════════════════════════════════════════════════════════════════════

var BSR_ROUTES_SS_ID = '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM';
var BSR_CRM_SS_ID    = '1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E';
var BSR_TZ           = 'America/Chicago';
var BSR_PHOTO_ROOT   = 'MCPS Visit Photos';

var BSR_STARTUP_DAY_RE = /^startup_day_(\d+)$/i;
var BSR_POOL_ID_RE     = /^MCPS-\d+$/i;
var BSR_SAMPLE_CAP     = 40;   // keep the log readable; counts are always complete

// ─── Small helpers ────────────────────────────────────────────────────────────
// Each guards on the shared helper existing, so this file survives being loaded
// in isolation and does not silently depend on SalesHub.js load order.

function bsrHeader_(h) {
  if (typeof normalizeHeader_ === 'function') return normalizeHeader_(h);
  return String(h == null ? '' : h).trim().toLowerCase().replace(/ /g, '_');
}

function bsrRows_(sheet) {
  if (!sheet) return { headers: [], rows: [] };
  if (typeof sheetToObjects_ === 'function') return sheetToObjects_(sheet);
  if (sheet.getLastRow() < 1) return { headers: [], rows: [] };
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(bsrHeader_);
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = { _rowNum: i + 1 };
    headers.forEach(function (h, j) { if (h) obj[h] = values[i][j]; });
    rows.push(obj);
  }
  return { headers: headers, rows: rows };
}

// The log's pool_id column holds the full dropdown label
// ("Bullock - Weekly Full Service - 24102 Shelton Spring - MCPS-0017"), not a
// bare id. Same extractor the usage pipeline already uses.
function bsrPoolId_(value) {
  if (typeof normalizeUsagePoolId_ === 'function') {
    var viaShared = normalizeUsagePoolId_(value);
    return BSR_POOL_ID_RE.test(viaShared) ? viaShared.toUpperCase() : '';
  }
  var m = String(value == null ? '' : value).match(/MCPS-\d+/i);
  return m ? m[0].toUpperCase() : '';
}

function bsrYmd_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, BSR_TZ, 'yyyy-MM-dd');
  }
  var s = String(value == null ? '' : value).trim();
  var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  if (!s) return '';
  var d = new Date(s);
  return isNaN(d.getTime()) ? '' : Utilities.formatDate(d, BSR_TZ, 'yyyy-MM-dd');
}

function bsrToday_() {
  return Utilities.formatDate(new Date(), BSR_TZ, 'yyyy-MM-dd');
}

function bsrStr_(value) {
  return String(value == null ? '' : value).trim();
}

function bsrCompanyKey_(name) {
  return bsrStr_(name).replace(/\s+/g, ' ').toLowerCase();
}

// A blank status has always meant "scheduled" in Scheduled_Visits.
function bsrVisitStatus_(row) {
  return bsrStr_(row.status).toLowerCase() || 'scheduled';
}

function bsrPush_(list, item) {
  if (list.length < BSR_SAMPLE_CAP) list.push(item);
  return list;
}

// Customer label for a quote row — Quotes carries first_name/last_name, Routes
// carries customer_name, and older rows may only have an address.
function bsrCustomerLabel_(row) {
  var name = bsrStr_(row.customer_name);
  if (name) return name;
  var joined = (bsrStr_(row.first_name) + ' ' + bsrStr_(row.last_name)).trim();
  if (joined) return joined;
  return bsrStr_(row.address) || '(unnamed)';
}

// ─── The audit ────────────────────────────────────────────────────────────────

function bsrAudit_() {
  var audit = {
    ok: true,
    generated_at: new Date().toISOString(),
    today: bsrToday_()
  };

  var crm    = SpreadsheetApp.openById(BSR_CRM_SS_ID);
  var routes = SpreadsheetApp.openById(BSR_ROUTES_SS_ID);

  var quotes    = bsrRows_(crm.getSheetByName('Quotes'));
  var companies = bsrRows_(crm.getSheetByName('Pool_Companies'));
  var visits    = bsrRows_(routes.getSheetByName('Scheduled_Visits'));
  var routeRows = bsrRows_(routes.getSheetByName('Routes'));
  var logs      = bsrRows_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Chemical_Usage_Log'));

  audit.source_counts = {
    quotes: quotes.rows.length,
    pool_companies: companies.rows.length,
    scheduled_visits: visits.rows.length,
    routes: routeRows.rows.length,
    chemical_usage_log: logs.rows.length
  };

  // Does the durable link column exist on Quotes yet? Phase 1c adds it; until
  // then every pool falls through to name matching, which is the point.
  audit.quotes_has_pool_company_id = quotes.headers.indexOf('pool_company_id') !== -1;

  var companyByName = {};
  companies.rows.forEach(function (c) {
    var key = bsrCompanyKey_(c.company_name);
    if (key) companyByName[key] = c;
  });

  // ── 1. Whose pool is this? ──────────────────────────────────────────────────
  var buckets = { linked: 0, name_match: 0, named_no_company: 0, no_builder: 0 };
  var bucketSamples = { name_match: [], named_no_company: [] };
  var poolToQuotes = {};      // pool_id → [{ customer, service, status, company }]
  var quotePoolIds = {};

  quotes.rows.forEach(function (q) {
    var pid = bsrPoolId_(q.pool_id);
    if (!pid) return;
    quotePoolIds[pid] = true;

    var companyId = bsrStr_(q.pool_company_id);
    var companyName = bsrStr_(q.startup_company);
    var bucket;
    if (companyId)                                  bucket = 'linked';
    else if (companyName && companyByName[bsrCompanyKey_(companyName)]) bucket = 'name_match';
    else if (companyName)                           bucket = 'named_no_company';
    else                                            bucket = 'no_builder';
    buckets[bucket]++;

    var entry = {
      pool_id: pid,
      customer: bsrCustomerLabel_(q),
      service: bsrStr_(q.service),
      status: bsrStr_(q.status),
      company: companyName,
      bucket: bucket
    };
    if (bucketSamples[bucket]) bsrPush_(bucketSamples[bucket], entry);

    if (!poolToQuotes[pid]) poolToQuotes[pid] = [];
    poolToQuotes[pid].push(entry);
  });

  audit.builder_link = {
    buckets: buckets,
    note: audit.quotes_has_pool_company_id
      ? 'pool_company_id column present on Quotes.'
      : 'No pool_company_id column on Quotes yet — every pool resolves by company NAME only.',
    name_match_samples: bucketSamples.name_match,
    named_no_company_samples: bucketSamples.named_no_company
  };

  // ── 2. Is this pool id unique? ──────────────────────────────────────────────
  // Several quotes can legitimately share a pool_id (a startup quote plus the
  // weekly quote for the same pool). Two DIFFERENT customers on one id cannot.
  var conflicts = [];
  var multiQuote = 0;
  Object.keys(poolToQuotes).forEach(function (pid) {
    var entries = poolToQuotes[pid];
    if (entries.length < 2) return;
    multiQuote++;
    var distinct = {};
    entries.forEach(function (e) { distinct[e.customer.toLowerCase()] = e.customer; });
    var names = Object.keys(distinct).map(function (k) { return distinct[k]; });
    if (names.length > 1) {
      bsrPush_(conflicts, { pool_id: pid, customers: names, quote_count: entries.length });
    }
  });
  audit.duplicate_pool_ids = {
    conflicting: conflicts.length,
    pools_with_multiple_quotes: multiQuote,
    samples: conflicts
  };

  // ── 3. Is this a startup? ───────────────────────────────────────────────────
  // Mirror how production actually classifies a quote (syncQuoteOperationalSchedule_):
  // service_key is the machine key and wins; the display label is only a fallback.
  // Track which signal answered — a pool classified only by a free-text label is
  // one typo away from not being a startup at all.
  var quoteStartups = {};
  var startupBySignal = { service_key: 0, service_label: 0 };
  quotes.rows.forEach(function (q) {
    var pid = bsrPoolId_(q.pool_id);
    if (!pid) return;
    var key = bsrStr_(q.service_key).toLowerCase();
    if (key === 'pool_startup') {
      if (!quoteStartups[pid]) startupBySignal.service_key++;
      quoteStartups[pid] = true;
      return;
    }
    if (key) return;   // a different key is an explicit "not a startup"
    if (/startup/i.test(bsrStr_(q.service))) {
      if (!quoteStartups[pid]) startupBySignal.service_label++;
      quoteStartups[pid] = true;
    }
  });

  var visitStartups = {};
  var startupVisitsByPool = {};   // pool_id → [visit rows that are startup days]
  var visitById = {};
  visits.rows.forEach(function (v) {
    var svId = bsrStr_(v.scheduled_visit_id);
    if (svId) visitById[svId] = v;
    var pid = bsrPoolId_(v.pool_id);
    if (!pid) return;
    if (!BSR_STARTUP_DAY_RE.test(bsrStr_(v.visit_type))) return;
    visitStartups[pid] = true;
    if (!startupVisitsByPool[pid]) startupVisitsByPool[pid] = [];
    startupVisitsByPool[pid].push(v);
  });

  var missingVisits = [];
  Object.keys(quoteStartups).forEach(function (pid) {
    if (!visitStartups[pid]) bsrPush_(missingVisits, pid);
  });
  var orphanVisits = [];
  Object.keys(visitStartups).forEach(function (pid) {
    if (!quoteStartups[pid]) bsrPush_(orphanVisits, pid);
  });

  // How many days does each startup actually have? The system assumes 3.
  var dayCounts = {};
  Object.keys(startupVisitsByPool).forEach(function (pid) {
    var live = startupVisitsByPool[pid].filter(function (v) {
      return bsrVisitStatus_(v) !== 'cancelled';
    });
    var n = live.length;
    dayCounts[n] = (dayCounts[n] || 0) + 1;
  });

  audit.startup_identification = {
    startup_quotes: Object.keys(quoteStartups).length,
    classified_by: startupBySignal,
    pools_with_startup_visits: Object.keys(visitStartups).length,
    startup_quote_without_visits: missingVisits.length,
    startup_visits_without_quote: orphanVisits.length,
    days_per_startup: dayCounts,
    missing_visit_samples: missingVisits,
    orphan_visit_samples: orphanVisits
  };

  // ── 4. Which day was this log? ──────────────────────────────────────────────
  // Day-centric, NOT log-centric. The question the report must answer is "does
  // this scheduled startup day have identifiable evidence?" — so count startup
  // DAYS. Counting logs instead sweeps in every ordinary weekly visit a startup
  // pool has had since, which are normal service, not gaps, and badly inflates
  // the failure rate.
  var logsByPoolDate = {};
  logs.rows.forEach(function (row) {
    var lp = bsrPoolId_(row.pool_id);
    var ld = bsrYmd_(row.timestamp);
    if (!lp || !ld) return;
    var key = lp + '|' + ld;
    if (!logsByPoolDate[key]) logsByPoolDate[key] = [];
    logsByPoolDate[key].push({
      svid:  bsrStr_(row._scheduled_visit_id) || bsrStr_(row._service_visit_id),
      vtype: bsrStr_(row._visit_type),
      tech:  bsrStr_(row.technician)
    });
  });

  var today4 = bsrToday_();
  var dayEvidence = { visit_id: 0, visit_type: 0, date_match: 0, no_log: 0 };
  var noLogSamples = [];
  var pastDays = 0;
  var startupDayDates = {};

  Object.keys(startupVisitsByPool).forEach(function (poolId) {
    startupVisitsByPool[poolId].forEach(function (v) {
      var d = bsrYmd_(v.scheduled_date);
      if (d) startupDayDates[poolId + '|' + d] = true;
      if (bsrVisitStatus_(v) === 'cancelled') return;
      if (!d || d >= today4) return;               // only days that have happened
      pastDays++;
      var here = logsByPoolDate[poolId + '|' + d] || [];
      var svId = bsrStr_(v.scheduled_visit_id);
      if (svId && here.some(function (l) { return l.svid && l.svid === svId; })) { dayEvidence.visit_id++; return; }
      if (here.some(function (l) { return BSR_STARTUP_DAY_RE.test(l.vtype); }))  { dayEvidence.visit_type++; return; }
      if (here.length === 1) { dayEvidence.date_match++; return; }
      dayEvidence.no_log++;
      bsrPush_(noLogSamples, {
        pool_id: poolId, date: d, visit_type: bsrStr_(v.visit_type),
        status: bsrVisitStatus_(v), logs_that_day: here.length,
        technician: bsrStr_(v.assigned_technician)
      });
    });
  });

  // Logs on a startup pool that fall on no scheduled startup day — ordinary
  // weekly service. Reported separately so it can never be read as a gap.
  var otherService = 0;
  Object.keys(logsByPoolDate).forEach(function (key) {
    var poolId = key.split('|')[0];
    if (!quoteStartups[poolId] && !visitStartups[poolId]) return;
    if (startupDayDates[key]) return;
    otherService += logsByPoolDate[key].length;
  });

  audit.log_day_resolution = {
    past_startup_days: pastDays,
    by_signal: dayEvidence,
    identified_pct: pastDays ? Math.round(((pastDays - dayEvidence.no_log) / pastDays) * 1000) / 10 : 0,
    other_service_logs_on_startup_pools: otherService,
    no_log_samples: noLogSamples
  };

  // ── 5. Did the visit close? ─────────────────────────────────────────────────
  // markScheduledVisitCompleted_ is gated on the log carrying a scheduled_visit_id.
  // A tech who opens the service log from the pool dropdown instead of the Jobs
  // card leaves the row 'scheduled' forever. Count how often that has happened.
  var logDatesByPool = {};
  logs.rows.forEach(function (row) {
    var pid = bsrPoolId_(row.pool_id);
    var date = bsrYmd_(row.timestamp);
    if (!pid || !date) return;
    if (!logDatesByPool[pid]) logDatesByPool[pid] = {};
    logDatesByPool[pid][date] = true;
  });

  var today = bsrToday_();
  var unclosed = [];
  var unclosedCount = 0;
  var staleNoLog = 0;
  visits.rows.forEach(function (v) {
    if (bsrVisitStatus_(v) !== 'scheduled') return;
    var date = bsrYmd_(v.scheduled_date);
    if (!date || date >= today) return;
    var pid = bsrPoolId_(v.pool_id);
    if (!pid) return;
    if (logDatesByPool[pid] && logDatesByPool[pid][date]) {
      unclosedCount++;
      bsrPush_(unclosed, {
        pool_id: pid,
        date: date,
        visit_type: bsrStr_(v.visit_type),
        scheduled_visit_id: bsrStr_(v.scheduled_visit_id)
      });
    } else {
      staleNoLog++;
    }
  });

  audit.unclosed_visits = {
    passed_with_matching_log: unclosedCount,
    passed_without_log: staleNoLog,
    note: 'passed_with_matching_log = the WebhookReceiver.js:750 gap — work was done, the row never closed.',
    samples: unclosed
  };

  // ── 6. Do the photos belong here? ───────────────────────────────────────────
  // Jobs.js matches a pool folder with indexOf(pool_id), which has no digit
  // boundary: MCPS-002 would match inside MCPS-0026. Compare that naive match
  // against a boundary-aware one to see whether it is actually biting us.
  var knownPools = {};
  Object.keys(quotePoolIds).forEach(function (p) { knownPools[p] = true; });
  routeRows.rows.forEach(function (r) {
    var pid = bsrPoolId_(r.pool_id);
    if (pid) knownPools[pid] = true;
  });
  visits.rows.forEach(function (v) {
    var pid = bsrPoolId_(v.pool_id);
    if (pid) knownPools[pid] = true;
  });
  var knownList = Object.keys(knownPools);

  var photos = { scanned: 0, matched_one: 0, orphan: 0, ambiguous: 0, naive_overmatch: 0,
                 orphan_samples: [], ambiguous_samples: [], naive_overmatch_samples: [] };
  try {
    var rootIt = DriveApp.getFoldersByName(BSR_PHOTO_ROOT);
    if (!rootIt.hasNext()) {
      photos.error = 'No Drive folder named "' + BSR_PHOTO_ROOT + '" is visible to this script.';
    } else {
      var root = rootIt.next();
      var folderIt = root.getFolders();
      while (folderIt.hasNext()) {
        var folderName = folderIt.next().getName();
        photos.scanned++;

        var strict = knownList.filter(function (pid) {
          return new RegExp(pid.replace(/[-]/g, '\\-') + '(?!\\d)', 'i').test(folderName);
        });
        var naive = knownList.filter(function (pid) {
          return folderName.toUpperCase().indexOf(pid) !== -1;
        });

        if (naive.length > strict.length) {
          photos.naive_overmatch++;
          bsrPush_(photos.naive_overmatch_samples,
                   { folder: folderName, strict: strict, naive: naive });
        }
        if (strict.length === 1)      photos.matched_one++;
        else if (strict.length === 0) { photos.orphan++;    bsrPush_(photos.orphan_samples, folderName); }
        else                          { photos.ambiguous++; bsrPush_(photos.ambiguous_samples,
                                          { folder: folderName, pools: strict }); }
      }
    }
  } catch (e) {
    photos.error = String(e);
  }
  audit.photo_folders = photos;

  // ── 7. Do the startup checklists hold what the visit logs don't? ────────────
  // Startup_Checklists is the one place a technician records equipment state,
  // QC notes and punchlist items — and it already emails the builder a signed
  // PDF. If startup days have no visit logs, this is where the startup story
  // actually lives, so measure its coverage before assuming it must be rebuilt.
  var checklists = { total: 0, technician: 0, pool_school: 0, other: 0,
                     with_qc_notes: 0, with_punchlist: 0, with_items: 0,
                     startup_pools_covered: 0, startup_pools_uncovered: 0,
                     uncovered_samples: [] };
  try {
    var clSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Startup_Checklists');
    var cl = bsrRows_(clSheet);
    var byPool = {};
    cl.rows.forEach(function (r) {
      if (!bsrStr_(r.checklist_id)) return;
      checklists.total++;
      var t = bsrStr_(r.checklist_type).toLowerCase();
      if (t === 'pool_school') checklists.pool_school++;
      else if (t === 'technician' || !t) checklists.technician++;
      else checklists.other++;
      if (bsrStr_(r.qc_notes)) checklists.with_qc_notes++;
      if (bsrStr_(r.punchlist_notes)) checklists.with_punchlist++;
      var items = bsrStr_(r.items_data);
      if (items && items !== '{}') checklists.with_items++;
      var cp = bsrPoolId_(r.pool_id);
      if (cp) byPool[cp] = true;
    });
    Object.keys(visitStartups).forEach(function (poolId) {
      if (byPool[poolId]) checklists.startup_pools_covered++;
      else {
        checklists.startup_pools_uncovered++;
        bsrPush_(checklists.uncovered_samples, poolId);
      }
    });
  } catch (e) {
    checklists.error = String(e);
  }
  audit.startup_checklists = checklists;

  return audit;
}

// ─── Backfill: give every pool a durable builder id ───────────────────────────
//
// Three tiers, and only the first two ever write:
//
//   request    Startup_Requests already links this pool_id to a pool_company_id.
//              Deterministic — the builder submitted it. Safe to write.
//   name_match The quote's startup_company normalises to EXACTLY ONE active
//              Pool_Companies row. Written, and every one is listed so it can be
//              checked afterwards.
//   review     A company name with no match, or more than one. NEVER written.
//              These sit in the review list until a human resolves them.
//
// Dry run by default. Nothing is written unless you pass { dryRun: false }.

function bsrBackfillCompanyIds_(opts) {
  var dryRun = !opts || opts.dryRun !== false;
  var crm = SpreadsheetApp.openById(BSR_CRM_SS_ID);
  var quotesSheet = crm.getSheetByName('Quotes');
  if (!quotesSheet) return { ok: false, error: 'Quotes sheet not found.' };

  var companies = bsrRows_(crm.getSheetByName('Pool_Companies'));
  var requests = bsrRows_(crm.getSheetByName('Startup_Requests'));

  // Only active companies are backfill targets; an inactive one is a review case.
  var byName = {};
  var nameCount = {};
  companies.rows.forEach(function (c) {
    var key = bsrCompanyKey_(c.company_name);
    if (!key) return;
    if (String(c.active == null ? 'TRUE' : c.active).toUpperCase() === 'FALSE') return;
    nameCount[key] = (nameCount[key] || 0) + 1;
    byName[key] = c;
  });

  var idByPoolFromRequest = {};
  requests.rows.forEach(function (r) {
    var poolId = bsrPoolId_(r.pool_id);
    var cid = bsrStr_(r.pool_company_id);
    if (poolId && cid) idByPoolFromRequest[poolId] = cid;
  });

  var headers = quotesSheet.getRange(1, 1, 1, Math.max(1, quotesSheet.getLastColumn()))
    .getValues()[0].map(bsrHeader_);
  var idCol = headers.indexOf('pool_company_id');
  if (idCol === -1) {
    if (dryRun) return { ok: false, error: 'Quotes has no pool_company_id column yet. Run ensureNormalizedSalesSheets_() first, or apply once to create it.' };
    quotesSheet.getRange(1, quotesSheet.getLastColumn() + 1).setValue('pool_company_id');
    headers = quotesSheet.getRange(1, 1, 1, quotesSheet.getLastColumn()).getValues()[0].map(bsrHeader_);
    idCol = headers.indexOf('pool_company_id');
  }
  var poolCol = headers.indexOf('pool_id');
  var nameCol = headers.indexOf('startup_company');
  if (poolCol === -1) return { ok: false, error: 'Quotes has no pool_id column.' };

  var lastRow = quotesSheet.getLastRow();
  if (lastRow < 2) return { ok: true, dry_run: dryRun, written: 0, review: [], by_source: {} };

  var poolVals = quotesSheet.getRange(2, poolCol + 1, lastRow - 1, 1).getValues();
  var nameVals = nameCol === -1 ? null : quotesSheet.getRange(2, nameCol + 1, lastRow - 1, 1).getValues();
  var idVals = quotesSheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();

  var result = { ok: true, dry_run: dryRun, examined: 0, already_linked: 0,
                 by_source: { request: 0, name_match: 0 }, review: [], written_samples: [], changed: 0 };

  for (var i = 0; i < poolVals.length; i++) {
    var poolId = bsrPoolId_(poolVals[i][0]);
    if (!poolId) continue;
    result.examined++;
    if (bsrStr_(idVals[i][0])) { result.already_linked++; continue; }

    var companyName = nameVals ? bsrStr_(nameVals[i][0]) : '';
    var key = bsrCompanyKey_(companyName);

    var cid = idByPoolFromRequest[poolId];
    var source = cid ? 'request' : '';

    if (!cid && key) {
      if (nameCount[key] === 1) { cid = bsrStr_(byName[key].pool_company_id); source = 'name_match'; }
      else if (nameCount[key] > 1) {
        bsrPush_(result.review, { pool_id: poolId, company: companyName, reason: 'name matches ' + nameCount[key] + ' companies' });
        continue;
      } else {
        bsrPush_(result.review, { pool_id: poolId, company: companyName, reason: 'no active Pool_Companies row with this name' });
        continue;
      }
    }
    if (!cid) continue;   // no builder named at all — a direct customer, not a gap

    idVals[i][0] = cid;
    result.by_source[source]++;
    result.changed++;
    bsrPush_(result.written_samples, { pool_id: poolId, company: companyName, pool_company_id: cid, source: source });
  }

  if (!dryRun && result.changed) {
    quotesSheet.getRange(2, idCol + 1, idVals.length, 1).setValues(idVals);
  }
  return result;
}

function bsrBackfillSummary_(r) {
  if (!r.ok) return 'BACKFILL FAILED: ' + r.error;
  var L = [];
  L.push('BUILDER ID BACKFILL — ' + (r.dry_run ? 'DRY RUN, nothing written' : 'APPLIED'));
  L.push('  quote rows with a pool id   ' + r.examined);
  L.push('  already linked              ' + r.already_linked);
  L.push('  linked via Startup_Requests ' + r.by_source.request);
  L.push('  linked via company name     ' + r.by_source.name_match);
  L.push('  ' + (r.dry_run ? 'WOULD write' : 'WROTE') + '                 ' + r.changed);
  L.push('  needs a human               ' + r.review.length);
  if (r.written_samples.length) {
    L.push('');
    L.push('  sample of what ' + (r.dry_run ? 'would be' : 'was') + ' written:');
    r.written_samples.forEach(function (w) {
      L.push('    ' + w.pool_id + '  ' + w.pool_company_id + '  (' + w.source + ')  "' + w.company + '"');
    });
  }
  if (r.review.length) {
    L.push('');
    L.push('  REVIEW — never auto-assigned:');
    r.review.forEach(function (x) { L.push('    ' + x.pool_id + '  "' + x.company + '"  — ' + x.reason); });
  }
  return L.join('\n');
}

// Look first. This writes nothing.
function runBuilderBackfillPreview() {
  var r = bsrBackfillCompanyIds_({ dryRun: true });
  Logger.log(bsrBackfillSummary_(r));
  return r;
}

// Then commit. This writes to the Quotes sheet.
function runBuilderBackfillApply() {
  var r = bsrBackfillCompanyIds_({ dryRun: false });
  Logger.log(bsrBackfillSummary_(r));
  return r;
}

// ─── Readable summary ─────────────────────────────────────────────────────────

function bsrAuditSummary_(a) {
  var L = [];
  var pct = function (n, d) { return d ? Math.round((n / d) * 100) + '%' : '—'; };

  L.push('BUILDER REPORT AUDIT — ' + a.today);
  L.push('');
  L.push('Source rows: ' + JSON.stringify(a.source_counts));
  L.push('');

  L.push('1. WHOSE POOL IS THIS?');
  L.push('   ' + a.builder_link.note);
  var b = a.builder_link.buckets;
  var totalPools = b.linked + b.name_match + b.named_no_company + b.no_builder;
  L.push('   linked (durable id)   ' + b.linked + '  ' + pct(b.linked, totalPools));
  L.push('   name_match only       ' + b.name_match + '  ' + pct(b.name_match, totalPools));
  L.push('   named, no company row ' + b.named_no_company);
  L.push('   no builder named      ' + b.no_builder);
  if (a.builder_link.named_no_company_samples.length) {
    L.push('   → company names with no Pool_Companies row:');
    a.builder_link.named_no_company_samples.forEach(function (s) {
      L.push('     ' + s.pool_id + '  "' + s.company + '"  (' + s.customer + ')');
    });
  }
  L.push('');

  L.push('2. IS THE POOL ID UNIQUE?');
  L.push('   pools with >1 quote            ' + a.duplicate_pool_ids.pools_with_multiple_quotes);
  L.push('   pool ids on TWO customers     ' + a.duplicate_pool_ids.conflicting +
         (a.duplicate_pool_ids.conflicting ? '   ← must be fixed before any report' : '   ✓'));
  a.duplicate_pool_ids.samples.forEach(function (s) {
    L.push('     ' + s.pool_id + '  →  ' + s.customers.join('  |  '));
  });
  L.push('');

  L.push('3. IS THIS A STARTUP?');
  var s3 = a.startup_identification;
  L.push('   startup quotes                ' + s3.startup_quotes +
         '   (service_key=' + s3.classified_by.service_key +
         ', free-text label only=' + s3.classified_by.service_label + ')');
  L.push('   pools with startup_day_* rows  ' + s3.pools_with_startup_visits);
  L.push('   startup quote, no visits       ' + s3.startup_quote_without_visits);
  L.push('   startup visits, no quote       ' + s3.startup_visits_without_quote);
  L.push('   days per startup (count → pools): ' + JSON.stringify(s3.days_per_startup));
  if (s3.missing_visit_samples.length) L.push('     no visits: ' + s3.missing_visit_samples.join(', '));
  if (s3.orphan_visit_samples.length)  L.push('     no quote:  ' + s3.orphan_visit_samples.join(', '));
  L.push('');

  L.push('4. DOES EACH STARTUP DAY HAVE EVIDENCE?');
  var r = a.log_day_resolution;
  L.push('   startup days already past  ' + r.past_startup_days);
  L.push('   evidence via visit id      ' + r.by_signal.visit_id + '  ' + pct(r.by_signal.visit_id, r.past_startup_days));
  L.push('   evidence via visit type    ' + r.by_signal.visit_type + '  ' + pct(r.by_signal.visit_type, r.past_startup_days));
  L.push('   evidence via date alone    ' + r.by_signal.date_match + '  ' + pct(r.by_signal.date_match, r.past_startup_days));
  L.push('   NO LOG AT ALL              ' + r.by_signal.no_log + '  ' + pct(r.by_signal.no_log, r.past_startup_days) + '   <- report must stay silent about these');
  L.push('   identifiable overall       ' + r.identified_pct + '%');
  L.push('   (ordinary weekly logs on startup pools, NOT a gap: ' + r.other_service_logs_on_startup_pools + ')');
  r.no_log_samples.forEach(function (u) {
    L.push('     ' + u.pool_id + '  ' + u.date + '  ' + u.visit_type +
           '  status=' + u.status + '  tech=' + (u.technician || '-'));
  });
  L.push('');
  L.push('5. DID THE VISIT CLOSE?');
  L.push('   passed date, still "scheduled", HAS a log  ' + a.unclosed_visits.passed_with_matching_log +
         '   ← the WebhookReceiver.js:750 gap');
  L.push('   passed date, still "scheduled", no log     ' + a.unclosed_visits.passed_without_log);
  a.unclosed_visits.samples.forEach(function (u) {
    L.push('     ' + u.pool_id + '  ' + u.date + '  ' + u.visit_type);
  });
  L.push('');

  L.push('6. DO THE PHOTOS BELONG HERE?');
  var p = a.photo_folders;
  if (p.error) {
    L.push('   ' + p.error);
  } else {
    L.push('   folders scanned        ' + p.scanned);
    L.push('   match exactly one pool ' + p.matched_one);
    L.push('   match NO pool          ' + p.orphan);
    L.push('   match MORE than one    ' + p.ambiguous);
    L.push('   naive indexOf overmatches ' + p.naive_overmatch +
           (p.naive_overmatch ? '   ← Jobs.js photo lookup is picking up the wrong pool' : '   ✓'));
    p.orphan_samples.forEach(function (f) { L.push('     orphan: ' + f); });
    p.ambiguous_samples.forEach(function (f) { L.push('     ambiguous: ' + f.folder + '  → ' + f.pools.join(', ')); });
    p.naive_overmatch_samples.forEach(function (f) {
      L.push('     overmatch: ' + f.folder + '  strict=' + f.strict.join(',') + '  naive=' + f.naive.join(','));
    });
  }
  L.push('7. DO THE STARTUP CHECKLISTS COVER THE GAP?');
  var c = a.startup_checklists;
  if (c.error) {
    L.push('   ' + c.error);
  } else {
    L.push('   checklists on file       ' + c.total +
           '   (technician ' + c.technician + ', pool school ' + c.pool_school + ')');
    L.push('   with QC notes            ' + c.with_qc_notes);
    L.push('   with punchlist notes     ' + c.with_punchlist);
    L.push('   with checklist items     ' + c.with_items);
    L.push('   startup pools WITH one   ' + c.startup_pools_covered);
    L.push('   startup pools WITHOUT    ' + c.startup_pools_uncovered);
    if (c.uncovered_samples.length) L.push('     ' + c.uncovered_samples.join(', '));
  }
  L.push('');
  L.push('(Sample lists are capped at ' + BSR_SAMPLE_CAP + '; the counts above are complete.)');

  return L.join('\n');
}

// ─── Entry point ──────────────────────────────────────────────────────────────
// Run this from the Apps Script editor. It reads; it never writes.

function runBuilderReportAudit() {
  var audit = bsrAudit_();
  var summary = bsrAuditSummary_(audit);
  Logger.log(summary);
  return { ok: true, summary: summary, audit: audit };
}
