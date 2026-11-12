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
//   open_editor      everything the portal's email editor needs to edit an email locally:
//                    the starting content (live version, a draft, or the starter), its
//                    blocks, the field registry and the sample context for the renderer
//   save_draft       the editor's result as a draft (body + blocks + details box), checked
//                    by the same renderer; editing a draft replaces it
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
// t.blocks ([{name, flag, html}]) when the email carries its own (editor drafts); else the seed's.
function EE_templateCheck_(env, t) {
  var cfg = EE_config_(env.store), fields = env.store.rows('Fields');
  var blocks = {};
  if (t.blocks) t.blocks.forEach(function (b) { blocks[b.name] = { flag: b.flag, html: b.html }; });
  else Object.keys(EE_SEED.content.blocks || {}).forEach(function (name) {
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

// The blocks an email may use (name → flag), from the seed registry. A block's flag
// (which contact field turns it on) is never taken from the page.
function EE_blockRegistry_() {
  var out = {};
  Object.keys(EE_SEED.content.blocks || {}).forEach(function (name) { out[name] = EE_SEED.content.blocks[name].flag; });
  return out;
}
// A revision's (or draft's) blocks with their HTML, hashes checked when they have one.
function EE_revisionBlocks_(rev, deps, env) {
  return (rev.blocks_json || []).map(function (b) {
    var html = deps.drive.readDraft(b.file_id);
    if (b.sha256 && env.sha256(html) !== b.sha256) throw new Error('block ' + b.name + ' changed after it was saved');
    return { name: b.name, flag: b.flag, html: html };
  });
}
// Where the editor starts: a given draft or version, else the live version, else the starter.
function EE_editorSource_(env, stepId, revisionId, revisions, deps) {
  var rev = revisionId ? revisions.filter(function (r) { return r.revision_id === revisionId && r.step_id === stepId; })[0]
    : revisions.filter(function (r) { return r.step_id === stepId && r.status === 'published'; })[0];
  if (revisionId && !rev) return { error: 'version not found' };
  if (rev) {
    var html = deps.drive.readDraft(rev.body_file_id);
    if (rev.body_sha256 && env.sha256(html) !== rev.body_sha256) return { error: 'that version’s file changed after it was saved' };
    return { from: rev.status === 'draft' ? 'draft' : 'live', revision_id: rev.revision_id, rev_no: rev.rev_no || 0, subject: rev.subject || '', preheader: rev.preheader || '',
      details_box: rev.details_box || '', format: MCPS_EMAIL_RENDER.isFull({ body_html: html, format: rev.format }) ? 'full' : 'body',
      body_html: html, blocks: EE_revisionBlocks_(rev, deps, env), attachment_items: rev.attachment_items || [] };
  }
  var c = EE_SEED.content.steps[stepId];
  if (c && EE_SEED.templates[c.body]) {
    return { from: 'starter', revision_id: '', attachment_items: [], subject: c.subject || '', preheader: c.preheader || '', details_box: c.details_box || '', format: 'body',
      body_html: EE_SEED.templates[c.body], blocks: (c.blocks || []).map(function (name) {
        var spec = EE_SEED.content.blocks[name]; return { name: name, flag: spec.flag, html: EE_SEED.templates[spec.html] || '' };
      }) };
  }
  return { from: 'blank', revision_id: '', attachment_items: [], subject: '', preheader: '', details_box: '', format: 'body', blocks: [],
    body_html: '<h1>Your headline</h1>\n<p>Hi {{FirstName}},</p>\n<p>Write your email here.</p>\n' };
}

// Any email in the current rules (seeded B/C steps and single emails made since).
function EE_knownStep_(env, stepId) {
  var rs = typeof EE_currentRuleset_ === 'function' ? EE_currentRuleset_(env) : null;
  var steps = rs ? rs.json.steps : EE_SEED.ruleset.steps;
  return steps.some(function (st) { return st.step_id === stepId; });
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
  if (action === 'open_editor') {
    var es = String(p.step_id || '');
    if (!EE_knownStep_(env, es)) return { ok: false, error: 'unknown email' };
    var src = EE_editorSource_(env, es, String(p.revision_id || ''), revisions, deps);
    if (src.error) return { ok: false, error: src.error };
    var ecfg = EE_config_(env.store), reg = EE_blockRegistry_();
    // PDFs it can carry: active items in the Attachment Library (Attachments.js), with their published version.
    var attLib = env.store.rows('Attachments').filter(function (it) { return it.status !== 'retired'; }).map(function (it) {
      var pv = EE_attachPublished_(env, it.item_id); return { item_id: it.item_id, name: it.name, published_v: pv ? Number(pv.v) : 0 };
    });
    return { ok: true, step_id: es, source: src, fields: env.store.rows('Fields'), attachment_library: attLib,
      block_library: Object.keys(reg).map(function (name) { return { name: name, flag: reg[name], html: EE_SEED.templates[EE_SEED.content.blocks[name].html] || '' }; }),
      context: { sender_name: ecfg.sender_name || '', links: { quote: ecfg.link_quote || '' },
        business: { name: ecfg.business_name || '', address: ecfg.business_address || '', phone: ecfg.business_phone || '', website: ecfg.business_website || '' } } };
  }
  if (action === 'save_draft') {
    var ss = String(p.step_id || ''), sbody = String(p.body_html || ''), ssubj = String(p.subject || '').trim();
    if (!EE_knownStep_(env, ss)) return { ok: false, error: 'unknown email' };
    if (!ssubj) return { ok: false, error: 'a subject line is required' };
    if (!sbody.trim()) return { ok: false, error: 'the email is empty' };
    var sformat = MCPS_EMAIL_RENDER.isFull({ body_html: sbody }) ? 'full' : 'body';
    var breg = EE_blockRegistry_(), sblocks = [], bad = '';
    (Array.isArray(p.blocks) ? p.blocks : []).forEach(function (b) {
      var name = String(b && b.name || '');
      if (!breg[name]) { bad = 'unknown block ' + name; return; }
      if (sblocks.some(function (x) { return x.name === name; })) return;
      sblocks.push({ name: name, flag: breg[name], html: String(b.html || '') });
    });
    if (bad) return { ok: false, error: bad };
    if (sformat === 'full' && (sblocks.length || String(p.details_box || '').trim())) return { ok: false, error: 'full templates can’t use blocks or the details box' };
    var total = sbody.length + sblocks.reduce(function (n, b) { return n + b.html.length; }, 0);
    if (total > EE_TEMPLATE_MAX_BYTES) return { ok: false, error: 'the email is too large (over 200 KB)' };
    var sdetails = String(p.details_box || '').slice(0, 500), spre = String(p.preheader || '').trim().slice(0, 200);
    var activeItems = {}; env.store.rows('Attachments').forEach(function (it) { if (it.status !== 'retired') activeItems[it.item_id] = true; });
    var satt = []; (Array.isArray(p.attachment_items) ? p.attachment_items : []).map(String).forEach(function (id) { if (satt.indexOf(id) === -1) satt.push(id); });
    if (satt.some(function (id) { return !activeItems[id]; })) return { ok: false, error: 'an attachment it lists isn’t in the library (or was retired)' };
    var scheck = EE_templateCheck_(env, { html: sbody, subject: ssubj, preheader: spre, details_box: sdetails, format: sformat, blocks: sblocks });
    if (!scheck.ok) return { ok: false, error: 'This email has problems: ' + scheck.errors.join('; '), errors: scheck.errors };
    var based = p.based_on ? env.store.get('Revisions', String(p.based_on)) : null;
    if (p.based_on && (!based || based.step_id !== ss)) return { ok: false, error: 'the version you started from is gone; reload' };
    var sid = 'draft_' + ss + '_' + env.uuid().replace(/-/g, '').slice(-8);
    var sfile = deps.drive.saveDraft(sid + '__body.html', sbody);
    var bjson = sblocks.map(function (b) { return { name: b.name, flag: b.flag, file_id: deps.drive.saveDraft(sid + '__' + b.name + '.html', b.html), sha256: env.sha256(b.html) }; });
    core.commitEntity('revision', { revision_id: sid, step_id: ss, rev_no: 0, subject: ssubj.slice(0, 150), preheader: spre, details_box: sdetails,
      body_file_id: sfile, body_sha256: env.sha256(sbody), blocks_json: bjson, attachment_items: satt, status: 'draft', format: sformat,
      source_file_id: based ? (based.source_file_id || '') : '', source_name: 'the editor', source_modified: '',
      parent_revision_id: based ? based.revision_id : '', editor: actor, created_at: new Date(env.now()).toISOString() }, 'revision:' + sid + ':draft');
    // Editing a draft replaces it, so the list never shows two versions of one edit.
    if (based && based.status === 'draft') core.commitEntity('revision', { revision_id: based.revision_id, status: 'discarded', replaced_by: sid }, 'revision:' + based.revision_id + ':replaced');
    return { ok: true, revision_id: sid };
  }
  if (action === 'open_draft') {
    var od = env.store.get('Revisions', String(p.revision_id || ''));
    if (!od || !od.body_file_id) return { ok: false, error: 'version not found' };
    var oh = deps.drive.readDraft(od.body_file_id), oblocks;
    try { oblocks = (od.blocks_json || []).length ? EE_revisionBlocks_(od, deps, env) : null; } catch (e) { return { ok: false, error: String(e.message || e) }; }
    var oc = EE_templateCheck_(env, { html: oh, subject: od.subject, preheader: od.preheader, details_box: od.details_box, format: od.format, blocks: oblocks || undefined });
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
    var dblocks;
    try { dblocks = EE_revisionBlocks_(d, deps, env); } catch (e) { return { ok: false, error: 'the draft file changed after it was made; save it again' }; }
    var dry = EE_templateCheck_(env, { html: html, subject: d.subject, preheader: d.preheader, details_box: d.details_box || '', format: d.format, blocks: dblocks });
    if (!dry.ok) return { ok: false, error: 'Not approved, the draft has problems: ' + dry.errors.join('; ') };
    var prior = revisions.filter(function (r) { return r.step_id === d.step_id && r.status !== 'draft' && r.status !== 'discarded'; });
    var revNo = prior.reduce(function (m, r) { return Math.max(m, Number(r.rev_no || 0)); }, 0) + 1;
    var revisionId = 'rev_' + d.step_id + '_' + revNo;
    var frozen = deps.drive.freeze(revisionId + '__body.html', html);
    var fblocks = dblocks.map(function (b) { return { name: b.name, flag: b.flag, file_id: deps.drive.freeze(revisionId + '__' + b.name + '.html', b.html), sha256: env.sha256(b.html) }; });
    var fields = env.store.rows('Fields');
    var rec = { revision_id: revisionId, step_id: d.step_id, rev_no: revNo, subject: d.subject, preheader: d.preheader || '', details_box: d.details_box || '',
      body_file_id: frozen, body_sha256: d.body_sha256, blocks_json: fblocks, attachment_items: d.attachment_items || [], fields_json: fields, status: 'published', format: d.format,
      source_file_id: d.source_file_id, source_name: d.source_name, source_modified: d.source_modified,
      editor: d.editor, approver: actor, approved_at: new Date(env.now()).toISOString(),
      parent_revision_id: prior.length ? prior[prior.length - 1].revision_id : '' };
    rec.content_hash = env.sha256(JSON.stringify([rec.subject, rec.preheader, rec.details_box, rec.body_sha256,
      fblocks.map(function (b) { return b.name + ':' + b.sha256; }), fields, rec.format].concat(rec.attachment_items.length ? [rec.attachment_items] : [])));
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
