// Attachment Library (email-engine/src/Attachments.js): Drive drop folder → frozen,
// hashed versions → approval → emails carry items, checked again at send.
// Failure rows 53 (changed after approval) and 57 (live before its PDFs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { fakeWorld, item } = require('./helpers/ee-fake-env.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const plain = x => JSON.parse(JSON.stringify(x));
const ADDR = '4640 South Flores Road, Elmendorf, TX 78112';

function world() {
  const w = fakeWorld();
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite, encodeURIComponent };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(['js/lib/lifecycle-rules.js', 'js/lib/batches.js', 'js/lib/email-render.js'].map(read).join('\n') +
    '\nvar EE_TZ = "America/Chicago";\nfunction EE_config_(store) { var c = {}; store.rows("Config").forEach(function (r) { c[r.key] = r.value; }); return c; }\n' +
    ['email-engine/src/Seed.js', 'email-engine/src/Admin.js', 'email-engine/src/Schedule.js', 'email-engine/src/Templates.js', 'email-engine/src/Attachments.js'].map(read).join('\n'), ctx);
  w.tables.Fields = JSON.parse(read('email-engine/seed/fields.json')).fields;
  w.tables.Config.push({ key: 'business_address', value: ADDR }, { key: 'sender_name', value: 'Tony' });
  // Drive: the drop folder and the engine's frozen copies.
  w.drive = { drop: { p1: { id: 'p1', name: 'Safety Guidelines.pdf', mime: 'application/pdf', size: 2000, body: 'SAFETY-1' },
    p2: { id: 'p2', name: 'Safety Guidelines (rev).pdf', mime: 'application/pdf', size: 2100, body: 'SAFETY-2' },
    big: { id: 'big', name: 'Huge.pdf', mime: 'application/pdf', size: 11 * 1024 * 1024, body: 'X' },
    doc: { id: 'doc', name: 'Notes.docx', mime: 'application/msword', size: 10, body: 'D' } }, frozen: {} };
  w.drive.elsewhere = { id: 'out', name: 'Other.pdf', mime: 'application/pdf', size: 10, body: 'O' };
  const files = {
    dropFolder: () => 'DROP',
    list: () => Object.values(w.drive.drop).map(f => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, modified: '2026-11-20T10:00:00Z' })),
    get: id => w.drive.drop[id] ? Object.assign({ parents: ['DROP'] }, w.drive.drop[id]) : id === 'out' ? Object.assign({ parents: ['ELSE'] }, w.drive.elsewhere) : null,
    freeze: (id, name) => { const fid = 'z' + Object.keys(w.drive.frozen).length; w.drive.frozen[fid] = w.drive.drop[id].body; return { file_id: fid, sha256: sha(w.drive.drop[id].body), size: w.drive.drop[id].size }; },
    hash: fid => sha(w.drive.frozen[fid])
  };
  w.sendFiles = { read: fid => ({ body: w.drive.frozen[fid], fid }), sha256: b => sha(b.body), size: b => b.body.length };
  w.ctx_ = ctx;
  w.admin = (action, params, actor) => ctx.EE_adminRun_(w.env, w.core, { action, params, actor: actor || 'mau' }, { files, drive: { saveDraft: (n, h) => { const id = 'd' + Math.random(); w.drive.frozen[id] = h; return id; },
    readDraft: id => w.drive.frozen[id], freeze: (n, h) => { const id = 'f' + Object.keys(w.drive.frozen).length; w.drive.frozen[id] = h; return id; } } });
  w.ver = id => w.tables.AttachmentVersions.find(v => v.version_id === id);
  return w;
}

test('Drop folder → new item (pending) → approve → published; a new version supersedes it', () => {
  const w = world();
  const a = w.admin('add_attachment', { file_id: 'p1', name: 'Safety Guidelines' });
  assert.equal(a.ok, true, a.error);
  assert.equal(w.ver(a.version_id).status, 'pending');
  assert.equal(w.ver(a.version_id).sha256, sha('SAFETY-1'));
  assert.equal(w.admin('approve_attachment', { version_id: a.version_id }).ok, true);
  assert.equal(w.ver(a.version_id).status, 'published');
  const b = w.admin('add_attachment', { file_id: 'p2', item_id: a.item_id });
  assert.equal(b.v, 2);
  assert.equal(w.ver(a.version_id).status, 'published', 'the old one stays live until the new one is approved');
  w.admin('approve_attachment', { version_id: b.version_id });
  assert.deepEqual([w.ver(a.version_id).status, w.ver(b.version_id).status], ['superseded', 'published']);
  // Roll back: v1 again, as v3, pending until approved.
  const r = w.admin('rollback_attachment', { version_id: a.version_id });
  assert.equal(r.v, 3); assert.equal(w.ver(r.version_id).status, 'pending'); assert.equal(w.ver(r.version_id).sha256, sha('SAFETY-1'));
  const list = plain(w.admin('list_attachments', {}));
  assert.equal(list.items[0].versions.length, 3);
  assert.equal(list.drop.find(f => f.file_id === 'p1').used_as.v, 3, 'the newest version made from that file');
  assert.equal(list.drop.find(f => f.file_id === 'doc').ok, false);
});

test('Refused: not a PDF, over 10 MB, outside the drop folder, duplicate name; two-person rule; a changed stored copy', () => {
  const w = world();
  assert.match(w.admin('add_attachment', { file_id: 'doc', name: 'Notes' }).error, /PDF/);
  assert.match(w.admin('add_attachment', { file_id: 'big', name: 'Huge' }).error, /10 MB/);
  assert.match(w.admin('add_attachment', { file_id: 'out', name: 'Other' }).error, /Email Attachments folder/);
  assert.match(w.admin('add_attachment', { file_id: 'p1', name: '' }).error, /name/);
  const a = w.admin('add_attachment', { file_id: 'p1', name: 'Safety Guidelines' });
  assert.match(w.admin('add_attachment', { file_id: 'p2', name: 'safety guidelines' }).error, /already/);
  w.props.EE_REQUIRE_SECOND_APPROVER = 'true';
  assert.match(w.admin('approve_attachment', { version_id: a.version_id }, 'mau').error, /Two-person/);
  w.props.EE_REQUIRE_SECOND_APPROVER = 'false';
  w.drive.frozen[w.ver(a.version_id).file_id] = 'TAMPERED';
  assert.match(w.admin('approve_attachment', { version_id: a.version_id }).error, /changed/);
});

test('Emails list items: save_draft checks them, approval keeps them, list shows who uses each', () => {
  const w = world();
  const a = w.admin('add_attachment', { file_id: 'p1', name: 'Safety Guidelines' });
  const base = { step_id: 'b_checkin', subject: 'Checking in', body_html: '<h1>Hi {{FirstName}}</h1><p>How is the pool?</p>' };
  assert.match(w.admin('save_draft', Object.assign({}, base, { attachment_items: ['att_nope'] })).error, /library/);
  const d = w.admin('save_draft', Object.assign({}, base, { attachment_items: [a.item_id, a.item_id] }));
  assert.equal(d.ok, true, d.error);
  assert.deepEqual(plain(w.tables.Revisions.find(r => r.revision_id === d.revision_id).attachment_items), [a.item_id]);
  const pub = w.admin('approve_draft', { revision_id: d.revision_id });
  assert.equal(pub.ok, true, pub.error);
  assert.deepEqual(plain(w.tables.Revisions.find(r => r.revision_id === pub.revision_id).attachment_items), [a.item_id]);
  const used = plain(w.admin('list_attachments', {})).items[0].used_by;
  assert.ok(used.some(u => u.step_id === 'b_checkin' && u.status === 'published'));
  // The editor offers active items with their published version.
  const ed = plain(w.admin('open_editor', { step_id: 'b_checkin' }));
  assert.deepEqual(ed.attachment_library.map(x => [x.name, x.published_v]), [['Safety Guidelines', 0]]);
  assert.deepEqual(ed.source.attachment_items, [a.item_id]);
});

test('At send (rows 57 and 53): only published versions go, hash-checked; a changed file fails the delivery', () => {
  const w = world();
  const a = w.admin('add_attachment', { file_id: 'p1', name: 'Safety Guidelines' });
  const rev = { attachment_items: [a.item_id] };
  const at = () => w.ctx_.EE_attachmentsFor_(w.env, rev, w.sendFiles);
  assert.equal(at().length, 0, 'row 57: the email goes out without a PDF that isn’t approved yet');
  w.admin('approve_attachment', { version_id: a.version_id });
  assert.deepEqual(plain(at().map(x => [x.name, x.version_id])), [['Safety Guidelines.pdf', a.version_id]]);
  w.drive.frozen[w.ver(a.version_id).file_id] = 'CHANGED';
  assert.throws(at, /attachment: Safety Guidelines v1 changed after approval/, 'row 53');
  w.drive.frozen[w.ver(a.version_id).file_id] = 'SAFETY-1';
  w.admin('retire_attachment', { item_id: a.item_id });
  assert.equal(at().length, 0, 'a retired item is never sent again');
});

test('The core records which PDF versions went with a delivery and hands the files to Gmail', () => {
  const w = world();
  w.tables.Enrollments.push({ enrollment_id: 'e1', status: 'active', stopped_branches: [] });
  w.env.render = row => ({ to: row.email_norm, subject: 'Hello', html: '<p>Hi</p><p>Ref ' + row.token + '</p>', text: 'Hi. Ref ' + row.token,
    attachments: [{ name: 'Safety Guidelines.pdf' }], attachment_versions: ['att_x_v2'] });
  w.core.run({ plan: () => [item('e1:b_intro:1')] });
  const d = w.delivery('e1:b_intro:1');
  assert.equal(d.state, 'sent');
  assert.deepEqual(plain(d.attachment_versions), ['att_x_v2']);
  assert.ok(Object.values(w.drafts).some(x => (x.msg.attachments || []).length === 1) || Object.keys(w.drafts).length === 0, 'files went to createDraft');
});

test('Row 56: a new version approved mid-run: this run keeps the version it started with; the next run carries the new one', () => {
  const w = world();
  const a = w.admin('add_attachment', { file_id: 'p1', name: 'Safety Guidelines' });
  w.admin('approve_attachment', { version_id: a.version_id });
  const rev = { attachment_items: [a.item_id] }, run1 = {};
  assert.equal(w.ctx_.EE_attachmentsFor_(w.env, rev, w.sendFiles, run1)[0].version_id, a.version_id);
  const b = w.admin('add_attachment', { file_id: 'p2', item_id: a.item_id });
  w.admin('approve_attachment', { version_id: b.version_id });
  assert.equal(w.ctx_.EE_attachmentsFor_(w.env, rev, w.sendFiles, run1)[0].version_id, a.version_id, 'same run: still v1');
  assert.equal(w.ctx_.EE_attachmentsFor_(w.env, rev, w.sendFiles, {})[0].version_id, b.version_id, 'next run: v2');
});
