// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE EMAIL → Contacts → Import (CP7a). Any spreadsheet into Needs review.
//
//   1 File      CSV / Excel / pasted rows, the group, the source
//   2 Columns   sheet + header row, suggested mapping (or a saved one), live preview
//   3 Check     the server's verdict per row (api/email.js → op=import, stage check)
//   4 Import    chunks of 100 (stage save), progress, the mapping saved for next time
//
// Parsing and normalizing: js/lib/contact-import.js (MCPS_CONTACT_IMPORT).
// Excel is read with SheetJS, loaded only when an Excel file is chosen.
// Shares helpers with js/features/lifecycle.js (lcEsc_, lcToast_, LC, LC_SEQ, LC_ICON).
// ══════════════════════════════════════════════════════════════════════════════

const IMP = { step: 1, layer: null, file: '', sheets: null, sheet: '', rows: [], header: 0, map: {}, group: 'B', source: '',
  saved: null, mappings: null, check: null, include: new Set(), choice: {}, progress: null, done: null, busy: false };
const IMP_XLSX = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const IMP_VERDICT = {
  new: ['Will be added', 'live'], possible_duplicate: ['Possibly already here', 'warn'], existing: ['Already here (same email)', ''], same_person: ['Same person, other email', 'warn'],
  customer: ['Already an MCPS customer', ''], opted_out: ['Unsubscribed or bounced', ''], do_not_contact: ['Do not contact', 'bad']
};

async function impPost_(body) {
  const res = await fetch('/api/email?op=import', { method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + currentSessionToken_() }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok && !out.error) out.error = 'HTTP ' + res.status;
  return out;
}
function impLoadScript_(src) {
  return new Promise((ok, fail) => { if (window.XLSX) return ok(); const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Couldn’t load the Excel reader')); document.head.appendChild(s); });
}

function lcOpenImport_() {
  Object.assign(IMP, { step: 1, file: '', sheets: null, sheet: '', rows: [], header: 0, map: {}, group: 'B', source: '', saved: null,
    check: null, include: new Set(), progress: null, done: null, busy: false });
  const layer = document.createElement('div');
  layer.className = 'lc-layer';
  layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim"></div><section class="lc-imp" role="dialog" aria-modal="true" aria-label="Import contacts"></section>';
  document.body.appendChild(layer);
  IMP.layer = layer;
  layer.addEventListener('click', impOnClick_);
  layer.addEventListener('change', impOnChange_);
  layer.addEventListener('input', impOnInput_);
  layer.addEventListener('dragover', e => { if (e.target.closest('.lc-drop')) { e.preventDefault(); e.target.closest('.lc-drop').classList.add('over'); } });
  layer.addEventListener('dragleave', e => { const d = e.target.closest('.lc-drop'); if (d) d.classList.remove('over'); });
  layer.addEventListener('drop', e => { const d = e.target.closest('.lc-drop'); if (!d) return; e.preventDefault(); d.classList.remove('over'); if (e.dataTransfer.files[0]) impReadFile_(e.dataTransfer.files[0]); });
  document.addEventListener('keydown', impOnKey_);
  impPost_({ stage: 'mappings' }).then(r => { IMP.mappings = r.ok ? r.mappings : {}; }).catch(() => { IMP.mappings = {}; });
  impRender_();
}
function impClose_() {
  if (!IMP.layer || IMP.busy) return;
  IMP.layer.remove(); IMP.layer = null;
  document.removeEventListener('keydown', impOnKey_);
  if (IMP.done) { LC.contacts = null; lcRefresh_(true); }
}
function impOnKey_(e) { if (e.key === 'Escape') impClose_(); }

// ── Reading the file ─────────────────────────────────────────────────────────
async function impReadFile_(file) {
  IMP.file = file.name;
  if (!IMP.source) IMP.source = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  try {
    if (/\.xlsx?$|\.xlsm$/i.test(file.name)) {
      await impLoadScript_(IMP_XLSX);
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
      IMP.sheets = {};
      wb.SheetNames.forEach(n => { IMP.sheets[n] = window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }); });
      // Start on the sheet with the most rows; the person can switch.
      IMP.sheet = wb.SheetNames.slice().sort((a, b) => IMP.sheets[b].length - IMP.sheets[a].length)[0];
      impUseRows_(IMP.sheets[IMP.sheet]);
    } else {
      IMP.sheets = null;
      impUseRows_(MCPS_CONTACT_IMPORT.parseDelimited(await file.text()));
    }
  } catch (e) { lcToast_(e.message || 'Couldn’t read that file', true); }
}
function impUseRows_(rows) {
  IMP.rows = rows || [];
  IMP.header = MCPS_CONTACT_IMPORT.findHeaderRow(IMP.rows);
  impSuggest_();
  IMP.step = IMP.rows.length ? 2 : 1;
  if (!IMP.rows.length) lcToast_('That file has no rows', true);
  impRender_();
}
function impSuggest_() {
  const I = MCPS_CONTACT_IMPORT, headers = IMP.rows[IMP.header] || [];
  const saved = IMP.mappings && IMP.mappings[I.mappingKey(headers)];
  IMP.saved = saved || null;
  IMP.map = saved ? Object.assign({}, saved.mapping) : I.suggestMapping(headers, IMP.rows.slice(IMP.header + 1, IMP.header + 21));
  if (saved && saved.source && !IMP.sourceTouched) IMP.source = saved.source;
}
function impContacts_() {
  return MCPS_CONTACT_IMPORT.toContacts(IMP.rows, IMP.header, IMP.map, { source: IMP.source });
}

// ── Rendering ────────────────────────────────────────────────────────────────
function impRender_() {
  if (!IMP.layer) return;
  const el = IMP.layer.querySelector('.lc-imp');
  const steps = ['File', 'Columns', 'Check', 'Import'];
  el.innerHTML = '<header class="lc-imp-h"><div><h2>Import contacts</h2><ol class="lc-steps">' +
    steps.map((s, i) => '<li class="' + (IMP.step === i + 1 ? 'on' : IMP.step > i + 1 ? 'done' : '') + '"><span>' + (IMP.step > i + 1 ? '✓' : i + 1) + '</span>' + s + '</li>').join('') +
    '</ol></div><button class="lc-icon-btn" data-imp="close" aria-label="Close"' + (IMP.busy ? ' disabled' : '') + '>' + LC_ICON.x + '</button></header>' +
    '<div class="lc-imp-body">' + [impStepFile_, impStepColumns_, impStepCheck_, impStepImport_][IMP.step - 1]() + '</div>';
}

function impStepFile_() {
  return '<label class="lc-drop" tabindex="0"><input type="file" accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm" data-imp-file hidden>' +
    '<b>Drop a spreadsheet here, or click to choose</b><small>Excel or CSV, any layout. The list stays on your computer until you import.</small></label>' +
    '<div class="lc-or">or paste rows copied from a spreadsheet</div>' +
    '<textarea class="lc-input lc-paste" rows="5" placeholder="Paste here, including the header row" data-imp-paste></textarea>' +
    '<div class="lc-imp-f"><span></span><button class="lc-btn primary" data-imp="paste">Use pasted rows</button></div>';
}

function impStepColumns_() {
  const I = MCPS_CONTACT_IMPORT, headers = IMP.rows[IMP.header] || [], body = IMP.rows.slice(IMP.header + 1);
  const res = impContacts_(), hasEmail = Object.values(IMP.map).includes('email');
  const opts = i => I.FIELDS.map(f => '<option value="' + f.key + '"' + ((IMP.map[i] || '') === f.key ? ' selected' : '') + '>' + lcEsc_(f.label) + '</option>').join('');
  const sheetPick = IMP.sheets && Object.keys(IMP.sheets).length > 1 ? '<label class="lc-fld"><span>Sheet</span><select class="lc-input" data-imp-sheet>' +
    Object.keys(IMP.sheets).map(n => '<option' + (n === IMP.sheet ? ' selected' : '') + '>' + lcEsc_(n) + '</option>').join('') + '</select></label>' : '';
  const headerPick = '<label class="lc-fld"><span>Header row</span><select class="lc-input" data-imp-header>' +
    IMP.rows.slice(0, 15).map((r, i) => '<option value="' + i + '"' + (i === IMP.header ? ' selected' : '') + '>Row ' + (i + 1) + ': ' + lcEsc_(r.filter(Boolean).slice(0, 3).join(', ').slice(0, 50)) + '</option>').join('') + '</select></label>';
  const cols = headers.map((h, i) => {
    const samples = body.map(r => String(r[i] == null ? '' : r[i]).trim()).filter(Boolean).slice(0, 3);
    return '<tr><td><b>' + lcEsc_(h || 'Column ' + (i + 1)) + '</b><small>' + lcEsc_(samples.join(' · ').slice(0, 90) || 'empty') + '</small></td>' +
      '<td><select class="lc-input' + (IMP.map[i] ? ' set' : '') + '" data-imp-col="' + i + '">' + opts(i) + '</select></td></tr>';
  }).join('');
  const preview = res.contacts.slice(0, 5).map(c => '<tr><td>' + lcEsc_([c.first_name, c.last_name].filter(Boolean).join(' ') || '–') + '</td><td>' + lcEsc_(c.email_norm) +
    '</td><td class="hide-xs">' + lcEsc_(c.phone || '') + '</td><td class="hide-sm">' + lcEsc_(c.address || '') + '</td><td class="hide-sm">' + lcEsc_((c.tags || []).join(', ')) + '</td></tr>').join('');
  return '<div class="lc-imp-row">' + sheetPick + headerPick +
    '<label class="lc-fld"><span>Group</span><select class="lc-input" data-imp-group>' + ['B', 'C'].map(b => '<option value="' + b + '"' + (IMP.group === b ? ' selected' : '') + '>' + LC_SEQ[b] + '</option>').join('') + '</select></label>' +
    '<label class="lc-fld grow"><span>Source</span><input class="lc-input" data-imp-source value="' + lcEsc_(IMP.source) + '" placeholder="Where this list came from"></label></div>' +
    (IMP.saved ? '<div class="lc-hint">' + LC_ICON.check + 'Using the columns you saved for this layout' + (IMP.saved.at ? ' on ' + lcEsc_(lcDay_(IMP.saved.at)) : '') + '.</div>' : '') +
    '<div class="lc-imp-cols"><table class="lc-table"><thead><tr><th>Column in your file</th><th>Goes into</th></tr></thead><tbody>' + cols + '</tbody></table></div>' +
    '<h4 class="lc-imp-sub">How they’ll be saved <small>' + res.contacts.length + ' with an email' +
      (res.skipped.length ? ' · ' + res.skipped.length + ' without a usable email' : '') + (res.duplicates.length ? ' · ' + res.duplicates.length + ' repeated in the file' : '') + '</small></h4>' +
    (preview ? '<div class="lc-card"><table class="lc-table"><thead><tr><th>Name</th><th>Email</th><th class="hide-xs">Phone</th><th class="hide-sm">Address</th><th class="hide-sm">Tags</th></tr></thead><tbody>' + preview + '</tbody></table></div>'
      : '<div class="lc-empty">' + (hasEmail ? 'No rows with an email yet.' : 'Pick which column holds the email.') + '</div>') +
    '<div class="lc-imp-f"><button class="lc-btn" data-imp="back">Back</button><button class="lc-btn primary" data-imp="check"' + (hasEmail && res.contacts.length ? '' : ' disabled') + '>' +
    (IMP.busy ? 'Checking…' : 'Check ' + res.contacts.length + ' contacts') + '</button></div>';
}

// Repeats and possible repeats: what to do with each, like copying files into a folder.
const IMP_CHOICES = { existing: [['skip', 'Skip'], ['merge', 'Fill in blanks'], ['replace', 'Use the new details']],
  same_person: [['skip', 'Skip'], ['merge', 'Merge (add this email)'], ['replace', 'Use the new details'], ['keep_both', 'Keep both']],
  possible_duplicate: [['skip', 'Skip'], ['merge', 'Merge (add this email)'], ['replace', 'Use the new details'], ['keep_both', 'Keep both']] };
const IMP_WHY = { same_email: 'same email', same_inbox: 'same Gmail inbox', same_person: 'same name and street', similar_name: 'similar name, same address', same_household: 'same address', possible_duplicate: 'possible duplicate' };
const impChoice_ = r => IMP.choice[r.row] || 'skip';
function impStepCheck_() {
  const c = IMP.check, s = c.summary || {}, local = c.local;
  const keep = c.rows.filter(r => IMP_CHOICES[r.status] && impChoice_(r) === 'keep_both').length;
  const fold = c.rows.filter(r => IMP_CHOICES[r.status] && /^(merge|replace)$/.test(impChoice_(r))).length;
  const adding = (s.new || 0) + keep;
  const group = (status) => {
    const rows = c.rows.filter(r => r.status === status);
    if (!rows.length) return '';
    const v = IMP_VERDICT[status], opts = IMP_CHOICES[status];
    const all = opts ? '<span class="lc-imp-all">For all: <select class="lc-input sm" data-imp-all="' + status + '"><option value="">Choose…</option>' +
      opts.map(([k, l]) => '<option value="' + k + '">' + l + '</option>').join('') + '</select></span>' : '';
    return '<details class="lc-verdict"' + (status === 'new' || (opts && status !== 'existing') ? ' open' : '') + '><summary>' + lcTag_(v[0], v[1]) + '<b class="num">' + rows.length + '</b>' + all + '</summary><ul>' +
      rows.slice(0, 200).map(r => {
        const was = r.clean && r.clean.changed && (r.clean.changed.includes('first_name') || r.clean.changed.includes('last_name')) ? ' <small class="lc-dim">(tidied)</small>' : '';
        const kind = r.clean && r.clean.kind && r.clean.kind !== 'person' ? ' ' + lcTag_(r.clean.kind === 'couple' ? 'Couple' : r.clean.kind === 'family' ? 'Family' : 'Business', '') : '';
        const m = r.match;
        const match = m ? '<div class="lc-imp-match"><span>Looks like</span> <b>' + lcEsc_(m.name || m.email) + '</b> · ' + lcEsc_(m.email || '') + (m.address ? ' · ' + lcEsc_(m.address) : '') +
          ' <em>' + lcEsc_(IMP_WHY[m.reason] || m.reason) + (m.in_file ? ', row ' + m.row + ' of this file' : '') + '</em></div>' : '';
        const pick = opts ? '<select class="lc-input sm" data-imp-choice="' + r.row + '">' +
          opts.filter(([k]) => !(m && m.in_file && /^(merge|replace)$/.test(k))).map(([k, l]) => '<option value="' + k + '"' + (impChoice_(r) === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' : '';
        return '<li><div class="lc-imp-li"><span>' + lcEsc_([r.first_name, r.last_name].filter(Boolean).join(' ') || '–') + was + kind + '</span><small>' + lcEsc_(r.email_norm) +
          (r.reason ? ' · ' + lcEsc_(r.reason) : '') + (r.note ? ' · ' + lcEsc_(r.note) : '') + ' · row ' + r.row + '</small>' + match + '</div>' + pick + '</li>';
      }).join('') + (rows.length > 200 ? '<li><small>and ' + (rows.length - 200) + ' more</small></li>' : '') + '</ul></details>';
  };
  const fileIssues = (local.skipped.length || local.duplicates.length) ? '<details class="lc-verdict"><summary>' + lcTag_('Not in the check', '') + '<b class="num">' + (local.skipped.length + local.duplicates.length) + '</b></summary><ul>' +
    local.skipped.map(x => '<li><span>Row ' + x.row + '</span><small>' + (x.reason === 'no_email' ? 'no email' : 'email not valid: ' + lcEsc_(x.detail)) + '</small></li>').join('') +
    local.duplicates.map(x => '<li><span>Row ' + x.row + '</span><small>same email as row ' + x.first_row + ' (' + lcEsc_(x.email) + ')</small></li>').join('') + '</ul></details>' : '';
  return (c.tidied ? '<div class="lc-hint">' + LC_ICON.check + c.tidied + ' name' + (c.tidied === 1 ? '' : 's') + ' tidied (capitals, couples, families, phone numbers)' + (c.ai ? ', ' + c.ai + ' sorted by the AI check' : '') + '. The original is kept.</div>' : '') +
    ['new', 'possible_duplicate', 'same_person', 'existing', 'customer', 'opted_out', 'do_not_contact'].map(group).join('') + fileIssues +
    '<p class="lc-note">They go to <b>Needs review</b>. Nobody is emailed by an import; you start them in batches.' + (s.do_not_contact ? ' People marked do-not-contact are added to the opt-out list.' : '') + '</p>' +
    '<label class="lc-check"><input type="checkbox" data-imp-remember' + (IMP.remember !== false ? ' checked' : '') + '> Remember these columns for files like this</label>' +
    '<div class="lc-imp-f"><button class="lc-btn" data-imp="back">Back</button><button class="lc-btn primary" data-imp="import"' + (adding || fold || s.do_not_contact ? '' : ' disabled') + '>Import ' + adding + ' contact' + (adding === 1 ? '' : 's') + (fold ? ' · update ' + fold : '') + '</button></div>';
}

function impStepImport_() {
  if (IMP.done) {
    const d = IMP.done;
    return '<div class="lc-ok big"><span class="dot">' + LC_ICON.check + '</span><div><b>' + d.added + ' added to Needs review</b><small>' +
      [d.merged ? d.merged + ' existing contact' + (d.merged === 1 ? '' : 's') + ' updated' : '', d.skipped ? d.skipped + ' already there' : '', d.dnc ? d.dnc + ' added to the opt-out list' : '', d.failed ? d.failed + ' couldn’t be saved, try again' : ''].filter(Boolean).join(' · ') +
      '</small></div></div><div class="lc-imp-f"><span></span><button class="lc-btn primary" data-imp="close">Done</button></div>';
  }
  const p = IMP.progress || { sent: 0, total: 1 };
  return '<div class="lc-prog"><div class="lc-prog-bar"><i style="width:' + Math.round(100 * p.sent / Math.max(1, p.total)) + '%"></i></div><small>Saving ' + p.sent + ' of ' + p.total + '…</small></div>';
}

// ── Actions ──────────────────────────────────────────────────────────────────
async function impCheck_() {
  const local = impContacts_();
  IMP.busy = true; impRender_();
  const r = await impPost_({ stage: 'check', group: IMP.group, contacts: local.contacts }).catch(() => ({ ok: false, error: 'Network error' }));
  IMP.busy = false;
  if (!r.ok) { impRender_(); return lcToast_(r.error || 'The check didn’t work', true); }
  IMP.check = { rows: r.rows, summary: r.summary, tidied: r.tidied || 0, ai: r.ai || 0, local };
  IMP.include = new Set(); IMP.choice = {}; IMP.step = 3; impRender_();
}
async function impImport_() {
  const local = IMP.check.local;
  const allowed = new Set(IMP.check.rows.filter(r => r.status === 'new' || r.status === 'do_not_contact' || (IMP_CHOICES[r.status] && impChoice_(r) !== 'skip')).map(r => r.row));
  const rows = local.contacts.filter(c => allowed.has(c.row));
  IMP.step = 4; IMP.busy = true; IMP.progress = { sent: 0, total: rows.length }; impRender_();
  const done = { added: 0, skipped: 0, dnc: 0, failed: 0, merged: 0 };
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const res = {}; chunk.forEach(c => { if (IMP.choice[c.row]) res[c.row] = IMP.choice[c.row]; });
    const r = await impPost_({ stage: 'save', group: IMP.group, source: IMP.source, contacts: chunk, resolutions: res }).catch(() => ({ ok: false }));
    if (r.ok) { done.merged += r.merged || 0; done.added += r.added || 0; done.skipped += (r.skipped || []).length; done.dnc += r.do_not_contact_recorded || 0; } else done.failed += chunk.length;
    IMP.progress.sent = Math.min(rows.length, i + chunk.length); impRender_();
  }
  if (IMP.remember !== false) {
    impPost_({ stage: 'save_mapping', key: MCPS_CONTACT_IMPORT.mappingKey(IMP.rows[IMP.header] || []), mapping: IMP.map, source: IMP.source }).catch(() => {});
  }
  IMP.busy = false; IMP.done = done; impRender_();
}

function impOnClick_(e) {
  const t = e.target.closest('[data-imp]');
  if (!t) { if (e.target.classList.contains('lc-sheet-scrim')) impClose_(); return; }
  const a = t.dataset.imp;
  if (a === 'close') impClose_();
  else if (a === 'back') { IMP.step = Math.max(1, IMP.step - 1); impRender_(); }
  else if (a === 'paste') {
    const text = IMP.layer.querySelector('[data-imp-paste]').value;
    if (!text.trim()) return lcToast_('Paste some rows first', true);
    IMP.file = 'pasted rows'; IMP.sheets = null; impUseRows_(MCPS_CONTACT_IMPORT.parseDelimited(text));
  }
  else if (a === 'check') impCheck_();
  else if (a === 'import') impImport_();
}
function impOnChange_(e) {
  const t = e.target;
  if (t.matches('[data-imp-file]') && t.files[0]) impReadFile_(t.files[0]);
  else if (t.matches('[data-imp-sheet]')) { IMP.sheet = t.value; impUseRows_(IMP.sheets[IMP.sheet]); }
  else if (t.matches('[data-imp-header]')) { IMP.header = Number(t.value); impSuggest_(); impRender_(); }
  else if (t.matches('[data-imp-col]')) {
    const i = t.dataset.impCol, f = t.value;
    // One column per field (except tags/notes, which can combine).
    if (f && !['tags', 'notes'].includes(f)) Object.keys(IMP.map).forEach(k => { if (k !== i && IMP.map[k] === f) delete IMP.map[k]; });
    if (f) IMP.map[i] = f; else delete IMP.map[i];
    IMP.saved = null; impRender_();
  }
  else if (t.matches('[data-imp-group]')) { IMP.group = t.value; impRender_(); }
  else if (t.matches('[data-imp-choice]')) { IMP.choice[Number(t.dataset.impChoice)] = t.value; impRender_(); }
  else if (t.matches('[data-imp-all]') && t.value) { IMP.check.rows.filter(r => r.status === t.dataset.impAll).forEach(r => { if (!(r.match && r.match.in_file && /^(merge|replace)$/.test(t.value))) IMP.choice[r.row] = t.value; }); impRender_(); }
  else if (t.matches('[data-imp-include]')) { const r = Number(t.dataset.impInclude); if (t.checked) IMP.include.add(r); else IMP.include.delete(r); impRender_(); }
  else if (t.matches('[data-imp-remember]')) IMP.remember = t.checked;
}
function impOnInput_(e) {
  if (e.target.matches('[data-imp-source]')) { IMP.source = e.target.value; IMP.sourceTouched = true; }
}
