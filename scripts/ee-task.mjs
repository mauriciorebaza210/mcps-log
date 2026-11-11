// Run an allow-listed engine maintenance task as Tony, over the signed relay
// (email-engine/src/Admin.js → maintenance), so nobody has to click Run in the
// Apps Script editor:
//
//   EE_RELAY_SECRET=… node scripts/ee-task.mjs setup_marketing_kit | setup | diagnostics
//
// The secret is never in the repo: it's the preview's EE_RELAY_SECRET
// (`vercel env pull --environment=preview --git-branch=feat/email-engine`) or
// the engine's Script Property of the same name.
import { relayAdmin } from '../api/_lib/email-relay.js';

const WEBAPP = 'https://script.google.com/macros/s/AKfycby4cJlb1hFupST63Wdjp6R1EeURsSgCGbpqcKkfFfadLMKrbbjS7kzTB7STAyAZsBpx/exec';
const task = process.argv[2];
const secret = String(process.env.EE_RELAY_SECRET || '').trim();
if (!task || !secret) { console.error('usage: EE_RELAY_SECRET=… node scripts/ee-task.mjs <setup_marketing_kit|setup|diagnostics>'); process.exit(1); }
const r = await relayAdmin({ action: 'maintenance', params: { task }, actor: 'claude' }, { url: WEBAPP, secret });
console.log(JSON.stringify(r, null, 1));
process.exit(r && r.ok ? 0 : 1);
