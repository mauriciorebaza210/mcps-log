// ─────────────────────────────────────────────────────────────────────────────
// Fleet Monitor — data layer.
//
// Owns the session gate, the fetch/poll/delta-merge cycle against
// fleet_monitor_data, and the localStorage instant-paint snapshot. Nothing here
// touches the board's DOM directly — it calls monBoardRender(changedIds) and
// monBoardSetLive(state) and leaves rendering to monitor-board.js.
// ─────────────────────────────────────────────────────────────────────────────

const MON_POLL_MS   = 60000;
const MON_SNAP_KEY   = 'mcps_monitor_snap';
const MON_WATCH_KEY  = 'mcps_monitor_watch';

// Global state. `pools` is a Map keyed by pool_id holding the RAW server record
// (id,n,a,ci,sv,rs,d,op,sz,mt,sc,mx,prov,v) plus derived fields computed by
// monDerive() each time a pool's data changes.
const MON = {
  pools: new Map(),
  dict: { techs: [], cities: [], services: [], statuses: [], sizes: [], materials: [], tabs: [] },
  gen: 0,
  metaRev: 0,
  loaded: false,
  pollTimer: null,
  pollDue: 0,
  watch: new Set(),
  alerts: new Map()   // pool_id -> [open Issues_Alerts rows]
};

// ── session gate ───────────────────────────────────────────────────────────
function monSession_() {
  try {
    const raw = localStorage.getItem('mcps_s');
    if (!raw) return null;
    const s = JSON.parse(raw);
    return (s && s.token) ? s : null;
  } catch (e) { return null; }
}

function monGateFail_(title, msg, showLogin) {
  document.getElementById('gate-title').textContent = title;
  const msgEl = document.getElementById('gate-msg');
  msgEl.textContent = msg;
  if (showLogin) {
    const a = document.createElement('a');
    a.className = 'mon-btn'; a.href = '/'; a.textContent = 'Go to portal';
    msgEl.after(a);
  }
}

// ── watchlist (persisted client-side, per-browser) ──────────────────────────
function monLoadWatch_() {
  try {
    const raw = localStorage.getItem(MON_WATCH_KEY);
    MON.watch = new Set(raw ? JSON.parse(raw) : []);
  } catch (e) { MON.watch = new Set(); }
}
function monSaveWatch_() {
  try { localStorage.setItem(MON_WATCH_KEY, JSON.stringify(Array.from(MON.watch))); } catch (e) {}
}
function monToggleWatch(poolId) {
  if (MON.watch.has(poolId)) MON.watch.delete(poolId); else MON.watch.add(poolId);
  monSaveWatch_();
  const p = MON.pools.get(poolId);
  if (p) p.derived.watched = MON.watch.has(poolId);
}

// ── snapshot (instant paint on reload) ──────────────────────────────────────
function monSaveSnapshot_() {
  try {
    const pools = {};
    MON.pools.forEach((p, id) => { pools[id] = monStrip_(p); });
    localStorage.setItem(MON_SNAP_KEY, JSON.stringify({
      ts: Date.now(), gen: MON.gen, metaRev: MON.metaRev, dict: MON.dict, pools
    }));
  } catch (e) { /* storage full or unavailable — instant paint just won't have data */ }
}

// Strip derived fields before persisting; they're cheap to recompute and this
// keeps the snapshot from drifting out of sync with monDerive()'s logic.
function monStrip_(p) {
  return { id: p.id, n: p.n, a: p.a, ci: p.ci, sv: p.sv, rs: p.rs, d: p.d,
           op: p.op, sz: p.sz, mt: p.mt, sc: p.sc, mx: p.mx, prov: p.prov, v: p.v };
}

function monLoadSnapshot_() {
  try {
    const raw = localStorage.getItem(MON_SNAP_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw);
    if (!snap || !snap.pools) return false;
    MON.dict = snap.dict || MON.dict;
    MON.gen = snap.gen || 0;
    MON.metaRev = snap.metaRev || 0;
    Object.keys(snap.pools).forEach(id => {
      const p = snap.pools[id];
      p.derived = monDerive(p);
      MON.pools.set(id, p);
    });
    return true;
  } catch (e) { return false; }
}

// ── deriving display data from a raw pool record ────────────────────────────
// Converts the positional wire format into the shape monBand/monScore/etc.
// (monitor-chem.js) expect, then computes everything the board renders.
function monVisitToReadings_(v) {
  return {
    'Free Chlorine (FC)': v[2], 'pH': v[3], 'Total Alkalinity (TA)': v[4],
    'Calcium Hardness (CH)': v[5], 'Cyanuric Acid (CYA)': v[6], 'Salt Level': v[7]
  };
}

function monDerive(p) {
  const visits = (p.v || []).map(v => ({
    date: new Date(v[0] * 1000),
    tech: v[1] >= 0 ? MON.dict.techs[v[1]] : '',
    readings: monVisitToReadings_(v),
    tab: v[8] >= 0 ? MON.dict.tabs[v[8]] : '',
    cost: v[9],
    provisional: v.length > 10 && v[10] === 1
  }));

  const latest = visits[0] || null;
  const prior  = visits[1] || null;
  const score  = latest ? monScore(latest.readings) : null;
  const priorScore = prior ? monScore(prior.readings) : null;
  const delta  = (score !== null && priorScore !== null) ? Math.round((score - priorScore) * 10) / 10 : null;
  const status = latest ? monStatus(latest.readings) : 'nodata';
  const lsi    = latest ? monLSI(latest.readings, latest.date) : null;
  const forecast = monSoonestForecast(visits);
  const daysAgo = latest ? monDaysAgo(latest.date) : null;

  return {
    name: p.n || p.id,
    address: p.a || '',
    city: MON.dict.cities[p.ci] || '',
    service: MON.dict.services[p.sv] || '',
    status_raw: MON.dict.statuses[p.rs] || '',
    weekday: p.d,
    operator: p.op >= 0 ? MON.dict.techs[p.op] : '',
    size: p.sz >= 0 ? MON.dict.sizes[p.sz] : '',
    material: p.mt >= 0 ? MON.dict.materials[p.mt] : '',
    lifecycle: p.sc === 2 ? 'convert' : (p.sc === 1 ? 'startup' : 'active'),
    isStartup: p.sc === 1,
    needsConversion: p.sc === 2,
    alerts: MON.alerts.get(p.id) || [],
    provisional: p.prov === 1,
    visits: visits,
    latest: latest,
    score: score,
    delta: delta,
    status: status,
    lsi: lsi,
    forecast: forecast,
    daysAgo: daysAgo,
    watched: MON.watch.has(p.id)
  };
}

// ── open issue alerts ───────────────────────────────────────────────────────
// Reuses the existing Issues_Alerts feed rather than inventing a parallel one,
// so anything flagged here shows up in the portal's Alerts page too. Fetched on
// load and after any write — not on every 60s poll, since alerts change far
// less often than chemistry and each poll costs GAS quota.
function monFetchAlerts_() {
  return apiGet({ action: 'get_issue_alerts' }).then(res => {
    if (!res || !res.ok) return;
    const byPool = new Map();
    (res.alerts || []).forEach(a => {
      const pid = String(a.linked_pool_id || '').trim().toUpperCase();
      if (!pid) return;
      if (!byPool.has(pid)) byPool.set(pid, []);
      byPool.get(pid).push(a);
    });
    MON.alerts = byPool;
    MON.pools.forEach(p => { if (p.derived) p.derived.alerts = byPool.get(p.id) || []; });
  }).catch(() => { /* alerts are supplementary — never block the board on them */ });
}

// Flag a pool for follow-up. Writes a real Issues_Alerts row via the existing
// submit_issue_alert action, so it lands in the portal's Alerts page as well.
function monFlagPool(poolId, message) {
  return api({
    action: 'submit_issue_alert',
    type: 'issue',
    message: message,
    visibility: 'admin_only',
    linked_pool_id: poolId
  }).then(res => {
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not save the flag.');
    return monFetchAlerts_();
  });
}

// Resolve an open alert from the board, via the existing resolve_issue_alert.
function monResolveAlert(alertId) {
  return api({ action: 'resolve_issue_alert', id: alertId }).then(res => {
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not resolve.');
    return monFetchAlerts_();
  });
}

function monRebuildAll_() {
  MON.pools.forEach(p => { p.derived = monDerive(p); });
}

// ── fetch + merge ────────────────────────────────────────────────────────────
function monFetch_(isInitial) {
  const session = monSession_();
  if (!session) return Promise.reject(new Error('no-session'));

  const params = { action: 'fleet_monitor_data', cost: '0' };
  if (!isInitial && MON.gen) { params.since = MON.gen; params.mrev = MON.metaRev; }

  return apiGet(params).then(res => {
    if (!res || !res.ok) {
      const err = new Error((res && res.error) || 'Request failed');
      err.code = res && res.error;
      throw err;
    }

    const changed = [];
    if (res.mode === 'full') {
      MON.dict = res.dict || MON.dict;
      MON.pools.clear();
      (res.pools || []).forEach(p => {
        p.derived = monDerive(p);
        MON.pools.set(p.id, p);
        changed.push(p.id);
      });
    } else {
      (res.pools || []).forEach(p => {
        p.derived = monDerive(p);
        MON.pools.set(p.id, p);
        changed.push(p.id);
      });
    }
    MON.gen = res.gen;
    MON.metaRev = res.meta_rev;
    MON.loaded = true;
    monSaveSnapshot_();
    return { mode: res.mode, changed };
  });
}

function monPoll_() {
  if (document.hidden) return;
  monFetch_(false).then(result => {
    monBoardSetLive(true);
    monBoardRender(result.changed);
  }).catch(err => {
    // A transient network hiccup shouldn't tear down the board — keep showing
    // the last good data and just flag it as stale.
    monBoardSetLive(false);
    if (err.code === 'Unauthorized' || err.code === 'Admin access required.') {
      monStopPolling();
      monGateFail_('Session expired', 'Sign back in to the portal, then reopen this page.', true);
      document.getElementById('gate').hidden = false;
      document.getElementById('app').hidden = true;
    }
  });
}

function monStartPolling() {
  monStopPolling();
  MON.pollTimer = setInterval(monPoll_, MON_POLL_MS);
}
function monStopPolling() {
  if (MON.pollTimer) { clearInterval(MON.pollTimer); MON.pollTimer = null; }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && MON.loaded) monPoll_();  // refetch immediately on refocus
});

// ── boot ─────────────────────────────────────────────────────────────────────
function monInit() {
  monLoadWatch_();

  const session = monSession_();
  if (!session) {
    monGateFail_('Sign in required', 'Open the MCPS portal and sign in, then come back to this page.', true);
    return;
  }

  // Instant paint from whatever we had last time, before the network even starts.
  const hadSnapshot = monLoadSnapshot_();
  if (hadSnapshot) {
    document.getElementById('gate').hidden = true;
    document.getElementById('app').hidden = false;
    monBoardInit();
    monBoardRender(Array.from(MON.pools.keys()));
    monBoardSetLive(false); // dim until live data confirms it
  } else {
    monGateFail_('Loading fleet…', 'Fetching pool chemistry from the field.', false);
  }

  monFetchAlerts_();

  monFetch_(true).then(result => {
    document.getElementById('gate').hidden = true;
    document.getElementById('app').hidden = false;
    if (!hadSnapshot) monBoardInit();
    monBoardRender(result.changed);
    monBoardSetLive(true);
    monStartPolling();
  }).catch(err => {
    if (err.code === 'Admin access required.') {
      monGateFail_('Admins and managers only', 'This board isn’t available for your role.', true);
      document.getElementById('app').hidden = true;
      document.getElementById('gate').hidden = false;
    } else if (!hadSnapshot) {
      monGateFail_('Couldn’t load the fleet', String(err.message || err), true);
    } else {
      // We already painted from snapshot — just mark it stale, don't block the UI.
      monBoardSetLive(false);
    }
  });
}
