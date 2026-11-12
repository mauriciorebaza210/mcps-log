// The guarded deploy's schema range and rollback-floor checks (row 32; scripts/ee-schema.mjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Row 32 (deploy side): code that can’t read the live data is refused; a rollback below the floor is refused', async () => {
  const { deployCheck, readLocalSchema } = await import('../scripts/ee-schema.mjs');
  const local = readLocalSchema(fs.readFileSync(path.join(__dirname, '..', 'email-engine', 'src', 'Main.js'), 'utf8'));
  assert.deepEqual(local, { read_min: 1, read_max: 1, writes: 1 });
  assert.equal(deployCheck({ localSchema: local, liveDataSchema: 1 }), '');
  assert.equal(deployCheck({ localSchema: local, liveDataSchema: 0 }), '', 'no schema recorded yet (first deploy)');
  assert.match(deployCheck({ localSchema: local, liveDataSchema: 2 }), /reads schema 1\.\.1 but the live data is schema 2/);
  assert.match(deployCheck({ localSchema: { read_min: 2, read_max: 3, writes: 3 }, liveDataSchema: 1 }), /live data is schema 1/);
  assert.equal(deployCheck({ rollbackTo: 30, floor: 0 }), '');
  assert.match(deployCheck({ rollbackTo: 30, floor: 33 }), /below the rollback floor @33/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'email-engine', 'rollback-floor.json'), 'utf8')).floor, 0);
});
