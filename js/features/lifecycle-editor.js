// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE EMAIL → an email's drawer → Templates → Edit: the email editor
// (PLAN.md → "Email editor", Plan changes 2026-11-02 and 2026-11-11).
//
//   Edit text  click any text in the email and type. The frame, images and link
//              targets stay locked; merge fields are chips (insert with "Insert
//              field", delete with Backspace); pasted text arrives as plain text.
//   Edit HTML  the body (and each block, and the details box) as code, with the
//              real email beside it.
//   Preview    the email exactly as it sends, for a chosen sample person.
//
// Every change runs the same renderer the engine sends with (js/lib/email-render.js)
// and lists its problems; Save makes a draft that still needs approval
// (Templates.js → open_editor / save_draft). Nothing here changes a live email.
// Shares helpers with js/features/lifecycle.js and lifecycle-templates.js.
// ══════════════════════════════════════════════════════════════════════════════

const ED = { layer: null };
const ED_TOKEN = /\{\{\s*(block:([A-Za-z0-9_]+)|button:([^|}]+)\|([A-Za-z0-9_]+)|details|([A-Za-z][A-Za-z0-9_]*))\s*\}\}/g;
const ED_BLOCK_NOTE = { PoolSchool: 'only for people with Pool School' };

// Sample people for checks and "Preview as" (never real contacts).
function edSamples_() {
  const t = new Date(Date.now() + 7 * 86400000), startup = t.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const base = { last_name: 'Lopez', address: '118 Cypress Bend, Boerne, TX 78006', startup_date: startup };
  return {
    school: { label: 'Maria (with Pool School)', contact: Object.assign({ first_name: 'Maria', pool_school: 'Y' }, base) },
    noschool: { label: 'Tom (no Pool School)', contact: Object.assign({ first_name: 'Tom', pool_school: 'N' }, base, { last_name: 'Reyes' }) },
    noname: { label: 'No first name on file', contact: Object.assign({ first_name: '', pool_school: 'Y' }, base) }
  };
}
const edFieldLabel_ = f => String(f).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()).replace(/ ([A-Z])/g, (m, c) => ' ' + c.toLowerCase());

// ── Open / close ──────────────────────────────────────────────────────────────
async function edOpen_(revisionId) {
  const D = LC.drawer; if (!D || ED.layer) return;
  const step = (D.data && D.data.step) || {};
  const layer = document.createElement('div');
  layer.className = 'lc-layer';
  layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim"></div><section class="lc-imp lc-ed" role="dialog" aria-modal="true" aria-label="Edit email">' +
    '<header class="lc-imp-h"><div><h2>Edit “' + lcEsc_(step.name || 'email') + '”</h2><small class="lc-sub">Opening…</small></div><button class="lc-icon-btn" data-ed="close" aria-label="Close">' + LC_ICON.x + '</button></header>' +
    '<div class="lc-imp-body"><div class="lc-tpl-loading" role="status"><span class="lc-spinner"></span><div><b>Opening the email</b><small>Getting the current version and its parts.</small></div></div><div class="lc-sk" style="height:50vh"></div></div></section>';
  document.body.appendChild(layer);
  Object.assign(ED, { layer, D, step, stepId: D.id, loading: true, dirty: false, saving: false, mode: 'text', sample: 'school', htmlPart: 'body', errors: [], lastFocus: null });
  layer.addEventListener('click', edOnClick_);
  layer.addEventListener('input', edOnInput_);
  layer.addEventListener('change', edOnChange_);
  layer.addEventListener('focusin', e => { if (e.target.matches('[data-ed-in]')) ED.lastFocus = e.target; });
  document.addEventListener('keydown', edOnKey_, true);
  const r = await lcAdmin_('open_editor', { step_id: D.id, revision_id: revisionId || '' }).catch(() => ({ ok: false, error: 'Network error' }));
  if (ED.layer !== layer) return;
  if (!r.ok) {
    layer.querySelector('.lc-imp-body').innerHTML = '<div class="lc-wiz-warn">' + LC_ICON.alert + '<div><b>Couldn’t open the editor</b><small>' +
      lcEsc_(r.error === 'unknown action' ? 'The engine needs an update before emails can be edited here.' : r.error || '') + '</small></div></div>';
    return;
  }
  const s = r.source;
  Object.assign(ED, { loading: false, src: s, fields: r.fields || [], ctx: Object.assign({ unsubscribeUrl: 'https://example.invalid/unsubscribe' }, r.context || {}),
    library: r.block_library || [], subject: s.subject, preheader: s.preheader, details: s.details_box || '', format: s.format, body: s.body_html,
    blocks: Object.fromEntries((s.blocks || []).map(b => [b.name, b.html])), mode: 'text',
    attLib: r.attachment_library || [], att: new Set(s.attachment_items || []) });
  // The starter isn't a draft yet, so saving it unchanged is still a real step.
  ED.initial = edSnapshot_();
  ED.saved = s.from === 'starter' ? '' : edSnapshot_();
  edRender_();
}
function edSnapshot_() { return JSON.stringify([ED.subject, ED.preheader, ED.details, ED.body, ED.blocks, [...(ED.att || [])].sort()]); }
async function edClose_(force) {
  if (!ED.layer) return;
  if (!force && ED.saving) return;
  if (ED.mode === 'text' && ED.doc) edReadBack_(ED.doc);
  if (!force && !ED.loading && ED.src && edSnapshot_() !== ED.initial &&
    !await lcConfirm_({ title: 'Discard your changes?', ok: 'Discard', danger: true, body: 'Nothing was saved. The email stays as it was.' })) return;
  ED.layer.remove(); ED.layer = null;
  document.removeEventListener('keydown', edOnKey_, true);
}
function edOnKey_(e) {
  if (e.key === 'Escape' && ED.layer && !document.querySelector('.lc-sheet')) { e.stopPropagation(); edClose_(); }
}

// ── Render the sheet ──────────────────────────────────────────────────────────
function edRender_() {
  const L = ED.layer; if (!L) return;
  const s = ED.src, full = ED.format === 'full';
  const from = s.from === 'live' ? 'Starting from the live version' + (s.rev_no ? ' (version ' + s.rev_no + ')' : '')
    : s.from === 'draft' ? 'Editing a draft (saving replaces it)' : s.from === 'starter' ? 'Starting from the MCPS starter draft' : 'Starting from a blank email';
  const seg = [['text', 'Edit text'], ['html', 'Edit HTML'], ['preview', 'Preview']].map(([k, l]) =>
    '<button data-ed="mode" data-v="' + k + '" class="' + (ED.mode === k ? 'on' : '') + '">' + l + '</button>').join('');
  const fieldOpts = '<option value="">Insert field…</option>' + ED.fields.map(f => '<option value="' + lcEsc_(f.field) + '">' + lcEsc_(edFieldLabel_(f.field)) +
    (f.fallback ? ' (if empty: “' + lcEsc_(f.fallback) + '”)' : f.required ? ' (required)' : '') + '</option>').join('') +
    // Links go in an href (HTML mode). {{QuoteLink}} is the tracked service request form: a request stops the emails.
    (ED.mode === 'html' && full ? '<optgroup label="Links (put inside href=&quot;…&quot;)"><option value="QuoteLink">Service request form (tracked)</option><option value="UnsubscribeLink">Unsubscribe</option></optgroup>' : '');
  const samples = edSamples_();
  const asOpts = Object.entries(samples).map(([k, v]) => '<option value="' + k + '"' + (ED.sample === k ? ' selected' : '') + '>' + lcEsc_(v.label) + '</option>').join('');
  L.querySelector('.lc-ed').innerHTML =
    '<header class="lc-imp-h"><div><h2>Edit “' + lcEsc_(ED.step.name || 'email') + '”</h2><small class="lc-sub">' + lcEsc_(from) + ' · ' + (full ? 'full template' : 'MCPS frame') + '</small></div>' +
      '<button class="lc-icon-btn" data-ed="close" aria-label="Close">' + LC_ICON.x + '</button></header>' +
    '<div class="lc-ed-meta">' +
      '<label class="lc-fld grow"><span>Subject line</span><input class="lc-input" data-ed-in="subject" maxlength="150" value="' + lcEsc_(ED.subject) + '" placeholder="Under 50 characters reads best"></label>' +
      '<label class="lc-fld grow"><span>Preview text <small>(after the subject in the inbox)</small></span><input class="lc-input" data-ed-in="preheader" maxlength="200" value="' + lcEsc_(ED.preheader) + '"></label>' +
    '</div>' + edAttRow_() +
    '<div class="lc-ed-bar"><div class="lc-seg">' + seg + '</div>' +
      (ED.mode !== 'preview' ? '<select class="lc-input sm" data-ed-field aria-label="Insert a field">' + fieldOpts + '</select>' : '') +
      (ED.mode !== 'text' ? '<label class="lc-ed-as"><span>Preview as</span><select class="lc-input sm" data-ed-sample>' + asOpts + '</select></label>' : '') +
      '<span class="lc-ed-hint">' + lcEsc_(ED.mode === 'text' ? 'Click any text to change it. Fields show as chips.' : ED.mode === 'html' ? (full ? 'Buttons asking for service link to href="{{QuoteLink}}": the click and the request are tracked, and a request stops the emails.' : 'For layout changes. The button already links to the service request form, tracked.') : 'Exactly as it sends, with sample details.') + '</span>' +
    '</div>' +
    '<div class="lc-ed-main ' + ED.mode + '">' + edMain_() + '</div>' +
    '<footer class="lc-ed-f"><div class="lc-ed-status" data-ed-status></div><div class="lc-ed-acts"><button class="lc-btn" data-ed="close">Cancel</button>' +
      '<button class="lc-btn primary" data-ed="save">Save as draft</button></div></footer>';
  edMount_();
  edCheck_();
}
// Attachments it carries (the Attachment Library); a PDF goes out only once its own version is approved.
function edAttRow_() {
  const lib = ED.attLib || [];
  if (!lib.length && !(ED.att && ED.att.size)) return '<div class="lc-ed-att"><span class="lc-ed-attl">' + LC_ICON.clip + 'Attachments</span><span class="lc-dim">None in the library yet (Emails → Attachments).</span></div>';
  return '<div class="lc-ed-att"><span class="lc-ed-attl">' + LC_ICON.clip + 'Attachments</span>' + lib.map(a => '<button class="lc-chip' + (ED.att.has(a.item_id) ? ' on' : '') + '" data-ed="att" data-v="' + lcEsc_(a.item_id) + '" aria-pressed="' + ED.att.has(a.item_id) + '">' +
    lcEsc_(a.name) + (a.published_v ? '' : ' <small>not approved yet</small>') + '</button>').join('') + '</div>';
}
function edMain_() {
  if (ED.mode === 'html') {
    const full = ED.format === 'full';
    const parts = [['body', full ? 'Template' : 'Body']].concat(full ? [] : Object.keys(ED.blocks).map(n => ['block:' + n, n.replace(/([a-z])([A-Z])/g, '$1 $2') + ' block'])).concat(full ? [] : [['details', 'Details box']]);
    const tabs = '<div class="lc-ed-parts">' + parts.map(([k, l]) => '<button data-ed="part" data-v="' + lcEsc_(k) + '" class="' + (ED.htmlPart === k ? 'on' : '') + '">' + lcEsc_(l) + '</button>').join('') + '</div>';
    const note = ED.htmlPart === 'details' ? '<p class="lc-note">One line per row, separated by <b>|</b>. Example: Startup begins: {{StartupDate}}|Pool address: {{Address}}. Leave empty for no box.</p>'
      : ED.htmlPart.startsWith('block:') ? '<p class="lc-note">This block shows only for people whose ' + lcEsc_((ED.library.find(b => 'block:' + b.name === ED.htmlPart) || {}).flag || 'flag') + ' is Y. Place it with {{' + lcEsc_(ED.htmlPart) + '}} in the body.</p>'
      : full ? '' : '<p class="lc-note">Plain tags (h1, h2, p, a, strong, ul) get the MCPS look automatically. {{details}} places the details box, {{button:Label|quote}} a button, {{block:Name}} a block.</p>';
    return '<div class="lc-ed-code">' + tabs + note + '<textarea class="lc-ed-ta" data-ed-in="code" spellcheck="false" wrap="soft">' + lcEsc_(edPartValue_()) + '</textarea></div>' +
      '<div class="lc-ed-view"><iframe class="lc-ed-frame" sandbox="" title="Email preview" data-ed-preview></iframe></div>';
  }
  if (ED.mode === 'preview') return '<div class="lc-ed-view"><iframe class="lc-ed-frame" sandbox="" title="Email preview" data-ed-preview></iframe></div>';
  return '<div class="lc-ed-view"><iframe class="lc-ed-frame" sandbox="allow-same-origin" title="Email editor" data-ed-edit></iframe></div>';
}
function edPartValue_() {
  if (ED.htmlPart === 'details') return ED.details;
  if (ED.htmlPart.startsWith('block:')) return ED.blocks[ED.htmlPart.slice(6)] || '';
  return ED.body;
}
function edMount_() {
  const L = ED.layer;
  const prev = L.querySelector('[data-ed-preview]');
  if (prev) edShowPreview_(prev);
  const ed = L.querySelector('[data-ed-edit]');
  if (ed) edMountEditable_(ed);
}

// ── Checks (the renderer the engine sends with) ───────────────────────────────
function edRenderWith_(contact) {
  return MCPS_EMAIL_RENDER.render({ revision: { subject: ED.subject || '', preheader: ED.preheader || '', details_box: ED.details || '', body_html: ED.body, format: ED.format === 'full' ? 'full' : 'body' },
    blocks: Object.fromEntries(Object.entries(ED.blocks).map(([n, html]) => [n, { flag: (ED.library.find(b => b.name === n) || {}).flag || 'pool_school', html }])),
    fields: ED.fields, contact, context: ED.ctx });
}
function edCheck_() {
  const samples = edSamples_();
  // Problems are checked against every sample, so a field that breaks only for someone without a name still shows.
  const errs = [];
  Object.values(samples).forEach(v => { const r = edRenderWith_(v.contact); (r.errors || []).forEach(e => { if (!errs.includes(e)) errs.push(e); }); });
  if (!String(ED.subject || '').trim() && !errs.includes('subject is empty')) errs.unshift('subject is empty');
  ED.errors = errs;
  const st = ED.layer && ED.layer.querySelector('[data-ed-status]');
  if (st) {
    const changed = ED.saved !== edSnapshot_();
    st.innerHTML = errs.length
      ? '<details class="lc-ed-errs"><summary>' + LC_ICON.alert + errs.length + ' problem' + (errs.length === 1 ? '' : 's') + ' to fix before saving</summary><ul>' +
        errs.map(e => '<li>' + lcEsc_(e.charAt(0).toUpperCase() + e.slice(1)) + '</li>').join('') + '</ul></details>'
      : '<span class="lc-ed-ok">' + LC_ICON.check + (changed ? 'Ready to save. It becomes a draft that needs approval.' : 'No changes yet.') + '</span>';
    const save = ED.layer.querySelector('[data-ed="save"]');
    if (save && !ED.saving) save.disabled = !!errs.length || !changed;
  }
}
let edCheckT_ = 0;
function edChanged_() { clearTimeout(edCheckT_); edCheckT_ = setTimeout(() => { edCheck_(); if (ED.mode === 'html') { const p = ED.layer && ED.layer.querySelector('[data-ed-preview]'); if (p) edShowPreview_(p); } }, 250); }
function edShowPreview_(frame) {
  const r = edRenderWith_(edSamples_()[ED.sample].contact);
  frame.srcdoc = r.ok ? r.html : '<html><body style="font-family:Arial,sans-serif;color:#7A4E0F;background:#FFF8EC;padding:24px;font-size:14px">' +
    '<b>This email can’t be shown yet.</b><ul>' + (r.errors || []).map(e => '<li>' + lcEsc_(e) + '</li>').join('') + '</ul></body></html>';
}

// ── Edit text: the email in an editable frame ─────────────────────────────────
// Tokens become locked islands (chips, button, block, details) so typing can't break them.
const ED_EDIT_CSS = '[data-ee-ui]{}' +
  '.ee-chip{display:inline-block;padding:0 7px;margin:0 1px;border-radius:999px;background:#E3F4F3;color:#0D3D3E;font:600 0.86em/1.6 Arial,sans-serif;border:1px solid #9FD6D3;cursor:default;white-space:nowrap;vertical-align:baseline}' +
  '.ee-chip.bad{background:#FDECEC;color:#B42318;border-color:#F3B4AE}' +
  '.ee-edit{outline:none;border-radius:4px;transition:box-shadow .12s}' +
  '.ee-edit:hover{box-shadow:0 0 0 2px rgba(31,167,168,.25)}' +
  '.ee-edit:focus-within{box-shadow:0 0 0 2px #1FA7A8}' +
  '.ee-island{position:relative;margin:6px 0 16px;border:1px dashed #9FB7B6;border-radius:8px;padding:10px 12px 8px}' +
  '.ee-island-label{position:absolute;top:-9px;left:10px;padding:0 6px;background:#fff;font:700 10.5px/16px Arial,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#5A6A6A}' +
  '.ee-btn{text-align:center;margin:22px 0 8px}' +
  '.ee-btn span{display:inline-block;padding:16px 36px;border-radius:7px;background:#0D3D3E;color:#fff;font:700 16px/1 Montserrat,Arial,sans-serif;outline:none;min-width:40px}' +
  '.ee-btn span:focus{box-shadow:0 0 0 3px #5ED6D3}' +
  '.ee-dline{outline:none;padding:1px 2px;border-radius:3px}.ee-dline:focus{box-shadow:0 0 0 2px #1FA7A8}' +
  'img{pointer-events:none}a{cursor:text}';

function edEditableBody_(doc, html) {
  const box = doc.createElement('div');
  box.innerHTML = html;
  box.querySelectorAll('*').forEach(el => el.setAttribute('data-ee-o', ''));    // originals: Chrome's own spans get unwrapped later
  edTokensToIslands_(doc, box);
  return box;
}
// Replace {{tokens}} in text nodes (never inside attributes) with islands.
function edTokensToIslands_(doc, root) {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
  while (walker.nextNode()) if (/\{\{/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  nodes.forEach(t => {
    const frag = doc.createDocumentFragment(), text = t.nodeValue;
    let last = 0;
    text.replace(ED_TOKEN, (m, all, blk, label, link, field, at) => {
      if (at > last) frag.appendChild(doc.createTextNode(text.slice(last, at)));
      frag.appendChild(edIsland_(doc, { blk, label, link, field, details: all === 'details' }));
      last = at + m.length; return m;
    });
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    t.parentNode.replaceChild(frag, t);
  });
}
function edIsland_(doc, t) {
  const el = doc.createElement(t.field ? 'span' : 'div');
  el.setAttribute('contenteditable', 'false');
  if (t.field) {
    const known = ED.fields.some(f => f.field === t.field);
    el.className = 'ee-chip' + (known ? '' : ' bad'); el.dataset.eeField = t.field; el.textContent = known ? edFieldLabel_(t.field) : '{{' + t.field + '}}';
    el.title = known ? '{{' + t.field + '}}: Backspace removes it; Insert field adds one' : 'Unknown field: delete it and pick one from Insert field';
    return el;
  }
  if (t.blk) {
    el.className = 'ee-island'; el.dataset.eeBlock = t.blk;
    el.innerHTML = '<div class="ee-island-label">' + lcEsc_(t.blk.replace(/([a-z])([A-Z])/g, '$1 $2')) + ' block · ' + lcEsc_(ED_BLOCK_NOTE[t.blk] || 'shown for some people') + '</div>';
    const inner = doc.createElement('div'); inner.className = 'ee-edit'; inner.setAttribute('contenteditable', 'true'); inner.dataset.eeBlockBody = '';
    inner.innerHTML = ED.blocks[t.blk] || '<p>(this block is empty)</p>';
    inner.querySelectorAll('*').forEach(x => x.setAttribute('data-ee-o', ''));
    edTokensToIslands_(doc, inner);
    el.appendChild(inner);
    return el;
  }
  if (t.details) return edDetailsIsland_(doc, true);
  el.className = 'ee-btn'; el.dataset.eeButton = t.link;
  const s = doc.createElement('span'); s.setAttribute('contenteditable', 'true'); s.textContent = t.label.trim(); s.title = 'Button text (the link stays the same)';
  el.appendChild(s);
  return el;
}
function edDetailsIsland_(doc, placed) {
  const el = doc.createElement('div');
  el.setAttribute('contenteditable', 'false'); el.className = 'ee-island'; el.dataset.eeDetails = placed ? 'placed' : 'auto';
  el.style.background = '#F3F5F6';
  el.innerHTML = '<div class="ee-island-label" style="background:#F3F5F6">Details box</div>';
  const lines = String(ED.details || '').split('|').map(l => l.trim()).filter(Boolean);
  (lines.length ? lines : ['']).forEach(l => {
    const d = doc.createElement('div'); d.className = 'ee-dline'; d.setAttribute('contenteditable', 'true'); d.textContent = l;
    d.style.cssText = 'font:15px/1.6 Arial,sans-serif;color:#0D3D3E';
    el.appendChild(d); edTokensToIslands_(doc, d);
  });
  return el;
}

function edMountEditable_(frame) {
  const full = ED.format === 'full';
  const I = MCPS_EMAIL_RENDER.inline || {};
  const tagCss = Object.entries(I).map(([t, css]) => '.ee-root ' + t + '{' + css + '}').join('');
  let html;
  if (full) html = ED.body;
  else {
    const details = String(ED.details || '').trim() && !/\{\{\s*details\s*\}\}/.test(ED.body) ? '<div data-ee-autodetails></div>' : '';
    html = MCPS_EMAIL_RENDER.frame('<div class="ee-root" data-ee-root>[[EE_ROOT]]</div>' + details, ED.ctx, { subject: ED.subject });
  }
  frame.onload = () => {
    const doc = frame.contentDocument; if (!doc) return;
    const style = doc.createElement('style'); style.setAttribute('data-ee-ui', ''); style.textContent = ED_EDIT_CSS + tagCss;
    doc.head.appendChild(style);
    try { doc.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) { /* older engines */ }
    if (full) {
      doc.body.querySelectorAll('*').forEach(el => el.setAttribute('data-ee-o', ''));
      edTokensToIslands_(doc, doc.body);
      edMarkLeaves_(doc);
    } else {
      const root = doc.querySelector('[data-ee-root]');
      const box = edEditableBody_(doc, ED.body);
      root.textContent = '';
      while (box.firstChild) root.appendChild(box.firstChild);
      root.setAttribute('contenteditable', 'true'); root.classList.add('ee-edit');
      const auto = doc.querySelector('[data-ee-autodetails]');
      if (auto) auto.replaceWith(edDetailsIsland_(doc, false));
    }
    doc.addEventListener('input', () => { edReadBack_(doc); edChanged_(); });
    doc.addEventListener('paste', e => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text/plain');
      doc.execCommand('insertText', false, t);
    });
    doc.addEventListener('keydown', e => {
      // One line per row in the details box and in buttons; line breaks inside a full template's cells.
      const tgt = doc.getSelection().anchorNode, el = tgt && (tgt.nodeType === 1 ? tgt : tgt.parentElement);
      if (e.key === 'Enter' && el && (el.closest('.ee-dline') || el.closest('.ee-btn'))) e.preventDefault();
      else if (e.key === 'Enter' && full) { e.preventDefault(); doc.execCommand('insertLineBreak'); }
      if (e.key === 'Escape') { e.preventDefault(); edClose_(); }
    });
    doc.addEventListener('click', e => { if (e.target.closest('a')) e.preventDefault(); });
    doc.addEventListener('focusin', () => { ED.lastFocus = null; });
    ED.doc = doc;
  };
  frame.srcdoc = full ? html : html.replace('[[EE_ROOT]]', '');
}
// Full templates: make the smallest elements that hold text editable, nothing else.
function edMarkLeaves_(doc) {
  const BLOCK = 'p,h1,h2,h3,h4,h5,h6,li,td,th,div,blockquote';
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT), hosts = new Set();
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (!t.nodeValue.trim() || t.parentElement.closest('style,script,title,.ee-chip,[data-ee-ui]')) continue;
    const host = t.parentElement.closest(BLOCK);
    if (host && host !== doc.body) hosts.add(host);
  }
  doc.querySelectorAll('.ee-chip').forEach(c => { const h = c.parentElement.closest(BLOCK); if (h) hosts.add(h); });
  hosts.forEach(h => { if (![...hosts].some(o => o !== h && o.contains(h))) { h.setAttribute('contenteditable', 'true'); h.classList.add('ee-edit'); h.setAttribute('data-ee-host', ''); } });
}

// Editable frame → the template again (tokens back, editor marks off, Chrome's extra spans unwrapped).
function edReadBack_(doc) {
  if (ED.format === 'full') {
    const clone = doc.documentElement.cloneNode(true);
    clone.querySelectorAll('[data-ee-ui]').forEach(n => n.remove());
    edIslandsToTokens_(clone);
    edClean_(clone, true);
    const dt = doc.doctype ? '<!DOCTYPE ' + doc.doctype.name + (doc.doctype.publicId ? ' PUBLIC "' + doc.doctype.publicId + '"' : '') + (doc.doctype.systemId ? ' "' + doc.doctype.systemId + '"' : '') + '>' : '';
    ED.body = dt + clone.outerHTML;
    return;
  }
  const root = doc.querySelector('[data-ee-root]'); if (!root) return;
  const clone = root.cloneNode(true);
  // Details lines (placed in the body or shown after it).
  const det = doc.querySelector('[data-ee-details]');
  if (det) ED.details = [...det.querySelectorAll('.ee-dline')].map(d => { const c = d.cloneNode(true); edIslandsToTokens_(c); return c.textContent.replace(/\|/g, '/').trim(); }).filter(Boolean).join('|');
  // Blocks keep their own HTML; the body keeps {{block:Name}} where they sit.
  clone.querySelectorAll('[data-ee-block]').forEach(b => {
    const inner = b.querySelector('[data-ee-block-body]').cloneNode(true);
    edIslandsToTokens_(inner); edClean_(inner);
    ED.blocks[b.dataset.eeBlock] = inner.innerHTML;
    b.replaceWith(doc.createTextNode('{{block:' + b.dataset.eeBlock + '}}'));
  });
  edIslandsToTokens_(clone);
  edClean_(clone);
  // Blocks and the details box sit on their own lines (the renderer drops a hidden block with its line).
  ED.body = clone.innerHTML.replace(/(\{\{\s*(?:block:[A-Za-z0-9_]+|details)\s*\}\})(?=<)/g, '$1\n').replace(/(>)(\{\{\s*(?:block:|details))/g, '$1\n$2');
}
function edIslandsToTokens_(root) {
  const doc = root.ownerDocument;
  // The spacer typed after an inserted chip (so the caret has somewhere to go).
  const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) if (w.currentNode.nodeValue.indexOf('\u200B') !== -1) w.currentNode.nodeValue = w.currentNode.nodeValue.replace(/\u200B/g, '');
  root.querySelectorAll('.ee-chip').forEach(c => c.replaceWith(doc.createTextNode('{{' + c.dataset.eeField + '}}')));
  root.querySelectorAll('[data-ee-button]').forEach(b => {
    const label = (b.textContent || '').replace(/[|{}]/g, '').replace(/\s+/g, ' ').trim() || 'Button';
    b.replaceWith(doc.createTextNode('{{button:' + label + '|' + b.dataset.eeButton + '}}'));
  });
  root.querySelectorAll('[data-ee-details]').forEach(d => d.dataset.eeDetails === 'placed' ? d.replaceWith(doc.createTextNode('{{details}}')) : d.remove());
}
function edClean_(root, full) {
  // Chrome adds <span style> / <font> when text is merged; those weren't in the email.
  root.querySelectorAll('span:not([data-ee-o]),font').forEach(s => s.replaceWith(...s.childNodes));
  root.querySelectorAll('*').forEach(el => {
    ['contenteditable', 'data-ee-o', 'data-ee-host', 'spellcheck'].forEach(a => el.removeAttribute(a));
    if (el.classList.contains('ee-edit')) { el.classList.remove('ee-edit'); if (!el.classList.length) el.removeAttribute('class'); }
  });
  if (full) return;    // a full template's own layout is never rewritten
  // An empty paragraph Chrome leaves behind after deleting a line.
  root.querySelectorAll('p').forEach(p => { if (!p.textContent.trim() && !p.querySelector('img') && /^(<br>)?$/.test(p.innerHTML)) p.remove(); });
  root.querySelectorAll('div').forEach(d => { if (!d.attributes.length && d.parentElement) { const p = root.ownerDocument.createElement('p'); p.innerHTML = d.innerHTML; d.replaceWith(p); } });
}

// A {{block:Name}} typed into the body brings that block (from the library) along.
function edSyncBlocks_() {
  (ED.body.match(/\{\{\s*block:([A-Za-z0-9_]+)\s*\}\}/g) || []).forEach(m => {
    const name = m.replace(/[{}\s]/g, '').slice(6), lib = ED.library.find(b => b.name === name);
    if (lib && !(name in ED.blocks)) ED.blocks[name] = lib.html;
  });
}
const edUsedBlocks_ = () => Object.entries(ED.blocks).filter(([n]) => new RegExp('\\{\\{\\s*block:' + n + '\\s*\\}\\}').test(ED.body));

// ── Events ────────────────────────────────────────────────────────────────────
function edInsertField_(name) {
  const tok = '{{' + name + '}}';
  if (ED.mode === 'text' && ED.lastFocus == null && ED.doc) {
    const doc = ED.doc, sel = doc.getSelection();
    const host = sel && sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    if (!host || !host.closest('[contenteditable="true"]')) return lcToast_('Click where the field should go first', true);
    const chip = edIsland_(doc, { field: name });
    doc.defaultView.focus();
    doc.execCommand('insertHTML', false, chip.outerHTML + '​');
    edReadBack_(doc); edChanged_();
    return;
  }
  const el = ED.lastFocus;
  if (!el || !el.isConnected) return lcToast_('Click where the field should go first', true);
  const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
  el.value = el.value.slice(0, a) + tok + el.value.slice(b);
  el.focus(); el.setSelectionRange(a + tok.length, a + tok.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function edOnInput_(e) {
  const t = e.target, k = t.dataset.edIn; if (!k) return;
  if (k === 'subject') ED.subject = t.value;
  else if (k === 'preheader') ED.preheader = t.value;
  else if (k === 'code') {
    if (ED.htmlPart === 'details') ED.details = t.value.replace(/\n+/g, '|');
    else if (ED.htmlPart.startsWith('block:')) ED.blocks[ED.htmlPart.slice(6)] = t.value;
    else { ED.body = t.value; edSyncBlocks_(); }
  }
  edChanged_();
}
function edOnChange_(e) {
  const t = e.target;
  if (t.matches('[data-ed-field]') && t.value) { const v = t.value; t.value = ''; edInsertField_(v); }
  else if (t.matches('[data-ed-sample]')) { ED.sample = t.value; const p = ED.layer.querySelector('[data-ed-preview]'); if (p) edShowPreview_(p); }
}
async function edOnClick_(e) {
  const t = e.target.closest('[data-ed]'); if (!t || t.disabled) return;
  const a = t.dataset.ed;
  if (a === 'close') return edClose_();
  if (a === 'mode') { if (ED.mode === 'text' && ED.doc) edReadBack_(ED.doc); ED.mode = t.dataset.v; ED.doc = null; ED.lastFocus = null; return edRender_(); }
  if (a === 'part') { ED.htmlPart = t.dataset.v; ED.lastFocus = null; return edRender_(); }
  if (a === 'att') {
    if (ED.att.has(t.dataset.v)) ED.att.delete(t.dataset.v); else ED.att.add(t.dataset.v);
    t.classList.toggle('on', ED.att.has(t.dataset.v)); t.setAttribute('aria-pressed', ED.att.has(t.dataset.v));
    return edCheck_();
  }
  if (a === 'save') return edSave_(t);
}
// Selecting text in the frame means "insert there", not into the subject box.
document.addEventListener('focusin', e => { if (ED.layer && !e.target.matches('[data-ed-in]') && !e.target.matches('[data-ed-field]')) ED.lastFocus = null; });
async function edSave_(btn) {
  if (ED.saving) return;
  if (ED.mode === 'text' && ED.doc) edReadBack_(ED.doc);
  edCheck_();
  if (ED.errors.length) return lcToast_('Fix the problems first', true);
  ED.saving = true; lcBusyBtn_(btn, true);
  const s = ED.src;
  const r = await lcAdmin_('save_draft', { step_id: ED.stepId, subject: ED.subject.trim(), preheader: ED.preheader.trim(), details_box: ED.format === 'full' ? '' : ED.details,
    body_html: ED.body, blocks: ED.format === 'full' ? [] : edUsedBlocks_().map(([name, html]) => ({ name, html })), attachment_items: [...ED.att], based_on: s.revision_id || '' })
    .catch(() => ({ ok: false, error: 'Network error' }));
  ED.saving = false; lcBusyBtn_(btn, false);
  if (!r.ok) { lcToast_(r.error === 'unknown action' ? 'The engine needs an update before edits can be saved.' : (r.error || 'That didn’t work'), true); return edCheck_(); }
  edClose_(true);
  lcToast_('Saved as a draft. It needs approval before it sends.');
  if (LC.drawer) { LC.drawer.tab = 'templates'; lcTplReload_(); }
}
