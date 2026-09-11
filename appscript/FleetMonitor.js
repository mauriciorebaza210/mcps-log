// ══════════════════════════════════════════════════════════════════════════════
// FleetMonitor.gs — the `fleet_monitor_data` read action.
//
// Powers /monitor, a read-only fleet board for admin/manager that polls every
// 60 seconds. For every in-scope pool it returns the last 12 visits' chemistry
// in a positional wire format.
//
// Scope = active weekly customers (Routes) + pools currently in startup
//         (Scheduled_Visits — startups often have NO Routes row at all; see
//          addStartupPoolToRoutes_ in SalesHub.js, which despite its name
//          creates only Scheduled_Visits rows).
//
// ── Two decisions worth knowing before you edit this file ────────────────────
//
// 1. Chemistry comes from Chemical_Usage_Log, NOT Usage_Priced.
//    Usage_Priced lags a submitted visit by at least 75s: snapshotUsageToPriced_
//    runs only from the deferred processPendingSvcJobs_ trigger created at
//    WebhookReceiver.js `.after(75000)`, and that job additionally defers
//    anything younger than MIN_AGE_MS. That delay is deliberately the
//    technician's undo window. A 60s-polled board built on it would always be a
//    cycle and a half behind.
//
// 2. Scope gates on NEGATIVE route_status values, not `=== 'active'`.
//    The live signing path writes 'weekly'; RouteManager writes 'weekly' or '';
//    only RouteData's self-heal ever writes 'active'. Filtering for 'active'
//    would return almost nothing. This mirrors how Jobs.js and Reschedule.js
//    already decide what is on route.
//
// Cache: FM_CACHE_KEY, 300s. Every mutation that changes a visit row or a
// pool's scope must call fleetMonInvalidate_() — see the list on that function.
// ══════════════════════════════════════════════════════════════════════════════

const FM_ROUTES_SS_ID    = '1cXDjTSO1XmbXZFEAf6tctDdL0_Oijt__axmI-9ZBENM';
const FM_CACHE_KEY       = 'fleet_mon:v1';
const FM_CACHE_TTL       = 300;      // seconds
const FM_CACHE_MAX_BYTES = 90000;    // stay clear of the 100KB CacheService ceiling
const FM_VISITS          = 12;       // last N visits per pool
const FM_PROVISIONAL_MS  = 75000;    // matches the .after(75000) undo window
const FM_LOOKBACK_MS     = 20 * 7 * 86400000;  // 20 weeks — terminates the tail read

// Chemistry columns in wire order. `legacy` is resolved PER ROW, not per sheet:
// both columns coexist and older rows populate only the legacy one.
const FM_READINGS = [
  { h: 'Free Chlorine (FC)',    legacy: 'Chlorine (Cl)' },
  { h: 'pH' },
  { h: 'Total Alkalinity (TA)' },
  { h: 'Calcium Hardness (CH)' },
  { h: 'Cyanuric Acid (CYA)' },
  { h: 'Salt Level' }
];

const FM_WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

// ─── small helpers ────────────────────────────────────────────────────────────

function fmStr_(v) { return String(v === null || v === undefined ? '' : v).trim(); }

// Cells are often typed as text, so coerce rather than trusting getValues().
function fmNum_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = (typeof v === 'number') ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : null;
}

function fmMs_(v) {
  if (v instanceof Date) { const t = v.getTime(); return isNaN(t) ? 0 : t; }
  const s = fmStr_(v);
  if (!s) return 0;
  const t = new Date(s).getTime();
  return isNaN(t) ? 0 : t;
}

// pool_id in Chemical_Usage_Log may hold the verbose dropdown label
// ("MCPS-0007 - Dave Libby") because extractPoolId_ normalizes at snapshot time,
// not at write time. Normalize both sides before comparing, as Payroll.js does.
function fmPid_(v) {
  const s = fmStr_(v);
  const m = s.match(/(MCPS-\d{4,})/i);
  return m ? m[1].toUpperCase() : s.toUpperCase();
}

// String interning — every repeated name becomes a small int on the wire.
function fmDict_() {
  const list = [], idx = {};
  return {
    list: list,
    id: function (v) {
      const s = fmStr_(v);
      if (s === '') return -1;
      if (Object.prototype.hasOwnProperty.call(idx, s)) return idx[s];
      idx[s] = list.length;
      list.push(s);
      return idx[s];
    }
  };
}

// FNV-1a. Used for meta_rev: metadata edits never move a visit timestamp, so
// `since` alone cannot detect them.
function fmHash_(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function fmFields_() {
  return ['t','k','fc','ph','ta','ch','cya','salt','tab','cost','prov'];
}

function fmDicts_(d) {
  return {
    techs: d.techs.list, cities: d.cities.list, services: d.svcs.list,
    statuses: d.stats.list, sizes: d.sizes.list, materials: d.mats.list,
    tabs: d.tabs.list
  };
}

// ─── entry point ──────────────────────────────────────────────────────────────

function handleFleetMonitorData_(params) {
  params = params || {};

  const cache = CacheService.getScriptCache();
  let snap = null;
  try {
    const hit = cache.get(FM_CACHE_KEY);
    if (hit) snap = JSON.parse(hit);
  } catch (e) { snap = null; }

  if (!snap || String(params.refresh || '') === '1') {
    snap = fleetMonCompute_(String(params.cost || '') !== '0');
    if (!snap.ok) return snap;
    try {
      const blob = JSON.stringify(snap);
      if (blob.length <= FM_CACHE_MAX_BYTES) {
        cache.put(FM_CACHE_KEY, blob, FM_CACHE_TTL);
      } else {
        // CacheService.put throws silently past 100KB and the caller just logs,
        // which degrades into "every poll is a cold recompute" with no visible
        // error. Make that condition legible instead.
        Logger.log('fleet_monitor_data: payload ' + blob.length +
                   'B exceeds cache budget - serving uncached');
      }
    } catch (e) {
      Logger.log('fleet_monitor_data cache put failed: ' + e);
    }
  }

  // ── delta negotiation — an in-memory filter over the cached snapshot, no
  //    extra sheet reads ────────────────────────────────────────────────────
  const since = parseInt(params.since, 10) || 0;
  const mrev  = parseInt(params.mrev, 10) || 0;
  const metaStale = (mrev !== 0 && mrev !== snap.meta_rev);

  if (since > 0 && !metaStale && since >= snap.floor) {
    const changed = [];
    for (let i = 0; i < snap.pools.length; i++) {
      const p = snap.pools[i];
      // Provisional pools are always re-sent: cancel_service_log deletes the
      // row outright, so a visit shown 30s ago can simply vanish.
      if (p.mx > since || p.prov === 1) changed.push(p);
    }
    return {
      ok: true, mode: 'delta', gen: snap.gen, since: snap.gen,
      meta_rev: snap.meta_rev, pools: changed
    };
  }

  return {
    ok: true, mode: 'full', gen: snap.gen, since: snap.gen,
    meta_rev: snap.meta_rev, fields: snap.fields, dict: snap.dict,
    pools: snap.pools
  };
}

// ─── snapshot builder ─────────────────────────────────────────────────────────

function fleetMonCompute_(wantCost) {
  const now = Date.now();
  const d = {
    techs: fmDict_(), cities: fmDict_(), svcs: fmDict_(), stats: fmDict_(),
    sizes: fmDict_(), mats: fmDict_(), tabs: fmDict_()
  };

  const pools = {};
  const order = [];

  // ── 1. Routes + Scheduled_Visits — ONE openById, both sheets live in it ────
  const rss    = SpreadsheetApp.openById(FM_ROUTES_SS_ID);
  const rSheet = rss.getSheetByName('Routes');
  const rData  = (rSheet && rSheet.getLastRow() >= 2) ? rSheet.getDataRange().getValues() : [];
  const rH     = rData.length
    ? rData[0].map(function (h) { return fmStr_(h).toLowerCase().replace(/ /g, '_'); })
    : [];
  const rv = function (row, name) {
    const i = rH.indexOf(name);
    return (i === -1 || !row) ? '' : fmStr_(row[i]);
  };

  const routesByPool = {};
  for (let i = 1; i < rData.length; i++) {
    const row = rData[i];
    const pid = fmPid_(rv(row, 'pool_id'));
    if (!pid) continue;
    routesByPool[pid] = row;

    const status = rv(row, 'route_status').toLowerCase();
    const svc    = rv(row, 'service');
    const day    = rv(row, 'day_of_week');

    // Negative gates only — see the header note on why '=== active' is wrong.
    if (status === 'inactive' || status === 'startup_complete') continue;
    if (status === 'gtc') continue;                                  // G2C is out of scope
    if (status === 'startup') continue;                              // caught below via Scheduled_Visits
    if (svc.toLowerCase().indexOf('startup') !== -1) continue;
    if (!day || day.toUpperCase() === 'UNSCHEDULED') continue;

    pools[pid] = {
      id: pid,
      n:  rv(row, 'customer_name'),
      a:  rv(row, 'address'),
      ci: d.cities.id(rv(row, 'city')),
      sv: d.svcs.id(svc),
      rs: d.stats.id(status),
      d:  FM_WEEKDAYS.indexOf(day),
      op: d.techs.id(rv(row, 'operator')),
      sz: -1, mt: -1,
      sc: 0,              // 0 = weekly, 1 = startup
      mx: 0, prov: 0,
      v: []
    };
    order.push(pid);
  }

  // 1b. Scheduled_Visits — the startup scope.
  const svSheet = rss.getSheetByName('Scheduled_Visits');
  if (svSheet && svSheet.getLastRow() >= 2) {
    const svLastCol = svSheet.getLastColumn();
    const svH = svSheet.getRange(1, 1, 1, svLastCol).getValues()[0]
      .map(function (h) { return fmStr_(h).toLowerCase().replace(/ /g, '_'); });

    // Narrow to the span covering the columns we need, falling back to full
    // width if the header has drifted from SV_HEADERS.
    const want = ['pool_id','customer_name','service_type','visit_type',
                  'scheduled_date','assigned_technician','status'];
    let lo = svLastCol, hi = 1, ok = true;
    want.forEach(function (w) {
      const i = svH.indexOf(w);
      if (i === -1) { ok = false; return; }
      lo = Math.min(lo, i + 1);
      hi = Math.max(hi, i + 1);
    });
    if (!ok) { lo = 1; hi = svLastCol; }

    const svRows = svSheet.getRange(2, lo, svSheet.getLastRow() - 1, hi - lo + 1).getValues();
    const sv = function (row, name) {
      const i = svH.indexOf(name) - (lo - 1);
      return (i < 0 || !row) ? '' : fmStr_(row[i]);
    };

    const startupState = {};
    for (let s = 0; s < svRows.length; s++) {
      const row = svRows[s];
      if (!/^startup_day_[123]$/.test(sv(row, 'visit_type'))) continue;
      const st = sv(row, 'status').toLowerCase();
      if (st === 'cancelled' || st === 'removed') continue;

      const pid = fmPid_(sv(row, 'pool_id'));
      if (!pid) continue;

      if (!startupState[pid]) startupState[pid] = { total: 0, done: 0, row: row };
      startupState[pid].total++;
      if (st === 'completed') startupState[pid].done++;
    }

    Object.keys(startupState).forEach(function (pid) {
      const s = startupState[pid];
      const finished = s.done >= s.total;

      // Already has a Routes row: either mid-startup and also tracked there, or
      // already converted to weekly. Either way it's already in `pools` with the
      // right scope from the Routes pass above — nothing to add.
      if (pools[pid]) { if (!finished) pools[pid].sc = 1; return; }

      // No Routes row. Startups usually have none at all while in progress
      // (addStartupPoolToRoutes_ creates only Scheduled_Visits rows), so address
      // and city may be blank here — that's expected, not a bug.
      //
      // sc: 2 = "startup complete, not yet converted to a weekly route." This is
      // the pool most likely to quietly become a lost customer: its 3 startup
      // visits are done, so it no longer shows up as an active startup, but
      // nobody has converted it to a weekly route yet either. Earlier this
      // handler dropped these pools entirely once `finished` was true — they
      // vanished from the board with no signal. They must stay visible.
      const rr = routesByPool[pid] || null;
      pools[pid] = {
        id: pid,
        n:  sv(s.row, 'customer_name') || rv(rr, 'customer_name'),
        a:  rv(rr, 'address'),
        ci: d.cities.id(rv(rr, 'city')),
        sv: d.svcs.id(sv(s.row, 'service_type') || 'Pool Startup'),
        rs: d.stats.id(rv(rr, 'route_status') || (finished ? 'startup_complete' : 'startup')),
        d:  FM_WEEKDAYS.indexOf(rv(rr, 'day_of_week')),
        op: d.techs.id(sv(s.row, 'assigned_technician') || rv(rr, 'operator')),
        sz: -1, mt: -1,
        sc: finished ? 2 : 1,
        mx: 0, prov: 0,
        v: []
      };
      order.push(pid);
    });
  }

  if (!order.length) return fleetMonFinish_(order, pools, d, now);

  // ── 2. Chemical_Usage_Log — trailing rows only ────────────────────────────
  // The sheet is strictly append-ordered by Timestamp and never pruned, so the
  // newest 12 visits per pool always sit in a bounded tail. A full
  // getDataRange() here is the dominant cost and degrades linearly forever.
  const ss  = SpreadsheetApp.getActiveSpreadsheet();   // bound SS — opens nothing
  const log = ss.getSheetByName('Chemical_Usage_Log');
  if (!log || log.getLastRow() < 2) return fleetMonFinish_(order, pools, d, now);

  const lastRow = log.getLastRow();
  const lastCol = log.getLastColumn();
  // submitCustomForm appends a column for any unseen payload key, so column
  // positions shift over time. Always resolve by header name.
  const H  = log.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return fmStr_(h); });
  const ix = function (name) { return H.indexOf(name); };

  const iTs   = ix('Timestamp');
  const iPid  = ix('pool_id');
  const iTech = ix('Technician');
  const iTab  = ix('Tablet Level');
  const iSize = ix('Pool Size');
  const iMat  = ix('Pool Material');
  // applyVoid appends Voided/Voided_At/Voided_By/Void_Reason at getLastColumn()+1
  // on first use, so this sits past the chemistry block at a variable index.
  // Voided rows are flagged, NOT deleted — missing this filter silently shows
  // voided visits on the board.
  const iVoid = ix('Voided');

  const iRead = FM_READINGS.map(function (r) {
    return { cur: ix(r.h), leg: r.legacy ? ix(r.legacy) : -1 };
  });

  // Live chemical cost. buildPriceMap_ is a narrow read over Chem_Costs (~15
  // rows) — cheaper than reading Usage_Priced, and it stays current. Note this
  // uses TODAY's prices where Usage_Priced froze them at snapshot time, so it
  // will not reconcile to the margins report to the cent. Pass cost=0 to skip.
  let priceCols = [];
  if (wantCost) {
    try {
      const pm = buildPriceMap_();
      Object.keys(pm).forEach(function (name) {
        const c = ix(name);
        if (c !== -1) priceCols.push({ c: c, u: pm[name] });
      });
    } catch (e) {
      Logger.log('fleet_monitor_data price map: ' + e);
      priceCols = [];
    }
  }

  // Window sizing. The terminator is a TIME cutoff, not "every pool has 12" —
  // startups and new pools never reach 12 and that condition would walk the
  // whole sheet.
  const cutoff = now - FM_LOOKBACK_MS;
  let cursor = lastRow;
  let block  = Math.min(1500, Math.max(400, Math.ceil(order.length * FM_VISITS * 2.2)));
  let reads  = 0;

  while (cursor >= 2 && reads < 3) {
    const start = Math.max(2, cursor - block + 1);
    const rows  = log.getRange(start, 1, cursor - start + 1, lastCol).getValues();
    reads++;

    let oldest = 0;
    for (let r = rows.length - 1; r >= 0; r--) {        // newest -> oldest
      const row = rows[r];

      if (iVoid !== -1 && fmStr_(row[iVoid]).toLowerCase() === 'yes') continue;

      const ts = fmMs_(row[iTs]);
      if (!ts) continue;
      if (!oldest || ts < oldest) oldest = ts;

      const pid = fmPid_(iPid === -1 ? '' : row[iPid]);
      const p = pools[pid];
      if (!p || p.v.length >= FM_VISITS) continue;

      const vals = iRead.map(function (r2) {
        let v = (r2.cur === -1) ? null : fmNum_(row[r2.cur]);
        if (v === null && r2.leg !== -1) v = fmNum_(row[r2.leg]);
        return v;
      });

      let cost = null;
      if (priceCols.length) {
        let t = 0;
        for (let k = 0; k < priceCols.length; k++) {
          const q = fmNum_(row[priceCols[k].c]);
          if (q) t += q * priceCols[k].u;
        }
        cost = Math.round(t * 100) / 100;
      }

      const rec = [
        Math.floor(ts / 1000),
        (iTech === -1) ? -1 : d.techs.id(row[iTech]),
        vals[0], vals[1], vals[2], vals[3], vals[4], vals[5],
        (iTab === -1) ? -1 : d.tabs.id(row[iTab]),
        cost
      ];
      // Trailing slot present only when the row is still inside the undo window.
      if ((now - ts) < FM_PROVISIONAL_MS) { rec.push(1); p.prov = 1; }

      p.v.push(rec);
      if (Math.floor(ts / 1000) > p.mx) p.mx = Math.floor(ts / 1000);

      // Rows arrive newest-first, so the first non-empty value is the latest.
      if (p.sz === -1 && iSize !== -1 && fmStr_(row[iSize])) p.sz = d.sizes.id(row[iSize]);
      if (p.mt === -1 && iMat  !== -1 && fmStr_(row[iMat]))  p.mt = d.mats.id(row[iMat]);
    }

    if (oldest && oldest < cutoff) break;
    if (start <= 2) break;
    cursor = start - 1;
    block *= 2;
  }

  return fleetMonFinish_(order, pools, d, now);
}

function fleetMonFinish_(order, pools, d, now) {
  const out = [];
  let floor = 0;
  const metaBits = [];

  for (let i = 0; i < order.length; i++) {
    const p = pools[order[i]];
    if (!p) continue;
    out.push(p);
    if (p.mx && (!floor || p.mx < floor)) floor = p.mx;
    metaBits.push([p.id, p.n, p.a, p.ci, p.sv, p.rs, p.d, p.op, p.sc].join('|'));
  }

  out.sort(function (a, b) { return (b.mx || 0) - (a.mx || 0); });

  return {
    ok: true,
    gen: Math.floor(now / 1000),
    floor: floor,
    meta_rev: fmHash_(metaBits.join('\n')),
    fields: fmFields_(),
    dict: fmDicts_(d),
    pools: out
  };
}

// ─── invalidation ─────────────────────────────────────────────────────────────
// Call from every mutation that changes a visit row, or a pool's scope or
// metadata. Missing one leaves the board stale for up to FM_CACHE_TTL.
//
//   Visit data (Chemical_Usage_Log):
//     submit_form            — row is live immediately, so the board can show it
//     cancel_service_log     — row is DELETED outright
//     void_service_log       — row is flagged Voided=yes, not deleted
//     applyCorrection        — Corrections.js
//     resolveUnmatchedSubmission — UnmatchedSubmissions.js
//   Scope / metadata (Routes, Scheduled_Visits):
//     bustScheduledVisitRouteCache_ — ScheduledVisits.js, the single chokepoint
//                                     for every Scheduled_Visits mutation
//     movePoolThisWeek, convertStartupToWeekly, markStartupComplete — RouteData.js
//     handleConvertStartupToMaintenance — Jobs.js
//     save_quote (new pool onto Routes) — SalesHub.js
function fleetMonInvalidate_() {
  try { CacheService.getScriptCache().remove(FM_CACHE_KEY); } catch (e) {}
}
