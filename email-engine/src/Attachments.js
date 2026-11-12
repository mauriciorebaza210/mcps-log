// ══════════════════════════════════════════════════════════════════════════════
// ATTACHMENT LIBRARY (PLAN.md → Attachments). PDFs that emails carry, e.g. the
// Welcome's Safety Guidelines and Startup Guide.
//
//   Tony drops a PDF into MCPS Marketing → Email Attachments (Drive). From the
//   portal it becomes a new item, or a new version of one; the engine copies it
//   into the engine's own Attachments folder (view-only to everyone else) and
//   records its sha256. A version is pending until approved (approve_publish,
//   two-person rule if on); then it is the item's published version.
//   Emails list items (Revisions.attachment_items), so approving an email approves
//   which PDFs it carries; revising a PDF needs only the PDF's approval.
//   At send (Env.js → EE_renderDelivery_) each item's published version is read,
//   its hash checked and size limited; any problem fails the delivery and alerts.
//
//   list_attachments   items with versions and "used by", and the files in the drop folder
//   add_attachment     { file_id, item_id | name }  → a pending version
//   approve_attachment { version_id }   discard_attachment { version_id }
//   rollback_attachment { version_id }  an older version again, as a new pending version
//   retire_attachment  { item_id }      no future email carries it
//
// deps.files = { dropFolder() -> id, list(folderId) -> [{id, name, mime, size, modified}],
//   get(fileId) -> {id, name, mime, size, parents[]} | null, freeze(fileId, name) -> {file_id, sha256, size},
//   hash(fileId) -> sha256 }
// ══════════════════════════════════════════════════════════════════════════════

var EE_ATTACH_MAX = 10 * 1024 * 1024, EE_ATTACH_EMAIL_MAX = 20 * 1024 * 1024;
var EE_ATTACH_TYPES = { 'application/pdf': 1 };
var EE_ATTACH_ACTIONS = { list_attachments: 1, add_attachment: 1, approve_attachment: 1, discard_attachment: 1, rollback_attachment: 1, retire_attachment: 1 };

function EE_attachPublished_(env, itemId) {
  return env.store.rows('AttachmentVersions').filter(function (v) { return v.item_id === itemId && v.status === 'published'; })[0] || null;
}

function EE_attachmentAction_(env, core, action, p, actor, deps) {
  var items = env.store.rows('Attachments'), versions = env.store.rows('AttachmentVersions');
  var now = new Date(env.now()).toISOString();
  if (action === 'list_attachments') {
    var revisions = env.store.rows('Revisions').filter(function (r) { return r.status === 'published' || r.status === 'draft'; });
    var rs = typeof EE_currentRuleset_ === 'function' ? EE_currentRuleset_(env) : null;
    var stepName = {}; ((rs && rs.json.steps) || EE_SEED.ruleset.steps).forEach(function (s) { stepName[s.step_id] = s.name; });
    var folder = deps.files.dropFolder();
    var used = {}; versions.forEach(function (v) { if (v.source_file_id) used[v.source_file_id] = v; });
    return { ok: true, folder: 'MCPS Marketing → Email Attachments',
      items: items.map(function (it) {
        var mine = versions.filter(function (v) { return v.item_id === it.item_id; }).sort(function (a, b) { return Number(b.v) - Number(a.v); });
        return { item_id: it.item_id, name: it.name, status: it.status, created_at: it.created_at,
          versions: mine.map(function (v) { return { version_id: v.version_id, v: Number(v.v), status: v.status, size: Number(v.size || 0), source_name: v.source_name,
            uploaded_by: v.uploaded_by, uploaded_at: v.uploaded_at, approver: v.approver || '', approved_at: v.approved_at || '' }; }),
          used_by: revisions.filter(function (r) { return (r.attachment_items || []).indexOf(it.item_id) !== -1; })
            .map(function (r) { return { step_id: r.step_id, name: stepName[r.step_id] || r.step_id, status: r.status, rev_no: r.rev_no }; }) };
      }),
      drop: folder ? deps.files.list(folder).map(function (f) {
        var u = used[f.id];
        return { file_id: f.id, name: f.name, mime: f.mime, size: f.size, modified: f.modified, ok: !!EE_ATTACH_TYPES[f.mime] && f.size <= EE_ATTACH_MAX,
          used_as: u ? { item_id: u.item_id, v: Number(u.v) } : null };
      }).sort(function (a, b) { return String(b.modified).localeCompare(String(a.modified)); }) : [] };
  }
  if (action === 'add_attachment') {
    var folderId = deps.files.dropFolder(), f = deps.files.get(String(p.file_id || ''));
    if (!f || (f.parents || []).indexOf(folderId) === -1) return { ok: false, error: 'that file isn’t in the Email Attachments folder' };
    if (!EE_ATTACH_TYPES[f.mime]) return { ok: false, error: 'only PDF files can be attached' };
    if (f.size > EE_ATTACH_MAX) return { ok: false, error: 'the file is over 10 MB' };
    var item = p.item_id ? items.filter(function (i) { return i.item_id === String(p.item_id); })[0] : null;
    if (p.item_id && (!item || item.status === 'retired')) return { ok: false, error: 'attachment not found' };
    if (!item) {
      var name = String(p.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!name) return { ok: false, error: 'give the attachment a name' };
      if (items.some(function (i) { return i.status !== 'retired' && i.name.toLowerCase() === name.toLowerCase(); })) return { ok: false, error: 'there is already an attachment called “' + name + '”' };
      item = { item_id: 'att_' + env.uuid().replace(/-/g, '').slice(0, 8), name: name, status: 'active', created_by: actor, created_at: now };
      env.store.upsert('Attachments', item);
    }
    var n = versions.filter(function (v) { return v.item_id === item.item_id; }).reduce(function (m, v) { return Math.max(m, Number(v.v || 0)); }, 0) + 1;
    var frozen = deps.files.freeze(f.id, item.name.replace(/[^\w\- ]+/g, '') + ' v' + n + '.pdf');
    var ver = { version_id: item.item_id + '_v' + n, item_id: item.item_id, v: n, file_id: frozen.file_id, sha256: frozen.sha256, size: frozen.size,
      source_file_id: f.id, source_name: f.name, status: 'pending', uploaded_by: actor, uploaded_at: now };
    env.store.upsert('AttachmentVersions', ver);
    return { ok: true, item_id: item.item_id, version_id: ver.version_id, v: n };
  }
  var vv = p.version_id ? versions.filter(function (v) { return v.version_id === String(p.version_id); })[0] : null;
  if (action === 'approve_attachment' || action === 'discard_attachment') {
    if (!vv || vv.status !== 'pending') return { ok: false, error: 'pending version not found' };
    if (action === 'discard_attachment') { env.store.upsert('AttachmentVersions', EE_merge_(vv, { status: 'discarded' })); return { ok: true }; }
    if (env.props.get('EE_REQUIRE_SECOND_APPROVER') === 'true' && String(vv.uploaded_by).toLowerCase() === String(actor).toLowerCase()) {
      return { ok: false, error: 'Two-person rule is on: someone other than ' + actor + ' must approve this PDF.' };
    }
    if (deps.files.hash(vv.file_id) !== vv.sha256) return { ok: false, error: 'the stored copy changed after it was added; add the file again' };
    versions.filter(function (v) { return v.item_id === vv.item_id && v.status === 'published'; })
      .forEach(function (v) { env.store.upsert('AttachmentVersions', EE_merge_(v, { status: 'superseded' })); });
    env.store.upsert('AttachmentVersions', EE_merge_(vv, { status: 'published', approver: actor, approved_at: now }));
    return { ok: true, v: Number(vv.v) };
  }
  if (action === 'rollback_attachment') {
    if (!vv || !/^(superseded|published)$/.test(vv.status)) return { ok: false, error: 'version not found' };
    var m = versions.filter(function (v) { return v.item_id === vv.item_id; }).reduce(function (x, v) { return Math.max(x, Number(v.v || 0)); }, 0) + 1;
    var again = { version_id: vv.item_id + '_v' + m, item_id: vv.item_id, v: m, file_id: vv.file_id, sha256: vv.sha256, size: vv.size,
      source_file_id: vv.source_file_id, source_name: vv.source_name + ' (v' + vv.v + ' again)', status: 'pending', uploaded_by: actor, uploaded_at: now, restored_from: vv.version_id };
    env.store.upsert('AttachmentVersions', again);
    return { ok: true, version_id: again.version_id, v: m };
  }
  if (action === 'retire_attachment') {
    var it2 = items.filter(function (i) { return i.item_id === String(p.item_id || ''); })[0];
    if (!it2) return { ok: false, error: 'attachment not found' };
    env.store.upsert('Attachments', EE_merge_(it2, { status: 'retired', retired_by: actor, retired_at: now }));
    return { ok: true };
  }
  return { ok: false, error: 'unknown attachment action' };
}

// What an email carries at send: each item's published version, hash-checked.
// Items without a published version are skipped (an email can go live before its
// PDFs; PLAN.md row 57); a retired item is skipped too. Anything wrong throws,
// which fails the delivery with "attachment: …" and alerts (row 53).
function EE_attachmentsFor_(env, rev, files) {
  var out = [], total = 0;
  (rev.attachment_items || []).forEach(function (itemId) {
    var item = env.store.get('Attachments', itemId);
    if (!item || item.status === 'retired') return;
    var v = EE_attachPublished_(env, itemId);
    if (!v) return;
    var blob = files.read(v.file_id);
    if (files.sha256(blob) !== v.sha256) throw new Error('attachment: ' + item.name + ' v' + v.v + ' changed after approval');
    var size = files.size(blob);
    if (size > EE_ATTACH_MAX) throw new Error('attachment: ' + item.name + ' is over 10 MB');
    total += size;
    out.push({ item_id: itemId, version_id: v.version_id, name: item.name + '.pdf', blob: blob });
  });
  if (total > EE_ATTACH_EMAIL_MAX) throw new Error('attachment: over 20 MB in one email');
  return out;
}

// ── Apps Script Drive access ──────────────────────────────────────────────────
function EE_attachFilesDeps_() {
  var props = EE_props_();
  var hashBytes = function (bytes) {
    return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
  };
  return {
    dropFolder: function () {
      var root = EE_folder_(props, 'EE_FOLDER_MARKETING', 'MCPS Marketing', null);
      return EE_folder_(props, 'EE_FOLDER_ATTACH_DROP', 'Email Attachments', root).getId();
    },
    list: function (folderId) {
      var it = DriveApp.getFolderById(folderId).getFiles(), out = [];
      while (it.hasNext()) { var f = it.next(); out.push({ id: f.getId(), name: f.getName(), mime: f.getMimeType(), size: f.getSize(), modified: f.getLastUpdated().toISOString() }); }
      return out;
    },
    get: function (fileId) {
      var f; try { f = DriveApp.getFileById(fileId); } catch (e) { return null; }
      var parents = [], it = f.getParents(); while (it.hasNext()) parents.push(it.next().getId());
      return { id: f.getId(), name: f.getName(), mime: f.getMimeType(), size: f.getSize(), parents: parents };
    },
    freeze: function (fileId, name) {
      var dest = EE_folder_(props, 'EE_FOLDER_ATTACHMENTS', 'Attachments', DriveApp.getFolderById(props.getProperty('EE_FOLDER_ROOT')));
      var copy = DriveApp.getFileById(fileId).makeCopy(name, dest);
      var bytes = copy.getBlob().getBytes();
      return { file_id: copy.getId(), sha256: hashBytes(bytes), size: bytes.length };
    },
    hash: function (fileId) { return hashBytes(DriveApp.getFileById(fileId).getBlob().getBytes()); }
  };
}
// For the send path (Env.js): read a frozen file as a blob, hash it, size it.
function EE_attachSendFiles_() {
  return {
    read: function (fileId) { return DriveApp.getFileById(fileId).getBlob(); },
    sha256: function (blob) {
      return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, blob.getBytes()).map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
    },
    size: function (blob) { return blob.getBytes().length; }
  };
}
