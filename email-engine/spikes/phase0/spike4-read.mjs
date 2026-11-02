// Spike 4: how fast can the portal read the engine spreadsheet, and how much
// does each page pull? Run from a dev machine with the portal's service
// account in ~/mcps-log/.env.local:
//
//   node email-engine/spikes/phase0/spike4-read.mjs <spreadsheet id>
//
// The service account can't create files (Google returns 403), so it fills a
// blank spreadsheet Mau created and shared with it as Editor. It adds test tabs with
// synthetic engine data at the plan's benchmark size (5k contacts, 20k
// deliveries, 20k engagement rows, plus an Events month), times the read
// patterns the Lifecycle page will use, prints a report, then deletes the tabs
// it added. Nothing real is read or written. The key is never printed.
import crypto from 'node:crypto';
import fs from 'node:fs';

const ENV_FILE = '/Users/mauriciorebaza/mcps-log/.env.local';
const env = Object.fromEntries(fs.readFileSync(ENV_FILE, 'utf8').split('\n')
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
  .map(([, k, v]) => [k, v.trim().replace(/^["']|["']$/g, '')]));
const EMAIL = env.GOOGLE_CLIENT_EMAIL;
const KEY = (env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
if (!EMAIL || !KEY) throw new Error('GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY missing in ' + ENV_FILE);

const b64url = v => Buffer.from(v).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
async function token() {
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: EMAIL, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/spreadsheets' };
  const input = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify(claim));
  const assertion = input + '.' + b64url(crypto.sign('RSA-SHA256', Buffer.from(input), KEY));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const j = await r.json(); if (!j.access_token) throw new Error('token: ' + JSON.stringify(j)); return j.access_token;
}
let TOKEN;
async function api(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(r.status + ' ' + text.slice(0, 300));
  return { text, json: text ? JSON.parse(text) : {} };
}

// ── Synthetic data (shapes follow PLAN.md → Domain model) ──
const pick = (a, i) => a[i % a.length];
const FIRST = ['Maria', 'James', 'Ana', 'David', 'Linda', 'Robert', 'Patricia', 'Michael', 'Karen', 'Steven', 'Rosa', 'Tom', 'Grace', 'Luis'];
const LAST = ['Lopez', 'Carter', 'Ruiz', 'Nguyen', 'Patel', 'Hill', 'Moore', 'Brooks', 'Flores', 'Reed', 'Garza', 'Alvarez', 'Kim', 'Romero'];
const day = i => new Date(Date.UTC(2026, 0, 1) + (i % 300) * 864e5).toISOString().slice(0, 10);
const iso = i => new Date(Date.UTC(2026, 0, 1) + (i % 300) * 864e5 + (i % 86400) * 1000).toISOString();
const uuid = i => crypto.createHash('md5').update('x' + i).digest('hex');
// Default = the benchmark size. 'launch' = 2x the initial workload (PLAN.md →
// Performance: mandatory launch budgets are measured at this size).
const SCALE = process.argv[3] || 'benchmark';
const N = SCALE === 'launch'
  ? { contacts: 300, enrollments: 300, deliveries: 1200, engagement: 1200, events: 3000, recent: 600 }
  : { contacts: 5000, enrollments: 5000, deliveries: 20000, engagement: 20000, events: 30000, recent: 3000 };

const TABS = {
  Contacts: [['contact_id', 'email_norm', 'alt_emails', 'first_name', 'last_name', 'phone', 'address', 'language', 'bucket', 'sub_bucket',
    'tags', 'review_status', 'is_test', 'pool_school', 'pool_school_date', 'source', 'quote_id', 'pool_id', 'startup_date', 'startup_source',
    'events_json', 'created_at', 'updated_at', 'last_seq', 'notes'],
    i => ['c' + i, (pick(FIRST, i) + '.' + pick(LAST, i * 7) + i + '@example.com').toLowerCase(), '', pick(FIRST, i), pick(LAST, i * 7),
      '(210) 555-' + String(1000 + i % 9000), (100 + i % 900) + ' Canyon Oak Dr, San Antonio, TX 78' + String(200 + i % 99), 'en',
      i % 3 ? 'B' : 'C', i % 3 ? 'B' + (1 + i % 4) : '', i % 5 ? '' : 'pool-school', 'confirmed', 'N', i % 4 ? 'N' : 'Y', '', 'import',
      'Q' + i, 'MCPS' + i, i % 3 ? '' : day(i), i % 3 ? '' : 'scheduled_visits', '{}', iso(i), iso(i + 9), String(i), '']],
  Steps: [['step_id', 'sequence_id', 'order', 'name', 'category', 'status', 'audience_filter', 'anchor', 'event', 'month_day', 'offset', 'unit',
    'repeat_every', 'repeat_count', 'window_days', 'max_hold_days', 'hard_deadline', 'requires', 'stop_rules', 'on_send_sub_bucket',
    'published_revision_id', 'rev', 'attachment_items', 'updated_by', 'updated_at'],
    i => ['s' + i, i < 10 ? 'B' : 'C', i % 5, 'Step ' + i, i % 2 ? 'marketing' : 'service', 'active', '{"sub_buckets":["B1"]}', 'enrollment', '', '',
      String(i * 3), 'calendar', '', '1', '7', '2', '', '', '[{"signal":"reply","stops":"enrollment"}]', '', 'rev' + i, '3', '[]', 'mauricio', iso(i)]],
  Enrollments: [['enrollment_id', 'contact_id', 'sequence_id', 'rule_rev', 'mode', 'status', 'enrolled_at', 'anchor_snapshot_json',
    'stop_reason', 'stopped_at', 'stopped_branches', 'last_seq'],
    i => ['e' + i, 'c' + i, i % 3 ? 'B' : 'C', 'r3', 'production', i % 6 ? 'active' : 'completed', iso(i), '{"enrollment":"' + day(i) + '"}', '', '', '[]', String(i)]],
  Deliveries: [['delivery_id', 'delivery_token', 'key', 'mode', 'state', 'attempt', 'lease_until', 'draft_id', 'message_id', 'thread_id',
    'send_invoked_at', 'revision_id', 'shell_version', 'run_id', 'due_date', 'original_due_date', 'held_days', 'deadline', 'sent_at', 'error',
    'reconcile_notes', 'reply_scan_cursor', 'attachment_versions', 'enrollment_id', 'last_seq'],
    i => ['d' + i, 'dlv_' + uuid(i), 'e' + (i % 5000) + ':s' + (i % 20) + ':1', 'production', 'sent', '1', '', 'r-' + uuid(i).slice(0, 16),
      uuid(i + 1).slice(0, 16), uuid(i + 2).slice(0, 16), iso(i), 'rev' + (i % 20), 'shell-3', 'run' + (i % 300), day(i), day(i), '0', '',
      iso(i), '', '', uuid(i + 3).slice(0, 16), '[]', 'e' + (i % 5000), String(i)]],
  Engagement: [['delivery_id', 'classifier_version', 'opens_total', 'opens_unique_first_at', 'last_open_at', 'open_confidence',
    'human_clicks_json', 'scanner_like_hits', 'replied_at', 'reply_from', 'reply_snippet', 'unsubscribed_at'],
    i => ['d' + i, 'v1', String(i % 4), i % 4 ? iso(i + 30) : '', i % 4 ? iso(i + 90) : '', i % 4 ? 'medium' : '',
      i % 9 ? '{}' : '{"quote":1}', String(i % 3), i % 25 ? '' : iso(i + 400), i % 25 ? '' : 'someone@example.com',
      i % 25 ? '' : 'Hi Tony, yes we would love a quote for weekly service.', '']],
  Runs: [['run_id', 'trigger', 'owner', 'started_at', 'finished_at', 'rule_version', 'counts_json', 'stopped_reason'],
    i => ['run' + i, 'daily', 'antonio@mcpoolsolutions.org', iso(i), iso(i + 120), 'r3', '{"sent":12,"held":2,"failed":0}', 'done']],
  Config: [['key', 'value'], i => ['setting_' + i, 'value_' + i]],
  Events_2026_10: [['event_id', 'gmail_message_id', 'delivery_id', 'enrollment_id', 'mode', 'type', 'link_id', 'received_at', 'seconds_since_send',
    'method', 'ua_raw', 'ua_family', 'ip_prefix_hash', 'beacon_present', 'burst_count'],
    i => ['ev' + i, '', 'd' + (i % 20000), 'e' + (i % 5000), 'production', pick(['open', 'click', 'open', 'open'], i), i % 4 === 1 ? 'quote' : '',
      iso(i), String(30 + i % 90000), 'GET', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15', 'Safari iOS',
      uuid(i + 5).slice(0, 12), i % 4 === 1 ? 'Y' : 'N', '1']],
};
const COUNTS = { Contacts: N.contacts, Steps: 20, Enrollments: N.enrollments, Deliveries: N.deliveries, Engagement: N.engagement,
  Runs: 300, Config: 30, Events_2026_10: N.events };

function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

async function main() {
  TOKEN = await token();
  const ID = process.argv[2];
  if (!ID) throw new Error('usage: node spike4-read.mjs <spreadsheet id shared with the service account as Editor>');
  const added = await api(`https://sheets.googleapis.com/v4/spreadsheets/${ID}:batchUpdate`, { method: 'POST', body: JSON.stringify({
    requests: Object.entries(COUNTS).map(([title, n]) => ({ addSheet: { properties: { title: 'ee4_' + title,
      gridProperties: { rowCount: n + 1, columnCount: TABS[title][0].length } } } })) }) });
  const addedIds = added.json.replies.map(r => r.addSheet.properties.sheetId);
  console.log('added', addedIds.length, 'test tabs');
  try {
    // Fill in chunks of 4,000 rows.
    for (const [title, n] of Object.entries(COUNTS)) {
      const [header, gen] = TABS[title];
      const lastCol = colLetter(header.length);
      for (let start = 0; start < n; start += 4000) {
        const rows = [];
        if (start === 0) rows.push(header);
        for (let i = start; i < Math.min(n, start + 4000); i++) rows.push(gen(i));
        const firstRow = start === 0 ? 1 : start + 2;
        await api(`https://sheets.googleapis.com/v4/spreadsheets/${ID}/values/${encodeURIComponent('ee4_' + title + '!A' + firstRow + ':' + lastCol + (firstRow + rows.length - 1))}?valueInputOption=RAW`,
          { method: 'PUT', body: JSON.stringify({ values: rows }) });
      }
      process.stdout.write('  filled ' + title + ' (' + n + ' rows)\n');
    }

    const batchGet = async ranges => {
      const u = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${ID}/values:batchGet`);
      ranges.forEach(r => u.searchParams.append('ranges', 'ee4_' + r));
      u.searchParams.set('majorDimension', 'ROWS');
      u.searchParams.set('prettyPrint', 'false');
      const t = Date.now(); const { text } = await api(u.toString()); return { ms: Date.now() - t, bytes: Buffer.byteLength(text) };
    };
    const recent = N.recent; // ~60 days of deliveries, with older rows archived
    const patterns = {
      'overview (plan: Contacts + Steps + active Enrollments + recent Deliveries + Engagement + Runs + Config)': [
        `Contacts!A1:Y${N.contacts + 1}`, 'Steps!A1:Y21', `Enrollments!A1:L${N.enrollments + 1}`, `Deliveries!A1:Y${recent + 1}`, `Engagement!A1:L${recent + 1}`, 'Runs!A1:H31', 'Config!A1:B31'],
      'overview, narrow columns only (fields the page actually shows)': [
        `Contacts!A1:L${N.contacts + 1}`, 'Steps!A1:F21', `Enrollments!A1:F${N.enrollments + 1}`, `Deliveries!A1:E${recent + 1}`, `Deliveries!S1:S${recent + 1}`,
        `Engagement!A1:L${recent + 1}`, 'Runs!A1:H31'],
      'contacts page (all contacts, for filter counts)': [`Contacts!A1:Y${N.contacts + 1}`],
      'tracking detail for one email (recent Deliveries + Engagement)': [`Deliveries!A1:Y${recent + 1}`, `Engagement!A1:L${recent + 1}`],
      'worst case: all Deliveries + Engagement (no archiving)': [`Deliveries!A1:Y${N.deliveries + 1}`, `Engagement!A1:L${N.engagement + 1}`],
      'raw events, current month (per-delivery event list source)': [`Events_2026_10!A1:O${N.events + 1}`],
    };
    const report = [];
    for (const [name, ranges] of Object.entries(patterns)) {
      const runs = [];
      for (let k = 0; k < 6; k++) runs.push(await batchGet(ranges));
      const ms = runs.map(r => r.ms); const cold = ms[0]; const warm = ms.slice(1).sort((a, b) => a - b);
      report.push({ pattern: name, cells_ranges: ranges.length, bytes: runs[0].bytes, cold_ms: cold,
        warm_p50_ms: warm[Math.floor(warm.length / 2)], warm_max_ms: warm[warm.length - 1] });
    }
    console.log('\nRESULTS at scale=' + SCALE + ' ' + JSON.stringify(N) + ' (from this machine; Vercel functions may differ)');
    for (const r of report) console.log(JSON.stringify(r));
  } finally {
    try {
      await api(`https://sheets.googleapis.com/v4/spreadsheets/${ID}:batchUpdate`, { method: 'POST',
        body: JSON.stringify({ requests: addedIds.map(sheetId => ({ deleteSheet: { sheetId } })) }) });
      console.log('\nremoved the test tabs; the spreadsheet itself can now be deleted');
    } catch (e) { console.log('\nCOULD NOT remove test tabs: ' + String(e.message).slice(0, 200)); }
  }
}
main().catch(e => { console.error('spike 4 failed:', e.message); process.exit(1); });
