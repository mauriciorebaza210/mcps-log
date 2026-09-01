#!/usr/bin/env node
/**
 * gas-verify.js — prove a GAS deploy did not break the live portal.
 *
 *   node scripts/gas-verify.js baseline          # BEFORE deploy — records current behaviour
 *   node scripts/gas-verify.js check             # AFTER deploy  — diffs against the baseline
 *
 * Optionally add read-shape coverage (needs a real session token — open the portal,
 * DevTools console: JSON.parse(localStorage.mcps_s).token):
 *
 *   node scripts/gas-verify.js baseline --token=ABC123
 *   node scripts/gas-verify.js check    --token=ABC123
 *
 * WHY THIS IS SAFE TO RUN AGAINST PRODUCTION
 * Every probed action is auth-gated and the probe sends NO session token, so each
 * handler's own validateToken() rejects it before any side effect. Nothing is
 * written, no email sent, no Drive file created. The probe only asks "does this
 * route still exist?" — exactly what a deploy can silently take away.
 *
 * HOW A MISSING ROUTE IS DETECTED
 * The probe sends the webhook secret but no token. That passes doPost's outer
 * token-or-secret gate, so a *missing* route falls through to the QBO bill handler,
 * which finds no line items and answers with its own signature:
 *     { ok:true, result:{ written:0, reason:"No valid line items" } }
 * A *present* route answers "Unauthorized" (its own validateToken failing) or its
 * own validation error. Post-deploy the unknown-action guard adds a second missing
 * signature: { ok:false, error:"Unknown action: X" }. Both are treated as missing.
 */

const fs = require('fs');
const path = require('path');

const AS = 'https://script.google.com/macros/s/AKfycbxFrdZRbkXuGuazfqf7q-rKp-T-3DinM8t_3Pp5i6Efr7tciDU59Go6L7s3kxCQl9I/exec';
const BASELINE = path.join(__dirname, '..', '.gas-verify-baseline.json');
const SEC = '220ed543794285b632c27dec0b1b6529'; // WEBHOOK_SECRET — same value js/lib/constants.js sends

// Auth-gated doPost actions. Derived from WebhookReceiver.js — every block here
// calls validateToken() or checks WEBHOOK_SECRET, so an invalid token is refused
// before any side effect. Public/unauthenticated routes are deliberately absent:
// probing those would actually execute them.
const GATED_ACTIONS = [
  'add_manual_pool', 'analyze_migration_coverage', 'analyze_route_geography',
  'approve_pending_sku', 'archive_schedule_blackout', 'backfill_job_completions',
  'backfill_missing_usage_priced', 'cancel_service_log', 'confirm_start_date',
  'convert_to_wfs', 'create_amendment', 'delete_pool_note', 'generate_contract',
  'generate_proposal', 'get_action_queue', 'get_agreement_preview',
  'get_assignment_exceptions', 'get_crm_data', 'get_gtc_pools', 'get_gtc_visits',
  'get_pool_context', 'get_pool_list', 'get_pool_phone', 'get_portal_schema',
  'get_sales_funnel', 'get_scope_library', 'import_leads', 'log_payroll_payment',
  'manual_apply_purchases', 'manual_check_poolcorp', 'onboarding_reject',
  'onboarding_save_contract', 'process_pending_service_jobs', 'provision_quote_schedule',
  'recalculate_routes', 'reject_pending_sku', 'resolve_assignment_exception',
  'resolve_issue_alert', 'resolve_unmatched', 'save_employee_paycheck', 'save_gate_code',
  'save_i9_info', 'save_info', 'save_payroll_config', 'save_payroll_employee',
  'save_pool_note', 'save_portal_schema', 'save_quote', 'save_scope_library_item',
  'save_sensitive_info', 'save_startup_checklist', 'schedule_gtc_visit', 'send_contract',
  'send_heads_up', 'service_agreement_signed', 'service_request_notify',
  'set_inventory_qty', 'set_paycheck_qbo_ref', 'set_payroll_approval', 'set_payroll_rate',
  'set_weekly_goal', 'submit_form', 'submit_issue_alert', 'sync_chemicals',
  'sync_pool_dropdown', 'technician_check_out', 'update_employee_paycheck',
  'update_lead', 'update_quote_info', 'upload_alert_photo', 'validate_token',
  'void_service_log'
];

// doGet reads the live portal depends on. Shape-checked only when a token is given.
const READ_ACTIONS = [
  { action: 'route_data' },
  { action: 'scheduled_visits' },
  { action: 'get_crm_data' },
  { action: 'get_pool_list' },
  { action: 'get_unassigned' },
  { action: 'get_gtc_pools' },
  { action: 'get_issue_alerts' },
  { action: 'get_visit_history' },
  { action: 'get_weekly_goal' },
  { action: 'calendar_data' }
];

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

async function post(payload) {
  // Body sent as text/plain (fetch's default for a string) so GAS treats it as a
  // simple request and populates e.postData.contents — same as the portal's api().
  const res = await fetch(AS, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow' });
  const text = await res.text();
  try { return { http: res.status, body: JSON.parse(text) }; }
  catch { return { http: res.status, body: null, raw: text.slice(0, 200) }; }
}

async function get(params) {
  const url = `${AS}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  try { return { http: res.status, body: JSON.parse(text) }; }
  catch { return { http: res.status, body: null, raw: text.slice(0, 200) }; }
}

// "Does this route exist?" — never "does it work", which would require executing it.
function classify({ http, body, raw }) {
  if (body === null) return `NON_JSON(http ${http}${raw ? ': ' + raw.replace(/\s+/g, ' ').slice(0, 80) : ''})`;
  const err = String(body.error || '');
  if (body.ok === false && /^Unknown action:/i.test(err)) return 'ROUTE_MISSING';
  const reason = body.result && body.result.reason;
  if (body.ok === true && reason === 'No valid line items') return 'ROUTE_MISSING';
  return 'ROUTE_PRESENT';
}

// Compare response SHAPE, not values: live data changes between runs, so diffing
// payloads would cry wolf. A key that disappears is what actually breaks a caller.
function shapeOf(value, depth = 0) {
  if (depth > 2 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.length ? shapeOf(value[0], depth + 1).map((k) => `[]${k}`) : [];
  return Object.keys(value).sort().flatMap((k) => [`.${k}`, ...shapeOf(value[k], depth + 1).map((s) => `.${k}${s}`)]);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

async function probe(token) {
  process.stdout.write(`Probing ${GATED_ACTIONS.length} auth-gated routes`);
  const routes = {};
  const results = await mapLimit(GATED_ACTIONS, 4, async (action) => {
    const r = await post({ action, secret: SEC });
    process.stdout.write('.');
    return [action, classify(r)];
  });
  results.forEach(([a, c]) => { routes[a] = c; });
  process.stdout.write('\n');

  const reads = {};
  if (token) {
    process.stdout.write(`Capturing ${READ_ACTIONS.length} read shapes`);
    const rs = await mapLimit(READ_ACTIONS, 3, async (spec) => {
      const r = await get({ ...spec, token });
      process.stdout.write('.');
      return [spec.action, r.body === null
        ? { ok: null, note: `NON_JSON(http ${r.http})`, keys: [] }
        : { ok: r.body.ok === true, error: r.body.ok ? '' : String(r.body.error || ''), keys: shapeOf(r.body) }];
    });
    rs.forEach(([a, s]) => { reads[a] = s; });
    process.stdout.write('\n');
  }
  return { at: new Date().toISOString(), routes, reads };
}

(async () => {
  const mode = process.argv[2];
  const token = arg('token');
  if (!['baseline', 'check'].includes(mode)) {
    console.error('usage: node scripts/gas-verify.js <baseline|check> [--token=SESSION_TOKEN]');
    process.exit(2);
  }
  if (!token) console.log('! No --token: probing routes only, skipping read shapes.\n');

  const snap = await probe(token);

  if (mode === 'baseline') {
    fs.writeFileSync(BASELINE, JSON.stringify(snap, null, 2));
    const missing = Object.entries(snap.routes).filter(([, v]) => v === 'ROUTE_MISSING');
    console.log(`\nBaseline written to ${path.relative(process.cwd(), BASELINE)}`);
    console.log(`  routes present : ${Object.values(snap.routes).filter((v) => v === 'ROUTE_PRESENT').length}`);
    console.log(`  routes missing : ${missing.length}${missing.length ? ' -> ' + missing.map(([k]) => k).join(', ') : ''}`);
    if (token) console.log(`  read shapes    : ${Object.keys(snap.reads).length}`);
    console.log('\nNow deploy, then run: node scripts/gas-verify.js check' + (token ? ' --token=...' : ''));
    return;
  }

  if (!fs.existsSync(BASELINE)) {
    console.error(`No baseline at ${BASELINE}. Run "baseline" BEFORE deploying.`);
    process.exit(2);
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const problems = [];

  for (const [action, was] of Object.entries(base.routes)) {
    const now = snap.routes[action];
    if (was === 'ROUTE_PRESENT' && now !== 'ROUTE_PRESENT') {
      problems.push(`REGRESSION  ${action}: was ROUTE_PRESENT, now ${now}`);
    }
  }
  for (const [action, wasShape] of Object.entries(base.reads || {})) {
    const nowShape = snap.reads[action];
    if (!nowShape) continue;
    if (wasShape.ok && !nowShape.ok) {
      problems.push(`REGRESSION  ${action}: read was ok, now failing — ${nowShape.error || nowShape.note}`);
      continue;
    }
    const gone = (wasShape.keys || []).filter((k) => !(nowShape.keys || []).includes(k));
    if (gone.length) problems.push(`REGRESSION  ${action}: response keys disappeared — ${gone.join(', ')}`);
  }

  const newlyPresent = Object.entries(snap.routes)
    .filter(([a, v]) => v === 'ROUTE_PRESENT' && base.routes[a] === 'ROUTE_MISSING')
    .map(([a]) => a);

  console.log('');
  if (newlyPresent.length) console.log(`Newly wired routes (expected): ${newlyPresent.join(', ')}\n`);
  if (!problems.length) {
    console.log(`PASS — nothing regressed against the baseline from ${base.at}.`);
    console.log(`  ${Object.keys(snap.routes).length} routes checked` + (token ? `, ${Object.keys(snap.reads).length} read shapes compared` : ''));
    return;
  }
  console.log(`FAIL — ${problems.length} regression(s):\n`);
  problems.forEach((p) => console.log('  ' + p));
  process.exit(1);
})();
