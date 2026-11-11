// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE EMAIL → Emails → an email's drawer → Templates (CP7 Template Library).
// The live version, drafts waiting for approval, and the templates in that
// email's Drive folder (Tony's MCPS Marketing → Email Templates). Preview checks
// a template with the real renderer; "Use as draft" copies it into a draft;
// approving freezes and publishes it. Engine: email-engine/src/Templates.js,
// through /api/email?op=admin (list_templates, open_template, open_draft,
// import_template, approve_draft, discard_draft).
// Shares helpers with js/features/lifecycle.js.
// ══════════════════════════════════════════════════════════════════════════════

function lcTemplatesTab_(D) {
  const d = D.data, revs = d.revisions || [];
  const live = revs.find(r => r.status === 'published');
  const drafts = revs.filter(r => r.status === 'draft');
  if (!D.tpl) { D.tpl = { loading: true }; lcLoadTemplates_(D); }
  const who = v => lcEsc_(String(v || '').split('@')[0] || 'someone');
  const can = c => lcCan_(c);
  const liveHtml = live ? '<div class="lc-tpl-live"><div class="main"><b>' + lcEsc_(live.subject) + '</b><small>Version ' + live.rev_no + ' · approved ' + lcEsc_(lcStamp_(live.approved_at)) +
      ' by ' + who(live.approver) + (live.source_name ? ' · from ' + lcEsc_(live.source_name) : '') + (live.format === 'full' ? ' · full template' : ' · MCPS frame') + '</small></div>' +
      '<button class="lc-btn sm" data-act="tpl-preview-rev" data-id="' + lcEsc_(live.revision_id) + '">Preview</button></div>'
    : '<div class="lc-empty" style="text-align:left;padding:0">Nothing approved yet: this email doesn’t send.</div>';
  const draftHtml = drafts.length ? '<ul class="lc-list lc-tpl-list">' + drafts.map(r => '<li><div class="main"><b>' + lcEsc_(r.subject) + '</b><small>From ' + lcEsc_(r.source_name || 'the editor') +
      ' · added ' + lcEsc_(lcStamp_(r.created_at)) + ' by ' + who(r.editor) + '</small></div><div class="lc-tpl-acts">' +
      '<button class="lc-btn sm" data-act="tpl-preview-rev" data-id="' + lcEsc_(r.revision_id) + '">Preview</button>' +
      (can('edit_drafts') ? '<button class="lc-btn sm danger" data-act="tpl-discard" data-id="' + lcEsc_(r.revision_id) + '">Discard</button>' : '') +
      (can('approve_publish') ? '<button class="lc-btn sm primary" data-act="tpl-approve" data-id="' + lcEsc_(r.revision_id) + '">Approve</button>' : '') + '</div></li>').join('') + '</ul>'
    : '';
  const T = D.tpl, files = (T.list || []);
  const state = f => f.newer_in_drive ? lcTag_('Newer in Drive', 'warn') : f.revision_status === 'draft' ? lcTag_('Draft', 'warn')
    : f.revision_status === 'approved' || f.revision_status === 'published' ? lcTag_(live && live.source_file_id === f.file_id ? 'Live' : 'Used before', live && live.source_file_id === f.file_id ? 'live' : '') : '';
  const drive = T.loading ? '<div class="lc-sk" style="height:96px"></div>'
    : T.error ? '<div class="lc-empty" style="text-align:left;padding:0">' + lcEsc_(T.error) + '</div>'
    : !files.length ? '<div class="lc-empty" style="text-align:left;padding:0">No templates in this email’s folder yet. Drop an .html file into <b>MCPS Marketing → Email Templates → ' +
        lcEsc_(LC_SEQ[d.step.bucket]) + ' → ' + lcEsc_(d.step.order + ' - ' + d.step.name) + '</b> and it shows up here.</div>'
    : '<ul class="lc-list lc-tpl-list">' + files.map(f => '<li><div class="main"><b>' + lcEsc_(f.name.replace(/\.html?$/i, '')) + '</b><small>Changed ' + lcEsc_(lcStamp_(f.modified)) +
      ' · ' + Math.max(1, Math.round(f.size / 1024)) + ' KB</small></div>' + state(f) + '<div class="lc-tpl-acts"><button class="lc-btn sm" data-act="tpl-open" data-id="' + lcEsc_(f.file_id) + '">Preview</button>' +
      (can('edit_drafts') && (f.revision_status !== 'draft' || f.newer_in_drive) ? '<button class="lc-btn sm primary" data-act="tpl-use" data-id="' + lcEsc_(f.file_id) + '" data-name="' + lcEsc_(f.name) + '">Use as draft</button>' : '') +
      '</div></li>').join('') + '</ul>';
  return '<div class="lc-sec"><h4>Live</h4>' + liveHtml + '</div>' +
    (drafts.length ? '<div class="lc-sec"><h4>Waiting for approval</h4>' + draftHtml + '<div class="lc-note">Approving freezes this copy: later changes in Drive never change an approved email.</div></div>' : '') +
    '<div class="lc-sec"><h4>In Drive <button class="lc-link" data-act="tpl-reload" style="margin-left:8px;text-transform:none;letter-spacing:0;font-weight:600">Refresh</button></h4>' + drive + '</div>';
}

async function lcLoadTemplates_(D) {
  const r = await lcAdmin_('list_templates', { step_id: D.id }).catch(() => ({ ok: false, error: 'Network error' }));
  if (LC.drawer !== D) return;
  D.tpl = r.ok ? { list: (r.templates || {})[D.id] || [] } : { error: r.error === 'unknown action' ? 'The engine needs an update before templates can be listed.' : (r.error || 'Couldn’t read the Drive folder.') };
  if (D.tab === 'templates') lcRenderDrawer_();
}

// A large preview panel: the checked email in a sandboxed frame, or the list of problems.
function lcTplPreview_(title, r, actions) {
  const layer = document.createElement('div');
  layer.className = 'lc-layer';
  const body = r.ok === false ? '<div class="lc-wiz-warn">' + LC_ICON.alert + '<div><b>Couldn’t open it</b><small>' + lcEsc_(r.error || '') + '</small></div></div>'
    : (r.errors || []).length ? '<div class="lc-wiz-warn">' + LC_ICON.alert + '<div><b>This template can’t be used yet</b><small>' + r.errors.map(e => lcEsc_(e.charAt(0).toUpperCase() + e.slice(1))).join('<br>') + '</small></div></div>' +
      '<p class="lc-note">Fix these in the file (or ask ChatGPT to), save it to the same folder, and preview again.</p>'
    : '<iframe class="lc-tpl-frame" sandbox="" title="Email preview"></iframe>';
  layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim" data-x="close"></div><section class="lc-imp lc-tpl-prev" role="dialog" aria-modal="true" aria-label="Preview">' +
    '<header class="lc-imp-h"><div><h2>' + lcEsc_(title) + '</h2><small class="lc-sub">' + lcEsc_(r.subject ? 'Subject: ' + r.subject : (r.format === 'full' ? 'Full template' : r.format ? 'MCPS frame' : '')) +
    (r.preview_html ? ' · shown with sample details' : '') + '</small></div><button class="lc-icon-btn" data-x="close" aria-label="Close">' + LC_ICON.x + '</button></header>' +
    '<div class="lc-imp-body">' + body + '<div class="lc-imp-f"><button class="lc-btn" data-x="close">Close</button><div style="display:flex;gap:8px">' + (actions || '') + '</div></div></div></section>';
  const close = () => { layer.remove(); document.removeEventListener('keydown', key, true); };
  const key = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  layer.addEventListener('click', e => {
    const x = e.target.closest('[data-x]'); if (!x) return;
    if (x.dataset.x === 'close') return close();
    close(); lcTplAct_(x.dataset.x, x.dataset.id, x.dataset.name);
  });
  document.addEventListener('keydown', key, true);
  document.body.appendChild(layer);
  const fr = layer.querySelector('.lc-tpl-frame');
  if (fr) fr.srcdoc = r.preview_html;
}

// Subject and preview text for a new draft (ChatGPT gives them outside the file).
function lcTplAskSubject_(name, suggested, pre) {
  return new Promise(resolve => {
    const layer = document.createElement('div');
    layer.className = 'lc-layer';
    layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim" data-x="0"></div><div class="lc-sheet" role="dialog" aria-modal="true">' +
      '<h3>Use “' + lcEsc_(name.replace(/\.html?$/i, '')) + '” as a draft</h3><p>It’s copied into a draft that needs approval before anyone gets it.</p>' +
      '<label class="lc-fld" style="margin-top:14px"><span>Subject line</span><input class="lc-input" data-subject maxlength="150" value="' + lcEsc_(suggested || '') + '" placeholder="Under 50 characters reads best"></label>' +
      '<label class="lc-fld" style="margin-top:10px"><span>Preview text <small style="text-transform:none;letter-spacing:0">(optional)</small></span><input class="lc-input" data-pre maxlength="200" value="' + lcEsc_(pre || '') + '" placeholder="Shown after the subject in the inbox"></label>' +
      '<div class="row"><button class="lc-btn" data-x="0">Cancel</button><button class="lc-btn primary" data-x="1">Make draft</button></div></div>';
    const done = v => { layer.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    layer.addEventListener('click', e => {
      const x = e.target.closest('[data-x]'); if (!x) return;
      if (x.dataset.x !== '1') return done(null);
      const subject = layer.querySelector('[data-subject]').value.trim();
      if (!subject) { layer.querySelector('[data-subject]').focus(); return; }
      done({ subject, preheader: layer.querySelector('[data-pre]').value.trim() });
    });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(layer);
    layer.querySelector('[data-subject]').focus();
  });
}

async function lcTplAct_(act, id, name) {
  const D = LC.drawer; if (!D) return;
  const stepId = D.id;
  if (act === 'tpl-reload') { D.tpl = { loading: true }; lcRenderDrawer_(); return lcLoadTemplates_(D); }
  if (act === 'tpl-open') {
    lcToast_('Checking the template…');
    const r = await lcAdmin_('open_template', { step_id: stepId, file_id: id }).catch(() => ({ ok: false, error: 'Network error' }));
    const f = ((D.tpl && D.tpl.list) || []).find(x => x.file_id === id) || { name: r.name || 'Template' };
    const use = r.ok && !(r.errors || []).length && lcCan_('edit_drafts')
      ? '<button class="lc-btn primary" data-x="tpl-use" data-id="' + lcEsc_(id) + '" data-name="' + lcEsc_(f.name) + '">Use as draft</button>' : '';
    D.suggested = Object.assign(D.suggested || {}, { [id]: { s: r.suggested_subject || '', p: r.suggested_preheader || '' } });
    return lcTplPreview_(f.name.replace(/\.html?$/i, ''), r, use);
  }
  if (act === 'tpl-preview-rev') {
    const r = await lcAdmin_('open_draft', { revision_id: id }).catch(() => ({ ok: false, error: 'Network error' }));
    const rev = (D.data.revisions || []).find(x => x.revision_id === id) || {};
    const acts = rev.status === 'draft' && lcCan_('approve_publish') && r.ok && !(r.errors || []).length
      ? '<button class="lc-btn primary" data-x="tpl-approve" data-id="' + lcEsc_(id) + '">Approve</button>' : '';
    return lcTplPreview_(rev.status === 'draft' ? 'Draft' : 'Version ' + rev.rev_no, r, acts);
  }
  if (act === 'tpl-use') {
    let sug = (D.suggested || {})[id];
    if (!sug) { const o = await lcAdmin_('open_template', { step_id: stepId, file_id: id }).catch(() => ({})); sug = { s: o.suggested_subject || '', p: o.suggested_preheader || '' }; }
    const ans = await lcTplAskSubject_(name || 'Template', sug.s, sug.p);
    if (!ans) return;
    const r = await lcAdmin_('import_template', { step_id: stepId, file_id: id, subject: ans.subject, preheader: ans.preheader }).catch(() => ({ ok: false, error: 'Network error' }));
    if (!r.ok) return lcToast_(r.error || 'That didn’t work', true);
    lcToast_('Draft made. It needs approval before it sends.');
    return lcTplReload_();
  }
  if (act === 'tpl-approve') {
    const rev = (D.data.revisions || []).find(x => x.revision_id === id) || {};
    if (!await lcConfirm_({ title: 'Approve and make it live?', ok: 'Approve',
      body: '“' + (rev.subject || '') + '” replaces the current version for every email not yet sent. Emails already sent stay as they were.' })) return;
    const r = await lcAdmin_('approve_draft', { revision_id: id }).catch(() => ({ ok: false, error: 'Network error' }));
    if (!r.ok) return lcToast_(r.error || 'That didn’t work', true);
    lcToast_('Approved: version ' + r.rev_no + ' is live');
    return lcTplReload_();
  }
  if (act === 'tpl-discard') {
    if (!await lcConfirm_({ title: 'Discard this draft?', ok: 'Discard', danger: true, body: 'The template stays in Drive; only this draft goes away.' })) return;
    const r = await lcAdmin_('discard_draft', { revision_id: id }).catch(() => ({ ok: false, error: 'Network error' }));
    if (!r.ok) return lcToast_(r.error || 'That didn’t work', true);
    lcToast_('Draft discarded');
    return lcTplReload_();
  }
}
// Fresh drawer data (versions) and Drive list after a change.
function lcTplReload_() {
  const D = LC.drawer; if (!D) return;
  D.tpl = { loading: true };
  lcFetch_('step', { id: D.id, mode: LC.mode || '', fresh: '1' }).then(data => { if (LC.drawer === D) { D.data = data; lcRenderDrawer_(); } }).catch(() => {});
  lcLoadTemplates_(D);
  lcRefresh_(true);
}
