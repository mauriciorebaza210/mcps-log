// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE EMAIL page: the Lifecycle Email Engine's portal view (CP6b).
//
// Reads /api/email?op=read (api/email.js) with the session token in the
// Authorization header, never the URL. Every view renders from a per-user cache
// first (localStorage `mcps_lc:{username}:…`, cleared on logout in auth.js) and
// revalidates in the background, so the page paints instantly.
// Styles: lifecycle.css (scoped to .lc / .lc-layer).
// ══════════════════════════════════════════════════════════════════════════════

const LC = { tab: 'campaigns', mode: null, ov: null, contacts: null, q: '', bucket: '', review: '', loading: false, error: null,
  drawer: null, root: null, bound: false, runPending: 0, busy: {} };
const LC_QUIESCENCE_MS = 36 * 60 * 1000;     // EngineCore: a Resend waits until any earlier attempt has surely finished
const LC_SEQ = { B: 'MCP Legacy', C: 'MCP Startup', Z: 'Staff' };
const LC_ICON = {
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l8-8"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  // AI marker: a four-point sparkle with a small companion star.
  sparkle: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 5.5c.75 5 2.4 7 7.5 8.5-5.1 1.5-6.75 3.5-7.5 8.5-.75-5-2.4-7-7.5-8.5 5.1-1.5 6.75-3.5 7.5-8.5z"/><path d="M18.5 1.5c.35 2.3 1.1 3.15 3.5 3.5-2.4.35-3.15 1.2-3.5 3.5-.35-2.3-1.1-3.15-3.5-3.5 2.4-.35 3.15-1.2 3.5-3.5z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12.5 10 17 19 7"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
};

// ── Data ──────────────────────────────────────────────────────────────────────
function lcKey_(view, extra) { return 'mcps_lc:' + ((_s && _s.username) || 'anon') + ':' + view + (extra ? ':' + extra : ''); }
function lcCacheGet_(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } }
function lcCacheSet_(key, data) { try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch (_) { /* full or private mode */ } }
async function lcFetch_(view, params = {}) {
  const url = new URL('/api/email', location.origin);
  url.searchParams.set('op', 'read'); url.searchParams.set('view', view);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  const res = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + currentSessionToken_() } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) { const e = new Error(body.error || ('HTTP ' + res.status)); e.status = res.status; throw e; }
  return body.data;
}
// Cache-first: hand back the cached copy now, call onFresh when the network answers.
function lcLoad_(view, params, onData, extraKey) {
  const key = lcKey_(view, extraKey);
  const hit = lcCacheGet_(key);
  if (hit) onData(hit.data, true);
  return lcFetch_(view, params).then(data => { lcCacheSet_(key, data); onData(data, false); return data; });
}

async function lcAdmin_(action, params) {
  const res = await fetch('/api/email?op=admin', { method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + currentSessionToken_() },
    body: JSON.stringify({ action, params: params || {} }) });
  const body = await res.json().catch(() => ({}));
  if (res.status >= 400 && !body.error) body.error = 'HTTP ' + res.status;
  return body;
}
function lcCan_(cap) { return !!(LC.ov && (LC.ov.capabilities || []).includes(cap)); }
function lcToast_(text, bad) {
  let el = document.getElementById('lc-toast');
  if (!el) { const wrap = document.createElement('div'); wrap.className = 'lc-layer'; wrap.innerHTML = '<div class="lc-toast" id="lc-toast" role="status" aria-live="polite"></div>'; document.body.appendChild(wrap); el = document.getElementById('lc-toast'); }
  el.textContent = text; el.classList.toggle('bad', !!bad);
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(lcToast_.t); lcToast_.t = setTimeout(() => el.classList.remove('show'), 3200);
}
// A small confirm sheet in the page's own style. Resolves true / false.
// With o.run (an async action returning {ok, error}), the sheet stays open with a
// spinner while it runs, shows a failure inline, and resolves to the result (or false).
function lcConfirm_(o) {
  return new Promise(resolve => {
    const layer = document.createElement('div');
    layer.className = 'lc-layer';
    layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim" data-x="0"></div><div class="lc-sheet' + (o.wide ? ' wide' : '') + '" role="alertdialog" aria-modal="true">' +
      '<h3>' + lcEsc_(o.title) + '</h3>' + (o.html || '<p>' + lcEsc_(o.body || '') + '</p>') + '<p class="lc-note" data-err hidden style="color:var(--red)"></p><div class="row"><button class="lc-btn" data-x="0">Cancel</button>' +
      '<button class="lc-btn ' + (o.danger ? 'danger solid' : 'primary') + '" data-x="1">' + lcEsc_(o.ok || 'Confirm') + '</button></div></div>';
    if (o.cancel) layer.querySelector('[data-x="0"].lc-btn').textContent = o.cancel;
    let running = false;
    const done = v => { layer.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = e => { if (e.key === 'Escape' && !running) { e.stopPropagation(); done(false); } };
    layer.addEventListener('click', async e => {
      const t = e.target.closest('[data-x]'); if (!t || running) return;
      if (t.dataset.x !== '1' || !o.run) return done(t.dataset.x === '1');
      running = true; lcBusyBtn_(t, true); layer.querySelector('[data-x="0"].lc-btn').disabled = true;
      const r = await Promise.resolve().then(() => o.run(layer)).catch(() => ({ ok: false, error: 'Network error' }));
      running = false; lcBusyBtn_(t, false); layer.querySelector('[data-x="0"].lc-btn').disabled = false;
      if (r && r.ok) return done(r);
      const err = layer.querySelector('[data-err]'); err.hidden = false; err.textContent = (r && (r.error || r.reason)) || 'That didn’t work';
    });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(layer);
    layer.querySelector('.lc-btn.' + (o.danger ? 'danger' : 'primary')).focus();
    if (o.wide) layer.querySelector('.lc-sheet').scrollTop = 0;   // a long sheet starts at its top, not at the focused button
  });
}

// ── Formatting ────────────────────────────────────────────────────────────────
const lcEsc_ = v => (typeof escHtml === 'function' ? escHtml(v) : String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));
function lcAgo_(iso) {
  const t = Date.parse(iso || ''); if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 7 * 86400) return Math.floor(s / 86400) + ' d ago';
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
// ── Time on screen: always the engine's local time (Central) with its zone ──
// (PLAN.md → Execution modes → Time on screen), whatever the viewer's computer says.
const LC_TZ = 'America/Chicago';
const lcLocalDay_ = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: LC_TZ });
const lcTodayCT_ = () => lcLocalDay_(Date.now());
const lcZone_ = ms => ((new Intl.DateTimeFormat('en-US', { timeZone: LC_TZ, timeZoneName: 'short' }).formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName') || {}).value || 'CT');
// The zone in force on a local date (CST or CDT), for planned times.
const lcZoneOn_ = d => lcZone_(Date.parse((d || lcTodayCT_()) + 'T18:00:00Z'));
// 'HH:MM' → '10:30 AM'
function lcClock_(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/); if (!m) return '';
  const h = +m[1]; return (h % 12 || 12) + ':' + m[2] + ' ' + (h < 12 ? 'AM' : 'PM');
}
// Compact for tight spaces (calendar cells): '9am', '2:15pm'
const lcClockShort_ = hhmm => { const c = lcClock_(hhmm); return c ? c.replace(':00 ', ' ').replace(' AM', 'am').replace(' PM', 'pm') : ''; };
const lcClockAt_ = ms => new Date(ms).toLocaleTimeString('en-US', { timeZone: LC_TZ, hour: 'numeric', minute: '2-digit' });
// 'Today · 10:31 AM CST', 'Yesterday · …', 'Mon, Nov 23 · 10:31 AM CST'
function lcStamp_(iso, noZone) {
  const t = Date.parse(iso || ''); if (!t) return '';
  const d = lcLocalDay_(t), today = lcTodayCT_(), y = lcLocalDay_(Date.parse(today + 'T18:00:00Z') - 86400000);
  const day = d === today ? 'Today' : d === y ? 'Yesterday'
    : new Date(t).toLocaleDateString('en-US', { timeZone: LC_TZ, weekday: 'short', month: 'short', day: 'numeric' });
  return day + ' · ' + lcClockAt_(t) + (noZone ? '' : ' ' + lcZone_(t));
}
const lcDate_ = iso => lcStamp_(iso);
const lcDay_ = iso => { const t = Date.parse(iso || ''); return t ? new Date(t).toLocaleDateString('en-US', { timeZone: LC_TZ, month: 'short', day: 'numeric' }) : ''; };
// A relative time with the exact local time on hover.
const lcAgoT_ = iso => '<time title="' + lcEsc_(lcStamp_(iso)) + '">' + lcEsc_(lcAgo_(iso)) + '</time>';
// Today's runs still ahead, from the engine's plan ('' when none is planned for today).
function lcNextRun_() {
  const p = LC.ov && LC.ov.engine.run_plan, now = lcClockAt_(Date.now());
  if (!p || p.date !== lcTodayCT_()) return '';
  const cur = new Date().toLocaleTimeString('en-GB', { timeZone: LC_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return (p.times || []).find(t => t > cur) || '';
}
const lcSendTime_ = b => (LC.ov && LC.ov.engine.send_times && LC.ov.engine.send_times[b]) || '09:00';
const lcPct_ = (n, d) => d ? Math.round(100 * n / d) + '%' : '';
const lcInitials_ = (a, b) => ((String(a || '')[0] || '') + (String(b || '')[0] || '')).toUpperCase() || '·';
// Sends when it happens rather than at the campaign's send time (lifecycle-rules.js → isImmediate).
const lcImmediate_ = t => !!(t && (t.immediate || (t.anchor === 'enrollment' && t.deadline && t.deadline.from === 'startup')));
function lcTiming_(t, steps) {
  if (!t) return '';
  const d = n => Math.abs(n) + (Math.abs(n) === 1 ? ' day' : ' days');
  // B people join when their batch starts; C people when their startup is approved in the portal.
  if (t.anchor === 'enrollment') {
    const from = (steps || []).some(s => s.timing && s.timing.anchor === 'startup') ? 'the startup is approved' : 'their batch starts';
    return t.offset ? d(t.offset) + ' after ' + from.replace('is approved', 'approval').replace('their batch starts', 'their batch’s start date') : 'When ' + from;
  }
  if (t.anchor === 'previous') {
    const prev = (steps || []).find(s => s.step_id === t.requires);
    return d(t.offset) + ' after ' + (prev ? prev.name : 'the previous email');
  }
  if (t.anchor === 'startup') {
    if (t.repeat_every) return 'Every ' + d(t.repeat_every).replace(/^7 days$/, 'week') + ', ' + t.repeat_count + ' times, from ' + d(t.offset) + ' after startup';
    return t.offset < 0 ? d(t.offset) + ' before startup' : (t.offset ? d(t.offset) + ' after startup' : 'On startup day');
  }
  return '';
}
const LC_SIGNAL = { reply: 'A reply', click: 'A verified click', form: 'A service request' };
const LC_STOPS = { enrollment: 'ends the sequence', marketing_branch: 'stops the marketing emails' };
const LC_RESULT = { done: 'Completed', quota_reserve: 'Paused for quota', daily_cap: 'Daily cap reached', time_budget: 'Time limit',
  lease_lost: 'Superseded', safety_pause: 'Safety pause', kill_switch: 'Engine off', owner_guard: 'Wrong account', already_running: 'Already running' };
const LC_STATE = { sent: ['Sent', 'live'], unknown: ['Unconfirmed', 'bad'], reconcile: ['Confirming', 'warn'], failed: ['Failed', 'bad'],
  cancelled: ['Cancelled', ''], claimed: ['Preparing', ''], drafted: ['Preparing', ''], sending: ['Sending', 'warn'],
  released: ['Retrying', ''], abandoned: ['Abandoned', ''] };
const LC_ISSUE = { no_recent_run: 'No scheduled run in over a day', last_run_crashed: 'The last run crashed', unresolved_unknown: 'A send is unconfirmed',
  unresolved_reconcile: 'A send is still confirming', delivery_failed: 'An email failed', engine_unreadable: 'The engine can’t be reached' };
const LC_ALERT = { trigger_test_done: 'Trigger timing test finished', security_property_changed: 'Security setting changed', schema_incompatible: 'Engine code too old for its data', backup_failed: 'Nightly backup failed', too_many_send_times: 'Too many send times', delivery_failed: 'Email failed', delivery_unknown: 'Send unconfirmed', run_stopped: 'Run stopped', run_crashed: 'Run crashed',
  journal_integrity: 'Safety pause', reply_scan_failed: 'Reply scan failed' };
const LC_STOP = { clicked: 'clicked', replied: 'replied', form_submitted: 'requested service', suppressed_all: 'unsubscribed',
  prerequisite_expired: 'expired', bucket_changed: 'moved group', manual: 'stopped by hand' };
const lcStopWord_ = r => LC_STOP[r] || String(r || 'manual').replace(/_/g, ' ');
// What the AI suggested: the sparkle plus "AI", on a teal-to-aqua chip.
function lcAiTag_(title) { return '<span class="lc-tag lc-ai"' + (title ? ' title="' + lcEsc_(title) + '"' : '') + '>' + LC_ICON.sparkle + 'AI</span>'; }
function lcTag_(text, kind) { return '<span class="lc-tag ' + (kind || '') + '"><i></i>' + lcEsc_(text) + '</span>'; }
function lcStateTag_(state) { const s = LC_STATE[state] || [state, '']; return lcTag_(s[0], s[1]); }
function lcEvidence_(g) {
  if (!g) return '';
  const out = [];
  if (g.bounced_at) out.push(lcTag_('Bounced', 'bad'));
  if (g.unsubscribed_at) out.push(lcTag_('Unsubscribed', 'warn'));
  if (g.replied_at || g.other_replied_at) out.push(lcTag_('Replied', 'teal'));
  if (g.verified_clicks) out.push(lcTag_('Verified click', 'live'));
  else if (g.clicks) out.push(lcTag_('Clicked', ''));
  if (g.form_submitted_at) out.push(lcTag_('Requested service', 'live'));
  if (g.opened && !out.length) out.push(lcTag_('Opened', ''));
  return out.join('');
}

// ── Page ──────────────────────────────────────────────────────────────────────
function loadLifecycle(sub) {
  LC.t0 = performance.now(); LC.perf = null;
  LC.root = document.getElementById('lc-root');
  if (!LC.root) return;
  if (sub && ['campaigns', 'emails', 'activity', 'contacts'].includes(sub)) LC.tab = sub;
  if (!LC.bound) {
    LC.root.addEventListener('click', lcOnClick_);
    LC.root.addEventListener('input', lcOnInput_);
    // Table rows are focusable (tabindex) but aren't buttons: Enter opens them too.
    LC.root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('tr[data-act]')) e.target.click(); });
    if (typeof cmpBind_ === 'function') cmpBind_(LC.root);
    LC.bound = true;
  }
  lcRender_();
  lcRefresh_();
}
function lcRefresh_(fresh) {
  LC.loading = true; LC.error = null; lcRenderHead_();
  const params = { mode: LC.mode || '', fresh: fresh ? '1' : '' };
  lcLoad_('overview', params, (data, cached) => {
    LC.ov = data; if (typeof sglNames_ === 'function') sglNames_(data); if (!LC.mode) LC.mode = data.mode; lcRender_();
    if (!LC.perf && LC.t0) LC.perf = { paint_ms: Math.round(performance.now() - LC.t0), paint_from: cached ? 'cache' : 'network' };
  }, LC.mode || 'default')
    .catch(e => { LC.error = e; })
    .finally(() => {
      LC.loading = false;
      if (LC.tab === 'contacts' || LC.tab === 'campaigns' || LC.contacts) lcLoadContacts_(fresh);
      if (LC.tab === 'campaigns' && typeof CMP !== 'undefined' && CMP.id) cmpLoadPlan_(CMP.id, fresh);
      lcRender_();
    });
}
function lcLoadContacts_(fresh) {
  return lcLoad_('contacts', { limit: 1000, fresh: fresh ? '1' : '' }, (data) => { LC.contacts = data; if (LC.tab === 'contacts' || LC.tab === 'campaigns') lcRenderBody_(); })
    .catch(e => { if (!LC.contacts) { LC.error = e; lcRenderBody_(); } });
}

function lcRender_() {
  if (!LC.root) return;
  if (!LC.root.querySelector('.lc')) {
    LC.root.innerHTML = '<div class="lc"><div data-lc="head"></div><div data-lc="kpis"></div><div data-lc="banner"></div>' +
      '<div data-lc="hlp"></div><nav class="lc-tabs" data-lc="tabs" aria-label="Lifecycle sections"></nav><div data-lc="body"></div></div>';
  }
  lcRenderHead_(); lcRenderKpis_(); if (typeof hlpRenderOffer_ === 'function') hlpRenderOffer_(); lcRenderTabs_(); lcRenderBody_();
  if (typeof rqMount_ === 'function') rqMount_();
}
const lcSlot_ = name => LC.root && LC.root.querySelector('[data-lc="' + name + '"]');

function lcRenderHead_() {
  const el = lcSlot_('head'); if (!el) return;
  const ov = LC.ov, h = ov && ov.health;
  let health = '';
  if (h) {
    const sys = lcSystemIssues_(h);
    const cls = !sys.length ? '' : (sys.some(i => /crash|unreadable/.test(i.kind)) ? 'bad' : 'warn');
    const label = !sys.length ? (h.last_run_at ? 'Healthy · ran ' + lcStamp_(h.last_run_at, true) : 'Healthy') : (LC_ISSUE[sys[0].kind] || sys[0].kind);
    health = '<button class="lc-pill ' + cls + '" data-act="tab" data-tab="activity" title="' + lcEsc_(h.last_run_at ? 'Last run ' + lcStamp_(h.last_run_at) : '') + '"><i></i>' + lcEsc_(label) + '</button>';
    const next = lcNextRun_();
    if (next) health += '<button class="lc-pill" data-act="tab" data-tab="activity"><i class="next"></i>Next run ' + lcEsc_(lcClock_(next) + ' ' + lcZoneOn_()) + '</button>';
  }
  // Test / Live only matters while the engine is in test mode; once it's live, the page just shows live.
  const mode = ov && ov.engine.mode !== 'production' ? '<div class="lc-seg" role="group" aria-label="Data shown">' +
    ['test', 'production'].map(m => '<button data-act="mode" data-mode="' + m + '" class="' + (LC.mode === m ? 'on' : '') + '">' + (m === 'test' ? 'Test' : 'Live') + '</button>').join('') + '</div>' : '';
  const test = ov && ov.engine.mode !== 'production' ? '<span class="lc-pill test"><i></i>Test mode</span>' : '';
  const off = ov && !ov.engine.enabled ? '<button class="lc-pill bad" data-act="tab" data-tab="activity"><i></i>Sending off</button>' : '';
  // "Send due emails now" lives on the Activity tab (Health card); the header only shows that it's happening.
  const run = LC.runPending ? '<button class="lc-pill" data-act="tab" data-tab="activity"><i class="next"></i>Sending due emails…</button>' : '';
  el.innerHTML = '<header class="lc-head"><div class="lc-title"><h1>Lifecycle Email</h1>' + mode + '</div>' +
    '<div class="lc-status">' + test + off + health +
    '<button class="lc-icon-btn' + (LC.loading ? ' spin' : '') + '" data-act="refresh" aria-label="Refresh" title="Refresh">' + LC_ICON.refresh + '</button>' +
    (typeof hlpHeadBtn_ === 'function' ? hlpHeadBtn_() : '') + run + '</div></header>';
}

function lcRenderKpis_() {
  const el = lcSlot_('kpis'), ban = lcSlot_('banner'); if (!el) return;
  const ov = LC.ov;
  if (!ov) { el.innerHTML = LC.error ? '' : '<div class="lc-kpis">' + '<div class="lc-sk" style="height:92px"></div>'.repeat(4) + '</div>'; ban.innerHTML = ''; return; }
  const sum = k => ov.steps.reduce((a, s) => a + Number((s.tracking || {})[k] || 0), 0);
  const kpi = (v, l) => '<div class="lc-kpi"><b>' + lcEsc_(v) + '</b><span>' + lcEsc_(l) + '</span></div>';
  el.innerHTML = '<div class="lc-kpis">' + kpi(ov.totals.active_enrollments, 'In a sequence') + kpi(ov.totals.sent_7d, 'Sent this week') +
    kpi(sum('verified_clicks'), 'Verified clicks') + kpi(sum('replied'), 'Replies') + '</div>';
  const n = ov.attention.length;
  ban.innerHTML = n ? '<button class="lc-banner' + (ov.attention.some(d => d.state === 'unknown' || d.state === 'failed') ? ' bad' : '') + '" data-act="tab" data-tab="activity">' +
    LC_ICON.alert + '<span>' + n + (n === 1 ? ' email needs' : ' emails need') + ' a decision</span><em>Review</em></button>' : '';
}

function lcRenderTabs_() {
  const el = lcSlot_('tabs'); if (!el) return;
  const ov = LC.ov;
  const tabs = [['campaigns', 'Campaigns', ''], ['emails', 'Emails', ov ? ov.steps.length : ''], ['activity', 'Activity', ov && ov.attention.length ? ov.attention.length : ''],
    ['contacts', 'Contacts', ov ? ov.totals.contacts : '']];
  el.innerHTML = tabs.map(([k, l, c]) => '<button data-act="tab" data-tab="' + k + '" class="' + (LC.tab === k ? 'on' : '') + '">' + l +
    (c !== '' ? '<span class="c">' + c + '</span>' : '') + '</button>').join('');
}

function lcRenderBody_() {
  const el = lcSlot_('body'); if (!el) return;
  if (LC.error && !LC.ov) { el.innerHTML = lcErrorView_(LC.error); return; }
  if (!LC.ov) { el.innerHTML = '<div class="lc-sk" style="height:260px;margin-bottom:16px"></div><div class="lc-sk" style="height:320px"></div>'; return; }
  if (LC.tab === 'activity') el.innerHTML = lcActivity_();
  else if (LC.tab === 'contacts') el.innerHTML = lcContacts_();
  else if (LC.tab === 'campaigns') el.innerHTML = lcCampaigns_();
  else el.innerHTML = lcEmails_();
  if (typeof hlpAfterRender_ === 'function') hlpAfterRender_();
}
function lcErrorView_(e) {
  const denied = e.status === 403, offline = e.status === 503;
  return '<div class="lc-msg"><div class="dot">' + (denied ? LC_ICON.lock : LC_ICON.alert) + '</div><h2>' +
    (denied ? 'No access yet' : offline ? 'Engine not connected' : 'Couldn’t load') + '</h2><p>' +
    lcEsc_(denied ? 'Ask an admin to add you to Lifecycle Email.' : e.message) + '</p></div>';
}

// Emails: one panel per sequence. Timing lives in the drawer, not the table.
function lcEmails_() {
  const ov = LC.ov;
  const singles = typeof sglList_ === 'function' ? sglList_() : [];
  const singleRows = singles.map(x => {
    const s = x.step, c = s.counts, t = s.tracking || {}, sent = c.sent, st = sglState_(x);
    const m = (n, base) => '<div class="lc-metric' + (sent ? '' : ' dim') + '"><b>' + (sent ? n : '–') + '</b>' + (sent && base && n ? '<small>' + lcPct_(n, base) + '</small>' : '') + '</div>';
    return '<button class="lc-row" data-act="step" data-id="' + lcEsc_(s.step_id) + '"><div class="lc-name"><span class="lc-step lc-sgl-ic">' + CMP_ICON.mail + '</span><div style="min-width:0"><b>' + lcEsc_(s.name) + '</b>' +
      '<small>' + lcEsc_(sglWhen_(s) + ' · ' + (s.enrolled || 0) + ' people') + '</small></div></div><div>' + lcTag_(st[0], st[1]) + '</div>' +
      m(sent, 0) + m(t.opened_est || 0, sent) + m(t.clicked || 0, sent) + m(t.replied || 0, sent) + '<span class="chev">' + LC_ICON.chev + '</span></button>';
  }).join('');
  const singleSec = singles.length ? '<section class="lc-seq"><div class="lc-seq-h"><span class="lc-bkt lc-sgl-ic">' + CMP_ICON.mail + '</span><div class="grow"><h2>Single emails</h2>' +
    '<small>' + singles.length + ' made · one day each</small></div></div>' +
    '<div class="lc-cols"><span>Email</span><span>Status</span><span class="r">Sent</span><span class="r">Opened</span><span class="r">Clicked</span><span class="r">Replied</span><span></span></div>' + singleRows + '</section>' : '';
  // Who the emails come from: the inbox name and the sign-off, editable by whoever edits emails.
  const eng = LC.ov.engine, fromName = eng.sender_display_name || ((eng.sender_name || 'Tony') + ' | Mission Custom Pool Solutions');
  const from = '<div class="lc-from"><span>From</span><b>' + lcEsc_(fromName) + '</b>' + (lcCan_('edit_drafts') ? '<button class="lc-link" data-act="sender">Change</button>' : '') + '</div>';
  const bar = '<div class="lc-emails-bar">' + from + (typeof attOpen_ === 'function' ? '<button class="lc-btn" data-act="att-open">' + LC_ICON.clip + 'Attachments</button>' : '') + '</div>';
  return bar + ['B', 'C'].map(b => {
    const steps = ov.steps.filter(s => s.bucket === b).sort((x, y) => x.order - y.order);
    if (!steps.length) return '';
    const live = steps.filter(s => s.published).length;
    const rows = steps.map(s => {
      const c = s.counts, t = s.tracking || {}, sent = c.sent;
      const m = (n, base) => '<div class="lc-metric' + (s.published ? '' : ' dim') + '"><b>' + (s.published ? n : '–') + '</b>' +
        (s.published && base && n ? '<small>' + lcPct_(n, base) + '</small>' : '') + '</div>';
      const status = s.status === 'off' ? lcTag_('Off', '') : !s.published ? lcTag_('Not approved', '') : (ov.engine.paused_buckets.includes(b) ? lcTag_('Paused', 'warn') : lcTag_('Live', 'live'));
      return '<button class="lc-row" data-act="step" data-id="' + lcEsc_(s.step_id) + '">' +
        '<div class="lc-name"><span class="lc-step">' + s.order + '</span><div style="min-width:0"><b>' + lcEsc_(s.name) + '</b>' +
        '<small>' + lcEsc_((s.published ? s.published.subject : 'Waiting for approval') + (s.sender ? ' · from ' + (s.sender.name || s.sender.email) : '')) + '</small></div></div>' +
        '<div>' + status + '</div>' + m(sent, 0) + m(t.opened_est || 0, sent) + m(t.clicked || 0, sent) + m(t.replied || 0, sent) +
        '<span class="chev">' + LC_ICON.chev + '</span></button>';
    }).join('');
    const audience = steps.length ? steps[0].audience : 0;
    return '<section class="lc-seq"><div class="lc-seq-h"><span class="lc-bkt">' + b + '</span><div class="grow"><h2>' + LC_SEQ[b] + '</h2>' +
      '<small>' + audience + ' in sequence · ' + live + ' of ' + steps.length + ' emails live</small></div></div>' +
      '<div class="lc-cols"><span>Email</span><span>Status</span><span class="r">Sent</span><span class="r">Opened</span><span class="r">Clicked</span><span class="r">Replied</span><span></span></div>' +
      rows + '</section>';
  }).join('') + singleSec;
}

function lcActivity_() {
  const ov = LC.ov, h = ov.health;
  const sys = lcSystemIssues_(h);
  const issues = !sys.length ? '<div class="lc-ok"><span class="dot">' + LC_ICON.check + '</span><div><b>All clear</b><small>' +
      lcEsc_(h.daily_trigger_seen ? 'Last run ' + lcStamp_(h.last_run_at) : 'Schedule not switched on yet') + '</small></div></div>'
    : '<ul class="lc-list">' + sys.map(i => '<li><span class="lc-li-ic bad">' + LC_ICON.alert + '</span><div class="main"><b>' + lcEsc_(LC_ISSUE[i.kind] || i.kind) +
      '</b><small>' + lcEsc_(i.kind === 'no_recent_run' ? 'Last one ' + lcDate_(i.at) : i.at ? lcDate_(i.at) : '') + '</small></div></li>').join('') + '</ul>';
  const att = ov.attention.length ? '<ul class="lc-list">' + ov.attention.map(d => '<li>' + lcStateTag_(d.state) + '<div class="main"><b>' +
      lcEsc_(lcStepName_(d.step_id)) + '</b><small>' + lcEsc_(d.email) + (d.error ? ' · ' + lcEsc_(d.error) : '') + '</small>' + lcResolveActs_(d) + '</div>' + lcAgoT_(d.send_invoked_at || d.claimed_at) + '</li>').join('') + '</ul>'
    : '<div class="lc-empty">Nothing needs a decision.</div>';
  const canPause = lcCan_('pause'), e = ov.engine;
  const sw = (on, act, extra, label, key) => '<button class="lc-switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + on + '" aria-label="' + lcEsc_(label) + '" data-act="' + act + '"' +
    (extra || '') + (canPause && !LC.busy[key] ? '' : ' disabled') + '></button>';
  const ctrls = '<ul class="lc-ctrls"><li><div><b>Sending</b><small>' + (e.enabled ? 'On' : 'Off · nothing sends') + '</small></div>' + sw(e.enabled, 'enabled', '', 'Sending', 'enabled') + '</li>' +
    ['B', 'C'].map(b => { const on = !e.paused_buckets.includes(b); return '<li><div><b>' + LC_SEQ[b] + '</b><small>' + (on ? 'Running' : 'Paused') + '</small></div>' +
      sw(on, 'pause', ' data-bucket="' + b + '"', LC_SEQ[b], 'pause' + b) + '</li>'; }).join('') +
    (lcCan_('run_now') ? '<li class="lc-ctrl-run"><div><b>Send due emails now</b><small>Emails go out by themselves at your send times. This sends anything that’s already due right away, e.g. just after you approve an email. Never early, never twice.</small></div>' +
      '<button class="lc-btn sm' + (LC.runPending ? ' busy' : '') + '" data-act="run"' + (LC.runPending ? ' disabled' : '') + '>' + (LC.runPending ? LC_ICON.refresh + 'Sending…' : LC_ICON.play + 'Send now') + '</button></li>' : '') + '</ul>';
  const changes = (ov.changes || []).length ? '<ul class="lc-list">' + ov.changes.slice(0, 8).map(c => '<li><div class="main"><b>' + lcEsc_(lcChangeText_(c)) +
      '</b>' + (c.result !== 'ok' ? '<small>Refused: ' + lcEsc_(c.result) + '</small>' : '') + '</div>' + lcAgoT_(c.at) + '</li>').join('') + '</ul>' : '';
  const runs = ov.runs.length ? '<table class="lc-table lc-runs"><thead><tr><th>Run</th><th class="hide-sm">Trigger</th><th class="r">Sent</th><th class="r hide-sm">Skipped</th><th>Result</th></tr></thead><tbody>' +
      ov.runs.map(r => '<tr><td>' + lcEsc_(lcStamp_(r.started_at, true)) + '</td><td class="hide-sm lc-fit"' + (r.planned_for ? ' title="Planned for ' + lcEsc_(lcClock_(r.planned_for)) + '"' : '') + '>' + lcEsc_(lcTrigger_(r)) +
        '</td><td class="r num">' + r.sent + '</td><td class="r num hide-sm">' + r.skipped + '</td><td>' +
        (r.stopped_reason === 'done' ? lcTag_('Completed', 'live') : /^crashed/.test(r.stopped_reason) ? lcTag_('Crashed', 'bad') : lcTag_(LC_RESULT[r.stopped_reason] || r.stopped_reason, 'warn')) +
        '</td></tr>').join('') + '</tbody></table>' : '<div class="lc-empty">No runs yet.</div>';
  const alerts = ov.alerts.length ? '<ul class="lc-list">' + ov.alerts.slice(0, 8).map(a => '<li><div class="main"><b>' + lcEsc_(LC_ALERT[a.kind] || a.kind) +
      '</b>' + (a.detail ? '<small>' + lcEsc_(lcHumanize_(a.detail)) + '</small>' : '') + '</div>' + lcAgoT_(a.at) + '</li>').join('') + '</ul>'
    : '<div class="lc-empty">No alerts.</div>';
  return (typeof wtBanner_ === 'function' ? wtBanner_() : '') + '<div class="lc-grid"><div><div class="lc-card"><div class="lc-card-h"><h3>Health</h3></div>' + issues + ctrls + '</div>' +
    '<div class="lc-card"><div class="lc-card-h"><h3>Needs a decision</h3><small>' + ov.attention.length + '</small></div>' + att + '</div>' +
    (changes ? '<div class="lc-card"><div class="lc-card-h"><h3>Changes</h3></div>' + changes + '</div>' : '') + '</div>' +
    '<div>' + lcTodayRuns_() + '<div class="lc-card"><div class="lc-card-h"><h3>Recent runs</h3><small>Times in ' + lcEsc_(lcZoneOn_()) + '</small></div>' + runs + '</div>' +
    '<div class="lc-card"><div class="lc-card-h"><h3>Alerts</h3></div>' + alerts + '</div>' + (typeof rqListCard_ === 'function' ? rqListCard_() : '') + lcGoLiveCard_() + lcChecks_() + '</div></div>';
}
// Engine checks: the trigger-precision test (Schedule.js → trigger_test). Before the
// scheduler is installed, this measures how close to the planned minute Apps Script's
// one-off triggers fire. Nothing is sent.
function lcChecks_() {
  if (!lcCan_('edit_config')) return '';
  if (!LC.trig) { LC.trig = { loading: true }; lcAdmin_('trigger_test', { do: 'result' }).then(r => { LC.trig = r.ok ? { test: r.test } : { error: r.error }; if (LC.tab === 'activity') lcRenderBody_(); }).catch(() => { LC.trig = { error: 'Network error' }; }); }
  // A run counts as finished 10 min after its last timer (the engine allows a new one then too).
  const t = LC.trig.test, lastAt = t ? Math.max(...t.slots.map(s => Date.parse(s.planned) || 0)) : 0;
  const stale = !!(t && t.status === 'running' && Date.now() > lastAt + 10 * 60000), fmt = s => s == null ? '–' : (s < 0 ? '−' : '+') + (Math.abs(s) >= 60 ? Math.floor(Math.abs(s) / 60) + ' min ' : '') + (Math.abs(s) % 60) + ' s';
  const rows = t ? '<ul class="lc-list">' + t.slots.map(s => '<li><div class="main"><b>' + lcEsc_(lcClockAt_(Date.parse(s.planned))) + '</b><small>planned</small></div>' +
    (s.fired ? '<span class="num">' + lcEsc_(fmt(s.delta_s)) + '</span>' : '<span class="lc-dim">' + (stale ? 'no report' : 'waiting…') + '</span>') + '</li>').join('') + '</ul>' : '';
  const sum = t && t.summary ? '<p class="lc-note">' + (t.summary.within_20_min ? lcTag_('Within 20 min', 'live') : lcTag_('Outside 20 min', 'bad')) +
    ' Earliest ' + lcEsc_(fmt(t.summary.earliest_s)) + ', latest ' + lcEsc_(fmt(t.summary.latest_s)) + ' from the planned minute.</p>' : '';
  const running = t && t.status === 'running' && !stale;
  const staleNote = stale ? '<p class="lc-note">These timers never reported back, so this run has no result. Run it again.</p>' : '';
  return '<div class="lc-card"><div class="lc-card-h"><h3>Engine checks</h3>' + (running ? '<small>Running · about 8 min</small>' : '') + '</div>' +
    '<div class="lc-checks"><b style="font-size:13.5px">Trigger timing</b><p class="lc-note" style="margin-top:2px">Plans 4 test timers 2 to 8 minutes out and records how close to the minute each one fires. Nothing is sent. Needed once before the scheduler is turned on.</p>' +
    (LC.trig.error ? '<div class="lc-empty" style="text-align:left;padding:0">' + lcEsc_(LC.trig.error === 'unknown action' ? 'The engine needs an update for this test.' : LC.trig.error) + '</div>' : rows + sum + staleNote) +
    '<button class="lc-btn sm" data-act="trig-test"' + (running ? ' disabled' : '') + '>' + (t ? 'Run it again' : 'Test trigger timing') + '</button>' +
    (running ? ' <button class="lc-link" data-act="trig-refresh">Refresh</button>' : '') + '</div></div>';
}
// Go live (Admin.js EE_goLive_): only for whoever can change settings, only while in test mode.
function lcGoLiveCard_() {
  const ov = LC.ov;
  if (!lcCan_('edit_config') || ov.engine.mode === 'production') return '';
  if (!LC.golive) { LC.golive = { loading: true }; lcAdmin_('go_live', { check: true }).then(r => { LC.golive = r; if (LC.tab === 'activity') lcRenderBody_(); }).catch(() => { LC.golive = { ok: false }; }); }
  const on = ov.steps.filter(s => s.status !== 'off' && s.published);
  const joining = typeof cmpPeople_ === 'function' ? cmpPeople_('C').joining.length : 0;
  const ready = LC.golive && LC.golive.ready;
  const li = (ok, text) => '<li><span class="lc-gl-dot ' + (ok ? 'ok' : 'warn') + '">' + (ok ? LC_ICON.check : '!') + '</span><span>' + text + '</span></li>';
  return '<div class="lc-card lc-golive"><div class="lc-card-h"><h3>Go live</h3><small>Test mode now</small></div><div class="lc-checks">' +
    '<p class="lc-note" style="margin-top:0">One click switches from testing to real customers. It turns on the daily schedule, points email links at the live site and swaps in new security keys.</p>' +
    '<ul class="lc-gl-list">' +
      li(on.length === 1 && on[0].step_id === 'c_welcome', on.length ? 'Emails that will be On: <b>' + on.map(s => lcEsc_(s.name)).join(', ') + '</b>' + (on.some(s => s.step_id !== 'c_welcome') ? ' (only Welcome should be; turn the others Off in their Setup first)' : '') : 'No email is On yet') +
      li(true, joining ? '<b>' + joining + '</b> startup' + (joining === 1 ? '' : 's') + ' already synced will be skipped (they got the old approval email)' : 'Startups approved from now on get the Welcome') +
      li(!!ready, ready ? 'New keys ready on the live site' : LC.golive && LC.golive.loading ? 'Checking the new keys…' : 'New keys not set up yet (Claude does this)') +
    '</ul><button class="lc-btn primary" data-act="golive"' + (ready ? '' : ' disabled') + '>Go live…</button></div></div>';
}
// Staff: MCPS people who can get single emails; no campaign ever picks them (Admin.js EE_addStaff_).
async function lcAddStaff_() {
  const html = '<p>Someone at MCPS who can get single emails, like a launch note. No campaign or batch ever picks them.</p>' +
    '<div class="lc-imp-row"><label class="lc-fld grow"><span>First name</span><input class="lc-input" data-st="first_name" maxlength="60"></label>' +
    '<label class="lc-fld grow"><span>Last name</span><input class="lc-input" data-st="last_name" maxlength="80"></label></div>' +
    '<label class="lc-fld"><span>Email</span><input class="lc-input" data-st="email" type="email" maxlength="120"></label>';
  const r = await lcConfirm_({ title: 'Add a staff member', html, ok: 'Add',
    run: layer => { const v = k => layer.querySelector('[data-st="' + k + '"]').value; return lcAdmin_('add_staff', { first_name: v('first_name'), last_name: v('last_name'), email: v('email') }); } });
  if (!r || !r.ok) return;
  lcToast_(r.existed ? 'Updated' : 'Added to Staff');
  LC.contacts = null; lcRefresh_(true);
}
async function lcGoLive_() {
  const html = '<p>Real customers start getting the emails that are On. After this, use the live portal (mcps-log.vercel.app); this preview stops talking to the engine.</p>' +
    '<label class="lc-fld"><span>Type GO LIVE to confirm</span><input class="lc-input" data-gl autocomplete="off"></label>';
  const r = await lcConfirm_({ title: 'Go live now?', html, ok: 'Go live', danger: true,
    run: layer => lcAdmin_('go_live', { confirm: String(layer.querySelector('[data-gl]').value || '').trim().toUpperCase() }) });
  if (!r || !r.ok) return;
  lcToast_('Live. ' + (r.held ? r.held + ' earlier startups skipped. ' : '') + 'Open mcps-log.vercel.app from now on.');
  LC.golive = null; lcRefresh_(true);
}
async function lcTrigTest_(refreshOnly) {
  const r = await lcAdmin_('trigger_test', { do: refreshOnly ? 'result' : 'start' }).catch(() => ({ ok: false, error: 'Network error' }));
  if (!r.ok) return lcToast_(r.error || 'That didn’t work', true);
  LC.trig = { test: r.test };
  if (!refreshOnly) lcToast_('Timing test started: results in about 8 minutes (and by email)');
  lcRenderBody_();
}
// Engine-level problems only; per-email ones live in "Needs a decision".
const lcSystemIssues_ = h => (h && h.issues || []).filter(i => !/^unresolved_|^delivery_failed$/.test(i.kind));
// Alert text comes from the engine: turn delivery ids and timestamps into words.
function lcHumanize_(text) {
  return String(text || '')
    .replace(/\b[\w]+:([a-z]+_[a-z]+):\d+\b/g, (m, step) => lcStepName_(step))
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, m => lcDate_(m));
}
// The decisions an unconfirmed send allows. "Confirming" resolves itself; failed needs the email fixed.
function lcResolveActs_(d) {
  if (d.state !== 'unknown' || !lcCan_('resolve_unknown')) return '';
  const unlock = Date.parse(d.send_invoked_at || d.claimed_at) + LC_QUIESCENCE_MS, ready = Date.now() >= unlock, busy = LC.busy['r:' + d.delivery_id];
  const b = (act, label, cls, dis, title) => '<button class="lc-btn sm ' + (cls || '') + '" data-act="resolve" data-do="' + act + '" data-id="' + lcEsc_(d.delivery_id) + '"' +
    (dis || busy ? ' disabled' : '') + (title ? ' title="' + lcEsc_(title) + '"' : '') + '>' + label + '</button>';
  return '<div class="lc-acts">' + b('mark_sent', 'Mark sent') +
    b('resend', ready ? 'Resend' : 'Resend at ' + lcClockAt_(unlock), '', !ready,
      ready ? '' : 'An earlier attempt could still finish until then') + b('abandon', 'Abandon', 'danger') + '</div>';
}
const LC_CHANGE = { run_now: () => 'started a run', set_enabled: p => (p.enabled ? 'turned sending on' : 'turned sending off'),
  set_bucket_paused: p => (p.paused ? 'paused ' : 'resumed ') + (LC_SEQ[p.bucket] || p.bucket), mark_sent: () => 'marked a send as sent',
  abandon: () => 'abandoned an unconfirmed send', resend: () => 'asked to resend an email' };
const lcChangeText_ = c => (c.actor || 'Someone') + ' ' + (LC_CHANGE[c.action] ? LC_CHANGE[c.action](c.params || {}) : c.action);
// How a run was started, with its planned time when the schedule started it.
// The run column already shows the time, so the trigger is one word (the planned slot stays in the tooltip).
const lcTrigger_ = r => r.trigger === 'scheduled' ? 'Scheduled'
  : r.trigger === 'daily' ? 'Daily' : 'By hand';
// Today's runs: the engine's plan for today, each marked done (with what it sent) or still ahead.
function lcTodayRuns_() {
  const ov = LC.ov, p = ov.engine.run_plan, today = lcTodayCT_(), zone = lcZoneOn_(today);
  const ran = ov.runs.filter(r => r.started_at && lcLocalDay_(Date.parse(r.started_at)) === today);
  const st = ov.engine.send_times || {};
  const defaults = Object.keys(st).map(b => LC_SEQ[b] + ' ' + lcClock_(st[b])).join(' · ');
  if (!p || p.date !== today) {
    return '<div class="lc-card"><div class="lc-card-h"><h3>Today’s runs</h3><small>' + lcEsc_(zone) + '</small></div><div class="lc-ok"><span class="dot">' + CMP_ICON_CLOCK + '</span><div><b>' +
      (ran.length ? ran.length + (ran.length === 1 ? ' run' : ' runs') + ' so far' : 'No runs planned today') + '</b><small>' +
      lcEsc_('The schedule isn’t switched on yet. Send times: ' + defaults + '.') + '</small></div></div></div>';
  }
  const cur = new Date().toLocaleTimeString('en-GB', { timeZone: LC_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const done = new Set(ran.map(r => r.planned_for).filter(Boolean));
  const times = [...new Set([...(p.times || []), ...done])].sort();
  const rows = times.map(t => {
    const r = ran.find(x => x.planned_for === t), next = !r && t > cur && t === (p.times || []).find(x => x > cur);
    const state = r ? lcTag_('Ran ' + lcClockAt_(Date.parse(r.started_at)) + ' · ' + r.sent + ' sent', 'live') : t > cur ? lcTag_(next ? 'Next' : 'Planned', next ? 'teal' : '') : lcTag_('Missed', 'warn');
    const why = Object.keys(st).filter(b => st[b] === t).map(b => LC_SEQ[b]).join(' · ') || 'Batch send time';
    return '<li class="' + (r ? 'done' : next ? 'next' : '') + '"><time>' + lcEsc_(lcClock_(t)) + '</time><div class="main"><small>' + lcEsc_(why) + '</small></div>' + state + '</li>';
  }).join('');
  const extra = ran.filter(r => !r.planned_for).length;
  return '<div class="lc-card"><div class="lc-card-h"><h3>Today’s runs</h3><small>Times in ' + lcEsc_(zone) + '</small></div><ol class="lc-runs">' + rows + '</ol>' +
    (extra ? '<p class="lc-note" style="padding:0 18px 12px;margin:0">Plus ' + extra + ' started by hand.</p>' : '') +
    ((p.dropped || []).length ? '<p class="lc-note" style="padding:0 18px 12px;margin:0">More than 12 send times today: ' + lcEsc_(p.dropped.map(lcClock_).join(', ')) + ' wait for the next run.</p>' : '') + '</div>';
}
const CMP_ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>';
const lcHour_ = h => { h = Number(h) || 9; return (h % 12 || 12) + (h < 12 ? ' AM' : ' PM'); };
const lcStepName_ = id => { const s = LC.ov && LC.ov.steps.find(x => x.step_id === id); return s ? s.name : id; };

function lcContacts_() {
  const bar = '<div class="lc-bar"><label class="lc-search">' + LC_ICON.search + '<input type="search" placeholder="Search people" value="' + lcEsc_(LC.q) +
    '" data-lc-input="q" aria-label="Search people"></label><div class="lc-seg">' +
    [['', 'All'], ['B', 'MCP Legacy'], ['C', 'MCP Startup']].map(([k, l]) => '<button data-act="bucket" data-bucket="' + k + '" class="' + (LC.bucket === k ? 'on' : '') + '">' + l + '</button>').join('') +
    '</div>' + (LC.contacts ? lcReviewChip_() + (typeof wtChips_ === 'function' ? wtChips_() : '') : '') + (lcCan_('edit_contacts') ? '<button class="lc-btn" data-act="batch">Start a batch</button><button class="lc-btn" data-act="crm-leads">MCP leads</button><button class="lc-btn" data-act="cleanup">Clean up</button><button class="lc-btn" data-act="staff">Add staff</button><button class="lc-btn primary" data-act="import">Import</button>' : '') + '</div>';
  if (!LC.contacts) return bar + '<div class="lc-sk" style="height:320px"></div>';
  const q = LC.q.trim().toLowerCase();
  // Merged and removed contacts stay in the engine (history, pointers) but not in the list.
  const tags = typeof tagMatches_ === 'function';
  const rows = LC.contacts.contacts.filter(c => !/^(merged|removed)$/.test(c.review_status || '') && (!LC.bucket || c.bucket === LC.bucket) && (typeof wtReviewMatch_ === 'function' ? wtReviewMatch_(c) : (!LC.review || c.review_status === LC.review)) &&
    (!tags || tagMatches_(c)) && (!q || [c.first_name, c.last_name, c.email].concat(c.tags || []).some(v => String(v || '').toLowerCase().includes(q))));
  const sel = tags && lcCan_('edit_contacts');
  const filters = tags ? tagFilterBar_() : '', bulk = tags ? tagBulkBar_(rows) : '';
  const batches = typeof lcBatchesCard_ === 'function' ? lcBatchesCard_() : '';
  const waitTop = (typeof wtBanner_ === 'function' && !LC.review ? wtBanner_() : '') + (typeof wtActionBar_ === 'function' ? wtActionBar_(rows) : '');
  if (!rows.length) return bar + filters + waitTop + batches + '<div class="lc-card"><div class="lc-empty">No one matches.</div></div>';
  const shownIds = rows.slice(0, 2000).map(c => c.contact_id), allOn = sel && shownIds.length && shownIds.every(id => TAGS.sel.has(id));
  return bar + filters + bulk + waitTop + batches + '<div class="lc-card"><table class="lc-table"><thead><tr>' +
    (sel ? '<th class="lc-selcol"><input type="checkbox" data-act="tag-selall" data-ids="' + lcEsc_(JSON.stringify(shownIds)) + '"' + (allOn ? ' checked' : '') + ' aria-label="Select everyone shown"></th>' : '') + '<th>Person</th><th class="hide-xs">Sequence</th><th>Status</th><th class="hide-sm">Last email</th></tr></thead><tbody>' +
    rows.map(c => {
      const seq = c.sequence, last = c.last_email;
      const wt = !seq && typeof wtStatusTag_ === 'function' ? wtStatusTag_(c) : '';
      const status = wt ? wt : !seq ? (c.review_status === 'needs_review' ? lcTag_('Needs review', 'warn') : c.review_status === 'possible_duplicate' ? lcTag_('Possible duplicate', 'warn') : c.review_status === 'held' ? lcTag_('Before go-live', '') : c.review_status === 'removed' ? lcTag_('Removed', '')
        : c.review_status === 'confirmed' ? lcTag_(c.bucket === 'C' ? 'From the portal' : 'Starting', 'live') : lcTag_('Not enrolled', '')) : seq.status === 'active' ? lcTag_('Active', 'live') :
        seq.status === 'stopped' ? lcTag_('Stopped · ' + lcStopWord_(seq.stop_reason), 'warn') : lcTag_(seq.status, '');
      return '<tr class="click' + (sel && TAGS.sel.has(c.contact_id) ? ' sel' : '') + '" data-act="contact" data-id="' + lcEsc_(c.contact_id) + '" tabindex="0">' +
        (sel ? '<td class="lc-selcol"><input type="checkbox" data-act="tag-sel" data-id="' + lcEsc_(c.contact_id) + '"' + (TAGS.sel.has(c.contact_id) ? ' checked' : '') + ' aria-label="Select"></td>' : '') +
        '<td class="lc-fit"><div class="lc-person"><span class="lc-avatar">' +
        lcEsc_(lcInitials_(c.first_name, c.last_name)) + '</span><div><b>' + lcEsc_([c.first_name, c.last_name].filter(Boolean).join(' ')) +
        (c.is_test ? ' <span class="lc-tag" style="height:18px;font-size:10.5px">Test</span>' : '') + '</b><small>' + lcEsc_(c.email) + '</small>' +
        ((c.tags || []).length ? '<div class="lc-tagrow sm">' + c.tags.map(t => '<span class="lc-tagchip">' + lcEsc_(t) + '</span>').join('') + '</div>' : '') + '</div></div></td>' +
        '<td class="hide-xs"><span class="lc-seqname"><span class="lc-bkt sm">' + lcEsc_(c.bucket) + '</span>' + lcEsc_(LC_SEQ[c.bucket] || '') + '</span></td>' +
        '<td>' + status + '</td><td class="hide-sm">' + (last ? lcEsc_(lcStepName_(last.step_id)) + ' <span style="color:var(--muted)">· ' + lcAgoT_(last.sent_at) + '</span>' : '<span style="color:var(--muted)">–</span>') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

// Imported people wait in Needs review until a batch starts them.
function lcReviewChip_() {
  const n = LC.contacts.contacts.filter(c => c.review_status === 'needs_review').length;
  if (!n && LC.review !== 'needs_review') return '';
  return '<button class="lc-btn sm' + (LC.review === 'needs_review' ? ' primary' : '') + '" data-act="review">Needs review · ' + n + '</button>';
}

// ── Drawers ───────────────────────────────────────────────────────────────────
function lcOpenDrawer_(kind, id) {
  lcCloseDrawer_();
  const layer = document.createElement('div');
  layer.className = 'lc-layer';
  layer.innerHTML = '<div class="lc-scrim" data-act="close"></div><aside class="lc-drawer" role="dialog" aria-modal="true"></aside>';
  document.body.appendChild(layer);
  layer.addEventListener('click', lcOnClick_);
  layer.addEventListener('change', e => { if (e.target.dataset.setup) lcSetupInput_(e.target); });
  layer.addEventListener('input', e => { if (e.target.dataset.setup === 'offset') lcSetupInput_(e.target); });
  LC.drawer = { kind, id, tab: kind === 'step' ? 'performance' : 'timeline', data: null, layer };
  document.addEventListener('keydown', lcOnKey_);
  lcRenderDrawer_();
  const view = kind === 'step' ? 'step' : 'contact';
  lcLoad_(view, { id, mode: LC.mode || '' }, (data) => { if (LC.drawer && LC.drawer.id === id) { LC.drawer.data = data; lcRenderDrawer_(); } }, id + ':' + (LC.mode || ''))
    .catch(e => { if (LC.drawer && LC.drawer.id === id && !LC.drawer.data) { LC.drawer.error = e; lcRenderDrawer_(); } });
}
function lcCloseDrawer_() {
  if (!LC.drawer) return;
  LC.drawer.layer.remove();
  document.removeEventListener('keydown', lcOnKey_);
  LC.drawer = null;
}
function lcOnKey_(e) { if (e.key === 'Escape') lcCloseDrawer_(); }

function lcRenderDrawer_() {
  const D = LC.drawer; if (!D) return;
  if (typeof hlpAfterRender_ === 'function') hlpAfterRender_();
  const el = D.layer.querySelector('.lc-drawer');
  const close = '<button class="lc-icon-btn" data-act="close" aria-label="Close">' + LC_ICON.x + '</button>';
  if (D.error) { el.innerHTML = '<div class="lc-dr-h"><div class="t"></div>' + close + '</div>' + lcErrorView_(D.error); return; }
  if (D.kind === 'step') {
    const s = (D.data && D.data.step) || (LC.ov && LC.ov.steps.find(x => x.step_id === D.id)) || { name: '', bucket: '' };
    const tabs = [['performance', 'Performance'], ['recipients', 'Recipients'], ['templates', 'Templates'], ['setup', 'Setup']];
    const single = typeof sglIsSingle_ === 'function' && sglIsSingle_(s.bucket);
    el.innerHTML = '<div class="lc-dr-h"><span class="lc-bkt' + (single ? ' lc-sgl-ic' : '') + '">' + (single ? CMP_ICON.mail : lcEsc_(s.bucket)) + '</span><div class="t"><small>' +
      (single ? 'Single email' + (s.timing && s.timing.date ? ' · ' + lcEsc_(sglWhen_(s)) : '') : lcEsc_(LC_SEQ[s.bucket] || '') + ' · Email ' + lcEsc_(s.order || '')) +
      '</small><h2>' + lcEsc_(s.name) + '</h2></div>' + close + '</div>' +
      '<div class="lc-dr-tabs">' + tabs.map(([k, l]) => '<button data-act="dtab" data-tab="' + k + '" class="' + (D.tab === k ? 'on' : '') + '">' + l + '</button>').join('') + '</div>' +
      '<div class="lc-dr-body">' + (D.data ? lcStepTab_(D) : '<div class="lc-sk" style="height:120px"></div><div class="lc-sk" style="height:200px"></div>') + '</div>';
  } else {
    const c = D.data && D.data.contact;
    el.innerHTML = '<div class="lc-dr-h"><span class="lc-avatar" style="width:40px;height:40px;font-size:14px">' + lcEsc_(c ? lcInitials_(c.first_name, c.last_name) : '') +
      '</span><div class="t"><small>' + lcEsc_(c ? c.email : '') + '</small><h2>' + lcEsc_(c ? [c.first_name, c.last_name].filter(Boolean).join(' ') : '') + '</h2></div>' + close + '</div>' +
      '<div class="lc-dr-body">' + (D.data ? lcContactBody_(D.data) : '<div class="lc-sk" style="height:220px"></div>') + '</div>';
  }
}

function lcStepTab_(D) {
  const d = D.data, s = d.step, c = s.counts, t = s.tracking || {}, sent = c.sent;
  if (D.tab === 'templates' && typeof lcTemplatesTab_ === 'function') return lcTemplatesTab_(D);
  if (D.tab === 'recipients') {
    if (!d.recipients.length) return '<div class="lc-empty">No one has received this email yet.</div>';
    return '<div>' + d.recipients.map(r => {
      const g = r.engagement || {};
      return '<div class="lc-rcp"><span class="lc-avatar">' + lcEsc_(lcInitials_(...String(r.name).split(' '))) + '</span><div class="who"><b>' + lcEsc_(r.name) +
        '</b><small>' + lcEsc_(r.email) + ' · ' + lcEsc_(r.sent_at ? lcStamp_(r.sent_at) : (LC_STATE[r.state] || [r.state])[0]) + '</small>' +
        (g.reply_snippet ? '<div class="lc-quote">' + lcEsc_(g.reply_snippet) + '</div>' : '') + '</div>' +
        '<div class="lc-ev">' + (r.state === 'sent' ? lcEvidence_(g) : lcStateTag_(r.state)) + '</div></div>';
    }).join('') + '</div>';
  }
  if (D.tab === 'setup') {
    if (typeof sglIsSingle_ === 'function' && sglIsSingle_(s.bucket)) return sglSetupTab_(D);
    if (D.edit) return lcSetupForm_(D);
    const rev = (d.revisions || []).find(r => r.status === 'published');
    const rules = (s.stop_rules || []).map(r => '<li>' + LC_ICON.stop + '<span>' + lcEsc_((LC_SIGNAL[r.signal] || r.signal) + ' ' + (LC_STOPS[r.stops] || 'stops it')) + '</span></li>').join('');
    const seqSteps = LC.ov.steps.filter(x => x.bucket === s.bucket);
    const off = s.status === 'off';
    const edit = lcCan_('edit_config') ? '<button class="lc-btn sm" data-act="setup-edit" data-do="open" style="margin-left:auto">Edit</button>' : '';
    return (off ? '<div class="lc-wiz-warn">' + LC_ICON.alert + '<div><b>This email is turned off</b><small>Nobody gets it. The emails after it still go out on their usual days.</small></div></div>' : '') +
      '<div class="lc-sec"><h4 style="display:flex;align-items:center">Sends' + edit + '</h4><dl class="lc-kv"><dt>When</dt><dd>' + lcEsc_(lcTiming_(s.timing, seqSteps)) +
      ' <span style="color:var(--muted)">· ' + (lcImmediate_(s.timing) ? 'about a minute after approval' : 'at ' + lcEsc_(lcClock_(lcSendTime_(s.bucket)))) + '</span></dd>' +
      '<dt>From</dt><dd>' + lcEsc_(lcStepFrom_(s)) + (lcCan_('edit_drafts') ? ' <button class="lc-link" data-act="step-sender" data-id="' + lcEsc_(s.step_id) + '">Change</button>' : '') + '</dd>' +
      '<dt>Type</dt><dd>' + (s.category === 'service' ? 'Service' : 'Marketing') + '</dd>' +
      '<dt>Audience</dt><dd>' + s.audience + ' in ' + lcEsc_(LC_SEQ[s.bucket]) + '</dd></dl></div>' +
      '<div class="lc-sec"><h4>Content</h4>' + (rev ? '<dl class="lc-kv"><dt>Subject</dt><dd>' + lcEsc_(rev.subject) + '</dd>' +
        (rev.preheader ? '<dt>Preview</dt><dd>' + lcEsc_(rev.preheader) + '</dd>' : '') +
        '<dt>Version</dt><dd>' + rev.rev_no + ' · approved ' + lcEsc_(lcDate_(rev.approved_at)) + ' by ' + lcEsc_(String(rev.approver).split('@')[0]) + '</dd></dl>'
        : '<div class="lc-empty" style="text-align:left;padding:0">Not approved yet.</div>') + '</div>' +
      '<div class="lc-sec"><h4>Stops when</h4>' + (rules ? '<ul class="lc-rules">' + rules + '</ul>' : '<div style="color:var(--muted)">Nothing stops this email; it’s a service email.</div>') +
      '<div class="lc-note">Unsubscribes and bounces always stop every email.</div></div>';
  }
  if (!sent) return '<div class="lc-empty">No sends yet. Results appear here after the first one.</div>';
  const row = (label, n, cls) => '<div class="lc-fr"><span>' + label + '</span><div class="track"><div class="fill ' + (cls || '') + '" style="width:' +
    (sent ? Math.max(n ? 3 : 0, Math.round(100 * n / sent)) : 0) + '%"></div></div><span class="v">' + n + ' <small>' + lcPct_(n, sent) + '</small></span></div>';
  const links = Object.entries(d.links || {}).sort((a, b) => b[1] - a[1]);
  return '<div class="lc-mini"><div><b class="num">' + sent + '</b><span>Sent</span></div><div><b class="num">' + c.sent_7d + '</b><span>This week</span></div>' +
    '<div><b class="num">' + (t.verified_clicks || 0) + '</b><span>Verified clicks</span></div><div><b class="num">' + (t.replied || 0) + '</b><span>Replies</span></div></div>' +
    '<div class="lc-sec"><h4>Engagement</h4><div class="lc-funnel">' + row('Delivered', sent - (t.bounced || 0), 'teal') + row('Opened', t.opened_est || 0) +
    row('Clicked', t.clicked || 0) + row('Verified click', t.verified_clicks || 0) + row('Replied', t.replied || 0) + '</div>' +
    '<div class="lc-note">Opens are estimates. Only verified clicks and replies count as real interest.</div></div>' +
    ((t.unsubscribed || t.bounced || t.scanner_like) ? '<div class="lc-sec"><h4>Also</h4><dl class="lc-kv">' +
      (t.unsubscribed ? '<dt>Unsubscribed</dt><dd class="num">' + t.unsubscribed + '</dd>' : '') + (t.bounced ? '<dt>Bounced</dt><dd class="num">' + t.bounced + '</dd>' : '') +
      (t.scanner_like ? '<dt>Automated</dt><dd class="num">' + t.scanner_like + ' <span style="color:var(--muted)">ignored</span></dd>' : '') + '</dl></div>' : '') +
    (links.length ? '<div class="lc-sec"><h4>Links clicked</h4><dl class="lc-kv">' + links.map(([k, v]) => '<dt>' + lcEsc_(k === 'button1' ? 'Main button' : k === 'website' ? 'Website' : 'Link ' + k.replace(/^a/, '')) +
      '</dt><dd class="num">' + v + '</dd>').join('') + '</dl></div>' : '');
}

function lcContactBody_(d) {
  const c = d.contact;
  const enr = d.enrollments.map(e => '<span class="lc-tag ' + (e.status === 'active' ? 'live' : e.status === 'stopped' ? 'warn' : '') + '"><i></i>' +
    lcEsc_(LC_SEQ[e.sequence_id] || e.sequence_id) + ' · ' + lcEsc_(e.status === 'stopped' ? 'stopped, ' + lcStopWord_(e.stop_reason) : e.status) + '</span>').join(' ');
  const tl = d.deliveries.length ? '<ul class="lc-tl">' + d.deliveries.map(x => '<li class="' + (x.state === 'sent' ? '' : 'off') + '"><b>' + lcEsc_(lcStepName_(x.step_id)) +
    '</b><small>' + lcEsc_(x.sent_at ? lcDate_(x.sent_at) : (LC_STATE[x.state] || [x.state])[0]) + '</small>' +
    '<div class="lc-ev" style="justify-content:flex-start;margin-top:6px">' + (x.state === 'sent' ? lcEvidence_(x.engagement) : lcStateTag_(x.state)) + '</div>' +
    (x.engagement && x.engagement.reply_snippet ? '<div class="lc-quote">' + lcEsc_(x.engagement.reply_snippet) + '</div>' : '') + '</li>').join('') + '</ul>'
    : '<div class="lc-empty">No emails yet.</div>';
  return '<div class="lc-sec"><h4>Sequence</h4>' + (enr || '<span style="color:var(--muted)">Not enrolled</span>') + '</div>' +
    '<div class="lc-sec"><h4>Details</h4><dl class="lc-kv"><dt>Group</dt><dd>' + lcEsc_(LC_SEQ[c.bucket] || c.bucket) + '</dd>' +
    (c.address && c.address !== 'hidden' ? '<dt>Address</dt><dd>' + lcEsc_(c.address) + '</dd>' : '') +
    (c.startup_date ? '<dt>Startup</dt><dd>' + lcEsc_(c.startup_date) + '</dd>' : '') + '</dl></div>' +
    (typeof tagSection_ === 'function' ? tagSection_(c) : '') +
    '<div class="lc-sec"><h4>Emails</h4>' + tl + '</div>';
}

// ── Email Setup editing (Admin.js → publish_rules) ───────────────────────────
// Timing, what stops it, and on/off. Saving makes a new rules version; the person
// chooses whether people already in the sequence move to it or keep the old one.
function lcSetupStart_(D) {
  const s = D.data.step, t = s.timing;
  D.edit = { anchor: t.anchor, offset: t.offset, before: t.anchor === 'startup' && t.offset < 0, status: s.status === 'off' ? 'off' : 'active',
    stops: Object.fromEntries(['reply', 'click', 'form'].map(k => [k, (s.stop_rules || []).some(r => r.signal === k)])) };
}
function lcSetupForm_(D) {
  const s = D.data.step, t = s.timing, E = D.edit;
  const seqSteps = LC.ov.steps.filter(x => x.bucket === s.bucket);
  const hasStartup = seqSteps.some(x => x.timing && x.timing.anchor === 'startup');
  const prev = t.anchor === 'previous' ? seqSteps.find(x => x.step_id === t.requires) : null;
  const num = (v, min, max) => '<input class="lc-input lc-num" type="number" inputmode="numeric" data-setup="offset" min="' + min + '" max="' + max + '" value="' + lcEsc_(v) + '">';
  let when;
  if (t.repeat_every) when = '<p class="lc-note" style="margin:0">' + lcEsc_(lcTiming_(t, seqSteps)) + '. Repeating emails keep their timing.</p>';
  else if (hasStartup && (t.anchor === 'enrollment' || (t.anchor === 'startup' && t.offset < 0))) {
    const before = E.before;
    when = '<label class="lc-radio"><input type="radio" name="lc-anchor" data-setup="anchor" value="enrollment"' + (before ? '' : ' checked') + '><span><b>When the startup is approved</b><small>About a minute after it’s approved in the portal. It replaces the old plain approval email.</small></span></label>' +
      '<label class="lc-radio"><input type="radio" name="lc-anchor" data-setup="anchor" value="startup"' + (before ? ' checked' : '') + '><span><b>Before the startup</b><small>' +
      (before ? num(-E.offset, 1, 30) + ' days before the startup date' : 'Pick how many days before.') + '</small></span></label>';
  } else if (E.anchor === 'previous') when = '<div class="lc-inline">' + num(E.offset, 1, 60) + '<span>days after “' + lcEsc_(prev ? prev.name : 'the previous email') + '”</span></div>';
  else if (E.anchor === 'enrollment') when = '<div class="lc-inline">' + num(E.offset, 0, 60) + '<span>days after their batch’s start date <small class="lc-dim">(0 = on the start date)</small></span></div>';
  else when = '<div class="lc-inline">' + num(E.offset, 0, 60) + '<span>days after the startup</span></div>';
  const stops = s.category === 'marketing'
    ? '<div class="lc-sec"><h4>Stops when</h4>' + [['reply', 'They reply'], ['click', 'They click a link (verified click)'], ['form', 'They send a service request']].map(([k, l]) =>
        '<label class="lc-check"><input type="checkbox" data-setup="stop" value="' + k + '"' + (E.stops[k] ? ' checked' : '') + '><span>' + l + '</span></label>').join('') +
      '<div class="lc-note">' + (s.bucket === 'B' ? 'A stop ends the whole sequence for that person.' : 'A stop ends the marketing emails; service emails still go out.') + ' Unsubscribes and bounces always stop every email.</div></div>'
    : '<div class="lc-sec"><h4>Stops when</h4><div style="color:var(--muted)">Nothing stops a service email.</div></div>';
  return '<div class="lc-sec"><h4>Send this email</h4><div class="lc-seg"><button data-act="setup-edit" data-do="status" data-v="active" class="' + (E.status === 'active' ? 'on' : '') + '">On</button>' +
      '<button data-act="setup-edit" data-do="status" data-v="off" class="' + (E.status === 'off' ? 'on' : '') + '">Off</button></div>' +
      (E.status === 'off' ? '<div class="lc-note">Off: nobody gets it. The emails after it still go out on their usual days.</div>' : '') + '</div>' +
    '<div class="lc-sec"><h4>When</h4>' + when + (E.anchor === 'enrollment' && hasStartup ? '' : '<div class="lc-note">It goes out at ' + lcEsc_(lcClock_(lcSendTime_(s.bucket))) + ' ' + lcEsc_(lcZoneOn_()) + ' (the campaign’s send time).</div>') + '</div>' + stops +
    '<div class="lc-imp-f"><button class="lc-btn" data-act="setup-edit" data-do="cancel">Cancel</button><button class="lc-btn primary" data-act="setup-edit" data-do="save">Save changes</button></div>';
}
function lcSetupInput_(el) {
  const D = LC.drawer; if (!D || !D.edit) return;
  const E = D.edit, k = el.dataset.setup;
  if (k === 'anchor') { E.anchor = el.value; E.before = el.value === 'startup'; E.offset = E.before ? -3 : 0; lcRenderDrawer_(); }
  // In "before the startup" the box shows days before (positive); the rule stores a negative offset.
  else if (k === 'offset') { const n = Math.round(Number(el.value)); if (el.value !== '' && Number.isFinite(n)) E.offset = E.before ? -Math.abs(n) : n; }
  else if (k === 'stop') E.stops[el.value] = el.checked;
}
async function lcSetupAct_(t) {
  const D = LC.drawer; if (!D || !D.data) return;
  const s = D.data.step, what = t.dataset.do;
  if (what === 'open') { lcSetupStart_(D); return lcRenderDrawer_(); }
  if (what === 'cancel') { D.edit = null; return lcRenderDrawer_(); }
  if (what === 'status') { D.edit.status = t.dataset.v; return lcRenderDrawer_(); }
  if (what !== 'save') return;
  const E = D.edit, tm = s.timing, edit = { step_id: s.step_id };
  if (E.status !== (s.status === 'off' ? 'off' : 'active')) edit.status = E.status;
  if (!tm.repeat_every) {
    if (E.anchor !== tm.anchor) edit.anchor = E.anchor;
    if (E.offset !== tm.offset || edit.anchor) edit.offset = E.offset;
  }
  if (s.category === 'marketing') {
    const was = Object.fromEntries(['reply', 'click', 'form'].map(k => [k, (s.stop_rules || []).some(r => r.signal === k)]));
    if (['reply', 'click', 'form'].some(k => !!E.stops[k] !== was[k])) edit.stops = E.stops;
  }
  if (Object.keys(edit).length === 1) { D.edit = null; lcRenderDrawer_(); return lcToast_('Nothing changed'); }
  const r = await lcSetupScope_(s, edit);
  if (!r) return;
  D.edit = null;
  lcToast_(r.unchanged ? 'Nothing changed' : 'Saved · ' + (r.moved ? r.moved + (r.moved === 1 ? ' person follows' : ' people follow') + ' the new setup' : 'new people follow the new setup'));
  lcRefresh_(true);
  lcFetch_('step', { id: D.id, mode: LC.mode || '', fresh: '1' }).then(data => { if (LC.drawer === D) { D.data = data; lcRenderDrawer_(); } }).catch(() => {});
}
// Who follows the change: everyone in the sequence now, or only people who join later.
function lcSetupScope_(s, edit) {
  const n = s.audience || 0, seq = LC_SEQ[s.bucket];
  return new Promise(resolve => {
    const layer = document.createElement('div');
    layer.className = 'lc-layer';
    layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim" data-x="0"></div><div class="lc-sheet" role="dialog" aria-modal="true">' +
      '<h3>Save the new setup for “' + lcEsc_(s.name) + '”?</h3><p>Nobody ever gets an email twice: anyone who already got it is never sent it again.</p>' +
      '<label class="lc-radio"><input type="radio" name="lc-scope" value="new" checked><span><b>Only people who join from now on</b><small>Recommended. The ' + n + ' ' + (n === 1 ? 'person' : 'people') + ' already in ' + lcEsc_(seq) + ' keep the old setup; nothing changes for them.</small></span></label>' +
      '<label class="lc-radio"><input type="radio" name="lc-scope" value="all"><span><b>Also the ' + n + ' ' + (n === 1 ? 'person' : 'people') + ' already in it</b><small>Anyone who hasn’t had this email yet follows the new setup. If their new day has already passed, it goes out at the next run or is skipped as too late.</small></span></label>' +
      '<p class="lc-note" data-err hidden style="color:var(--red)"></p>' +
      '<div class="row"><button class="lc-btn" data-x="0">Cancel</button><button class="lc-btn primary" data-x="1">Save</button></div></div>';
    let saving = false;
    const done = v => { layer.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = e => { if (e.key === 'Escape' && !saving) { e.stopPropagation(); done(null); } };
    layer.addEventListener('click', async e => {
      const x = e.target.closest('[data-x]'); if (!x || saving) return;
      if (x.dataset.x !== '1') return done(null);
      saving = true; lcBusyBtn_(x, true);
      const scope = layer.querySelector('input[name="lc-scope"]:checked').value;
      const r = await lcAdmin_('publish_rules', { edits: [edit], scope, base_rev: LC.ov.engine.rule_rev }).catch(() => ({ ok: false, error: 'Network error' }));
      saving = false; lcBusyBtn_(x, false);
      if (r.ok) return done(r);
      const err = layer.querySelector('[data-err]'); err.hidden = false;
      err.textContent = r.error === 'unknown action' ? 'The engine needs an update before setups can be changed.' : (r.error || 'That didn’t work');
    });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(layer);
    layer.querySelector('.lc-btn.primary').focus();
  });
}

// ── Actions ───────────────────────────────────────────────────────────────────
// Each one: confirm if it matters, call the engine, say what happened, then refresh.
// The name people see in their inbox, and the name emails are signed with.
async function lcEditSender_() {
  const e = LC.ov.engine, disp = e.sender_display_name || ((e.sender_name || 'Tony') + ' | Mission Custom Pool Solutions'), sign = e.sender_name || 'Tony';
  const html = '<p>How your emails show up for customers.</p>' +
    '<label class="lc-fld"><span>Name in their inbox</span><input class="lc-input" data-snd="display" maxlength="60" value="' + lcEsc_(disp) + '"><small class="lc-fld-help">Shown in the From column. Gmail cuts long names around 20 characters, e.g. “Tony at MCPS” shows in full.</small></label>' +
    '<label class="lc-fld" style="margin-top:12px"><span>Signs emails as</span><input class="lc-input" data-snd="sign" maxlength="40" value="' + lcEsc_(sign) + '"><small class="lc-fld-help">The name at the bottom of emails made in the portal, and {{SenderName}} in templates.</small></label>' +
    '<div class="lc-from-prev"><span>Preview</span><b data-snd-prev>' + lcEsc_(disp) + '</b><em>Welcome to Mission Custom Pool Solutions</em></div>';
  const done = lcConfirm_({ title: 'Who your emails are from', html, ok: 'Save',
    run: layer => lcAdmin_('set_sender', { display_name: layer.querySelector('[data-snd="display"]').value, sign_name: layer.querySelector('[data-snd="sign"]').value }) });
  setTimeout(() => { const l = [...document.querySelectorAll('.lc-layer')].pop(), i = l && l.querySelector('[data-snd="display"]'), pv = l && l.querySelector('[data-snd-prev]');
    if (i && pv) i.addEventListener('input', () => { pv.textContent = i.value; }); }, 0);
  const r = await done;
  if (!r || !r.ok) return;
  Object.assign(LC.ov.engine, { sender_display_name: r.display_name, sender_name: r.sign_name });
  lcToast_('Saved. New emails come from “' + r.display_name + '”.');
  lcRenderBody_();
}

// Linking another address in Tony's Gmail, step by step (for Tony). Every label quoted
// here is from Google's own help pages (Gmail 22370, Accounts 185833 / 185839, checked
// 2026-11-12) and from Mau's Admin console screen for step 1; where Google doesn't name a control, the step says what to type instead.
// The last step asks the engine (list_senders) whether Gmail now lists the address.
function lcLinkGuide_(email, name, stepId) {
  const owner = LC.senders_owner || 'antonio@mcpoolsolutions.org';
  const key = 'lc_link_guide_' + email;
  let done = {}; try { done = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { done = {}; }
  const copy = (v, label) => '<span class="lc-gd-val"><code>' + lcEsc_(v) + '</code><button class="lc-link" data-gd-copy="' + lcEsc_(v) + '">Copy' + (label ? ' ' + lcEsc_(label) : '') + '</button></span>';
  const who = (txt, mine) => '<span class="lc-gd-who' + (mine ? ' mine' : '') + '">' + lcEsc_(txt) + '</span>';
  const ownerDomain = owner.split('@')[1] || 'mcpoolsolutions.org';
  const steps = [
    ['admin', 'An admin allows outside mail servers (once)', who('Admin of ' + ownerDomain, true),
      '<p>Gmail blocks step 5 until this is on. Without it Tony sees “Functionality not enabled… contact your domain administrator”. An admin of ' + lcEsc_(ownerDomain) + ' does this once:</p><ol>' +
      '<li>Open <a target="_blank" rel="noopener" href="https://admin.google.com">admin.google.com</a> and sign in as an admin of ' + lcEsc_(ownerDomain) + '.</li>' +
      '<li>Go to <b>Apps</b> → <b>Google Workspace</b> → <b>Settings for Gmail</b> → <b>End User Access</b> (or open <a target="_blank" rel="noopener" href="https://admin.google.com/ac/apps/gmail/enduseraccess">this page</a> directly). On the left, keep the top organization selected.</li>' +
      '<li>Find <b>Allow per-user outbound gateways</b> and tick “Allow users to send mail through an external SMTP server when configuring a “from” address hosted outside your email domain” so it reads <b>ON</b>.</li>' +
      '<li>Click <b>Save</b>. Google shows “Allow per-user outbound gateways settings updated”. It can take up to 24 hours to apply, usually much less.</li></ol>'],
    ['private', 'Open a private window for ' + email, who('No sign-in yet'),
      '<p>Keeps Tony’s account and the MCP account apart. In Chrome press <kbd>⌘</kbd> <kbd>Shift</kbd> <kbd>N</kbd> on a Mac, or <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>N</kbd> on Windows. A dark window opens. Steps 3, 4 and 6 happen in that window.</p>'],
    ['2sv', 'Turn on 2-Step Verification for ' + email, who('Private window · ' + email),
      '<p>Copy this link, paste it in the private window, and sign in as ' + lcEsc_(email) + '.</p>' + copy('https://myaccount.google.com/signinoptions/two-step-verification', 'link') +
      '<p>Select <b>Turn on 2-Step Verification</b> and follow the on-screen steps. It asks for a phone number for codes. If it already says it’s on, go to step 4.</p>' +
      '<p class="lc-gd-stop">If Google says you can’t turn it on or to contact your administrator, stop here and tell Mau.</p>'],
    ['apppw', 'Make an app password', who('Private window · ' + email),
      '<p>In the same private window, open this link.</p>' + copy('https://myaccount.google.com/apppasswords', 'link') +
      '<p>Type <b>MCPS Email</b> as the name and create it. Google shows a 16-character code. Copy it and keep this window open; you paste it in step 5.</p>' +
      '<p class="lc-gd-stop">If the page says app passwords aren’t available for this account, stop here and tell Mau. The MCP Google admin has them switched off.</p>'],
    ['gmail', 'Add the address in Tony’s Gmail', who('Normal window · ' + owner, true),
      '<p>Go back to the normal Chrome window (signed in as ' + lcEsc_(owner) + ') and open Gmail’s settings:</p>' +
      '<p><a class="lc-btn sm" target="_blank" rel="noopener" href="https://mail.google.com/mail/?authuser=' + encodeURIComponent(owner) + '#settings/accounts">Open Tony’s Gmail settings</a></p>' +
      '<p>Check the picture in the top right is Tony’s. The tab is called <b>Accounts and import</b> (on some accounts just <b>Accounts</b>).</p><ol>' +
      '<li>In the <b>Send mail as</b> section, click <b>Add another email address</b>. A small window opens.</li>' +
      '<li>Name: ' + copy(name || 'Mission Custom Pools') + '</li><li>Email address: ' + copy(email) + '</li>' +
      '<li>Leave the checkbox under it as it is. Click <b>Next Step</b>.</li>' +
      '<li>Gmail asks for the mail server. Fill in:<br>SMTP server ' + copy('smtp.gmail.com') + '<br>Port ' + copy('587') + '<br>Username ' + copy(email) + '<br>Password: the code from step 4</li>' +
      '<li>Keep the TLS option selected (port 587 uses TLS). Click <b>Add Account</b>.</li></ol>' +
      '<p class="lc-gd-stop">If Gmail doesn’t ask for a mail server and shows <b>Send verification</b> instead, click it and go to step 6.</p>' +
      '<p class="lc-gd-stop">“Couldn’t reach server” or a password error: check the port is 587 and paste the step 4 code again. “Functionality not enabled”: step 1 isn’t done yet (or hasn’t taken effect). Still failing, tell Mau.</p>'],
    ['confirm', 'Confirm from ' + email + '’s inbox', who('Private window · ' + email),
      '<p>In the private window open ' + copy('https://mail.google.com', 'link') + '</p>' +
      '<p>Find the email from <b>send-as-noreply@google.com</b> and click the link in it. Not there after a minute? Look in Spam.</p>'],
    ['check', 'Check it here', who('This page'),
      '<p>Press <b>Check the link</b> below. The engine asks Tony’s Gmail whether ' + lcEsc_(email) + ' is linked' + (stepId ? ' and, if it is, makes it this email’s sender' : '') + '. Then close the private window.</p>']
  ];
  const html = '<p>About 10 minutes. You need Tony’s login and ' + lcEsc_(email) + '’s login. Tick each step as you finish it; this page remembers where you are.</p>' +
    '<ol class="lc-gd">' + steps.map(([id, title, w, body], i) => '<li class="lc-gd-step' + (done[id] ? ' done' : '') + '" data-gd="' + id + '">' +
      '<label class="lc-gd-h"><input type="checkbox" data-gd-done="' + id + '"' + (done[id] ? ' checked' : '') + '><span class="n">' + (i + 1) + '</span><b>' + lcEsc_(title) + '</b></label>' +
      '<div class="lc-gd-b">' + w + body + '</div></li>').join('') + '</ol>';
  const p = lcConfirm_({ title: 'Link ' + email + ' in Tony’s Gmail', html, ok: 'Check the link', cancel: 'Close', wide: true,
    run: async () => {
      const r = await lcAdmin_('list_senders', {});
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Couldn’t reach the engine. Try again.' };
      LC.senders_owner = r.owner;
      if (!(r.linked || []).includes(email)) return { ok: false, error: 'Not linked yet. Gmail doesn’t list ' + email + '. Check step 6 (the link in the email) and try again.' };
      try { localStorage.removeItem(key); } catch (e) { /* fine */ }
      // Linked: this email now comes from it (no separate Save needed).
      let saved = null;
      if (stepId) {
        const w = await lcAdmin_('set_step_sender', { step_id: stepId, email, name: name || email });
        if (!w || !w.ok) return { ok: false, error: 'Linked, but saving it as this email’s sender failed: ' + ((w && w.error) || 'try Save') };
        saved = w.sender;
      }
      lcToast_(email + ' is linked' + (saved ? ' and set as the sender' : '') + '. Send a test to check it.');
      return { ok: true, linked: r.linked, sender: saved };
    } });
  const layer = [...document.querySelectorAll('.lc-layer')].pop();
  layer.addEventListener('change', ev => {
    const id = ev.target.dataset.gdDone; if (!id) return;
    done[id] = ev.target.checked; ev.target.closest('.lc-gd-step').classList.toggle('done', ev.target.checked);
    try { localStorage.setItem(key, JSON.stringify(done)); } catch (e) { /* fine */ }
  });
  layer.addEventListener('click', ev => {
    const b = ev.target.closest('[data-gd-copy]'); if (!b) return;
    ev.preventDefault();
    const v = b.dataset.gdCopy, label = b.dataset.label || (b.dataset.label = b.textContent);
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = label; }, 1500); })
      .catch(() => lcToast_('Couldn’t copy. Select the text and copy it.', true));
  });
  return p;
}

// One email from another address (engine Admin.js → step_senders). The address must be
// linked in Tony's Gmail (Settings → Accounts → Send mail as) before the email can be on;
// until then it can be set up here and shows "Not linked yet". Replies always go to Tony.
function lcStepSenderSaved_(stepId, sender) {
  const snd = sender ? { email: sender.email, name: sender.name } : null;
  const step = LC.ov.steps.find(x => x.step_id === stepId);
  if (step) step.sender = snd;
  if (LC.drawer && LC.drawer.data && LC.drawer.data.step && LC.drawer.data.step.step_id === stepId) { LC.drawer.data.step.sender = snd; lcRenderDrawer_(); }
  lcRenderBody_();
}
function lcStepFrom_(s) {
  const e = LC.ov.engine;
  return s.sender ? (s.sender.name || s.sender.email) + ' <' + s.sender.email + '>'
    : (e.sender_display_name || ((e.sender_name || 'Tony') + ' | Mission Custom Pool Solutions')) + ' (Tony’s address)';
}
async function lcEditStepSender_(stepId) {
  const s = LC.ov.steps.find(x => x.step_id === stepId) || (LC.drawer && LC.drawer.data && LC.drawer.data.step);
  if (!s) return;
  const e = LC.ov.engine, tonyName = e.sender_display_name || ((e.sender_name || 'Tony') + ' | Mission Custom Pool Solutions');
  const cur = s.sender, other = !!cur;
  // MCP Legacy emails go to Mission Custom Pools clients: suggest that company's address.
  const sug = s.bucket === 'B' ? { email: 'info@missioncustompools.com', name: 'Mission Custom Pools' } : { email: '', name: '' };
  const html = '<p>Who “' + lcEsc_(s.name) + '” comes from. Every other email keeps its own sender.</p>' +
    '<label class="lc-radio"><input type="radio" name="lc-snd" value="tony"' + (other ? '' : ' checked') + '><span><b>Tony’s address</b><small>' + lcEsc_(tonyName) + '. The usual sender.</small></span></label>' +
    '<label class="lc-radio"><input type="radio" name="lc-snd" value="other"' + (other ? ' checked' : '') + '><span><b>Another address</b><small>An address linked in Tony’s Gmail. Replies still go to Tony, so a reply stops the emails after it as usual.</small></span></label>' +
    '<div data-snd-other' + (other ? '' : ' hidden') + ' style="margin-top:10px">' +
    '<label class="lc-fld"><span>Address</span><input class="lc-input" data-snd="email" type="email" maxlength="120" placeholder="info@missioncustompools.com" value="' + lcEsc_(cur ? cur.email : sug.email) + '"></label>' +
    '<label class="lc-fld" style="margin-top:12px"><span>Name in their inbox</span><input class="lc-input" data-snd="name" maxlength="60" placeholder="Mission Custom Pools" value="' + lcEsc_(cur ? cur.name : sug.name) + '"></label>' +
    '<div class="lc-note" data-snd-status style="margin-top:12px">Checking Tony’s Gmail…</div>' +
    '<button class="lc-btn sm" data-snd-test style="margin-top:8px;display:none">Send a test</button></div>';
  const done = lcConfirm_({ title: 'Who this email is from', html, ok: 'Save',
    run: layer => {
      const pick = layer.querySelector('[name="lc-snd"]:checked').value;
      return lcAdmin_('set_step_sender', pick === 'tony' ? { step_id: stepId, email: '' }
        : { step_id: stepId, email: layer.querySelector('[data-snd="email"]').value, name: layer.querySelector('[data-snd="name"]').value });
    } });
  const layer = [...document.querySelectorAll('.lc-layer')].pop();
  const box = layer.querySelector('[data-snd-other]'), status = layer.querySelector('[data-snd-status]'), test = layer.querySelector('[data-snd-test]');
  const emailIn = layer.querySelector('[data-snd="email"]'), nameIn = layer.querySelector('[data-snd="name"]');
  let linked = null;
  const paint = () => {
    const em = emailIn.value.trim().toLowerCase();
    if (!linked) return;
    if (!em) { status.textContent = 'Linked in Tony’s Gmail: ' + (linked.filter(a => a !== LC.senders_owner).join(', ') || 'none yet') + '.'; test.style.display = 'none'; return; }
    const ok = linked.includes(em);
    status.innerHTML = ok ? '<b style="color:var(--teal)">Linked in Tony’s Gmail.</b> Send a test to check how it looks.'
      : '<b>Not linked yet.</b> You can save it now. The email stays off until ' + lcEsc_(em) + ' is linked in Tony’s Gmail. <button class="lc-link" data-snd-guide>How to link it, step by step</button>';
    test.style.display = ok ? '' : 'none';
    if (ok && LC.senders_test_to) test.textContent = 'Send a test to ' + LC.senders_test_to;
  };
  layer.addEventListener('change', ev => { if (ev.target.name === 'lc-snd') box.hidden = ev.target.value !== 'other'; });
  emailIn.addEventListener('input', paint);
  status.addEventListener('click', async ev => {
    if (!ev.target.closest('[data-snd-guide]')) return;
    ev.preventDefault();
    const r = await lcLinkGuide_(emailIn.value.trim().toLowerCase(), nameIn.value.trim(), stepId);
    if (r && r.ok) { linked = r.linked; paint(); lcStepSenderSaved_(stepId, r.sender); }
  });
  test.addEventListener('click', async ev => {
    ev.preventDefault(); lcBusyBtn_(test, true);
    const r = await lcAdmin_('test_sender', { email: emailIn.value, name: nameIn.value }).catch(() => ({ ok: false, error: 'Network error' }));
    lcBusyBtn_(test, false);
    lcToast_(r.ok ? 'Test sent to ' + r.to + '.' : (r.error || 'The test didn’t send'), !r.ok);
  });
  lcAdmin_('list_senders', {}).then(r => {
    if (!r || !r.ok) { status.textContent = 'Couldn’t check Tony’s Gmail right now.'; return; }
    LC.senders_owner = r.owner; LC.senders_test_to = r.test_to || ''; linked = r.linked || []; paint();
  }).catch(() => { status.textContent = 'Couldn’t check Tony’s Gmail right now.'; });
  const r = await done;
  if (!r || !r.ok) return;
  lcStepSenderSaved_(stepId, r.sender);
  lcToast_(!r.sender ? 'Saved. It comes from Tony’s address.' : r.sender.linked ? 'Saved. It comes from ' + r.sender.email + '.' : 'Saved. Link ' + r.sender.email + ' in Tony’s Gmail before turning it on.');
  lcRenderBody_();
}
const lcRenderRun_ = () => { lcRenderHead_(); if (LC.tab === 'activity') lcRenderBody_(); };
async function lcRunNow_() {
  const live = LC.ov && LC.ov.engine.mode === 'production';
  if (!await lcConfirm_({ title: 'Send due emails now?', ok: 'Send now',
    body: live ? 'Emails that are already due go out to customers right away instead of at the next send time.' : 'Emails that are already due go out now, to test contacts only.' })) return;
  LC.runPending = Date.now(); lcRenderRun_();
  const r = await lcAdmin_('run_now');
  if (!r.ok) { LC.runPending = 0; lcRenderRun_(); return lcToast_(r.error || 'Couldn’t start sending', true); }
  lcToast_(r.status === 'already_queued' ? 'Already starting' : 'Sending starts within a minute');
  lcWatchRun_();
}
// Polls until a run newer than the click shows up, then reports it.
function lcWatchRun_() {
  const since = LC.runPending - 5000;
  const tick = () => {
    if (!LC.runPending) return;
    if (Date.now() - LC.runPending > 7 * 60 * 1000) { LC.runPending = 0; lcRenderRun_(); return lcToast_('It hasn’t reported back yet. Check Activity later.', true); }
    lcFetch_('overview', { mode: LC.mode || '', fresh: '1' }).then(data => {
      const r = (data.runs || []).find(x => Date.parse(x.started_at) >= since && x.finished_at);
      LC.ov = data; if (typeof sglNames_ === 'function') sglNames_(data); lcCacheSet_(lcKey_('overview', LC.mode || 'default'), data);
      if (r) { LC.runPending = 0; lcToast_('Done · ' + r.sent + ' sent'); }
      lcRender_();
      if (LC.runPending) setTimeout(tick, 15000);
    }).catch(() => setTimeout(tick, 15000));
  };
  setTimeout(tick, 20000);
}
async function lcSetEnabled_(on) {
  if (!on && !await lcConfirm_({ title: 'Turn sending off?', ok: 'Turn off', danger: true,
    body: 'No lifecycle email goes out until it’s back on. Nothing is lost; due emails wait.' })) return;
  await lcWrite_('enabled', 'set_enabled', { enabled: on }, on ? 'Sending is on' : 'Sending is off');
}
async function lcSetPaused_(bucket, paused) {
  await lcWrite_('pause' + bucket, 'set_bucket_paused', { bucket, paused }, (paused ? 'Paused ' : 'Resumed ') + LC_SEQ[bucket]);
}
async function lcResolve_(what, id) {
  const copy = {
    mark_sent: { title: 'Mark as sent?', ok: 'Mark sent', body: 'Only if you found this email in Tony’s Sent folder.' },
    resend: { title: 'Resend this email?', ok: 'Resend', body: 'Check Tony’s Sent folder first. If it isn’t there, the next run sends it again.' },
    abandon: { title: 'Abandon this email?', ok: 'Abandon', danger: true, body: 'It won’t be sent, and its draft is deleted.' }
  }[what];
  if (!copy || !await lcConfirm_(copy)) return;
  const done = { mark_sent: 'Marked as sent', resend: 'It sends on the next run', abandon: 'Abandoned' }[what];
  await lcWrite_('r:' + id, what, { delivery_id: id }, done);
}
async function lcCancelBatch_(id) {
  if (!await lcConfirm_({ title: 'Cancel this batch?', ok: 'Cancel batch', danger: true, body: 'Its people stay in Needs review.',
    run: () => lcAdmin_('cancel_batch', { batch_id: id }) })) return;
  lcToast_('Batch cancelled'); lcRefresh_(true);
  LC.contacts = null; lcLoadContacts_(true);
  if (typeof CMP !== 'undefined' && CMP.id) cmpLoadPlan_(CMP.id, true);
}
async function lcWrite_(busyKey, action, params, okText) {
  LC.busy[busyKey] = true; lcRenderBody_();
  const r = await lcAdmin_(action, params).catch(() => ({ ok: false, error: 'Network error' }));
  delete LC.busy[busyKey];
  if (r.ok) lcToast_(okText);
  else if (r.reason === 'quiescence') lcToast_('Not yet: available at ' + lcClockAt_(Date.parse(r.unlock_at)) + ' ' + lcZone_(Date.parse(r.unlock_at)), true);
  else lcToast_(r.error || r.reason || 'That didn’t work', true);
  lcRefresh_(true);
}

// ── Speed check (CP6c) ────────────────────────────────────────────────────────
// Run from the browser console on the Lifecycle page: lcBench(). Measures with
// the signed-in user's real session; only timings are printed.
async function lcBench(n = 20) {
  const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]); };
  const time = async fn => { const t = performance.now(); await fn(); return performance.now() - t; };
  const fresh = [], cached = [], write = [];
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    fresh.push(await time(async () => {
      const r = await fetch('/api/email?op=read&view=overview&fresh=1', { headers: { Authorization: 'Bearer ' + currentSessionToken_() } });
      bytes = Math.max(bytes, (await r.text()).length);
    }));
    cached.push(await time(() => fetch('/api/email?op=read&view=overview', { headers: { Authorization: 'Bearer ' + currentSessionToken_() } }).then(r => r.text())));
  }
  for (let i = 0; i < Math.min(n, 8); i++) write.push(await time(() => lcAdmin_('ping')));
  const out = {
    'Page from cache (ms)': LC.perf ? LC.perf.paint_ms + ' (' + LC.perf.paint_from + ')' : 'reload the page first',
    'Fresh read p50 / p95 (ms)': pct(fresh, 50) + ' / ' + pct(fresh, 95), 'Cached read p50 / p95 (ms)': pct(cached, 50) + ' / ' + pct(cached, 95),
    'Action p50 / p95 (ms)': pct(write, 50) + ' / ' + pct(write, 95), 'Overview size (KB)': Math.round(bytes / 1024),
    'Budgets met': (pct(fresh, 95) < 1500 && pct(write, 95) < 5000 && bytes < 1048576 && LC.perf && LC.perf.paint_ms < 500) ? 'yes' : 'NO'
  };
  console.table(out);
  return out;
}

// ── Events ────────────────────────────────────────────────────────────────────
// One click, one action: while an action that talks to the engine is in flight,
// its button shows a spinner and repeat clicks (on it or a re-rendered copy) do nothing.
const LC_INFLIGHT = new Set();
function lcOnClick_(e) {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const key = t.dataset.act + ':' + (t.dataset.id || t.dataset.key || t.dataset.bucket || t.dataset.do || '');
  if (t.disabled) return;
  lcGuard_(key, t, () => lcDispatch_(t));
}
// Runs fn unless the same action is already in flight; spins btn (if any) until it settles.
function lcGuard_(key, btn, fn) {
  if (LC_INFLIGHT.has(key)) return;
  const r = fn();
  if (!r || typeof r.then !== 'function') return;
  LC_INFLIGHT.add(key); lcBusyBtn_(btn, true);
  r.catch(() => {}).finally(() => { LC_INFLIGHT.delete(key); lcBusyBtn_(btn, false); });
}
function lcBusyBtn_(b, on) {
  if (!b || !b.isConnected || !b.classList.contains('lc-btn')) return;
  b.classList.toggle('is-busy', on); b.disabled = on;
  if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
}
function lcDispatch_(t) {
  const act = t.dataset.act;
  if (act.startsWith('cmp-')) return cmpOnClick_(t);
  if (act.startsWith('wt-') && typeof wtAct_ === 'function') return wtAct_(act, t);
  if (act.startsWith('tpl-')) return lcTplAct_(act, t.dataset.id, t.dataset.name);
  if (act === 'setup-edit') return lcSetupAct_(t);
  if (act === 'sgl-setup') return sglSetupAct_(t);
  if (act === 'sgl-new') return sglOpen_();
  if (act.startsWith('tag-') && typeof tagAct_ === 'function') return tagAct_(t);
  if (act.startsWith('att-') && typeof attAct_ === 'function') return attAct_(t);
  if (act.startsWith('help') && typeof hlpAct_ === 'function') return hlpAct_(t);
  if (act.startsWith('rq-') && typeof rqAct_ === 'function') return rqAct_(t);
  if (act === 'trig-test') return lcTrigTest_(false);
  if (act === 'trig-refresh') return lcTrigTest_(true);
  if (act === 'crm-sync') return crmSyncStartups_();
  if (act === 'run') return lcRunNow_();
  if (act === 'sender') return lcEditSender_();
  if (act === 'step-sender') return lcEditStepSender_(t.dataset.id);
  if (act === 'golive') return lcGoLive_();
  if (act === 'staff') return lcAddStaff_();
  if (act === 'cancelbatch') return lcCancelBatch_(t.dataset.id);
  if (act === 'enabled') return lcSetEnabled_(!LC.ov.engine.enabled);
  if (act === 'pause') return lcSetPaused_(t.dataset.bucket, !LC.ov.engine.paused_buckets.includes(t.dataset.bucket));
  if (act === 'resolve') return lcResolve_(t.dataset.do, t.dataset.id);
  if (act === 'crm-leads') crmOpenLeads_();
  else if (act === 'cleanup') clnOpen_();
  else if (act === 'tab') { LC.tab = t.dataset.tab; if ((LC.tab === 'contacts' || LC.tab === 'campaigns') && !LC.contacts) lcLoadContacts_(); lcRenderTabs_(); lcRenderBody_(); }
  else if (act === 'refresh') lcRefresh_(true);
  else if (act === 'mode') { if (LC.mode !== t.dataset.mode) { LC.mode = t.dataset.mode; LC.ov = null; lcRender_(); lcRefresh_(); } }
  else if (act === 'step') lcOpenDrawer_('step', t.dataset.id);
  else if (act === 'contact') lcOpenDrawer_('contact', t.dataset.id);
  else if (act === 'close') lcCloseDrawer_();
  else if (act === 'dtab' && LC.drawer) { LC.drawer.tab = t.dataset.tab; lcRenderDrawer_(); }
  else if (act === 'bucket') { LC.bucket = t.dataset.bucket; lcRenderBody_(); }
  else if (act === 'import') lcOpenImport_();
  else if (act === 'batch') lcOpenBatch_();
  else if (act === 'review') { LC.review = LC.review === 'needs_review' ? '' : 'needs_review'; lcRenderBody_(); }
}
function lcOnInput_(e) {
  if (e.target.dataset.lcInput !== 'q') return;
  LC.q = e.target.value;
  const pos = e.target.selectionStart;
  lcRenderBody_();
  const again = LC.root.querySelector('[data-lc-input="q"]');
  if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
}
