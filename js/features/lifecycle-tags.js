// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE EMAIL → Contacts: tags (PLAN.md → CP7 "Contact tags editing").
// Tags are labels you choose ("vip", "spa", "2019 build") used to filter the
// list, pick people for a batch or a single email. Lower case, comma-separated
// in the engine's Contacts.tags column (edited with update_contacts).
//   · a person's drawer: add and remove their tags
//   · the Contacts list: filter by tag, tick people, add or remove a tag for all of them
// Shares helpers with js/features/lifecycle.js and lifecycle-cleanup.js (clnApi_).
// ══════════════════════════════════════════════════════════════════════════════

const TAGS = { sel: new Set(), filter: '' };
const tagNorm_ = t => String(t || '').toLowerCase().replace(/[,|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
const tagContacts_ = () => (LC.contacts && LC.contacts.contacts) || [];
// Every tag in use, most used first.
function tagAll_() {
  const n = {};
  tagContacts_().forEach(c => (c.tags || []).forEach(t => { n[t] = (n[t] || 0) + 1; }));
  return Object.entries(n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
const tagDatalist_ = () => '<datalist id="lc-tag-list">' + tagAll_().map(([t]) => '<option value="' + lcEsc_(t) + '">').join('') + '</datalist>';
function tagChip_(t, removable, id) {
  return '<span class="lc-tagchip">' + lcEsc_(t) + (removable ? '<button data-act="tag-rm" data-id="' + lcEsc_(id) + '" data-key="' + lcEsc_(t) + '" aria-label="Remove tag ' + lcEsc_(t) + '">' + LC_ICON.x + '</button>' : '') + '</span>';
}

// Saves new tag lists ({contact_id: [tags]}) 300 at a time, then updates the page's copy.
async function tagSave_(lists) {
  const ids = Object.keys(lists);
  let done = 0;
  for (let i = 0; i < ids.length; i += 300) {
    const changes = ids.slice(i, i + 300).map(id => ({ contact_id: id, fields: { tags: lists[id].join(',') } }));
    const r = await clnApi_('POST', { stage: 'update', changes }).catch(() => ({ ok: false, error: 'Network error' }));
    if (!r.ok) { lcToast_((done ? done + ' saved, then: ' : '') + (r.error || 'That didn’t work'), true); return false; }
    done += changes.length;
  }
  ids.forEach(id => { const c = tagContacts_().find(x => x.contact_id === id); if (c) c.tags = lists[id]; });
  if (LC.drawer && LC.drawer.kind === 'contact' && lists[LC.drawer.id] && LC.drawer.data) LC.drawer.data.contact.tags = lists[LC.drawer.id];
  return true;
}

// ── A person's drawer ─────────────────────────────────────────────────────────
function tagSection_(c) {
  const can = lcCan_('edit_contacts'), tags = c.tags || [];
  return '<div class="lc-sec"><h4>Tags</h4><div class="lc-tagrow">' + (tags.length ? tags.map(t => tagChip_(t, can, c.contact_id)).join('') : '<span class="lc-dim">No tags</span>') + '</div>' +
    (can ? '<form class="lc-tagadd" data-tag-add="' + lcEsc_(c.contact_id) + '"><input class="lc-input sm" list="lc-tag-list" maxlength="40" placeholder="Add a tag" aria-label="Add a tag">' +
      '<button class="lc-btn sm" type="submit">Add</button>' + tagDatalist_() + '</form>' : '') + '</div>';
}
async function tagAddOne_(id, raw) {
  const t = tagNorm_(raw); if (!t) return;
  const c = tagContacts_().find(x => x.contact_id === id) || (LC.drawer && LC.drawer.data && LC.drawer.data.contact);
  const cur = (c && c.tags) || [];
  if (cur.includes(t)) return lcToast_('Already tagged “' + t + '”');
  if (await tagSave_({ [id]: cur.concat([t]) })) { lcToast_('Tagged “' + t + '”'); lcRenderDrawer_(); lcRenderBody_(); }
}
async function tagRemoveOne_(id, t) {
  const c = tagContacts_().find(x => x.contact_id === id) || (LC.drawer && LC.drawer.data && LC.drawer.data.contact);
  if (await tagSave_({ [id]: ((c && c.tags) || []).filter(x => x !== t) })) { lcToast_('Removed “' + t + '”'); lcRenderDrawer_(); lcRenderBody_(); }
}

// ── The Contacts list ─────────────────────────────────────────────────────────
function tagFilterBar_() {
  const all = tagAll_();
  if (!all.length) return '';
  return '<div class="lc-tagfilter"><span>Tags</span>' + all.slice(0, 30).map(([t, n]) => '<button class="lc-chip' + (TAGS.filter === t ? ' on' : '') + '" data-act="tag-filter" data-key="' + lcEsc_(t) + '">' +
    lcEsc_(t) + ' <small>' + n + '</small></button>').join('') + '</div>';
}
const tagMatches_ = c => !TAGS.filter || (c.tags || []).includes(TAGS.filter);
function tagBulkBar_(rows) {
  if (!lcCan_('edit_contacts') || !TAGS.sel.size) return '';
  const n = TAGS.sel.size, visible = rows.filter(c => TAGS.sel.has(c.contact_id)).length;
  return '<div class="lc-bulk"><b>' + n + ' selected</b>' + (visible < n ? '<span class="lc-dim">(' + (n - visible) + ' not shown)</span>' : '') +
    '<form class="lc-tagadd" data-tag-bulk><input class="lc-input sm" list="lc-tag-list" maxlength="40" placeholder="Tag" aria-label="Tag for the selected people">' + tagDatalist_() +
    '<button class="lc-btn sm primary" type="submit" data-v="add">Add tag</button><button class="lc-btn sm" type="submit" data-v="remove">Remove tag</button></form>' +
    '<button class="lc-link" data-act="tag-clear">Clear selection</button></div>';
}
async function tagBulk_(raw, how) {
  const t = tagNorm_(raw); if (!t) return lcToast_('Type a tag first', true);
  const lists = {};
  TAGS.sel.forEach(id => {
    const c = tagContacts_().find(x => x.contact_id === id); if (!c) return;
    const cur = c.tags || [], has = cur.includes(t);
    if (how === 'add' && !has) lists[id] = cur.concat([t]);
    if (how === 'remove' && has) lists[id] = cur.filter(x => x !== t);
  });
  const n = Object.keys(lists).length;
  if (!n) return lcToast_(how === 'add' ? 'They all have “' + t + '” already' : 'None of them has “' + t + '”');
  if (await tagSave_(lists)) { lcToast_((how === 'add' ? 'Tagged ' : 'Removed “' + t + '” from ') + n + (n === 1 ? ' person' : ' people') + (how === 'add' ? ' “' + t + '”' : '')); lcRenderBody_(); }
}

// Clicks with data-act="tag-…" (lifecycle.js → lcDispatch_), and the add forms.
function tagAct_(t) {
  const a = t.dataset.act;
  if (a === 'tag-rm') return tagRemoveOne_(t.dataset.id, t.dataset.key);
  if (a === 'tag-filter') { TAGS.filter = TAGS.filter === t.dataset.key ? '' : t.dataset.key; return lcRenderBody_(); }
  if (a === 'tag-clear') { TAGS.sel.clear(); return lcRenderBody_(); }
  if (a === 'tag-sel') { const id = t.dataset.id; if (TAGS.sel.has(id)) TAGS.sel.delete(id); else TAGS.sel.add(id); return lcRenderBody_(); }
  if (a === 'tag-selall') {
    const ids = JSON.parse(t.dataset.ids || '[]'), all = ids.every(id => TAGS.sel.has(id));
    ids.forEach(id => all ? TAGS.sel.delete(id) : TAGS.sel.add(id));
    return lcRenderBody_();
  }
}
// Forms submit (Enter or a button); the button pressed says add or remove.
document.addEventListener('submit', e => {
  const f = e.target;
  if (!f.matches || !(f.matches('[data-tag-add]') || f.matches('[data-tag-bulk]'))) return;
  e.preventDefault();
  const input = f.querySelector('input'), how = (e.submitter && e.submitter.dataset.v) || 'add';
  const btn = e.submitter || f.querySelector('button');
  const key = 'tag-form:' + (f.dataset.tagAdd || 'bulk');
  lcGuard_(key, btn, () => (f.matches('[data-tag-add]') ? tagAddOne_(f.dataset.tagAdd, input.value) : tagBulk_(input.value, how)));
});
