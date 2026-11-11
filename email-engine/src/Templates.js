// ══════════════════════════════════════════════════════════════════════════════
// TEMPLATE LIBRARY (PLAN.md → Plan changes 2026-11-10 "Template Library", "One
// template folder per email"). Templates live in Tony's Drive, one folder per
// email (Script Properties EE_FOLDER_STEP_<step_id>, made by eeSetupMarketingKit).
//
//   list_templates   every .html file in each email's folder, with whether it is
//                    already a draft or the live version
//   open_template    one file: checked by the renderer, and a sample render to preview
//   import_template  copy it into a draft of that email (a copy: later Drive edits never
//                    change a draft or an approved email)
//   approve_draft    freeze the draft into an immutable revision and publish it
//   discard_draft    drop a draft
//   open_draft       preview a draft (or any version) from its own frozen copy
//
// Pure helpers take deps so tests run with a fake Drive:
//   deps.drive = { list(folderId) -> [{id, name, modified, size}], read(fileId) -> {name, html, modified, parents[]},
//                  saveDraft(name, html) -> fileId, freeze(name, html) -> fileId, readDraft(fileId) -> html }
// ══════════════════════════════════════════════════════════════════════════════

var EE_TEMPLATE_MAX_BYTES = 200000;

function EE_templateFolders_(props) {
  var out = {};
  EE_SEED.ruleset.steps.forEach(function (st) {
    var id = props.get ? props.get('EE_FOLDER_STEP_' + st.step_id) : props.getProperty('EE_FOLDER_STEP_' + st.step_id);
    if (id) out[st.step_id] = id;
  });
  return out;
}

// A sample render: what the email looks like, and every problem the renderer finds.
function EE_templateCheck_(env, t) {
  var cfg = EE_config_(env.store), fields = env.store.rows('Fields');
  var blocks = {};
  Object.keys(EE_SEED.content.blocks || {}).forEach(function (name) {
    var b = EE_SEED.content.blocks[name];
    blocks[name] = { flag: b.flag, html: EE_SEED.templates[b.html] || '' };
  });
  var startup = MCPS_LIFECYCLE.addDays(EE_today_(env), 7);
  return MCPS_EMAIL_RENDER.render({ revision: { subject: t.subject || '', preheader: t.preheader || '', details_box: t.details_box || '', body_html: t.html, format: t.format },
    blocks: blocks, fields: fields,
    contact: { first_name: 'Sample', last_name: 'Contact', address: '1 Sample St, Boerne, TX', startup_date: startup, pool_school: 'Y' },
    context: { sender_name: cfg.sender_name, unsubscribeUrl: 'https://example.invalid/unsubscribe', links: { quote: cfg.link_quote },
      business: { name: cfg.business_name, address: cfg.business_address, phone: cfg.business_phone, website: cfg.business_website } } });
}
// ChatGPT puts the subject outside the file; a <title> is the best guess at it.
function EE_titleOf_(html) {
  var m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').replace(/&amp;/g, '&').trim().slice(0, 120) : '';
}

// Starter drafts written with the portal (email-engine/templates, in the seed) for emails
// that have nothing live yet: offered like a Drive file, without putting files in Tony's Drive.
function EE_seedTemplate_(stepId, revisions) {
  var c = EE_SEED.content.steps[stepId];
  if (!c || (c.blocks || []).length || c.details_box) return null;
  if (revisions.some(function (r) { return r.step_id === stepId && r.status === 'published'; })) return null;
  var html = EE_SEED.templates[c.body];
  return html ? { id: 'seed:' + stepId, name: 'MCPS starter draft.html', modified: '', size: html.length, html: html, subject: c.subject, preheader: c.preheader || '' } : null;
}

function EE_templateAction_(env, core, action, p, actor, deps) {
  var folders = EE_templateFolders_(env.props);
  var revisions = env.store.rows('Revisions');
  if (action === 'list_templates') {
    var out = {};
    EE_SEED.ruleset.steps.map(function (st) { return st.step_id; }).forEach(function (stepId) {
      if (p.step_id && p.step_id !== stepId) return;
      var seed = EE_seedTemplate_(stepId, revisions);
      if (!folders[stepId] && !seed) return;
      out[stepId] = (folders[stepId] ? deps.drive.list(folders[stepId]) : []).concat(seed ? [seed] : []).filter(function (f) { return /\.html?$/i.test(f.name); }).map(function (f) {
        var mine = revisions.filter(function (r) { return r.source_file_id === f.id; }).sort(function (a, b) { return String(b.created_at || b.approved_at).localeCompare(String(a.created_at || a.approved_at)); })[0];
        return { file_id: f.id, name: f.name, modified: f.modified, size: f.size,
          revision_id: mine ? mine.revision_id : '', revision_status: mine ? mine.status : '',
          // Changed in Drive after it was copied: offer a new draft from it.
          newer_in_drive: !!(mine && mine.source_modified && f.modified > mine.source_modified) };
      }).sort(function (a, b) { return String(b.modified).localeCompare(String(a.modified)); });
    });
    return { ok: true, templates: out };
  }
  if (action === 'open_template' || action === 'import_template') {
    var stepId = String(p.step_id || ''), seedT = String(p.file_id) === 'seed:' + stepId ? EE_seedTemplate_(stepId, revisions) : null;
    if (!folders[stepId] && !seedT) return { ok: false, error: 'no template folder for that email' };
    var f = seedT || deps.drive.read(String(p.file_id || ''));
    if (!f || (!seedT && (f.parents || []).indexOf(folders[stepId]) === -1)) return { ok: false, error: 'that file isn’t in this email’s template folder' };
    if (f.html.length > EE_TEMPLATE_MAX_BYTES) return { ok: false, error: 'the file is too large for an email (over 200 KB)' };
    var format = MCPS_EMAIL_RENDER.isFull({ body_html: f.html }) ? 'full' : 'body';
    var subject = String(p.subject || '').trim() || f.subject || EE_titleOf_(f.html), preheader = String(p.preheader || '').trim() || (seedT ? f.preheader : '');
    var check = EE_templateCheck_(env, { html: f.html, subject: subject || 'Subject', preheader: preheader, format: format });
    if (action === 'open_template') {
      return { ok: true, name: f.name, modified: f.modified, format: format, suggested_subject: f.subject || EE_titleOf_(f.html), suggested_preheader: f.preheader || '',
        errors: check.ok ? [] : check.errors, preview_html: check.ok ? check.html : '' };
    }
    if (!subject) return { ok: false, error: 'a subject line is required' };
    if (!check.ok) return { ok: false, error: 'This template has problems: ' + check.errors.join('; '), errors: check.errors };
    var n = revisions.filter(function (r) { return r.step_id === stepId && r.status === 'draft'; }).length;
    var id = 'draft_' + stepId + '_' + env.uuid().replace(/-/g, '').slice(-8);
    var fileId = deps.drive.saveDraft(id + '__' + f.name, f.html);
    core.commitEntity('revision', { revision_id: id, step_id: stepId, rev_no: 0, subject: subject.slice(0, 150), preheader: preheader.slice(0, 200),
      details_box: '', body_file_id: fileId, body_sha256: env.sha256(f.html), blocks_json: [], status: 'draft', format: format,
      source_file_id: f.id, source_name: f.name, source_modified: f.modified, editor: actor, created_at: new Date(env.now()).toISOString() },
      'revision:' + id + ':draft');
    return { ok: true, revision_id: id, drafts: n + 1 };
  }
  if (action === 'open_draft') {
    var od = env.store.get('Revisions', String(p.revision_id || ''));
    if (!od || !od.body_file_id) return { ok: false, error: 'version not found' };
    var oh = deps.drive.readDraft(od.body_file_id);
    var oc = EE_templateCheck_(env, { html: oh, subject: od.subject, preheader: od.preheader, details_box: od.details_box, format: od.format });
    return { ok: true, subject: oc.ok ? oc.subject : od.subject, errors: oc.ok ? [] : oc.errors, preview_html: oc.ok ? oc.html : '' };
  }
  if (action === 'approve_draft' || action === 'discard_draft') {
    var d = env.store.get('Revisions', String(p.revision_id || ''));
    if (!d || d.status !== 'draft') return { ok: false, error: 'draft not found' };
    if (action === 'discard_draft') {
      core.commitEntity('revision', { revision_id: d.revision_id, status: 'discarded' }, 'revision:' + d.revision_id + ':discarded');
      return { ok: true };
    }
    if (env.props.get('EE_REQUIRE_SECOND_APPROVER') === 'true' && String(d.editor).toLowerCase() === String(actor).toLowerCase()) {
      return { ok: false, error: 'Two-person rule is on: someone other than ' + actor + ' must approve this draft.' };
    }
    var html = deps.drive.readDraft(d.body_file_id);
    if (env.sha256(html) !== d.body_sha256) return { ok: false, error: 'the draft file changed after it was made; import it again' };
    var dry = EE_templateCheck_(env, { html: html, subject: d.subject, preheader: d.preheader, format: d.format });
    if (!dry.ok) return { ok: false, error: 'Not approved, the draft has problems: ' + dry.errors.join('; ') };
    var prior = revisions.filter(function (r) { return r.step_id === d.step_id && r.status !== 'draft' && r.status !== 'discarded'; });
    var revNo = prior.reduce(function (m, r) { return Math.max(m, Number(r.rev_no || 0)); }, 0) + 1;
    var revisionId = 'rev_' + d.step_id + '_' + revNo;
    var frozen = deps.drive.freeze(revisionId + '__body.html', html);
    var fields = env.store.rows('Fields');
    var rec = { revision_id: revisionId, step_id: d.step_id, rev_no: revNo, subject: d.subject, preheader: d.preheader || '', details_box: '',
      body_file_id: frozen, body_sha256: d.body_sha256, blocks_json: [], fields_json: fields, status: 'published', format: d.format,
      source_file_id: d.source_file_id, source_name: d.source_name, source_modified: d.source_modified,
      editor: d.editor, approver: actor, approved_at: new Date(env.now()).toISOString(),
      parent_revision_id: prior.length ? prior[prior.length - 1].revision_id : '' };
    rec.content_hash = env.sha256(JSON.stringify([rec.subject, rec.preheader, rec.details_box, rec.body_sha256, [], fields, rec.format]));
    prior.filter(function (r) { return r.status === 'published'; }).forEach(function (r) {
      core.commitEntity('revision', { revision_id: r.revision_id, status: 'superseded' }, 'revision:' + r.revision_id + ':superseded');
    });
    core.commitEntity('revision', rec, 'revision:' + revisionId + ':publish');
    core.commitEntity('revision', { revision_id: d.revision_id, status: 'approved', published_as: revisionId }, 'revision:' + d.revision_id + ':approved');
    return { ok: true, revision_id: revisionId, rev_no: revNo };
  }
  return { ok: false, error: 'unknown template action' };
}

// ── Apps Script Drive access ──────────────────────────────────────────────────
function EE_driveDeps_() {
  var props = EE_props_();
  var folder = function (key) { return DriveApp.getFolderById(props.getProperty(key)); };
  return {
    list: function (folderId) {
      var it = DriveApp.getFolderById(folderId).getFiles(), out = [];
      while (it.hasNext()) { var f = it.next(); out.push({ id: f.getId(), name: f.getName(), modified: f.getLastUpdated().toISOString(), size: f.getSize() }); }
      return out;
    },
    read: function (fileId) {
      var f;
      try { f = DriveApp.getFileById(fileId); } catch (e) { return null; }
      var parents = [], it = f.getParents();
      while (it.hasNext()) parents.push(it.next().getId());
      return { id: f.getId(), name: f.getName(), modified: f.getLastUpdated().toISOString(), parents: parents, html: f.getBlob().getDataAsString('UTF-8') };
    },
    saveDraft: function (name, html) { return folder('EE_FOLDER_DRAFTS').createFile(name, html, MimeType.HTML).getId(); },
    readDraft: function (fileId) { return DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8'); },
    freeze: function (name, html) { return folder('EE_FOLDER_REVISIONS').createFile(name, html, MimeType.HTML).getId(); }
  };
}
