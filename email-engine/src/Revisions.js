// ══════════════════════════════════════════════════════════════════════════════
// REVISIONS: approving a draft publishes an immutable revision (PLAN.md →
// Versioning contract). The body and its blocks are copied into the Revisions
// folder, hashed (sha256), and recorded with the subject, fields snapshot,
// approver and time. At send, EE_renderDelivery_ re-hashes the files; a file
// changed after approval fails the delivery instead of sending.
// ══════════════════════════════════════════════════════════════════════════════

// eeApprove('b_intro') from the editor, as the approver (Tony or Mau).
function eeApprove(stepId, editor) {
  var x = EE_core_(), env = x.env, props = EE_props_();
  var content = EE_SEED.content.steps[stepId];
  if (!content) throw new Error('no draft content for step ' + stepId);
  var approver = Session.getEffectiveUser().getEmail();
  editor = editor || 'seed';
  if (props.getProperty('EE_REQUIRE_SECOND_APPROVER') === 'true' && editor.toLowerCase() === approver.toLowerCase()) {
    throw new Error('Two-person rule is on: ' + approver + ' edited this draft, so someone else must approve it.');
  }
  var drafts = DriveApp.getFolderById(props.getProperty('EE_FOLDER_DRAFTS'));
  var revFolder = DriveApp.getFolderById(props.getProperty('EE_FOLDER_REVISIONS'));
  var readDraft = function (path) {
    var it = drafts.getFilesByName(path.replace(/\//g, '__'));
    if (!it.hasNext()) throw new Error('draft file ' + path + ' not found in Drafts');
    return it.next().getBlob().getDataAsString('UTF-8');
  };
  var prior = env.store.rows('Revisions').filter(function (r) { return r.step_id === stepId; });
  var revNo = prior.reduce(function (m, r) { return Math.max(m, Number(r.rev_no || 0)); }, 0) + 1;
  var revisionId = 'rev_' + stepId + '_' + revNo;
  var freeze = function (name, html) {
    var f = revFolder.createFile(revisionId + '__' + name, html, MimeType.HTML);
    return { file_id: f.getId(), sha256: EE_sha256Hex_(html) };
  };

  var bodyHtml = readDraft(content.body);
  var fields = env.store.rows('Fields');
  // Dry render with a complete sample contact: unknown fields, missing blocks
  // and unsafe HTML refuse the approval here, not at send time.
  var blockSpecs = (content.blocks || []).map(function (name) {
    var spec = EE_SEED.content.blocks[name];
    return { name: name, flag: spec.flag, html: readDraft(spec.html) };
  });
  var sampleBlocks = {}; blockSpecs.forEach(function (b) { sampleBlocks[b.name] = { flag: b.flag, html: b.html }; });
  var cfg = EE_config_(env.store);
  var dry = MCPS_EMAIL_RENDER.render({ revision: { subject: content.subject, preheader: content.preheader,
    details_box: content.details_box, body_html: bodyHtml }, blocks: sampleBlocks, fields: fields,
    contact: { first_name: 'Sample', last_name: 'Contact', address: '1 Sample St', startup_date: '2026-01-01', pool_school: 'Y' },
    context: { sender_name: cfg.sender_name, unsubscribeUrl: 'https://example.invalid/u', links: { quote: cfg.link_quote },
      business: { name: cfg.business_name, address: cfg.business_address, phone: cfg.business_phone, website: cfg.business_website } } });
  if (!dry.ok) throw new Error('Not approved, the draft has problems: ' + dry.errors.join('; '));

  var body = freeze('body.html', bodyHtml);
  var blocks = blockSpecs.map(function (b) { var fz = freeze(b.name + '.html', b.html); return { name: b.name, flag: b.flag, file_id: fz.file_id, sha256: fz.sha256 }; });
  var rec = { revision_id: revisionId, step_id: stepId, rev_no: revNo, subject: content.subject, preheader: content.preheader || '',
    details_box: content.details_box || '', body_file_id: body.file_id, body_sha256: body.sha256, blocks_json: blocks,
    fields_json: fields, status: 'published', editor: editor, approver: approver, approved_at: new Date().toISOString(),
    parent_revision_id: prior.length ? prior[prior.length - 1].revision_id : '' };
  rec.content_hash = EE_sha256Hex_(JSON.stringify([rec.subject, rec.preheader, rec.details_box, rec.body_sha256,
    blocks.map(function (b) { return b.name + ':' + b.sha256; }), fields]));
  prior.filter(function (r) { return r.status === 'published'; }).forEach(function (r) {
    x.core.commitEntity('revision', { revision_id: r.revision_id, status: 'superseded' }, 'revision:' + r.revision_id + ':superseded');
  });
  x.core.commitEntity('revision', rec, 'revision:' + revisionId + ':publish');
  Logger.log('Published ' + revisionId + ' (' + rec.content_hash.slice(0, 12) + ') approved by ' + approver + '.');
  return revisionId;
}

// One-click versions for the editor's Run button (it can't pass arguments).
function eeApproveBIntro() { return eeApprove('b_intro'); }
function eeApproveCWelcome() { return eeApprove('c_welcome'); }
