// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE EMAIL → Emails → Attachments: the Attachment Library (PLAN.md → Attachments).
// PDFs that emails carry (e.g. the Welcome's Safety Guidelines and Startup Guide).
// Drop a PDF into MCPS Marketing → Email Attachments in Drive; here it becomes an
// attachment (or a new version of one), gets approved, and emails pick it in the
// editor. Changing an approved PDF only needs the PDF approved again.
// Engine: Attachments.js (list_attachments, add_attachment, approve_attachment,
// discard_attachment, rollback_attachment, retire_attachment).
// Shares helpers with js/features/lifecycle.js.
// ══════════════════════════════════════════════════════════════════════════════

const ATT = { layer: null, data: null, error: '' };
const attSize_ = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const attWho_ = v => lcEsc_(String(v || '').split('@')[0] || 'someone');

function attOpen_() {
  if (ATT.layer) return;
  const layer = document.createElement('div');
  layer.className = 'lc-layer';
  layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim" data-act="att-close"></div><section class="lc-imp lc-att" role="dialog" aria-modal="true" aria-label="Attachments"></section>';
  document.body.appendChild(layer);
  Object.assign(ATT, { layer, data: null, error: '' });
  layer.addEventListener('click', lcOnClick_);
  document.addEventListener('keydown', attOnKey_);
  attRender_();
  return attLoad_();
}
function attClose_() { if (!ATT.layer) return; ATT.layer.remove(); ATT.layer = null; document.removeEventListener('keydown', attOnKey_); }
function attOnKey_(e) { if (e.key === 'Escape' && !document.querySelector('.lc-sheet')) attClose_(); }
async function attLoad_() {
  const r = await lcAdmin_('list_attachments', {}).catch(() => ({ ok: false, error: 'Network error' }));
  if (!ATT.layer) return;
  if (r.ok) { ATT.data = r; ATT.error = ''; } else ATT.error = r.error === 'unknown action' ? 'The engine needs an update before attachments can be used.' : (r.error || 'Couldn’t load attachments');
  attRender_();
}

function attRender_() {
  if (typeof hlpAfterRender_ === 'function') hlpAfterRender_();
  if (!ATT.layer) return;
  const D = ATT.data, canEdit = lcCan_('edit_drafts'), canOk = lcCan_('approve_publish');
  let body;
  if (ATT.error) body = '<div class="lc-wiz-warn">' + LC_ICON.alert + '<div><b>Couldn’t load</b><small>' + lcEsc_(ATT.error) + '</small></div></div>';
  else if (!D) body = '<div class="lc-tpl-loading" role="status"><span class="lc-spinner"></span><div><b>Loading attachments</b><small>Reading the library and the Drive folder.</small></div></div><div class="lc-sk" style="height:200px"></div>';
  else {
    const items = D.items.filter(i => i.status !== 'retired');
    const live = items.length ? items.map(it => {
      const pub = it.versions.find(v => v.status === 'published'), pend = it.versions.filter(v => v.status === 'pending');
      const vers = it.versions.filter(v => v.status !== 'discarded').map(v => '<li><div class="main"><b>v' + v.v + '</b> <span class="lc-dim">' + lcEsc_(v.source_name || '') + ' · ' + attSize_(v.size) + '</span>' +
        '<small>Added ' + lcEsc_(lcStamp_(v.uploaded_at)) + ' by ' + attWho_(v.uploaded_by) + (v.approved_at ? ' · approved by ' + attWho_(v.approver) : '') + '</small></div>' +
        (v.status === 'published' ? lcTag_('Live', 'live') : v.status === 'pending' ? lcTag_('Needs approval', 'warn') : lcTag_('Older', '')) +
        '<div class="lc-tpl-acts">' +
          (v.status === 'pending' && canOk ? '<button class="lc-btn sm primary" data-act="att-approve" data-id="' + lcEsc_(v.version_id) + '">Approve</button>' : '') +
          (v.status === 'pending' && canEdit ? '<button class="lc-btn sm danger" data-act="att-discard" data-id="' + lcEsc_(v.version_id) + '">Discard</button>' : '') +
          (v.status === 'superseded' && canEdit ? '<button class="lc-btn sm" data-act="att-rollback" data-id="' + lcEsc_(v.version_id) + '">Use again</button>' : '') +
        '</div></li>').join('');
      const used = it.used_by.length ? 'Used by ' + it.used_by.map(u => lcEsc_(u.name) + (u.status === 'draft' ? ' (draft)' : '')).join(', ') : 'Not in any email yet: pick it in an email’s editor';
      return '<article class="lc-att-item"><header><span class="lc-att-ic">' + LC_ICON.clip + '</span><div class="grow"><h3>' + lcEsc_(it.name) + '</h3><small>' + used + '</small></div>' +
        (pub ? lcTag_('v' + pub.v + ' live', 'live') : lcTag_(pend.length ? 'Waiting for approval' : 'No version', 'warn')) +
        (canEdit ? '<button class="lc-btn sm danger" data-act="att-retire" data-id="' + lcEsc_(it.item_id) + '" data-key="' + lcEsc_(it.name) + '">Retire</button>' : '') + '</header>' +
        '<ul class="lc-list lc-tpl-list">' + vers + '</ul></article>';
    }).join('') : '<div class="lc-empty" style="text-align:left">No attachments yet. Drop a PDF into the Drive folder below, then add it here.</div>';
    const opts = items.map(i => '<option value="' + lcEsc_(i.item_id) + '">New version of “' + lcEsc_(i.name) + '”</option>').join('');
    const drop = D.drop.length ? '<ul class="lc-list lc-tpl-list">' + D.drop.map(f => '<li><div class="main"><b>' + lcEsc_(f.name) + '</b><small>' + attSize_(f.size) + ' · changed ' + lcEsc_(lcStamp_(f.modified)) +
        (f.used_as ? ' · added as v' + f.used_as.v + ' of “' + lcEsc_((items.find(i => i.item_id === f.used_as.item_id) || {}).name || 'an attachment') + '”' : '') + '</small></div>' +
        (!f.ok ? lcTag_(f.size > 10485760 ? 'Over 10 MB' : 'Not a PDF', 'warn')
          : canEdit ? '<div class="lc-tpl-acts"><select class="lc-input sm" data-att-target="' + lcEsc_(f.file_id) + '"><option value="">Add as a new attachment</option>' + opts + '</select>' +
            '<button class="lc-btn sm primary" data-act="att-add" data-id="' + lcEsc_(f.file_id) + '" data-name="' + lcEsc_(f.name.replace(/\.pdf$/i, '')) + '">Add</button></div>' : '') + '</li>').join('') + '</ul>'
      : '<div class="lc-empty" style="text-align:left;padding:0">The folder is empty.</div>';
    body = '<div class="lc-sec"><h4>Attachments</h4>' + live + '<p class="lc-note">An email carries an attachment only after both are approved: the PDF here, and the email that lists it. A new version of a PDF needs only its own approval.</p></div>' +
      '<div class="lc-sec"><h4>In Drive <span class="lc-dim" style="text-transform:none;letter-spacing:0;font-weight:600">' + lcEsc_(D.folder) + '</span><button class="lc-link" data-act="att-reload" style="margin-left:8px;text-transform:none;letter-spacing:0;font-weight:600">Refresh</button></h4>' + drop +
      '<p class="lc-note">PDFs only, up to 10 MB each. Adding makes a locked copy, so later edits in Drive never change what was approved.</p></div>';
  }
  ATT.layer.querySelector('.lc-att').innerHTML = '<header class="lc-imp-h"><div><h2>Attachments</h2><small class="lc-sub">PDFs your emails can carry</small></div>' +
    '<button class="lc-icon-btn" data-act="att-close" aria-label="Close">' + LC_ICON.x + '</button></header><div class="lc-imp-body">' + body + '</div>';
}

async function attAct_(t) {
  const a = t.dataset.act, id = t.dataset.id;
  if (a === 'att-open') return attOpen_();
  if (a === 'att-close') return attClose_();
  if (a === 'att-reload') { ATT.data = null; attRender_(); return attLoad_(); }
  if (a === 'att-add') {
    const target = (ATT.layer.querySelector('[data-att-target="' + CSS.escape(id) + '"]') || {}).value || '';
    let p = { file_id: id };
    if (target) p.item_id = target;
    else {
      const name = await attAskName_(t.dataset.name || '');
      if (!name) return;
      p.name = name;
    }
    const r = await lcAdmin_('add_attachment', p).catch(() => ({ ok: false, error: 'Network error' }));
    if (!r.ok) return lcToast_(r.error || 'That didn’t work', true);
    lcToast_('Added as v' + r.v + '. It needs approval before any email carries it.');
    return attLoad_();
  }
  if (a === 'att-approve') {
    const r = await lcConfirm_({ title: 'Approve this PDF?', ok: 'Approve', body: 'Emails that list this attachment carry this version from their next send.',
      run: () => lcAdmin_('approve_attachment', { version_id: id }) });
    if (!r) return; lcToast_('Approved: v' + r.v + ' is live'); return attLoad_();
  }
  if (a === 'att-discard') {
    if (!await lcConfirm_({ title: 'Discard this version?', ok: 'Discard', danger: true, body: 'The file stays in Drive; only this version goes away.',
      run: () => lcAdmin_('discard_attachment', { version_id: id }) })) return;
    lcToast_('Discarded'); return attLoad_();
  }
  if (a === 'att-rollback') {
    const r = await lcAdmin_('rollback_attachment', { version_id: id }).catch(() => ({ ok: false, error: 'Network error' }));
    if (!r.ok) return lcToast_(r.error || 'That didn’t work', true);
    lcToast_('Copied as v' + r.v + '. Approve it to make it live.'); return attLoad_();
  }
  if (a === 'att-retire') {
    if (!await lcConfirm_({ title: 'Retire “' + t.dataset.key + '”?', ok: 'Retire', danger: true, body: 'No email carries it from now on, even ones that list it. Emails already sent keep it.',
      run: () => lcAdmin_('retire_attachment', { item_id: id }) })) return;
    lcToast_('Retired'); return attLoad_();
  }
}
// The name shown in the inbox (Safety Guidelines.pdf) and in the library.
function attAskName_(suggested) {
  return new Promise(resolve => {
    const layer = document.createElement('div');
    layer.className = 'lc-layer';
    layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim" data-x="0"></div><div class="lc-sheet" role="dialog" aria-modal="true"><h3>New attachment</h3>' +
      '<p>Its name is also the file name customers see, e.g. “Safety Guidelines” → Safety Guidelines.pdf.</p>' +
      '<label class="lc-fld" style="margin-top:14px"><span>Name</span><input class="lc-input" data-name maxlength="60" value="' + lcEsc_(suggested) + '"></label>' +
      '<div class="row"><button class="lc-btn" data-x="0">Cancel</button><button class="lc-btn primary" data-x="1">Add</button></div></div>';
    const done = v => { layer.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); done(''); } if (e.key === 'Enter') { e.preventDefault(); const v = layer.querySelector('[data-name]').value.trim(); if (v) done(v); } };
    layer.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (!x) return; const v = layer.querySelector('[data-name]').value.trim(); if (x.dataset.x === '1' && !v) return; done(x.dataset.x === '1' ? v : ''); });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(layer);
    layer.querySelector('[data-name]').focus();
  });
}
