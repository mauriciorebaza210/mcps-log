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
    read('email-engine/src/Seed.js') + '\n' + read('email-engine/src/Admin.js') + '\n' + read('email-engine/src/Schedule.js') + '\n' + read('email-engine/src/Templates.js') + '\n' + read('email-engine/src/Attachments.js'), ctx);
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

// ── The portal's email editor (open_editor → save_draft → approve) ───────────
// Puts a live Welcome in place the way eeApprove does: body + PoolSchool block frozen with hashes.
function liveWelcome(w) {
  const body = read('email-engine/templates/C/c_welcome.html'), blk = read('email-engine/templates/blocks/PoolSchool.html');
  w.frozen.zb = body; w.frozen.zk = blk;
  const sha = h => w.env.sha256(h);
  w.tables.Revisions.push({ revision_id: 'rev_c_welcome_1', step_id: 'c_welcome', rev_no: 1, subject: 'Welcome to Mission Custom Pool Solutions', preheader: 'Your startup date',
    details_box: 'Startup begins: {{StartupDate}}|Pool address: {{Address}}', body_file_id: 'zb', body_sha256: sha(body),
    blocks_json: [{ name: 'PoolSchool', flag: 'pool_school', file_id: 'zk', sha256: sha(blk) }], status: 'published' });
  return { body, blk };
}

test('open_editor: starts from the live version with its blocks and details box, else the starter, else blank', () => {
  const w = world();
  w.drafts = new Proxy(w.drafts, { get: (t, k) => k in t ? t[k] : w.frozen[k] });
  const { body } = liveWelcome(w);
  const live = w.admin('open_editor', { step_id: 'c_welcome' });
  assert.equal(live.ok, true, live.error);
  assert.equal(live.source.from, 'live');
  assert.equal(live.source.body_html, body);
  assert.deepEqual(JSON.parse(JSON.stringify(live.source.blocks.map(b => [b.name, b.flag]))), [['PoolSchool', 'pool_school']]);
  assert.match(live.source.details_box, /StartupDate/);
  assert.ok(live.fields.some(f => f.field === 'FirstName'));
  assert.equal(live.context.business.address, ADDR);
  assert.equal(w.admin('open_editor', { step_id: 'c_progress' }).source.from, 'starter');
  assert.equal(w.admin('open_editor', { step_id: 'b_checkin' }).source.from, 'blank');
  assert.equal(w.admin('open_editor', { step_id: 'nope' }).ok, false);
  assert.equal(w.tables.ChangeLog.length, 0, 'opening the editor isn\'t logged');
});

test('save_draft → approve: an edited Welcome keeps its Pool School block and details box, frozen with hashes', () => {
  const w = world();
  w.drafts = new Proxy(w.drafts, { get: (t, k) => k in t ? t[k] : w.frozen[k] });
  const { body, blk } = liveWelcome(w);
  const edited = body.replace('almost ready for its first swim', 'almost ready for its very first swim');
  const r = w.admin('save_draft', { step_id: 'c_welcome', subject: 'Welcome, {{FirstName}}', preheader: 'Startup soon',
    details_box: 'Startup begins: {{StartupDate}}|Pool address: {{Address}}', body_html: edited,
    blocks: [{ name: 'PoolSchool', flag: 'something_else', html: blk.replace('Pool School is included.', 'Pool School is on us.') }], based_on: 'rev_c_welcome_1' });
  assert.equal(r.ok, true, r.error);
  const d = w.rev(r.revision_id);
  assert.equal(d.status, 'draft'); assert.equal(d.source_name, 'the editor'); assert.equal(d.parent_revision_id, 'rev_c_welcome_1');
  assert.equal(d.blocks_json[0].flag, 'pool_school', 'the flag comes from the registry, never the page');
  const ok = w.admin('approve_draft', { revision_id: r.revision_id });
  assert.equal(ok.ok, true, ok.error);
  const pub = w.rev(ok.revision_id);
  assert.equal(pub.status, 'published'); assert.equal(pub.details_box, 'Startup begins: {{StartupDate}}|Pool address: {{Address}}');
  assert.equal(pub.blocks_json.length, 1);
  assert.match(w.frozen[pub.blocks_json[0].file_id], /Pool School is on us/);
  assert.equal(pub.blocks_json[0].sha256, w.env.sha256(w.frozen[pub.blocks_json[0].file_id]));
  assert.equal(w.rev('rev_c_welcome_1').status, 'superseded');
});

test('save_draft: refuses broken emails and unknown blocks; editing a draft replaces it', () => {
  const w = world();
  const base = { step_id: 'b_checkin', subject: 'Checking in', body_html: '<h1>Hi {{FirstName}}</h1><p>How is the pool?</p>' };
  assert.equal(w.admin('save_draft', Object.assign({}, base, { body_html: '<p>Hi {{Firstname}}</p>' })).ok, false, 'unknown field');
  assert.match(w.admin('save_draft', Object.assign({}, base, { body_html: '<p onclick="x()">Hi</p>' })).error, /event handler/);
  assert.match(w.admin('save_draft', Object.assign({}, base, { subject: ' ' })).error, /subject/);
  assert.match(w.admin('save_draft', Object.assign({}, base, { blocks: [{ name: 'Evil', html: '<p>x</p>' }] })).error, /unknown block/);
  assert.match(w.admin('save_draft', Object.assign({}, base, { body_html: FULL, blocks: [{ name: 'PoolSchool', html: '<p>x</p>' }] })).error, /full templates/);
  const a = w.admin('save_draft', base);
  assert.equal(a.ok, true, a.error);
  const b = w.admin('save_draft', Object.assign({}, base, { body_html: base.body_html + '<p>One more line.</p>', based_on: a.revision_id }));
  assert.equal(b.ok, true, b.error);
  assert.equal(w.rev(a.revision_id).status, 'discarded');
  assert.equal(w.rev(a.revision_id).replaced_by, b.revision_id);
  assert.equal(w.tables.Revisions.filter(r => r.status === 'draft').length, 1);
  // A full template from the editor is allowed when it passes the checks.
  assert.equal(w.admin('save_draft', { step_id: 'b_followup', subject: 'Following up', body_html: FULL }).ok, true);
});
