// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE EMAIL → Contacts → Start a batch (CP7a). Starts N people from Needs
// review on a date; several can be lined up ("20 now, 20 on Nov 23, 20 on Nov 30").
// Selection: js/lib/batches.js (MCPS_BATCHES), the same code the engine runs on
// the start date. Writes: /api/email?op=admin create_batch / cancel_batch.
// Shares helpers with js/features/lifecycle.js.
// ══════════════════════════════════════════════════════════════════════════════

const BAT = { layer: null, group: 'B', filters: { area: [], tags: [], source: [] }, count: 20, order: 'random', pick: 'now',
  start_on: '', picked: [], removed: new Set(), seed: 1, busy: false, created: [] };

const batToday_ = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const batAddDays_ = (d, n) => { const t = new Date(d + 'T12:00:00'); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); };
const batDayLabel_ = d => d === batToday_() ? 'today' : new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
function batRandom_(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

function lcOpenBatch_() {
  Object.assign(BAT, { group: LC.bucket || 'B', filters: { area: [], tags: [], source: [] }, count: 20, order: 'random', pick: 'now',
    start_on: batToday_(), removed: new Set(), seed: Date.now() % 2147483646 + 1, busy: false, created: [] });
  const layer = document.createElement('div');
  layer.className = 'lc-layer';
  layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim" data-bat="close"></div><section class="lc-imp" role="dialog" aria-modal="true" aria-label="Start a batch"></section>';
  document.body.appendChild(layer);
  BAT.layer = layer;
  layer.addEventListener('click', batOnClick_);
  layer.addEventListener('change', batOnChange_);
  document.addEventListener('keydown', batOnKey_);
  batRender_();
}
function batClose_() {
  if (!BAT.layer || BAT.busy) return;
  BAT.layer.remove(); BAT.layer = null;
  document.removeEventListener('keydown', batOnKey_);
  if (BAT.created.length) { LC.contacts = null; lcRefresh_(true); }
}
function batOnKey_(e) { if (e.key === 'Escape') batClose_(); }

// People already held by a planned batch (and those this panel just lined up) aren't picked again.
function batExcluded_() {
  const ids = new Set();
  ((LC.contacts && LC.contacts.batches) || []).forEach(b => (b.contact_ids || []).forEach(id => ids.add(id)));
  BAT.created.forEach(b => (b.contact_ids || []).forEach(id => ids.add(id)));
  BAT.removed.forEach(id => ids.add(id));
  return [...ids];
}
function batSpec_() { return { group: BAT.group, filters: BAT.filters, count: BAT.count, order: BAT.order, exclude: batExcluded_() }; }
function batPicked_() {
  return MCPS_BATCHES.pick((LC.contacts && LC.contacts.contacts) || [], batSpec_(), batRandom_(BAT.seed));
}

function batRender_() {
  if (!BAT.layer) return;
  const all = (LC.contacts && LC.contacts.contacts) || [];
  const opts = MCPS_BATCHES.filterOptions(all, BAT.group);
  const pool = MCPS_BATCHES.eligible(all, batSpec_());
  const picked = BAT.pick === 'now' ? batPicked_() : [];
  const n = BAT.pick === 'now' ? picked.length : Math.min(BAT.count, pool.length);
  const chips = (key, label) => opts[key].length ? '<div class="lc-fld"><span>' + label + '</span><div class="lc-chips">' +
    opts[key].map(o => '<button class="lc-chip' + (BAT.filters[key].includes(o.value) ? ' on' : '') + '" data-bat="chip" data-key="' + key + '" data-val="' + lcEsc_(o.value) + '">' +
      lcEsc_(o.value) + ' <small>' + o.count + '</small></button>').join('') + '</div></div>' : '';
  const seg = (name, val, items) => '<div class="lc-seg">' + items.map(([v, l]) => '<button data-bat="set" data-name="' + name + '" data-val="' + v + '" class="' + (val === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
  const done = BAT.created.length ? '<div class="lc-hint">' + LC_ICON.check + BAT.created.map(b => b.count + ' ' + (b.start_on <= batToday_() ? 'started' : 'lined up for ' + batDayLabel_(b.start_on))).join(' · ') + '</div>' : '';
  const list = BAT.pick === 'now' ? (picked.length ? '<div class="lc-card"><table class="lc-table"><tbody>' + picked.map(c => '<tr><td class="lc-fit"><div class="lc-person"><span class="lc-avatar">' +
      lcEsc_(lcInitials_(c.first_name, c.last_name)) + '</span><div><b>' + lcEsc_([c.first_name, c.last_name].filter(Boolean).join(' ') || c.email) + '</b><small>' + lcEsc_(c.email) +
      (c.area ? ' · ' + lcEsc_(c.area) : '') + '</small></div></div></td><td class="r"><button class="lc-icon-btn" data-bat="remove" data-id="' + lcEsc_(c.contact_id) + '" aria-label="Leave out" title="Leave out">' + LC_ICON.x + '</button></td></tr>').join('') +
      '</tbody></table></div>' : '<div class="lc-empty">No one waiting matches these filters.</div>')
    : '<p class="lc-note">The ' + n + ' people are chosen on ' + lcEsc_(batDayLabel_(BAT.start_on)) + ' from whoever is still waiting then.</p>';
  BAT.layer.querySelector('.lc-imp').innerHTML = '<header class="lc-imp-h"><div><h2>Start a batch</h2><small class="lc-sub">' + pool.length + ' waiting in Needs review match</small></div>' +
    '<button class="lc-icon-btn" data-bat="close" aria-label="Close"' + (BAT.busy ? ' disabled' : '') + '>' + LC_ICON.x + '</button></header><div class="lc-imp-body">' + done +
    '<div class="lc-imp-row"><div class="lc-fld"><span>Group</span>' + seg('group', BAT.group, [['B', 'MCP Legacy'], ['C', 'MCP Startup']]) + '</div>' +
    '<label class="lc-fld"><span>How many</span><input class="lc-input" type="number" min="1" max="500" value="' + BAT.count + '" data-bat-count style="width:110px"></label>' +
    '<div class="lc-fld"><span>Order</span>' + seg('order', BAT.order, [['random', 'Random'], ['oldest', 'Oldest first']]) + '</div>' +
    '<label class="lc-fld"><span>Start on</span><input class="lc-input" type="date" min="' + batToday_() + '" value="' + BAT.start_on + '" data-bat-date></label>' +
    '<div class="lc-fld"><span>People</span>' + seg('pick', BAT.pick, [['now', 'Pick now'], ['at_start', 'Pick on that day']]) + '</div></div>' +
    chips('area', 'Area') + chips('tags', 'Tags') + chips('source', 'Source') +
    (BAT.pick === 'now' && BAT.order === 'random' && pool.length > n ? '<div><button class="lc-btn sm" data-bat="shuffle">' + LC_ICON.refresh + 'Pick others</button></div>' : '') + list +
    '<div class="lc-imp-f"><button class="lc-btn" data-bat="close">' + (BAT.created.length ? 'Done' : 'Cancel') + '</button><div style="display:flex;gap:8px">' +
    (BAT.created.length ? '' : '') + '<button class="lc-btn primary" data-bat="create"' + (n && !BAT.busy ? '' : ' disabled') + '>' +
    (BAT.busy ? 'Saving…' : (BAT.start_on <= batToday_() ? 'Start ' + n + ' now' : 'Line up ' + n + ' for ' + batDayLabel_(BAT.start_on))) + '</button></div></div></div>';
}

async function batCreate_() {
  const picked = BAT.pick === 'now' ? batPicked_() : [];
  const params = { group: BAT.group, filters: BAT.filters, order: BAT.order, pick: BAT.pick, start_on: BAT.start_on,
    count: BAT.pick === 'now' ? picked.length : BAT.count, contact_ids: picked.map(c => c.contact_id) };
  if (BAT.start_on <= batToday_() && !await lcConfirm_({ title: 'Start ' + params.count + ' now?', ok: 'Start',
    body: 'They leave Needs review and their first email goes out on the next run.' })) return;
  BAT.busy = true; batRender_();
  const r = await lcAdmin_('create_batch', params).catch(() => ({ ok: false, error: 'Network error' }));
  BAT.busy = false;
  if (!r.ok) { batRender_(); return lcToast_(r.error || 'That didn’t work', true); }
  BAT.created.push({ count: params.count, start_on: BAT.start_on, contact_ids: params.contact_ids });
  lcToast_(BAT.start_on <= batToday_() ? params.count + ' started' : params.count + ' lined up for ' + batDayLabel_(BAT.start_on));
  // Ready for the next one: same choices, a week later, without the people just picked.
  BAT.start_on = batAddDays_(BAT.start_on, 7); BAT.removed = new Set(); BAT.seed = (BAT.seed * 48271) % 2147483647;
  batRender_();
}

function batOnClick_(e) {
  const t = e.target.closest('[data-bat]'); if (!t) return;
  const a = t.dataset.bat;
  if (a === 'close') batClose_();
  else if (a === 'set') { BAT[t.dataset.name] = t.dataset.val; if (t.dataset.name === 'group') BAT.filters = { area: [], tags: [], source: [] }; batRender_(); }
  else if (a === 'chip') { const list = BAT.filters[t.dataset.key], v = t.dataset.val, i = list.indexOf(v); if (i === -1) list.push(v); else list.splice(i, 1); batRender_(); }
  else if (a === 'remove') { BAT.removed.add(t.dataset.id); batRender_(); }
  else if (a === 'shuffle') { BAT.seed = (BAT.seed * 48271) % 2147483647; batRender_(); }
  else if (a === 'create') batCreate_();
}
function batOnChange_(e) {
  if (e.target.matches('[data-bat-count]')) { BAT.count = Math.max(1, Math.min(500, Number(e.target.value) || 1)); batRender_(); }
  else if (e.target.matches('[data-bat-date]')) { BAT.start_on = e.target.value < batToday_() ? batToday_() : e.target.value; batRender_(); }
}

// The Batches card at the top of Contacts.
function lcBatchesCard_() {
  const list = ((LC.contacts && LC.contacts.batches) || []).filter(b => b.status !== 'cancelled').slice(0, 8);
  if (!list.length) return '';
  return '<div class="lc-card" style="margin-bottom:14px"><div class="lc-card-h"><h3>Batches</h3></div><ul class="lc-list">' + list.map(b => {
    const f = b.filters || {}, what = [].concat(f.area || [], f.tags || [], f.source || []).join(', ');
    const when = b.status === 'started' ? 'Started ' + batDayLabel_(String(b.started_at).slice(0, 10)) + ' · ' + b.started_count + ' started'
      : 'Starts ' + batDayLabel_(b.start_on) + (b.pick === 'at_start' ? ' · picked that day' : '');
    return '<li><span class="lc-bkt sm">' + lcEsc_(b.group) + '</span><div class="main"><b>' + b.count + ' people' + (what ? ' · ' + lcEsc_(what) : '') + '</b><small>' + lcEsc_(when) +
      ' · ' + (b.order === 'oldest' ? 'oldest first' : 'random') + '</small></div>' +
      (b.status === 'planned' ? lcTag_('Planned', 'warn') + (lcCan_('edit_contacts') ? '<button class="lc-btn sm danger" data-act="cancelbatch" data-id="' + lcEsc_(b.batch_id) + '">Cancel</button>' : '') : lcTag_('Started', 'live')) + '</li>';
  }).join('') + '</ul></div>';
}
