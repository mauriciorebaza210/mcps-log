// One-time repair: Follow Up sent by hand Nov 16 (email-engine/src/Repair.js). Remove with it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const { fakeWorld } = require('./helpers/ee-fake-env.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
test('Only the people approved at the Follow Up, not yet started, move to Check-In next; runs once', () => {
  const w = fakeWorld();
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite };
  vm.createContext(ctx);
  vm.runInContext([read('js/lib/lifecycle-rules.js'), read('js/lib/batches.js'), 'var EE_TZ = "America/Chicago";',
    read('email-engine/src/Admin.js'), read('email-engine/src/Repair.js')].join('\n'), ctx);
  const base = { bucket: 'B', review_status: 'confirmed', start_step: 'b_followup', review_reason: 'approved by tony on 2026-11-16', intro_sent_on: '2026-11-10', is_test: 'N' };
  w.tables.Contacts.push(Object.assign({ contact_id: 'a' }, base), Object.assign({ contact_id: 'b' }, base),
    Object.assign({ contact_id: 'started' }, base), Object.assign({ contact_id: 'batch' }, base, { start_step: '', review_reason: 'batch bat_1', intro_sent_on: '' }),
    Object.assign({ contact_id: 'waiting' }, base, { review_status: 'awaiting_approval' }));
  w.tables.Enrollments.push({ enrollment_id: 'e1', contact_id: 'started', sequence_id: 'B', status: 'active' });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.EE_repairFollowUpNov16_(w.env, w.core))), { repaired: 2 });
  const get = id => w.tables.Contacts.find(c => c.contact_id === id);
  for (const id of ['a', 'b']) {
    assert.equal(get(id).start_step, 'b_checkin'); assert.equal(get(id).review_status, 'awaiting_approval'); assert.equal(get(id).followup_sent_on, '2026-11-16');
  }
  assert.equal(get('started').start_step, 'b_followup'); assert.equal(get('batch').review_status, 'confirmed'); assert.equal(get('waiting').start_step, 'b_followup');
  assert.equal(ctx.EE_repairFollowUpNov16_(w.env, w.core).skipped, 'already ran');
});
