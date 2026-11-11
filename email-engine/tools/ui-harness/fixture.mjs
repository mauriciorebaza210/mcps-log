// Realistic demo data, pushed through the REAL read model (api/_lib/email-read.js).
const R = await import('/Users/mauriciorebaza/mcps-log-email-engine/api/_lib/email-read.js');
const ruleset = JSON.parse(await (await import('node:fs/promises')).readFile('/Users/mauriciorebaza/mcps-log-email-engine/email-engine/seed/ruleset-bc.json', 'utf8'));
const now = Date.now(), iso = d => new Date(now - d * 86400000).toISOString();
const first = ['Maria','James','Linda','Robert','Patricia','Carlos','Jennifer','Michael','Elena','David','Sofia','William','Ana','Richard','Laura','Joseph','Gabriela','Thomas','Isabel','Daniel','Rosa','Mark'];
const last = ['Lopez','Park','Garza','Miller','Hernandez','Reyes','Davis','Brown','Flores','Wilson','Ramirez','Moore','Castillo','Taylor','Vega','Anderson','Morales','Thomas','Ortiz','Jackson','Silva','White'];
const T = { ChangeLog: [], Permissions: [], Config: [], Rulesets: [], Revisions: [], Contacts: [], Enrollments: [], Deliveries: [], Runs: [], Alerts: [], Engagement: [], Batches: [], Holds: [], Overrides: [] };
const rows = (name, objs) => { const h = [...new Set(objs.flatMap(Object.keys))]; T[name] = [h, ...objs.map(o => h.map(k => o[k] === undefined ? '' : (typeof o[k] === 'object' ? JSON.stringify(o[k]) : String(o[k]))))]; };
const todayCT = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const cfg = { engine_mode: 'test', rule_rev: 'bc-1', engine_enabled: 'true', daily_cap: '50', run_hour: '9', sender_name: 'Tony', paused_buckets: '',
  send_time_B: '09:00', send_time_C: '08:30', run_plan: JSON.stringify({ date: todayCT, times: ['08:30', '09:00', '10:30', '14:15', '16:00'], dropped: [] }) };
rows('Config', Object.entries(cfg).map(([key, value]) => ({ key, value })));
rows('Permissions', [{ username: 'mau', roles: 'editor,approver,operator', active: 'Y' }]);
rows('Rulesets', [{ rule_rev: 'bc-1', json: ruleset }]);
rows('Revisions', [
  { revision_id: 'rev_b_intro_1', step_id: 'b_intro', rev_no: 1, subject: 'An introduction from Mission Custom Pools', preheader: 'Meet Mission Custom Pool Solutions, the service side of the family that built your pool.', status: 'published', approver: 'antonio@mcpoolsolutions.org', approved_at: iso(8) },
  { revision_id: 'rev_b_followup_1', step_id: 'b_followup', rev_no: 1, subject: 'Following up on your pool', status: 'published', approver: 'antonio@mcpoolsolutions.org', approved_at: iso(5), format: 'full', source_name: 'Follow Up - first try.html', source_file_id: 't3' },
  { revision_id: 'rev_c_welcome_2', step_id: 'c_welcome', rev_no: 2, subject: 'Welcome to Mission Custom Pool Solutions', preheader: 'Your startup date and what happens next.', status: 'published', approver: 'antonio@mcpoolsolutions.org', approved_at: iso(6) },
  { revision_id: 'draft_b_followup_x1', step_id: 'b_followup', rev_no: 0, subject: 'A quick follow-up, {{FirstName}}', status: 'draft', format: 'full', source_name: 'Follow Up - short.html', source_file_id: 't2', editor: 'mau', created_at: iso(0.2) },
  { revision_id: 'rev_c_progress_1', step_id: 'c_progress', rev_no: 1, subject: 'Your startup: week {{n}}', status: 'published', approver: 'mauricio@mcpoolsolutions.org', approved_at: iso(4) }]);
const C = [], E = [], D = [], G = [];
first.forEach((f, i) => {
  const b = i < 14 ? 'B' : 'C', id = 'c' + i, email = (f + '.' + last[i]).toLowerCase() + '@example.com';
  C.push({ contact_id: id, email_norm: email, first_name: f, last_name: last[i], bucket: b, sub_bucket: b === 'B' ? (i % 3 ? 'B2' : 'B1') : '', is_test: 'N', review_status: 'confirmed', address: (100 + i * 7) + ' Canyon Oak, Boerne, TX', startup_date: b === 'C' ? iso(-3 + i % 5).slice(0, 10) : '' });
  const stopped = i === 3 ? 'replied' : i === 7 ? 'clicked' : '';
  E.push({ enrollment_id: 'e' + i, contact_id: id, sequence_id: b, rule_rev: 'bc-1', mode: 'test', status: stopped ? 'stopped' : 'active', stop_reason: stopped, enrolled_on: iso(9 - i % 6).slice(0, 10) });
  const add = (step, daysAgo, state, eng) => { const k = 'e' + i + ':' + step + ':1'; D.push({ delivery_id: k, key: k, contact_id: id, enrollment_id: 'e' + i, step_id: step, occurrence: 1, mode: 'test', email_norm: email, state, attempt: 1, claimed_at: iso(daysAgo), send_invoked_at: iso(daysAgo), sent_at: state === 'sent' ? iso(daysAgo) : '', error: state === 'unknown' ? 'no copy in Sent after 16 min' : '' }); if (eng) G.push({ delivery_id: k, ...eng }); };
  if (b === 'B') {
    add('b_intro', 8 - i % 5, i === 12 ? 'unknown' : 'sent', i % 2 ? { opens_total: 2, opens_medium: 1 + (i % 2), opens_low: 1, clicks_medium: i % 4 === 1 ? 1 : 0, clicks_high: i === 7 ? 1 : 0, clicks_low: i === 5 ? 2 : 0, links_json: i % 4 === 1 ? { button1: 1 } : {}, replied_at: i === 3 ? iso(5) : '', last_reply_snippet: i === 3 ? 'Thanks Tony — yes, we’d love a quote. Weekends work best for us.' : '' } : null);
    if (i % 3) add('b_followup', 3 - i % 3, 'sent', i === 4 ? { opens_total: 1, opens_medium: 1 } : null);
  } else {
    add('c_welcome', 5 - i % 4, 'sent', { opens_total: 1, opens_medium: 1 });
    if (i % 2) add('c_progress', 1, i === 19 ? 'failed' : 'sent', i === 17 ? { opens_total: 1, opens_medium: 1, clicks_medium: 1, clicks_high: 1, links_json: { button1: 1 } } : null);
  }
});
// Waiting people (Needs review), as an import leaves them.
const WF = ['Hannah','Luis','Grace','Oscar','Megan','Victor','Chloe','Ramon','Emily','Hector','Olivia','Pedro','Ava','Mateo','Zoe','Diego','Lily','Andres','Nora','Felipe'];
const WL = ['Perez','Cruz','Diaz','Long','Kim','Soto','Hall','Ruiz','Young','Lara','King','Rios','Scott','Nunez','Green','Vargas','Adams','Leon','Baker','Mora'];
for (let i = 0; i < 52; i++) C.push({ contact_id: 'w' + i, email_norm: (WF[i % 20] + '.' + WL[(i * 7) % 20] + i).toLowerCase() + '@example.com', first_name: WF[i % 20], last_name: WL[(i * 7) % 20],
  bucket: i < 46 ? 'B' : 'C', sub_bucket: i < 46 ? 'B1' : '', review_status: 'needs_review', is_test: 'N', area: ['Boerne', 'Helotes', 'Castroville', 'Bulverde'][i % 4],
  tags: i % 5 === 0 ? 'vip' : i % 3 === 0 ? 'spa' : '', source: i % 2 ? 'MCP 2019' : 'MCP 2022', created_at: '2026-10-' + String(1 + i % 28).padStart(2, '0') + 'T00:00:00Z' });
C.forEach((c, i) => { if (c.bucket === 'B' && i % 3 === 1 && !c.contact_id.startsWith('w')) c.send_time = '10:30'; });
const day = n => new Date(now + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
rows('Batches', [
  { batch_id: 'b1', group: 'B', count: 20, order: 'random', pick: 'now', start_on: day(12), send_time: '14:15', status: 'planned', filters_json: { area: ['Boerne'] }, contact_ids: Array.from({ length: 20 }, (_, k) => 'w' + k) },
  { batch_id: 'b2', group: 'B', count: 20, order: 'random', pick: 'at_start', start_on: day(26), status: 'planned', filters_json: {}, contact_ids: [] },
  { batch_id: 'b0', group: 'B', count: 14, order: 'oldest', pick: 'now', start_on: day(-9), status: 'started', started_count: 14, started_at: new Date(now - 9 * 86400000).toISOString(), filters_json: {}, contact_ids: [] }]);
rows('Overrides', [{ key: 'e5:b_followup:1', kind: 'next_run', date: '', by: 'mau', at: iso(0.1) }]);
rows('Holds', [{ key: 'none', held_days: 0 }]);
rows('Contacts', C); rows('Enrollments', E); rows('Deliveries', D); rows('Engagement', G);
const atCT = t => new Date(todayCT + 'T' + t + ':00-06:00').toISOString();
rows('Runs', [{ run_id: 's1', trigger: 'scheduled', planned_for: '08:30', started_at: atCT('08:31'), finished_at: atCT('08:32'), sent: 4, skipped: 0, stopped_reason: 'done' },
  { run_id: 's2', trigger: 'scheduled', planned_for: '09:00', started_at: atCT('09:00'), finished_at: atCT('09:02'), sent: 11, skipped: 1, stopped_reason: 'done' },
  { run_id: 'm1', trigger: 'portal', started_at: atCT('09:40'), finished_at: atCT('09:41'), sent: 0, skipped: 0, stopped_reason: 'done' }]
  .concat([1, 2, 3, 4].map(k => ({ run_id: 'r' + k, trigger: 'scheduled', planned_for: '09:00', started_at: new Date(Date.parse(atCT('09:01')) - k * 86400000).toISOString(), sent: [9, 6, 11, 4][k - 1], skipped: k % 2, stopped_reason: k === 4 ? 'quota_reserve' : 'done' }))));
rows('ChangeLog', [{ id: 'g1', at: new Date(now - 25*60e3).toISOString(), actor: 'tony', action: 'set_bucket_paused', detail: { bucket: 'C', paused: false }, result: 'ok' }, { id: 'g2', at: new Date(now - 3*3600e3).toISOString(), actor: 'mau', action: 'run_now', detail: {}, result: 'ok' }]);
rows('Alerts', [{ at: iso(1.2) + ' ab12', kind: 'delivery_unknown', detail: 'e12:b_intro:1' }]);
const tables = R.toTables(T), caps = R.capabilitiesFor('mau', tables.Permissions);
const out = { overview: R.buildOverview(tables, caps, now), contacts: R.buildContacts(tables, caps, { limit: 1000 }), step: {}, contact: {},
  plan: { B: R.buildPlan(tables, caps, now, { bucket: 'B' }), C: R.buildPlan(tables, caps, now, { bucket: 'C' }) } };
for (const s of out.overview.steps) out.step[s.step_id] = R.buildStep(tables, caps, s.step_id, now);
for (const c of C) out.contact[c.contact_id] = R.buildContact(tables, caps, c.contact_id);
const fs = await import('node:fs/promises'), here = new URL('.', import.meta.url).pathname;
await fs.writeFile(here + 'fixture.json', JSON.stringify(out));
const root = 'file://' + new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const tpl = await fs.readFile(here + 'harness.template.html', 'utf8');
await fs.writeFile(here + 'harness.html', tpl.replace('__FIXTURE__', JSON.stringify(out)).split('__ROOT__').join(root));
console.log('plan rows B', out.plan.B.rows.length, 'C', out.plan.C.rows.length, 'steps', out.overview.steps.length, 'contacts', out.contacts.total, 'attention', out.overview.attention.length, 'healthy', out.overview.health.ok);
