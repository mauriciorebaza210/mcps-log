// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE EMAIL page: the Lifecycle Email Engine's portal view (CP6b).
//
// Reads /api/email?op=read (api/email.js) with the session token in the
// Authorization header, never the URL. Every view renders from a per-user cache
// first (localStorage `mcps_lc:{username}:…`, cleared on logout in auth.js) and
// revalidates in the background, so the page paints instantly.
// Styles: lifecycle.css (scoped to .lc / .lc-layer).
// ══════════════════════════════════════════════════════════════════════════════

const LC = { tab: 'emails', mode: null, ov: null, contacts: null, q: '', bucket: '', loading: false, error: null,
  drawer: null, root: null, bound: false };
const LC_SEQ = { B: 'MCP Legacy', C: 'MCP Startup' };
const LC_ICON = {
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12.5 10 17 19 7"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
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
function lcDate_(iso) {
  const t = Date.parse(iso || ''); if (!t) return '';
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const lcDay_ = iso => { const t = Date.parse(iso || ''); return t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''; };
const lcPct_ = (n, d) => d ? Math.round(100 * n / d) + '%' : '';
const lcInitials_ = (a, b) => ((String(a || '')[0] || '') + (String(b || '')[0] || '')).toUpperCase() || '·';
function lcTiming_(t, steps) {
  if (!t) return '';
  const d = n => Math.abs(n) + (Math.abs(n) === 1 ? ' day' : ' days');
  if (t.anchor === 'enrollment') return t.offset ? d(t.offset) + ' after joining' : 'The day they join';
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
const LC_ISSUE = { no_recent_run: 'No daily run in over a day', last_run_crashed: 'The last run crashed', unresolved_unknown: 'A send is unconfirmed',
  unresolved_reconcile: 'A send is still confirming', delivery_failed: 'An email failed', engine_unreadable: 'The engine can’t be reached' };
const LC_ALERT = { delivery_failed: 'Email failed', delivery_unknown: 'Send unconfirmed', run_stopped: 'Run stopped', run_crashed: 'Run crashed',
  journal_integrity: 'Safety pause', reply_scan_failed: 'Reply scan failed' };
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
  LC.root = document.getElementById('lc-root');
  if (!LC.root) return;
  if (sub && ['emails', 'activity', 'contacts'].includes(sub)) LC.tab = sub;
  if (!LC.bound) {
    LC.root.addEventListener('click', lcOnClick_);
    LC.root.addEventListener('input', lcOnInput_);
    // Table rows are focusable (tabindex) but aren't buttons: Enter opens them too.
    LC.root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('tr[data-act]')) e.target.click(); });
    LC.bound = true;
  }
  lcRender_();
  lcRefresh_();
}
function lcRefresh_(fresh) {
  LC.loading = true; LC.error = null; lcRenderHead_();
  const params = { mode: LC.mode || '', fresh: fresh ? '1' : '' };
  lcLoad_('overview', params, (data) => { LC.ov = data; if (!LC.mode) LC.mode = data.mode; lcRender_(); }, LC.mode || 'default')
    .catch(e => { LC.error = e; })
    .finally(() => {
      LC.loading = false;
      if (LC.tab === 'contacts' || LC.contacts) lcLoadContacts_(fresh);
      lcRender_();
    });
}
function lcLoadContacts_(fresh) {
  return lcLoad_('contacts', { limit: 1000, fresh: fresh ? '1' : '' }, (data) => { LC.contacts = data; if (LC.tab === 'contacts') lcRenderBody_(); })
    .catch(e => { if (!LC.contacts) { LC.error = e; lcRenderBody_(); } });
}

function lcRender_() {
  if (!LC.root) return;
  if (!LC.root.querySelector('.lc')) {
    LC.root.innerHTML = '<div class="lc"><div data-lc="head"></div><div data-lc="kpis"></div><div data-lc="banner"></div>' +
      '<nav class="lc-tabs" data-lc="tabs" aria-label="Lifecycle sections"></nav><div data-lc="body"></div></div>';
  }
  lcRenderHead_(); lcRenderKpis_(); lcRenderTabs_(); lcRenderBody_();
}
const lcSlot_ = name => LC.root && LC.root.querySelector('[data-lc="' + name + '"]');

function lcRenderHead_() {
  const el = lcSlot_('head'); if (!el) return;
  const ov = LC.ov, h = ov && ov.health;
  let health = '';
  if (h) {
    const sys = lcSystemIssues_(h);
    const cls = !sys.length ? '' : (sys.some(i => /crash|unreadable/.test(i.kind)) ? 'bad' : 'warn');
    const label = !sys.length ? (h.last_run_at ? 'Healthy · ran ' + lcAgo_(h.last_run_at) : 'Healthy') : (LC_ISSUE[sys[0].kind] || sys[0].kind);
    health = '<button class="lc-pill ' + cls + '" data-act="tab" data-tab="activity"><i></i>' + lcEsc_(label) + '</button>';
  }
  const mode = ov ? '<div class="lc-seg" role="group" aria-label="Data shown">' +
    ['test', 'production'].map(m => '<button data-act="mode" data-mode="' + m + '" class="' + (LC.mode === m ? 'on' : '') + '">' + (m === 'test' ? 'Test' : 'Live') + '</button>').join('') + '</div>' : '';
  const test = ov && ov.engine.mode !== 'production' ? '<span class="lc-pill test"><i></i>Test mode</span>' : '';
  el.innerHTML = '<header class="lc-head"><div class="lc-title"><h1>Lifecycle Email</h1>' + mode + '</div>' +
    '<div class="lc-status">' + test + health +
    '<button class="lc-icon-btn' + (LC.loading ? ' spin' : '') + '" data-act="refresh" aria-label="Refresh" title="Refresh">' + LC_ICON.refresh + '</button></div></header>';
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
  const tabs = [['emails', 'Emails', ov ? ov.steps.length : ''], ['activity', 'Activity', ov && ov.attention.length ? ov.attention.length : ''],
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
  else el.innerHTML = lcEmails_();
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
  return ['B', 'C'].map(b => {
    const steps = ov.steps.filter(s => s.bucket === b).sort((x, y) => x.order - y.order);
    if (!steps.length) return '';
    const live = steps.filter(s => s.published).length;
    const rows = steps.map(s => {
      const c = s.counts, t = s.tracking || {}, sent = c.sent;
      const m = (n, base) => '<div class="lc-metric' + (s.published ? '' : ' dim') + '"><b>' + (s.published ? n : '–') + '</b>' +
        (s.published && base && n ? '<small>' + lcPct_(n, base) + '</small>' : '') + '</div>';
      const status = !s.published ? lcTag_('Not approved', '') : (ov.engine.paused_buckets.includes(b) ? lcTag_('Paused', 'warn') : lcTag_('Live', 'live'));
      return '<button class="lc-row" data-act="step" data-id="' + lcEsc_(s.step_id) + '">' +
        '<div class="lc-name"><span class="lc-step">' + s.order + '</span><div style="min-width:0"><b>' + lcEsc_(s.name) + '</b>' +
        '<small>' + lcEsc_(s.published ? s.published.subject : 'Waiting for approval') + '</small></div></div>' +
        '<div>' + status + '</div>' + m(sent, 0) + m(t.opened_est || 0, sent) + m(t.clicked || 0, sent) + m(t.replied || 0, sent) +
        '<span class="chev">' + LC_ICON.chev + '</span></button>';
    }).join('');
    const audience = steps.length ? steps[0].audience : 0;
    return '<section class="lc-seq"><div class="lc-seq-h"><span class="lc-bkt">' + b + '</span><div class="grow"><h2>' + LC_SEQ[b] + '</h2>' +
      '<small>' + audience + ' in sequence · ' + live + ' of ' + steps.length + ' emails live</small></div></div>' +
      '<div class="lc-cols"><span>Email</span><span>Status</span><span class="r">Sent</span><span class="r">Opened</span><span class="r">Clicked</span><span class="r">Replied</span><span></span></div>' +
      rows + '</section>';
  }).join('');
}

function lcActivity_() {
  const ov = LC.ov, h = ov.health;
  const sys = lcSystemIssues_(h);
  const issues = !sys.length ? '<div class="lc-ok"><span class="dot">' + LC_ICON.check + '</span><div><b>All clear</b><small>' +
      lcEsc_(h.daily_trigger_seen ? 'Last run ' + lcAgo_(h.last_run_at) : 'Daily schedule not switched on yet') + '</small></div></div>'
    : '<ul class="lc-list">' + sys.map(i => '<li><span class="lc-li-ic bad">' + LC_ICON.alert + '</span><div class="main"><b>' + lcEsc_(LC_ISSUE[i.kind] || i.kind) +
      '</b><small>' + lcEsc_(i.kind === 'no_recent_run' ? 'Last one ' + lcDate_(i.at) : i.at ? lcDate_(i.at) : '') + '</small></div></li>').join('') + '</ul>';
  const att = ov.attention.length ? '<ul class="lc-list">' + ov.attention.map(d => '<li>' + lcStateTag_(d.state) + '<div class="main"><b>' +
      lcEsc_(lcStepName_(d.step_id)) + '</b><small>' + lcEsc_(d.email) + (d.error ? ' · ' + lcEsc_(d.error) : '') + '</small></div><time>' +
      lcEsc_(lcAgo_(d.send_invoked_at || d.claimed_at)) + '</time></li>').join('') + '</ul>'
    : '<div class="lc-empty">Nothing needs a decision.</div>';
  const runs = ov.runs.length ? '<table class="lc-table"><thead><tr><th>Run</th><th class="hide-sm">Trigger</th><th class="r">Sent</th><th class="r hide-sm">Skipped</th><th>Result</th></tr></thead><tbody>' +
      ov.runs.map(r => '<tr><td>' + lcEsc_(lcDate_(r.started_at)) + '</td><td class="hide-sm">' + (r.trigger === 'daily' ? 'Scheduled' : 'Manual') +
        '</td><td class="r num">' + r.sent + '</td><td class="r num hide-sm">' + r.skipped + '</td><td>' +
        (r.stopped_reason === 'done' ? lcTag_('Completed', 'live') : /^crashed/.test(r.stopped_reason) ? lcTag_('Crashed', 'bad') : lcTag_(LC_RESULT[r.stopped_reason] || r.stopped_reason, 'warn')) +
        '</td></tr>').join('') + '</tbody></table>' : '<div class="lc-empty">No runs yet.</div>';
  const alerts = ov.alerts.length ? '<ul class="lc-list">' + ov.alerts.slice(0, 8).map(a => '<li><div class="main"><b>' + lcEsc_(LC_ALERT[a.kind] || a.kind) +
      '</b>' + (a.detail ? '<small>' + lcEsc_(lcHumanize_(a.detail)) + '</small>' : '') + '</div><time>' + lcEsc_(lcAgo_(a.at)) + '</time></li>').join('') + '</ul>'
    : '<div class="lc-empty">No alerts.</div>';
  return '<div class="lc-grid"><div><div class="lc-card"><div class="lc-card-h"><h3>Health</h3></div>' + issues + '</div>' +
    '<div class="lc-card"><div class="lc-card-h"><h3>Needs a decision</h3><small>' + ov.attention.length + '</small></div>' + att + '</div></div>' +
    '<div><div class="lc-card"><div class="lc-card-h"><h3>Runs</h3><small>Daily at ' + lcHour_(ov.engine.run_hour) + '</small></div>' + runs + '</div>' +
    '<div class="lc-card"><div class="lc-card-h"><h3>Alerts</h3></div>' + alerts + '</div></div></div>';
}
// Engine-level problems only; per-email ones live in "Needs a decision".
const lcSystemIssues_ = h => (h && h.issues || []).filter(i => !/^unresolved_|^delivery_failed$/.test(i.kind));
// Alert text comes from the engine: turn delivery ids and timestamps into words.
function lcHumanize_(text) {
  return String(text || '')
    .replace(/\b[\w]+:([a-z]+_[a-z]+):\d+\b/g, (m, step) => lcStepName_(step))
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, m => lcDate_(m));
}
const lcHour_ = h => { h = Number(h) || 9; return (h % 12 || 12) + (h < 12 ? ' AM' : ' PM'); };
const lcStepName_ = id => { const s = LC.ov && LC.ov.steps.find(x => x.step_id === id); return s ? s.name : id; };

function lcContacts_() {
  const bar = '<div class="lc-bar"><label class="lc-search">' + LC_ICON.search + '<input type="search" placeholder="Search people" value="' + lcEsc_(LC.q) +
    '" data-lc-input="q" aria-label="Search people"></label><div class="lc-seg">' +
    [['', 'All'], ['B', 'MCP Legacy'], ['C', 'MCP Startup']].map(([k, l]) => '<button data-act="bucket" data-bucket="' + k + '" class="' + (LC.bucket === k ? 'on' : '') + '">' + l + '</button>').join('') +
    '</div></div>';
  if (!LC.contacts) return bar + '<div class="lc-sk" style="height:320px"></div>';
  const q = LC.q.trim().toLowerCase();
  const rows = LC.contacts.contacts.filter(c => (!LC.bucket || c.bucket === LC.bucket) &&
    (!q || [c.first_name, c.last_name, c.email].some(v => String(v || '').toLowerCase().includes(q))));
  if (!rows.length) return bar + '<div class="lc-card"><div class="lc-empty">No one matches.</div></div>';
  return bar + '<div class="lc-card"><table class="lc-table"><thead><tr><th>Person</th><th class="hide-xs">Sequence</th><th>Status</th><th class="hide-sm">Last email</th></tr></thead><tbody>' +
    rows.map(c => {
      const seq = c.sequence, last = c.last_email;
      const status = !seq ? lcTag_('Not enrolled', '') : seq.status === 'active' ? lcTag_('Active', 'live') :
        seq.status === 'stopped' ? lcTag_('Stopped · ' + (seq.stop_reason || 'manual'), 'warn') : lcTag_(seq.status, '');
      return '<tr class="click" data-act="contact" data-id="' + lcEsc_(c.contact_id) + '" tabindex="0"><td class="lc-fit"><div class="lc-person"><span class="lc-avatar">' +
        lcEsc_(lcInitials_(c.first_name, c.last_name)) + '</span><div><b>' + lcEsc_([c.first_name, c.last_name].filter(Boolean).join(' ')) +
        (c.is_test ? ' <span class="lc-tag" style="height:18px;font-size:10.5px">Test</span>' : '') + '</b><small>' + lcEsc_(c.email) + '</small></div></div></td>' +
        '<td class="hide-xs"><span class="lc-seqname"><span class="lc-bkt sm">' + lcEsc_(c.bucket) + '</span>' + lcEsc_(LC_SEQ[c.bucket] || '') + '</span></td>' +
        '<td>' + status + '</td><td class="hide-sm">' + (last ? lcEsc_(lcStepName_(last.step_id)) + ' <span style="color:var(--muted)">· ' + lcEsc_(lcAgo_(last.sent_at)) + '</span>' : '<span style="color:var(--muted)">–</span>') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

// ── Drawers ───────────────────────────────────────────────────────────────────
function lcOpenDrawer_(kind, id) {
  lcCloseDrawer_();
  const layer = document.createElement('div');
  layer.className = 'lc-layer';
  layer.innerHTML = '<div class="lc-scrim" data-act="close"></div><aside class="lc-drawer" role="dialog" aria-modal="true"></aside>';
  document.body.appendChild(layer);
  layer.addEventListener('click', lcOnClick_);
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
  const el = D.layer.querySelector('.lc-drawer');
  const close = '<button class="lc-icon-btn" data-act="close" aria-label="Close">' + LC_ICON.x + '</button>';
  if (D.error) { el.innerHTML = '<div class="lc-dr-h"><div class="t"></div>' + close + '</div>' + lcErrorView_(D.error); return; }
  if (D.kind === 'step') {
    const s = (D.data && D.data.step) || (LC.ov && LC.ov.steps.find(x => x.step_id === D.id)) || { name: '', bucket: '' };
    const tabs = [['performance', 'Performance'], ['recipients', 'Recipients'], ['setup', 'Setup']];
    el.innerHTML = '<div class="lc-dr-h"><span class="lc-bkt">' + lcEsc_(s.bucket) + '</span><div class="t"><small>' + lcEsc_(LC_SEQ[s.bucket] || '') +
      ' · Email ' + lcEsc_(s.order || '') + '</small><h2>' + lcEsc_(s.name) + '</h2></div>' + close + '</div>' +
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
  if (D.tab === 'recipients') {
    if (!d.recipients.length) return '<div class="lc-empty">No one has received this email yet.</div>';
    return '<div>' + d.recipients.map(r => {
      const g = r.engagement || {};
      return '<div class="lc-rcp"><span class="lc-avatar">' + lcEsc_(lcInitials_(...String(r.name).split(' '))) + '</span><div class="who"><b>' + lcEsc_(r.name) +
        '</b><small>' + lcEsc_(r.email) + ' · ' + lcEsc_(r.sent_at ? lcDay_(r.sent_at) : (LC_STATE[r.state] || [r.state])[0]) + '</small>' +
        (g.reply_snippet ? '<div class="lc-quote">' + lcEsc_(g.reply_snippet) + '</div>' : '') + '</div>' +
        '<div class="lc-ev">' + (r.state === 'sent' ? lcEvidence_(g) : lcStateTag_(r.state)) + '</div></div>';
    }).join('') + '</div>';
  }
  if (D.tab === 'setup') {
    const rev = d.revisions[0];
    const rules = (s.stop_rules || []).map(r => '<li>' + LC_ICON.stop + '<span>' + lcEsc_((LC_SIGNAL[r.signal] || r.signal) + ' ' + (LC_STOPS[r.stops] || 'stops it')) + '</span></li>').join('');
    return '<div class="lc-sec"><h4>Sends</h4><dl class="lc-kv"><dt>When</dt><dd>' + lcEsc_(lcTiming_(s.timing, LC.ov.steps)) + '</dd>' +
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
    lcEsc_(LC_SEQ[e.sequence_id] || e.sequence_id) + ' · ' + lcEsc_(e.status === 'stopped' ? 'stopped, ' + (e.stop_reason || 'manual') : e.status) + '</span>').join(' ');
  const tl = d.deliveries.length ? '<ul class="lc-tl">' + d.deliveries.map(x => '<li class="' + (x.state === 'sent' ? '' : 'off') + '"><b>' + lcEsc_(lcStepName_(x.step_id)) +
    '</b><small>' + lcEsc_(x.sent_at ? lcDate_(x.sent_at) : (LC_STATE[x.state] || [x.state])[0]) + '</small>' +
    '<div class="lc-ev" style="justify-content:flex-start;margin-top:6px">' + (x.state === 'sent' ? lcEvidence_(x.engagement) : lcStateTag_(x.state)) + '</div>' +
    (x.engagement && x.engagement.reply_snippet ? '<div class="lc-quote">' + lcEsc_(x.engagement.reply_snippet) + '</div>' : '') + '</li>').join('') + '</ul>'
    : '<div class="lc-empty">No emails yet.</div>';
  return '<div class="lc-sec"><h4>Sequence</h4>' + (enr || '<span style="color:var(--muted)">Not enrolled</span>') + '</div>' +
    '<div class="lc-sec"><h4>Details</h4><dl class="lc-kv"><dt>Group</dt><dd>' + lcEsc_(LC_SEQ[c.bucket] || c.bucket) + '</dd>' +
    (c.address && c.address !== 'hidden' ? '<dt>Address</dt><dd>' + lcEsc_(c.address) + '</dd>' : '') +
    (c.startup_date ? '<dt>Startup</dt><dd>' + lcEsc_(c.startup_date) + '</dd>' : '') + '</dl></div>' +
    '<div class="lc-sec"><h4>Emails</h4>' + tl + '</div>';
}

// ── Events ────────────────────────────────────────────────────────────────────
function lcOnClick_(e) {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act;
  if (act === 'tab') { LC.tab = t.dataset.tab; if (LC.tab === 'contacts' && !LC.contacts) lcLoadContacts_(); lcRenderTabs_(); lcRenderBody_(); }
  else if (act === 'refresh') lcRefresh_(true);
  else if (act === 'mode') { if (LC.mode !== t.dataset.mode) { LC.mode = t.dataset.mode; LC.ov = null; lcRender_(); lcRefresh_(); } }
  else if (act === 'step') lcOpenDrawer_('step', t.dataset.id);
  else if (act === 'contact') lcOpenDrawer_('contact', t.dataset.id);
  else if (act === 'close') lcCloseDrawer_();
  else if (act === 'dtab' && LC.drawer) { LC.drawer.tab = t.dataset.tab; lcRenderDrawer_(); }
  else if (act === 'bucket') { LC.bucket = t.dataset.bucket; lcRenderBody_(); }
}
function lcOnInput_(e) {
  if (e.target.dataset.lcInput !== 'q') return;
  LC.q = e.target.value;
  const pos = e.target.selectionStart;
  lcRenderBody_();
  const again = LC.root.querySelector('[data-lc-input="q"]');
  if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
}
