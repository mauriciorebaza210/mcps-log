// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE EMAIL → Contacts → Clean up (PLAN.md → "Contact cleanup and duplicates").
//   Names: what the rules would tidy (capitals, couples, families, businesses,
//     phones, places), names left for the AI check, and email warnings; apply selected.
//   Possible duplicates: two contacts side by side with the four choices of a
//     file-copy dialog: Keep both · Keep left · Keep right · Merge into left.
// API: /api/email?op=clean (GET scan; POST ai | apply_names | resolve).
// Shares helpers with js/features/lifecycle.js.
// ══════════════════════════════════════════════════════════════════════════════

const CLN = { layer: null, tab: 'names', data: null, pick: {}, ai: {}, emailFix: {}, decide: {}, busy: false };
const CLN_KIND = { couple: 'Couple', family: 'Family', business: 'Business' };
const CLN_WHY = { same_email: 'Same email', same_inbox: 'Same Gmail inbox', same_person: 'Same name and street', similar_name: 'Similar name, same address',
  same_household: 'Same address, different names', possible_duplicate: 'Added by the MCP lead sync as a possible duplicate' };
const CLN_ACTS = [['keep_both', 'Keep both'], ['keep_a', 'Keep left'], ['keep_b', 'Keep right'], ['merge_into_a', 'Merge into left']];

async function clnApi_(method, body) {
  const res = await fetch('/api/email?op=clean', { method, headers: Object.assign({ Authorization: 'Bearer ' + currentSessionToken_() },
    body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const out = await res.json().catch(() => ({}));
  if (!res.ok && !out.error) out.error = 'HTTP ' + res.status;
  return out;
}
function clnOpen_(tab) {
  const layer = document.createElement('div');
  layer.className = 'lc-layer';
  layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim" data-cln="close"></div><section class="lc-imp" role="dialog" aria-modal="true" aria-label="Clean up contacts"></section>';
  document.body.appendChild(layer);
  Object.assign(CLN, { layer, tab: tab || 'names', data: null, pick: {}, ai: {}, emailFix: {}, decide: {}, busy: false });
  layer.addEventListener('click', clnOnClick_);
  layer.addEventListener('change', clnOnChange_);
  document.addEventListener('keydown', clnKey_);
  clnRender_(); clnLoad_();
}
function clnKey_(e) { if (e.key === 'Escape') clnClose_(); }
function clnClose_(changed) {
  if (!CLN.layer || CLN.busy) return;
  CLN.layer.remove(); CLN.layer = null;
  document.removeEventListener('keydown', clnKey_);
  if (changed) { LC.contacts = null; lcRefresh_(true); }
}
async function clnLoad_() {
  const r = await clnApi_('GET').catch(() => ({ ok: false, error: 'Network error' }));
  CLN.data = r.ok ? r : { error: r.error || 'Couldn’t load', names: [], pairs: [] };
  // Rule-based fixes start ticked; names waiting for the AI don't.
  (CLN.data.names || []).forEach(n => { if (!n.needs_ai && Object.keys(n.after || {}).length) CLN.pick[n.contact_id] = true; });
  clnRender_();
}

// The proposed name (AI answer when there is one, else the rules').
function clnAfter_(n) {
  const a = CLN.ai[n.contact_id];
  if (a) return { first_name: a.first_name, last_name: a.last_name, kind: a.kind };
  // Unclear names keep their words until the AI (or a person) decides how to split them.
  if (n.needs_ai) return { first_name: n.first_name, last_name: n.last_name, kind: n.kind };
  return { first_name: n.after.first_name !== undefined ? n.after.first_name : n.first_name, last_name: n.after.last_name !== undefined ? n.after.last_name : n.last_name, kind: n.kind };
}
function clnFields_(n) {
  const a = clnAfter_(n), f = {};
  if (a.first_name !== n.first_name) f.first_name = a.first_name;
  if (a.last_name !== n.last_name) f.last_name = a.last_name;
  ['phone', 'city', 'address'].forEach(k => { if (n.after[k] !== undefined) f[k] = n.after[k]; });
  if (a.kind && (a.kind !== 'person' || Object.keys(f).length || CLN.ai[n.contact_id])) f.name_kind = a.kind;
  if (CLN.emailFix[n.contact_id]) f.email_norm = CLN.emailFix[n.contact_id];
  return f;
}

function clnRender_() {
  if (!CLN.layer) return;
  const el = CLN.layer.querySelector('.lc-imp'), d = CLN.data;
  const names = (d && d.names) || [], pairs = (d && d.pairs) || [];
  const head = '<header class="lc-imp-h"><div><h2>Clean up contacts</h2><div class="lc-seg" role="tablist">' +
    [['names', 'Names', names.length], ['dupes', 'Possible duplicates', pairs.length]].map(([k, l, n]) => '<button data-cln="tab" data-tab="' + k + '" class="' + (CLN.tab === k ? 'on' : '') + '">' + l +
      (d ? ' <small>' + n + '</small>' : '') + '</button>').join('') + '</div></div><button class="lc-icon-btn" data-cln="close" aria-label="Close">' + LC_ICON.x + '</button></header>';
  if (!d) { el.innerHTML = head + '<div class="lc-imp-body"><div class="lc-sk" style="height:60px"></div><div class="lc-sk" style="height:260px"></div></div>'; return; }
  if (d.error) { el.innerHTML = head + '<div class="lc-imp-body"><div class="lc-wiz-warn">' + LC_ICON.alert + '<div><b>Couldn’t load</b><small>' + lcEsc_(d.error) + '</small></div></div></div>'; return; }
  el.innerHTML = head + '<div class="lc-imp-body">' + (CLN.tab === 'names' ? clnNames_(names, d.ai) : clnPairs_(pairs)) + '</div>';
}

function clnNames_(names, aiOn) {
  if (!names.length) return '<div class="lc-ok big"><span class="dot">' + LC_ICON.check + '</span><div><b>Every name looks tidy</b><small>New imports are tidied as they come in.</small></div></div>';
  const waiting = names.filter(n => n.needs_ai && !CLN.ai[n.contact_id]);
  const aiBar = waiting.length ? '<div class="lc-crm-auto"><div class="main"><b>' + waiting.length + ' name' + (waiting.length === 1 ? '' : 's') + ' the rules can’t settle</b><small>' +
    (aiOn ? 'Like “Mary Ann Smith” or couples with two surnames. A quick AI check (names only, no emails or addresses) suggests how to split them; you still choose.'
      : 'The AI check is off: an ANTHROPIC_API_KEY needs to be added in Vercel. You can still fix these by hand in each contact.') + '</small></div>' +
    (aiOn ? '<button class="lc-btn primary" data-cln="ai"' + (CLN.busy ? ' disabled' : '') + '>' + (CLN.busy ? 'Checking…' : 'Check with AI') + '</button>' : '') + '</div>' : '';
  const rows = names.map(n => {
    const a = clnAfter_(n), changed = Object.keys(clnFields_(n)).length;
    const typo = (n.issues || []).find(i => i.kind === 'typo'), role = (n.issues || []).some(i => i.kind === 'role');
    // How it reads in an email: a family's greeting already carries the surname.
    const before = [n.first_name, n.last_name].filter(Boolean).join(' ') || '–';
    const after = (a.kind === 'family' || a.kind === 'business' ? (a.first_name || a.last_name) : [a.first_name, a.last_name].filter(Boolean).join(' ')) || '(no name: greeted as “there”)';
    const nameMoved = (a.first_name !== n.first_name || a.last_name !== n.last_name) && after !== before;
    const extra = ['phone', 'city', 'address'].filter(k => n.after[k] !== undefined).map(k => '<small>' + lcEsc_(n[k]) + ' → <b>' + lcEsc_(n.after[k]) + '</b></small>').join('');
    return '<li class="lc-cln-row"><label class="lc-cln-pick"><input type="checkbox" data-cln-pick="' + lcEsc_(n.contact_id) + '"' + (CLN.pick[n.contact_id] ? ' checked' : '') + (changed ? '' : ' disabled') + '></label>' +
      '<div class="main"><div class="lc-cln-names"><span class="was">' + lcEsc_(before) + '</span>' + (nameMoved ? '<span class="arrow">→</span><b>' + lcEsc_(after) + '</b>' : '') +
      (CLN_KIND[a.kind] ? lcTag_(CLN_KIND[a.kind], a.kind === 'business' ? 'warn' : '') : '') + (CLN.ai[n.contact_id] ? lcTag_('AI', 'teal') : n.needs_ai ? lcTag_('Unclear', '') : '') + '</div>' + extra +
      '<small class="lc-dim">' + lcEsc_(n.email) + '</small>' +
      (typo ? '<label class="lc-cln-fix"><input type="checkbox" data-cln-email="' + lcEsc_(n.contact_id) + '" data-to="' + lcEsc_(typo.suggestion) + '"' + (CLN.emailFix[n.contact_id] ? ' checked' : '') + '> Email looks mistyped: use <b>' + lcEsc_(typo.suggestion) + '</b></label>' : '') +
      (role ? '<small class="lc-cln-warn">' + LC_ICON.alert + 'A shared address (like info@ or office@): it may not reach a person.</small>' : '') +
      (a.kind === 'business' ? '<small class="lc-cln-warn">' + LC_ICON.alert + 'Looks like a business, not a homeowner.</small>' : '') + '</div></li>';
  }).join('');
  const n = names.filter(x => CLN.pick[x.contact_id] && Object.keys(clnFields_(x)).length).length;
  return aiBar + '<ul class="lc-list lc-cln-list">' + rows + '</ul><p class="lc-note">Only names typed in all capitals or all lower case are re-cased. The original name is kept, so any change can be undone.</p>' +
    '<div class="lc-imp-f"><button class="lc-btn" data-cln="all">' + (n ? 'Clear all' : 'Select all') + '</button><button class="lc-btn primary" data-cln="apply"' + (n && !CLN.busy ? '' : ' disabled') + '>' +
    (CLN.busy ? 'Saving…' : 'Apply ' + n + ' change' + (n === 1 ? '' : 's')) + '</button></div>';
}

function clnPairs_(pairs) {
  if (!pairs.length) return '<div class="lc-ok big"><span class="dot">' + LC_ICON.check + '</span><div><b>No possible duplicates</b><small>New imports are checked for repeats as they come in.</small></div></div>';
  const card = c => '<div class="lc-cln-card"><b>' + lcEsc_(c.name || '–') + '</b><small>' + lcEsc_(c.email) + '</small>' + (c.address ? '<small>' + lcEsc_(c.address) + (c.city ? ', ' + lcEsc_(c.city) : '') + '</small>' : '') +
    (c.phone ? '<small>' + lcEsc_(c.phone) + '</small>' : '') + '<small class="lc-dim">' + lcEsc_(LC_SEQ[c.bucket] || '') + (c.status === 'possible_duplicate' ? ' · flagged' : '') + '</small></div>';
  const kinds = [...new Set(pairs.map(p => p.reason))];
  const all = '<div class="lc-imp-all">For every pair of a kind: ' + kinds.map(k => '<label>' + lcEsc_(CLN_WHY[k] || k) + ' <select class="lc-input sm" data-cln-all="' + k + '"><option value="">Choose…</option>' +
    CLN_ACTS.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('') + '</select></label>').join('') + '</div>';
  const rows = pairs.map((p, i) => '<li class="lc-cln-pair"><div class="why">' + lcTag_(CLN_WHY[p.reason] || p.reason, p.confidence === 'high' ? 'warn' : '') + '</div>' +
    '<div class="sides">' + card(p.a) + card(p.b) + '</div><div class="lc-seg">' + CLN_ACTS.map(([v, l]) => '<button data-cln="decide" data-i="' + i + '" data-v="' + v + '" class="' + (CLN.decide[i] === v ? 'on' : '') + '">' + l + '</button>').join('') +
    '</div></li>').join('');
  const n = Object.keys(CLN.decide).length;
  return all + '<ul class="lc-list lc-cln-list">' + rows + '</ul><p class="lc-note"><b>Merge</b> keeps the left contact and adds the right one’s email as an alternate (blank details are filled in). <b>Keep both</b> means they’re different people; they won’t be flagged again.</p>' +
    '<div class="lc-imp-f"><span class="lc-dim">' + n + ' of ' + pairs.length + ' decided</span><button class="lc-btn primary" data-cln="resolve"' + (n && !CLN.busy ? '' : ' disabled') + '>' + (CLN.busy ? 'Saving…' : 'Apply ' + n + ' decision' + (n === 1 ? '' : 's')) + '</button></div>';
}

async function clnOnClick_(e) {
  const t = e.target.closest('[data-cln]'); if (!t) return;
  const a = t.dataset.cln, d = CLN.data;
  if (a === 'close') return clnClose_(CLN.changed);
  if (a === 'tab') { CLN.tab = t.dataset.tab; return clnRender_(); }
  if (a === 'all') { const names = (d && d.names) || [], any = names.some(n => CLN.pick[n.contact_id]); names.forEach(n => { CLN.pick[n.contact_id] = !any && Object.keys(clnFields_(n)).length > 0; }); return clnRender_(); }
  if (a === 'decide') { const i = Number(t.dataset.i); CLN.decide[i] = CLN.decide[i] === t.dataset.v ? undefined : t.dataset.v; if (!CLN.decide[i]) delete CLN.decide[i]; return clnRender_(); }
  if (a === 'ai') {
    const ids = d.names.filter(n => n.needs_ai && !CLN.ai[n.contact_id]).map(n => n.contact_id);
    CLN.busy = true; clnRender_();
    const r = await clnApi_('POST', { stage: 'ai', contact_ids: ids }).catch(() => ({ ok: false, error: 'Network error' }));
    CLN.busy = false;
    if (!r.ok) { lcToast_(r.error || 'The AI check didn’t work', true); return clnRender_(); }
    r.suggestions.forEach(s => { CLN.ai[s.contact_id] = s; CLN.pick[s.contact_id] = true; });
    lcToast_(r.suggestions.length + ' of ' + ids.length + ' names sorted by the AI' + (r.suggestions.length < ids.length ? '; the rest stay as they are' : ''));
    return clnRender_();
  }
  if (a === 'apply') {
    const changes = d.names.filter(n => CLN.pick[n.contact_id]).map(n => ({ contact_id: n.contact_id, fields: clnFields_(n) })).filter(c => Object.keys(c.fields).length);
    CLN.busy = true; clnRender_();
    const r = await clnApi_('POST', { stage: 'apply_names', changes }).catch(() => ({ ok: false, error: 'Network error' }));
    CLN.busy = false;
    if (!r.ok) { lcToast_(r.error || 'That didn’t work', true); return clnRender_(); }
    lcToast_(r.updated + ' contact' + (r.updated === 1 ? '' : 's') + ' tidied');
    CLN.changed = true; CLN.data = null; CLN.pick = {}; CLN.ai = {}; CLN.emailFix = {}; clnRender_(); return clnLoad_();
  }
  if (a === 'resolve') {
    const pairs = Object.entries(CLN.decide).map(([i, v]) => ({ a: d.pairs[i].a.contact_id, b: d.pairs[i].b.contact_id, action: v }));
    const removing = pairs.filter(p => p.action !== 'keep_both').length;
    if (removing && !await lcConfirm_({ title: 'Apply ' + pairs.length + ' decision' + (pairs.length === 1 ? '' : 's') + '?', ok: 'Apply',
      body: removing + ' contact' + (removing === 1 ? '' : 's') + ' will be merged or removed. Anyone removed stops getting emails; opt-outs still apply by email.' })) return;
    CLN.busy = true; clnRender_();
    const r = await clnApi_('POST', { stage: 'resolve', pairs }).catch(() => ({ ok: false, error: 'Network error' }));
    CLN.busy = false;
    if (!r.ok) { lcToast_(r.error || 'That didn’t work', true); return clnRender_(); }
    lcToast_(r.resolved + ' resolved');
    CLN.changed = true; CLN.data = null; CLN.decide = {}; clnRender_(); return clnLoad_();
  }
}
function clnOnChange_(e) {
  const t = e.target;
  if (t.matches('[data-cln-pick]')) { CLN.pick[t.dataset.clnPick] = t.checked; clnRender_(); }
  else if (t.matches('[data-cln-email]')) { if (t.checked) { CLN.emailFix[t.dataset.clnEmail] = t.dataset.to; CLN.pick[t.dataset.clnEmail] = true; } else delete CLN.emailFix[t.dataset.clnEmail]; clnRender_(); }
  else if (t.matches('[data-cln-all]') && t.value) { (CLN.data.pairs || []).forEach((p, i) => { if (p.reason === t.dataset.clnAll) CLN.decide[i] = t.value; }); clnRender_(); }
}
