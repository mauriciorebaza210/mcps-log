// Template Library on the engine side (email-engine/src/Templates.js): list → open
// (checked + sample render) → import as a draft (a copy) → approve (frozen,
// published, supersedes the old version) or discard. Fake Drive, real renderer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeWorld } = require('./helpers/ee-fake-env.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const ADDR = '4640 South Flores Road, Elmendorf, TX 78112';
const FULL = '<!DOCTYPE html><html><head><title>Following up on your pool</title></head><body><p>Hi {{FirstName}},</p>' +
  '<a href="{{QuoteLink}}">Get your free quote</a><p>Mission Custom Pool Solutions, ' + ADDR + '</p><a href="{{UnsubscribeLink}}">Unsubscribe</a></body></html>';

function world() {
  const w = fakeWorld();
  w.now = Date.parse('2026-11-23T15:00:00Z');
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, isFinite, encodeURIComponent };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(['js/lib/lifecycle-rules.js', 'js/lib/batches.js', 'js/lib/email-render.js'].map(read).join('\n') +
    '\nvar EE_TZ = "America/Chicago";\nfunction EE_config_(store) { var c = {}; store.rows("Config").forEach(function (r) { c[r.key] = r.value; }); return c; }\n' +
    read('email-engine/src/Seed.js') + '\n' + read('email-engine/src/Admin.js') + '\n' + read('email-engine/src/Schedule.js') + '\n' + read('email-engine/src/Templates.js'), ctx);
  w.env.config.pausedBuckets = () => [];
  w.tables.Fields = JSON.parse(read('email-engine/seed/fields.json')).fields;
  w.tables.Config.push({ key: 'business_address', value: ADDR }, { key: 'business_name', value: 'Mission Custom Pool Solutions' },
    { key: 'sender_name', value: 'Tony' }, { key: 'link_quote', value: 'https://mcps.test/service' });
  w.props.EE_FOLDER_STEP_b_followup = 'fold_fu';
  w.props.EE_FOLDER_STEP_c_progress = 'fold_pr';
  w.files = { f1: { id: 'f1', name: 'Follow Up v1.html', modified: '2026-11-20T10:00:00.000Z', parents: ['fold_fu'], html: FULL },
    f2: { id: 'f2', name: 'notes.txt', modified: '2026-11-20T10:00:00.000Z', parents: ['fold_fu'], html: 'x' },
    f3: { id: 'f3', name: 'Broken.html', modified: '2026-11-21T10:00:00.000Z', parents: ['fold_fu'], html: FULL.replace('{{UnsubscribeLink}}', '#') },
    other: { id: 'other', name: 'Elsewhere.html', modified: '2026-11-21T10:00:00.000Z', parents: ['fold_x'], html: FULL } };
  w.drafts = {}; w.frozen = {};
  const drive = {
    list: id => Object.values(w.files).filter(f => f.parents.includes(id)).map(f => ({ id: f.id, name: f.name, modified: f.modified, size: f.html.length })),
    read: id => w.files[id] ? Object.assign({}, w.files[id]) : null,
    saveDraft: (name, html) => { const id = 'd' + Object.keys(w.drafts).length; w.drafts[id] = html; return id; },
    readDraft: id => w.drafts[id],
    freeze: (name, html) => { const id = 'z' + Object.keys(w.frozen).length; w.frozen[id] = html; return id; }
  };
  w.admin = (action, params, actor) => ctx.EE_adminRun_(w.env, w.core, { action, params, actor: actor || 'mau' }, { drive });
  w.rev = id => w.tables.Revisions.find(r => r.revision_id === id);
  return w;
}

test('list_templates: html files in each email\'s folder, newest first', () => {
  const w = world();
  const r = w.admin('list_templates', {});
  assert.deepEqual(r.templates.b_followup.map(t => t.name), ['Broken.html', 'Follow Up v1.html']);
  assert.deepEqual(r.templates.c_progress.map(t => t.file_id), ['seed:c_progress'], 'empty Drive folder: only the starter draft');
  assert.equal(w.tables.ChangeLog.length, 0, 'looking isn\'t logged');
});

test('open_template: problems listed, a clean one comes with a sample render and its <title> as the subject', () => {
  const w = world();
  const bad = w.admin('open_template', { step_id: 'b_followup', file_id: 'f3' });
  assert.match(bad.errors.join(), /unsubscribe link/);
  const ok = w.admin('open_template', { step_id: 'b_followup', file_id: 'f1' });
  assert.equal(ok.format, 'full');
  assert.equal(ok.suggested_subject, 'Following up on your pool');
  assert.match(ok.preview_html, /Hi Sample,/);
  assert.equal(w.admin('open_template', { step_id: 'b_followup', file_id: 'other' }).ok, false, 'files outside the email\'s folder are refused');
});

test('import → approve: a frozen copy is published, the old version superseded, Drive edits change nothing', () => {
  const w = world();
  w.tables.Revisions.push({ revision_id: 'rev_b_followup_1', step_id: 'b_followup', rev_no: 1, status: 'published' });
  const imp = w.admin('import_template', { step_id: 'b_followup', file_id: 'f1', subject: 'Following up, {{FirstName}}', preheader: 'A quick note' });
  assert.equal(imp.ok, true, imp.error);
  assert.equal(w.rev(imp.revision_id).status, 'draft');
  assert.equal(w.rev(imp.revision_id).editor, 'mau');
  assert.match(w.admin('open_draft', { revision_id: imp.revision_id }).preview_html, /Hi Sample,/, 'the draft previews from its own copy');
  assert.equal(w.admin('import_template', { step_id: 'b_followup', file_id: 'f3', subject: 'x' }).ok, false, 'a template with problems can\'t be imported');
  w.files.f1.html = FULL.replace('Hi', 'Hello');                       // edited in Drive afterwards
  w.files.f1.modified = '2026-11-22T10:00:00.000Z';
  assert.equal(w.admin('list_templates', {}).templates.b_followup.find(t => t.file_id === 'f1').newer_in_drive, true);
  const ap = w.admin('approve_draft', { revision_id: imp.revision_id });
  assert.equal(ap.ok, true, ap.error);
  assert.equal(ap.revision_id, 'rev_b_followup_2');
  const live = w.rev('rev_b_followup_2');
  assert.equal(live.status, 'published');
  assert.equal(live.format, 'full');
  assert.equal(live.approver, 'mau');
  assert.match(w.frozen[live.body_file_id], /Hi \{\{FirstName\}\}/, 'the approved copy is the imported one, not the Drive edit');
  assert.equal(w.rev('rev_b_followup_1').status, 'superseded');
  assert.equal(w.rev(imp.revision_id).status, 'approved');
  assert.deepEqual(w.tables.ChangeLog.map(c => c.action), ['import_template', 'import_template', 'approve_draft']);
});

test('Two-person rule, tampered drafts and discard', () => {
  const w = world();
  const imp = w.admin('import_template', { step_id: 'b_followup', file_id: 'f1', subject: 'Hi' });
  w.props.EE_REQUIRE_SECOND_APPROVER = 'true';
  assert.match(w.admin('approve_draft', { revision_id: imp.revision_id }).error, /Two-person rule/);
  w.drafts[w.rev(imp.revision_id).body_file_id] += '<!-- changed -->';
  assert.match(w.admin('approve_draft', { revision_id: imp.revision_id }, 'tony').error, /changed after it was made/);
  assert.equal(w.admin('discard_draft', { revision_id: imp.revision_id }).ok, true);
  assert.equal(w.rev(imp.revision_id).status, 'discarded');
});

test('Starter drafts from the portal: offered for emails with nothing live, pass the checks, import and approve like a Drive file', () => {
  const w = world();
  const list = w.admin('list_templates', {}).templates;
  for (const step of ['c_progress', 'c_maint', 'c_final']) {
    const seed = (list[step] || []).find(t => t.file_id === 'seed:' + step);
    assert.ok(seed, step + ' has a starter draft');
    const open = w.admin('open_template', { step_id: step, file_id: seed.file_id });
    assert.deepEqual([...open.errors], [], step + ': ' + open.errors.join('; '));
    assert.match(open.preview_html, /Hi Sample,/);
    assert.match(open.preview_html, /mcps-lockup-badge/, 'MCPS frame');
  }
  assert.equal((list.c_welcome || []).some(t => t.file_id.startsWith('seed:')), false, 'Welcome uses blocks and details: not offered this way');
  const imp = w.admin('import_template', { step_id: 'c_maint', file_id: 'seed:c_maint' });
  assert.equal(imp.ok, true, imp.error);
  assert.equal(w.rev(imp.revision_id).subject, 'Keep your new pool looking its best', 'its own subject when none is typed');
  assert.equal(w.admin('approve_draft', { revision_id: imp.revision_id }).ok, true);
  assert.equal((w.admin('list_templates', { step_id: 'c_maint' }).templates.c_maint || []).length, 0, 'gone once something is live');
});
