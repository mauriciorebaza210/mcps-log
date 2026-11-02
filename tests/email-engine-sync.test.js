// The Apps Script copies of the shared modules and seeds must match their
// sources exactly (scripts/ee-sync.mjs). Drift here would mean the engine sends
// by different rules than the portal previews.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

test('Generated Apps Script files match their sources', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'ee-sync.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /up to date/);
});
