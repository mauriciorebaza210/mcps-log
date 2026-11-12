// The portal's own data as lifecycle contacts: Sales Hub leads (Quotes, status
// LEAD) and startups (Quotes Pool Startup + the live schedule). Pure module
// (api/_lib/email-crm.js), the API route (api/email.js → op=crm, heartbeat) with
// fake sheets, and the engine's startup sync (Admin.js → sync_startups).
// PLAN.md → Plan changes 2026-11-11 "Connected to the portal's own data".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeWorld } = require('./helpers/ee-fake-env.js');
const ROOT = path.join(__dirname, '..');
const mod = () => import(path.join(ROOT, 'api', '_lib', 'email-crm.js'));

const Q = [
  { quote_id: 'Q-L1', status: 'LEAD', lead_source: 'import', first_name: 'Ana', last_name: 'Diaz', email: 'Ana@Example.com', area: 'Boerne', year_built: '2016', pool_info: 'Freeform, spa' },
  { quote_id: 'Q-L2', status: 'LEAD', lead_source: 'import', client_name: 'Bo Kim', email: 'bo@example.com', area: 'Helotes', year_built: '' },
  { quote_id: 'Q-L3', status: 'LEAD', lead_source: 'service_request:spring', first_name: 'Cy', email: 'cy@example.com' },
  { quote_id: 'Q-L4', status: 'LEAD', lead_source: 'import', first_name: 'Dee', email: 'not-an-email' },
  { quote_id: 'Q-L5', status: 'LEAD', lead_source: 'import', first_name: 'Ana again', email: 'ana@example.com', year_built: '2016' },
  { quote_id: 'Q-L6', status: 'LEAD', lead_source: 'import', first_name: 'Eve', email: 'eve@example.com', year_built: '2012' },
  { quote_id: 'Q-L7', status: 'LEAD', lead_source: '', first_name: 'Old', last_name: 'Import', email: 'oldimport@example.com' },
  { quote_id: 'Q-L8', status: 'LEAD', lead_source: 'mcp', first_name: 'New', last_name: 'Mcp', email: 'newmcp@example.com' },
  { quote_id: 'Q-L9', status: 'LEAD', lead_source: 'other_list', first_name: 'Other', email: 'other@example.com' },
  { quote_id: 'Q-L10', status: 'LEAD', lead_source: 'one_time_job', first_name: 'Job', email: 'job@example.com' },
  { quote_id: 'Q-C1', status: 'ACTIVE_CUSTOMER', service_key: 'weekly_full', first_name: 'Eve', email: 'eve@example.com' },
  // Startups
  { quote_id: 'Q-S1', status: 'ACTIVE_CUSTOMER', service_key: 'pool_startup', pool_id: 'MCPS-0101', first_name: 'Sam', last_name: 'Ruiz', email: 'sam@example.com', address: '9 Oak Ln', city: 'Boerne', startup_start_date: '2026-11-20', startup_pool_school: 'Yes' },
  { quote_id: 'Q-S2', status: 'ACTIVE_CUSTOMER', service: 'Pool Startup', pool_id: 'MCPS-0102', first_name: 'Tia', email: 'tia@example.com', startup_start_date: '2026-12-02', startup_pool_school: '' },
  { quote_id: 'Q-S3', status: 'LOST', service_key: 'pool_startup', pool_id: 'MCPS-0103', first_name: 'Uma', email: 'uma@example.com', startup_start_date: '2026-11-30' },
  { quote_id: 'Q-S4', status: 'ACTIVE_CUSTOMER', service_key: 'pool_startup', pool_id: 'MCPS-0104', first_name: 'Val', email: 'val@example.com', startup_start_date: '2026-11-25' },
  { quote_id: 'Q-S5', status: 'ACTIVE_CUSTOMER', service_key: 'pool_startup', pool_id: 'MCPS-0105', first_name: 'Old', email: 'old@example.com', startup_start_date: '2026-09-01' },
  { quote_id: 'Q-S6', status: 'UNSENT', service_key: 'pool_startup', pool_id: '', first_name: 'Not yet', email: 'ny@example.com' }
];
const V = [
  // Q-S1 was rescheduled: the schedule says Nov 24, the quote still says Nov 20.
  { pool_id: 'MCPS-0101', visit_type: 'startup_day_1', scheduled_date: '2026-11-24', status: 'scheduled' },
  { pool_id: 'MCPS-0101', visit_type: 'startup_day_2', scheduled_date: '2026-11-25', status: 'scheduled' },
  // Q-S4: every startup visit cancelled.
  { pool_id: 'MCPS-0104', visit_type: 'startup_day_1', scheduled_date: '2026-11-25', status: 'cancelled' },
  { pool_id: 'MCPS-0104', visit_type: 'startup_day_2', scheduled_date: '2026-11-26', status: 'cancelled' },
  // A day 1 already completed still counts (day 2 tells the same date).
  { pool_id: 'MCPS-0102', visit_type: 'startup_day_2', scheduled_date: '2026-12-03', status: 'completed' }
];

test('Lead breakdown: what the Sales Hub holds, so the rule is picked from real counts', async () => {
  const { leadBreakdown } = await mod();
  const b = leadBreakdown(Q, [{ email_norm: 'bo@example.com' }]);
  assert.equal(b.leads, 10);
  assert.equal(b.with_email, 9);
  assert.equal(b.in_engine, 1);
  assert.deepEqual(b.by_source, { import: 5, service_request: 1, unknown: 1, mcp: 1, other_list: 1, one_time_job: 1 });
  assert.deepEqual(b.year_built, { with: 3, without: 7 });
  assert.equal(b.by_status.ACTIVE_CUSTOMER, 5);
});

test('Lead candidates follow the saved rule; one per email; the Sales Hub link (quote_id) is kept', async () => {
  const { leadCandidates } = await mod();
  const c = leadCandidates(Q, { lead_sources: ['import'], year_built: 'with' });
  assert.deepEqual(c.map(x => x.quote_id), ['Q-L1', 'Q-L6'], 'L5 is Ana again; L2 has no year; L3 another source; L4 bad email');
  assert.equal(c[0].email_norm, 'ana@example.com');
  assert.equal(c[0].pool_build_year, '2016');
  assert.equal(c[0].source, 'sales_hub:import');
  assert.deepEqual(leadCandidates(Q, {}).map(x => x.quote_id), ['Q-L1', 'Q-L2', 'Q-L3', 'Q-L6', 'Q-L7', 'Q-L8', 'Q-L9', 'Q-L10'], 'no source filter: every LEAD with an email');
  assert.equal(leadCandidates(Q, {}).find(x => x.quote_id === 'Q-L2').first_name, 'Bo', 'client_name split when first/last are empty');
});

test('MCP leads by default: every imported lead (old imports with no source, "import", "mcp"); never other lists, service requests or jobs', async () => {
  const { leadCandidates, DEFAULT_MCP_RULE } = await mod();
  assert.deepEqual(leadCandidates(Q, DEFAULT_MCP_RULE).map(x => x.quote_id), ['Q-L1', 'Q-L2', 'Q-L6', 'Q-L7', 'Q-L8']);
});

test('Startups: live date from the schedule (reschedules), fallback to the quote; cancelled and old ones handled', async () => {
  const { startupContacts } = await mod();
  const s = startupContacts(Q, V, '2026-11-15');
  const by = Object.fromEntries(s.contacts.map(c => [c.quote_id, c]));
  assert.deepEqual(Object.keys(by).sort(), ['Q-S1', 'Q-S2']);
  assert.equal(by['Q-S1'].startup_date, '2026-11-24', 'the schedule wins over Quotes.startup_start_date');
  assert.equal(by['Q-S1'].startup_source, 'schedule');
  assert.equal(by['Q-S1'].pool_school, 'Y');
  assert.equal(by['Q-S1'].address, '9 Oak Ln, Boerne');
  assert.equal(by['Q-S2'].startup_date, '2026-12-02', 'worked back from day 2');
  assert.equal(by['Q-S2'].pool_school, 'N');
  assert.deepEqual(s.removed.map(r => [r.quote_id, r.reason]).sort(), [['Q-S3', 'quote_lost'], ['Q-S4', 'visits_cancelled']]);
  assert.ok(!by['Q-S5'], 'startup more than 33 days ago: nothing left to send');
  assert.ok(!by['Q-S6'], 'no pool yet (not activated)');
});

// ── API route with fake sheets ──
async function api(sheets, over = {}) {
  process.env.EE_ENGINE_SS_ID = 'engine-sheet';
  const { createEmailHandler } = await import(path.join(ROOT, 'api', 'email.js'));
  const relayed = [];
  const toSheet = rows => { const h = [...new Set(rows.flatMap(Object.keys))]; return [h, ...rows.map(r => h.map(k => r[k] == null ? '' : typeof r[k] === 'object' ? JSON.stringify(r[k]) : String(r[k])))]; };
  const data = { Permissions: toSheet([{ username: 'mau', roles: 'editor,approver,operator', active: 'Y' }, { username: 'viewer1', roles: 'viewer', active: 'Y' }]),
    Config: toSheet(sheets.config || [{ key: 'engine_mode', value: 'test' }]), Contacts: toSheet(sheets.contacts || [{ contact_id: 'x', email_norm: 'bo@example.com', bucket: 'B' }]),
    Quotes: toSheet(Q), Clients: toSheet([{ email: 'cy@example.com', status: 'active' }]), Scheduled_Visits: toSheet(V), Comms_Optouts: toSheet([{ email: 'eve@example.com', removed_at: '' }]) };
  const h = createEmailHandler({
    validatePortalSession: async t => ({ 'tok-mau': { username: 'mau' }, 'tok-viewer': { username: 'viewer1' } })[t] || null,
    readSheetRanges: async tabs => { const o = {}; tabs.forEach(t => { if (data[t]) o[t] = data[t]; }); return o; },
    getCached: async (k, ttl, f) => f(), crmSpreadsheetId: () => 'crm', routesSpreadsheetId: () => 'routes',
    relayAdmin: async req => { relayed.push(req); return { ok: true, added: (req.params.contacts || []).length }; },
    cronSecret: () => 'cron', sendEngineAlert: async () => ({ ok: true }), now: () => Date.parse('2026-11-15T15:00:00Z'), ...over });
  const call = async ({ method = 'GET', op = 'crm', body, token = 'tok-mau' } = {}) => {
    const res = { statusCode: 0, headers: {}, body: null };
    res.setHeader = (k, v) => { res.headers[k] = v; }; res.status = c => { res.statusCode = c; return res; }; res.send = b => { res.body = JSON.parse(b); return res; };
    await h({ method, query: { op }, headers: { authorization: 'Bearer ' + token }, body }, res);
    return res;
  };
  return { call, relayed };
}

test('op=crm GET: breakdown + startups found, for anyone with access', async () => {
  const { call } = await api({});
  const r = await call({ token: 'tok-viewer' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.breakdown.leads, 10);
  assert.equal(r.body.auto, true, 'automatic unless turned off');
  assert.deepEqual(r.body.rule.lead_sources, ['mcp', 'import', 'unknown']);
  assert.equal(r.body.mcp_leads.new, 3, 'Ana, Old Import, New Mcp; Bo is in the engine, Eve opted out');
  assert.equal(r.body.startups.found, 2);
  assert.equal(r.body.startups.cancelled, 2);
});

test('op=crm check/add: the import check runs (opted out, engine duplicate, customer); only new ones are saved, with quote_id; the rule is saved', async () => {
  const { call, relayed } = await api({});
  assert.equal((await call({ method: 'POST', token: 'tok-viewer', body: { stage: 'check', rule: {} } })).statusCode, 403, 'viewers can look, not add');
  const chk = await call({ method: 'POST', body: { stage: 'check', rule: {} } });
  assert.deepEqual(chk.body.summary, { new: 5, existing: 1, customer: 1, opted_out: 1 }, 'Bo in the engine; Cy a client; Eve opted out');
  const add = await call({ method: 'POST', body: { stage: 'add', rule: { lead_sources: ['import'] }, keep_in_sync: true } });
  assert.equal(add.body.added, 1);
  const imp = relayed.find(r => r.action === 'import_contacts');
  assert.equal(imp.params.contacts[0].quote_id, 'Q-L1');
  assert.equal(imp.params.source, 'sales_hub');
  const rule = relayed.find(r => r.action === 'set_crm_rule');
  assert.deepEqual(rule.params, { rule: { lead_sources: ['import'] }, auto: true });
});

test('Heartbeat syncs startups every morning, and MCP leads unless automatic adding is off', async () => {
  const off = await api({ config: [{ key: 'engine_mode', value: 'test' }, { key: 'crm_lead_auto', value: 'false' }] });
  await off.call({ method: 'GET', op: 'heartbeat', token: 'cron' });
  assert.deepEqual(off.relayed.map(r => r.action), ['sync_startups']);
  assert.deepEqual(off.relayed[0].params.contacts.map(c => c.quote_id).sort(), ['Q-S1', 'Q-S2']);
  const on = await api({});
  await on.call({ method: 'GET', op: 'heartbeat', token: 'cron' });
  assert.deepEqual(on.relayed.map(r => r.action), ['sync_startups', 'import_contacts']);
  assert.deepEqual(on.relayed[1].params.contacts.map(c => c.quote_id).sort(), ['Q-L1', 'Q-L7', 'Q-L8'], 'default MCP rule; Bo, Eve skipped');
});

// ── Engine: sync_startups ──
function engine() {
  const w = fakeWorld();
  w.now = Date.parse('2026-11-15T15:00:00Z');
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite };
  vm.createContext(ctx);
  vm.runInContext(['js/lib/lifecycle-rules.js', 'js/lib/batches.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n') +
    '\nvar EE_TZ = "America/Chicago";\n' + fs.readFileSync(path.join(ROOT, 'email-engine', 'src', 'Admin.js'), 'utf8'), ctx);
  w.sync = p => ctx.EE_adminRun_(w.env, w.core, { action: 'sync_startups', params: p, actor: 'heartbeat' }, {});
  w.contact = q => w.tables.Contacts.find(c => c.quote_id === q);
  return w;
}
const S1 = { quote_id: 'Q-S1', pool_id: 'MCPS-0101', email_norm: 'sam@example.com', first_name: 'Sam', last_name: 'Ruiz', address: '9 Oak Ln, Boerne', startup_date: '2026-11-24', startup_source: 'schedule', pool_school: 'Y' };

test('Engine: new startups become confirmed MCP Startup contacts; a date change updates them; unchanged ones write nothing', () => {
  const w = engine();
  assert.equal(w.sync({ contacts: [S1] }).added, 1);
  const c = w.contact('Q-S1');
  assert.deepEqual([c.bucket, c.review_status, c.startup_date, c.pool_school, c.source], ['C', 'confirmed', '2026-11-24', 'Y', 'portal_startup']);
  const journal = w.journal.length;
  assert.equal(w.sync({ contacts: [S1] }).updated, 0);
  assert.equal(w.journal.length, journal, 'nothing changed: no writes');
  assert.equal(w.sync({ contacts: [{ ...S1, startup_date: '2026-11-27' }] }).updated, 1);
  assert.equal(w.contact('Q-S1').startup_date, '2026-11-27');
});

test('Engine: a cancelled startup is removed and its sequence stopped; someone in MCP Legacy is left alone', () => {
  const w = engine();
  w.sync({ contacts: [S1] });
  const id = w.contact('Q-S1').contact_id;
  w.tables.Enrollments.push({ enrollment_id: 'en1', contact_id: id, sequence_id: 'C', status: 'active' });
  assert.equal(w.sync({ contacts: [], removed: [{ quote_id: 'Q-S1', reason: 'visits_cancelled' }] }).removed, 1);
  assert.equal(w.contact('Q-S1').review_status, 'removed');
  assert.deepEqual([w.tables.Enrollments[0].status, w.tables.Enrollments[0].stop_reason], ['stopped', 'startup_cancelled']);
  w.tables.Contacts.push({ contact_id: 'ct_b', email_norm: 'tia@example.com', bucket: 'B' });
  const r = w.sync({ contacts: [{ ...S1, quote_id: 'Q-S2', email_norm: 'tia@example.com' }] });
  assert.equal(r.skipped[0].reason, 'in_B_campaign');
  assert.ok(w.tables.Config.find(c => c.key === 'crm_sync_at'));
});
