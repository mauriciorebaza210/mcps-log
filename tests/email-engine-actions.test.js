// Every engine admin action must be reachable from the portal: either in
// api/email.js ADMIN_CAP (op=admin, with its permission) or relayed by another op
// (import, clean, crm). Caught after single emails shipped without ADMIN_CAP entries.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('Each engine action has a way in from the portal, and ADMIN_CAP names no action the engine lacks', () => {
  const admin = read('email-engine/src/Admin.js'), api = read('api/email.js');
  const engine = Object.keys(eval('(' + admin.match(/var EE_ADMIN_ACTIONS = (\{[^}]*\})/)[1] + ')'));
  const capBlock = api.match(/const ADMIN_CAP = \{([\s\S]*?)\};/)[1];
  const caps = [...capBlock.matchAll(/([a-z_]+):\s*'/g)].map(m => m[1]);
  const relayed = new Set([...api.matchAll(/(?:relay\(|action:\s*)'([a-z_]+)'/g)].map(m => m[1]));
  const internal = new Set(['ping']);   // the speed check
  const missing = engine.filter(a => !caps.includes(a) && !relayed.has(a) && !internal.has(a));
  assert.deepEqual(missing, [], 'engine actions with no route from the portal');
  const unknown = caps.filter(a => !engine.includes(a));
  assert.deepEqual(unknown, [], 'ADMIN_CAP entries the engine refuses as unknown');
});
