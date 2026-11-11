// Batch selection (js/lib/batches.js), shared by the page and the engine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../js/lib/batches.js');

const people = Array.from({ length: 12 }, (_, i) => ({ contact_id: 'c' + i, bucket: i < 10 ? 'B' : 'C', review_status: i === 9 ? 'confirmed' : 'needs_review',
  area: i % 3 === 0 ? 'Boerne' : 'Helotes', tags: i % 2 ? 'vip, spa' : 'spa', source: i < 5 ? 'MCP 2019' : 'MCP 2022', created_at: '2026-11-' + String(20 - i).padStart(2, '0') }));

test('Only waiting contacts of the group count; filters are "any of" and combine with "and"; test contacts are left out', () => {
  assert.equal(B.eligible(people, { group: 'B' }).length, 9, 'confirmed and other-group contacts excluded');
  assert.deepEqual(B.eligible(people, { group: 'B', filters: { area: ['Boerne'] } }).map(c => c.contact_id), ['c0', 'c3', 'c6']);
  assert.deepEqual(B.eligible(people, { group: 'B', filters: { area: ['boerne'], tags: ['VIP'] } }).map(c => c.contact_id), ['c3']);
  assert.equal(B.eligible(people, { group: 'B', filters: { source: ['MCP 2019'] } }).length, 5);
  assert.equal(B.eligible([{ contact_id: 't', bucket: 'B', review_status: 'needs_review', is_test: 'Y' }], { group: 'B' }).length, 0);
});

test('Oldest first is stable; random takes exactly N distinct people', () => {
  assert.deepEqual(B.pick(people, { group: 'B', count: 3, order: 'oldest' }).map(c => c.contact_id), ['c8', 'c7', 'c6']);
  let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const r = B.pick(people, { group: 'B', count: 4 }, rnd).map(c => c.contact_id);
  assert.equal(new Set(r).size, 4);
  assert.equal(B.pick(people, { group: 'B', count: 50 }).length, 9, 'never more than are waiting');
});

test('Filter options list what is actually waiting, with counts', () => {
  const o = B.filterOptions(people, 'B');
  assert.deepEqual(o.area, [{ value: 'Boerne', count: 3 }, { value: 'Helotes', count: 6 }]);
  assert.deepEqual(o.tags.map(t => t.value), ['spa', 'vip']);
});
