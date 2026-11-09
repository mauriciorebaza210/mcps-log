// Lifecycle Email Engine: the portal's read model (pure; no network).
//
// api/email.js reads the engine spreadsheet in one batchGet and hands the raw
// values here. Everything below is a function of (values, capabilities, now),
// so tests/email-read.test.js covers it without Sheets.
//
// Contract: email-engine/docs/PLAN.md → Read-path security and Configuration &
// authorization. Capabilities are explicit, never inherited: a user's set is
// the union of their roles' sets. Redaction runs on every request, after the
// (shared, raw) cache, so no filtered view is ever cached or shared.

export const ROLE_CAPS = {
  viewer: ['view_aggregates'],
  editor: ['view_aggregates', 'view_pii', 'edit_drafts', 'edit_contacts'],
  approver: ['view_aggregates', 'view_pii', 'approve_publish', 'activate_steps'],
  operator: ['view_aggregates', 'view_pii', 'export', 'run_now', 'pause', 'resolve_unknown', 'edit_config']
};

// The engine tabs the portal reads. Never raw Events (PLAN.md → Performance).
export const READ_TABS = ['Permissions', 'Config', 'Rulesets', 'Revisions', 'Contacts', 'Enrollments', 'Deliveries', 'Runs', 'Alerts', 'Engagement'];

const NUMERIC = new Set(['occurrence', 'attempt', 'gen', 'last_seq', 'held_days', 'rev_no', 'adopted_from_gen',
  'sent', 'skipped', 'cancelled', 'reconcile', 'adopted', 'failed', 'opens_total', 'opens_low', 'opens_medium',
  'clicks_total', 'clicks_low', 'clicks_medium', 'clicks_high', 'auto_replies', 'soft_bounces']);
const DAY = 24 * 60 * 60 * 1000;
const IN_FLIGHT = new Set(['claimed', 'drafted', 'sending', 'reconcile']);
const NEEDS_ATTENTION = new Set(['reconcile', 'unknown', 'failed']);

// Same decoding as the engine (email-engine/src/Env.js → EE_decode_): every
// column is plain text; JSON columns and counters are converted back.
function decode(key, v) {
  if (v === undefined || v === null || v === '') return NUMERIC.has(key) ? 0 : '';
  if (NUMERIC.has(key)) return Number(v);
  const s = String(v);
  if (s[0] === '{' || s[0] === '[') { try { return JSON.parse(s); } catch (_) { /* plain text */ } }
  return s;
}
export function toTables(values) {
  const out = {};
  for (const tab of READ_TABS) {
    const rows = values[tab];
    if (!Array.isArray(rows) || !rows.length) { out[tab] = rows ? [] : null; continue; }
    const h = rows[0].map(x => String(x || '').trim());
    out[tab] = rows.slice(1).filter(r => r.some(c => c !== '' && c !== undefined))
      .map(r => { const o = {}; h.forEach((k, i) => { if (k) o[k] = decode(k, r[i]); }); return o; });
  }
  return out;
}

export function capabilitiesFor(username, permissionRows) {
  const u = String(username || '').trim().toLowerCase();
  const caps = new Set();
  const row = (permissionRows || []).find(r => String(r.username || '').trim().toLowerCase() === u);
  if (!row || String(row.active || 'Y').toUpperCase().startsWith('N')) return caps;
  String(row.roles || '').split(',').map(r => r.trim().toLowerCase()).forEach(role => (ROLE_CAPS[role] || []).forEach(c => caps.add(c)));
  return caps;
}

function config(tables) {
  const c = {};
  (tables.Config || []).forEach(r => { c[r.key] = r.value; });
  return c;
}
function activeSteps(tables, cfg) {
  const rs = (tables.Rulesets || []).find(r => r.rule_rev === cfg.rule_rev);
  return (rs && rs.json && rs.json.steps) || [];
}
const ms = iso => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };
const byDesc = key => (a, b) => ms(b[key]) - ms(a[key]);

// PII is the contact's email address, street address and phone (and, from
// CP5c, reply snippets). Names stay visible: they're how anyone tells rows apart.
function maskEmail(e) {
  const s = String(e || ''), at = s.indexOf('@');
  return at > 0 ? s[0] + '•••' + s.slice(at) : (s ? '•••' : '');
}
function contactView(c, caps) {
  const pii = caps.has('view_pii');
  return {
    contact_id: c.contact_id, first_name: c.first_name, last_name: c.last_name,
    bucket: c.bucket, sub_bucket: c.sub_bucket, review_status: c.review_status, is_test: c.is_test === 'Y',
    email: pii ? c.email_norm : maskEmail(c.email_norm),
    address: pii ? (c.address || '') : (c.address ? 'hidden' : ''),
    phone: pii ? (c.phone || '') : (c.phone ? 'hidden' : ''),
    startup_date: c.startup_date || '', source: c.source || '', created_at: c.created_at || ''
  };
}
// Per-delivery tracking, by evidence level (PLAN.md → Tracking). Opens are
// estimates; "verified" is a browser-verified click, the only kind that stops.
function engagementView(g, caps) {
  if (!g) return null;
  return { opened: g.opens_medium > 0, opens: g.opens_total, opens_low: g.opens_low,
    clicks: g.clicks_medium, clicks_low: g.clicks_low, verified_clicks: g.clicks_high,
    first_open_at: g.first_open_at || '', first_click_at: g.first_click_at || '', first_verified_click_at: g.first_verified_click_at || '',
    unsubscribed_at: g.unsubscribed_at || '', form_submitted_at: g.form_submitted_at || '', links: g.links_json || {},
    replied_at: g.replied_at || '', other_replied_at: g.other_replied_at || '', auto_replies: g.auto_replies,
    reply_snippet: caps && caps.has('view_pii') ? (g.last_reply_snippet || '') : '',
    bounced_at: g.bounced_at || '', soft_bounces: g.soft_bounces,
    classifier_version: g.classifier_version || '' };
}
function deliveryView(d, caps, g) {
  return {
    delivery_id: d.delivery_id, contact_id: d.contact_id, enrollment_id: d.enrollment_id, step_id: d.step_id,
    occurrence: d.occurrence, mode: d.mode, state: d.state, attempt: d.attempt, revision_id: d.revision_id,
    email: caps.has('view_pii') ? d.email_norm : maskEmail(d.email_norm),
    claimed_at: d.claimed_at || '', send_invoked_at: d.send_invoked_at || '', sent_at: d.sent_at || '',
    error: d.error || '', resolved_by: d.resolved_by || '', engagement: engagementView(g, caps)
  };
}
function engagementIndex(tables) {
  const by = {};
  (tables.Engagement || []).forEach(g => { by[g.delivery_id] = g; });
  return by;
}

// Engine health, for the portal banner and the daily heartbeat (PLAN.md →
// Operations → SLOs). Only what the sheet can show: the engine's own safety
// pause lives in its Script Properties and it alerts on that itself.
export function health(tables, now) {
  const H = 60 * 60 * 1000, issues = [];
  const cfg = config(tables);
  const runs = (tables.Runs || []).slice().sort(byDesc('started_at'));
  const daily = runs.filter(r => r.trigger === 'daily');
  const lastDaily = daily[0] ? ms(daily[0].started_at) : 0;
  const enabled = String(cfg.engine_enabled) !== 'false';
  // Before the daily trigger is installed there's nothing to miss.
  // `detail` is for the alert email; `at` / `step_id` let the page word it properly.
  if (enabled && lastDaily && now - lastDaily > 26 * H) issues.push({ kind: 'no_recent_run', at: daily[0].started_at, detail: 'no daily run since ' + daily[0].started_at });
  if (runs[0] && /^crashed/.test(String(runs[0].stopped_reason))) issues.push({ kind: 'last_run_crashed', at: runs[0].started_at, detail: String(runs[0].stopped_reason).slice(0, 200) });
  (tables.Deliveries || []).forEach(d => {
    const since = ms(d.send_invoked_at || d.claimed_at);
    if ((d.state === 'unknown' || d.state === 'reconcile') && since && now - since > 24 * H) {
      issues.push({ kind: 'unresolved_' + d.state, at: d.send_invoked_at || d.claimed_at, step_id: d.step_id, detail: d.delivery_id + ' since ' + (d.send_invoked_at || d.claimed_at) });
    }
    if (d.state === 'failed' && now - ms(d.claimed_at) < 24 * H) issues.push({ kind: 'delivery_failed', at: d.claimed_at, step_id: d.step_id, detail: d.delivery_id + ': ' + String(d.error || '').slice(0, 160) });
  });
  const recentAlerts = (tables.Alerts || []).filter(a => now - ms(String(a.at).split(' ')[0]) < 24 * H).length;
  return { ok: issues.length === 0, issues, enabled, last_run_at: runs[0] ? runs[0].started_at : '',
    last_daily_run_at: daily[0] ? daily[0].started_at : '', daily_trigger_seen: !!lastDaily, alerts_24h: recentAlerts };
}

// mode: 'test' | 'production' (default: the engine's current mode).
export function buildOverview(tables, caps, now, opts = {}) {
  const cfg = config(tables);
  const mode = opts.mode === 'test' || opts.mode === 'production' ? opts.mode : (cfg.engine_mode === 'production' ? 'production' : 'test');
  const since = now - 60 * DAY, week = now - 7 * DAY;
  const deliveries = (tables.Deliveries || []).filter(d => d.mode === mode && (ms(d.sent_at || d.claimed_at) >= since || NEEDS_ATTENTION.has(d.state) || IN_FLIGHT.has(d.state)));
  const enrollments = (tables.Enrollments || []).filter(e => e.mode === mode);
  const published = {};
  (tables.Revisions || []).filter(r => r.status === 'published').forEach(r => {
    if (!published[r.step_id] || published[r.step_id].rev_no < r.rev_no) published[r.step_id] = r;
  });
  const eng = engagementIndex(tables);
  const steps = activeSteps(tables, cfg).map(s => {
    const mine = deliveries.filter(d => d.step_id === s.step_id);
    const count = pred => mine.filter(pred).length;
    const sentRows = mine.filter(d => d.state === 'sent');
    const tracked = pred => sentRows.filter(d => eng[d.delivery_id] && pred(eng[d.delivery_id])).length;
    const rev = published[s.step_id];
    return {
      step_id: s.step_id, name: s.name, bucket: s.sequence_id, order: s.order, category: s.category, status: s.status,
      timing: { anchor: s.anchor, offset: s.offset, repeat_every: s.repeat_every || 0, repeat_count: s.repeat_count || 0,
        requires: s.requires || '', window_days: s.window_days, max_hold_days: s.max_hold_days },
      stop_rules: (s.stop_rules || []).map(r => ({ signal: r.signal, min_confidence: r.min_confidence || '', stops: r.stops })),
      audience_filter: s.audience_filter || null,
      audience: enrollments.filter(e => e.sequence_id === s.sequence_id && e.status === 'active').length,
      published: rev ? { revision_id: rev.revision_id, rev_no: rev.rev_no, subject: rev.subject, approved_at: rev.approved_at, approver: rev.approver } : null,
      counts: {
        sent: count(d => d.state === 'sent'), sent_7d: count(d => d.state === 'sent' && ms(d.sent_at) >= week),
        in_flight: count(d => IN_FLIGHT.has(d.state)), unknown: count(d => d.state === 'unknown'),
        failed: count(d => d.state === 'failed'), cancelled: count(d => d.state === 'cancelled')
      },
      // Unique deliveries, among those sent in the window.
      tracking: {
        opened_est: tracked(g => g.opens_medium > 0), clicked: tracked(g => g.clicks_medium > 0),
        verified_clicks: tracked(g => g.clicks_high > 0), unsubscribed: tracked(g => !!g.unsubscribed_at),
        forms: tracked(g => !!g.form_submitted_at), scanner_like: tracked(g => g.clicks_low > 0 || g.opens_low > 0),
        replied: tracked(g => !!g.replied_at || !!g.other_replied_at), auto_replies: tracked(g => g.auto_replies > 0),
        bounced: tracked(g => !!g.bounced_at)
      }
    };
  });
  const runs = (tables.Runs || []).slice().sort(byDesc('started_at')).slice(0, 10).map(r => ({
    run_id: r.run_id, trigger: r.trigger, started_at: r.started_at, finished_at: r.finished_at,
    sent: r.sent, skipped: r.skipped, cancelled: r.cancelled, failed: r.failed, stopped_reason: r.stopped_reason
  }));
  const h = health(tables, now);
  return {
    mode,
    health: { ...h, issues: h.issues.map(i => ({ kind: i.kind, at: i.at || '', step_id: i.step_id || '', detail: caps.has('view_pii') ? i.detail : '' })) },
    engine: {
      enabled: String(cfg.engine_enabled) !== 'false', mode: cfg.engine_mode || 'test',
      paused_buckets: String(cfg.paused_buckets || '').split(',').map(x => x.trim()).filter(Boolean),
      daily_cap: Number(cfg.daily_cap || 0), run_hour: Number(cfg.run_hour || 0), sender_name: cfg.sender_name || '',
      rule_rev: cfg.rule_rev || '', last_run: runs[0] || null
    },
    steps,
    attention: deliveries.filter(d => NEEDS_ATTENTION.has(d.state)).sort(byDesc('claimed_at')).map(d => deliveryView(d, caps, eng[d.delivery_id])),
    runs,
    alerts: (tables.Alerts || []).slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20)
      .map(a => ({ at: String(a.at).split(' ')[0], kind: a.kind, detail: caps.has('view_pii') ? a.detail : '' })),
    totals: {
      contacts: (tables.Contacts || []).length,
      active_enrollments: enrollments.filter(e => e.status === 'active').length,
      sent_7d: deliveries.filter(d => d.state === 'sent' && ms(d.sent_at) >= week).length
    }
  };
}

// One email: its rules, content and every recipient's evidence (the drawer).
export function buildStep(tables, caps, stepId, now, opts = {}) {
  const ov = buildOverview(tables, caps, now, opts);
  const step = ov.steps.find(s => s.step_id === stepId);
  if (!step) return null;
  const eng = engagementIndex(tables);
  const contacts = {};
  (tables.Contacts || []).forEach(c => { contacts[c.contact_id] = c; });
  const rows = (tables.Deliveries || []).filter(d => d.step_id === stepId && d.mode === ov.mode).sort(byDesc('claimed_at'));
  const links = {};
  rows.forEach(d => { const g = eng[d.delivery_id]; Object.entries((g && g.links_json) || {}).forEach(([k, v]) => { links[k] = (links[k] || 0) + Number(v || 0); }); });
  const rev = (tables.Revisions || []).filter(r => r.step_id === stepId).sort((a, b) => b.rev_no - a.rev_no)
    .map(r => ({ revision_id: r.revision_id, rev_no: r.rev_no, status: r.status, subject: r.subject, preheader: r.preheader || '',
      approver: r.approver || '', approved_at: r.approved_at || '' }));
  return { mode: ov.mode, step, revisions: rev, links,
    recipients: rows.map(d => {
      const c = contacts[d.contact_id] || {};
      return { ...deliveryView(d, caps, eng[d.delivery_id]), name: [c.first_name, c.last_name].filter(Boolean).join(' ') || d.contact_id };
    }) };
}

export function buildContacts(tables, caps, opts = {}) {
  const q = String(opts.q || '').trim().toLowerCase();
  const pii = caps.has('view_pii');
  let rows = (tables.Contacts || []).filter(c => !opts.bucket || c.bucket === opts.bucket);
  if (opts.review) rows = rows.filter(c => c.review_status === opts.review);
  // Search matches names always, and email/address only for viewers allowed to see them,
  // so a search can't be used to probe hidden fields.
  if (q) rows = rows.filter(c => [c.first_name, c.last_name].concat(pii ? [c.email_norm, c.address] : [])
    .some(v => String(v || '').toLowerCase().includes(q)));
  const limit = Math.min(Number(opts.limit) || 200, 1000);
  // Where each person stands, without opening them: their sequence and last email.
  const enr = {}, last = {};
  (tables.Enrollments || []).forEach(e => { (enr[e.contact_id] = enr[e.contact_id] || []).push(e); });
  (tables.Deliveries || []).forEach(d => { if (d.state === 'sent' && ms(d.sent_at) > ms(last[d.contact_id] && last[d.contact_id].sent_at)) last[d.contact_id] = d; });
  return { total: rows.length, contacts: rows.slice(0, limit).map(c => {
    const e = (enr[c.contact_id] || []).sort(byDesc('enrolled_on'))[0];
    const l = last[c.contact_id];
    return { ...contactView(c, caps), sequence: e ? { status: e.status, stop_reason: e.stop_reason || '', mode: e.mode } : null,
      last_email: l ? { step_id: l.step_id, sent_at: l.sent_at } : null };
  }) };
}

export function buildContact(tables, caps, contactId) {
  const c = (tables.Contacts || []).find(x => x.contact_id === contactId);
  if (!c) return null;
  const enrollments = (tables.Enrollments || []).filter(e => e.contact_id === contactId).map(e => ({
    enrollment_id: e.enrollment_id, sequence_id: e.sequence_id, mode: e.mode, status: e.status, enrolled_on: e.enrolled_on,
    stop_reason: e.stop_reason || '', stopped_on: e.stopped_on || '', stopped_branches: e.stopped_branches || []
  }));
  const eng = engagementIndex(tables);
  const deliveries = (tables.Deliveries || []).filter(d => d.contact_id === contactId).sort(byDesc('claimed_at')).map(d => deliveryView(d, caps, eng[d.delivery_id]));
  return { contact: contactView(c, caps), enrollments, deliveries };
}
