// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE EMAIL → Campaigns → Single emails (PLAN.md → "Single email" sequence type).
// One email on one day to a list picked now: Details (name, day, time) → People
// (campaign group, area and tag filters, untick anyone) → Review → create, then
// write the email in the editor. It sends only once its email is approved.
// Engine: Singles.js (create_single / update_single / cancel_single).
// Shares helpers with js/features/lifecycle.js, lifecycle-batches.js, lifecycle-campaigns.js.
// ══════════════════════════════════════════════════════════════════════════════

const SGL = { layer: null };
const SGL_STEPS = [['details', 'Details'], ['people', 'People'], ['review', 'Review']];
const sglIsSingle_ = id => /^S[0-9A-F]{6}$/.test(String(id || ''));

// Single emails in the current rules, newest day first, with their step.
function sglList_() {
  const ov = LC.ov; if (!ov) return [];
  return (ov.sequences || []).filter(q => q.kind === 'single').map(q => ({ seq: q, step: ov.steps.find(s => s.bucket === q.sequence_id) }))
    .filter(x => x.step).sort((a, b) => String(b.step.timing.date).localeCompare(String(a.step.timing.date)));
}
// Names for single emails wherever the page shows a sequence's name.
function sglNames_(ov) { ((ov && ov.sequences) || []).forEach(q => { if (q.kind === 'single') LC_SEQ[q.sequence_id] = q.name; }); }
function sglState_(x) {
  const s = x.step, c = s.counts || {}, today = batToday_();
  if (s.status === 'off') return ['Cancelled', ''];
  if (!s.published) return ['Needs its email approved', 'warn'];
  if (c.sent && c.sent >= (s.enrolled || 0)) return ['Sent', 'live'];
  if (s.timing.date > today) return ['Scheduled', 'teal'];
  return [c.sent ? 'Sending · ' + c.sent + ' of ' + s.enrolled : 'Sends today', 'live'];
}
function sglWhen_(s) {
  const d = s.timing.date ? new Date(s.timing.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
  const t = (sglTimeOf_(s.bucket) && lcClock_(sglTimeOf_(s.bucket))) || '';
  return d + (t ? ', ' + t : '');
}
// The send time lives on each person's enrollment; the page keeps what it set (and the contacts view knows it).
function sglTimeOf_(seqId) {
  const st = ((LC.ov && LC.ov.single_times) || {})[seqId];
  return st || '';
}

// ── Campaigns tab: the cards ──────────────────────────────────────────────────
function sglSection_() {
  const list = sglList_(), can = lcCan_('edit_contacts');
  if (!list.length && !can) return '';
  const cards = list.map(x => {
    const s = x.step, st = sglState_(x);
    return '<article class="lc-cmp-card lc-sgl-card' + (s.status === 'off' ? ' off' : '') + '"><button class="lc-cmp-open" data-act="step" data-id="' + lcEsc_(s.step_id) + '" aria-label="Open ' + lcEsc_(s.name) + '"></button>' +
      '<header><span class="lc-bkt lc-sgl-ic">' + CMP_ICON.mail + '</span><div class="grow"><h2>' + lcEsc_(s.name) + '</h2><small>' + lcEsc_(sglWhen_(s)) + '</small></div>' + lcTag_(st[0], st[1]) + '</header>' +
      '<div class="lc-sgl-nums"><div><b>' + (s.enrolled || 0) + '</b><span>People</span></div><div><b>' + ((s.counts || {}).sent || 0) + '</b><span>Sent</span></div>' +
      '<div><b>' + (((s.tracking || {}).verified_clicks) || 0) + '</b><span>Verified clicks</span></div><div><b>' + (((s.tracking || {}).replied) || 0) + '</b><span>Replies</span></div></div></article>';
  }).join('');
  return '<section class="lc-sgl"><div class="lc-sgl-h"><div><h2>Single emails</h2><small>One email, one day, to a list you pick. Separate from the sequences.</small></div>' +
    (can ? '<button class="lc-btn sm primary" data-act="sgl-new">' + CMP_ICON.plus + 'New single email</button>' : '') + '</div>' +
    (cards ? '<div class="lc-cmp-grid">' + cards + '</div>' : '<div class="lc-empty" style="text-align:left">None yet. Use it for one-off news: holiday hours, a seasonal offer, a service change.</div>') + '</section>';
}

// ── New single email ──────────────────────────────────────────────────────────
function sglOpen_() {
  if (SGL.layer) return;
  const tomorrow = batAddDays_(batToday_(), 1);
  Object.assign(SGL, { step: 'details', name: '', date: tomorrow, time: lcSendTime_('B'), group: 'B', filters: { area: [], tags: [] }, off: new Set(), busy: false });
  const layer = document.createElement('div');
  layer.className = 'lc-layer';
  layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim" data-sgl="close"></div><section class="lc-imp lc-wiz" role="dialog" aria-modal="true" aria-label="New single email"></section>';
  document.body.appendChild(layer);
  SGL.layer = layer;
  layer.addEventListener('click', sglOnClick_);
  layer.addEventListener('input', sglOnInput_);
  layer.addEventListener('change', sglOnInput_);
  document.addEventListener('keydown', sglOnKey_);
  if (!LC.contacts) lcLoadContacts_();
  sglRender_();
}
function sglClose_() {
  if (!SGL.layer || SGL.busy) return;
  SGL.layer.remove(); SGL.layer = null;
  document.removeEventListener('keydown', sglOnKey_);
}
function sglOnKey_(e) { if (e.key === 'Escape' && !document.querySelector('.lc-sheet')) sglClose_(); }

// Who can get it: confirmed people in the engine's current mode (test mode: test contacts only).
function sglPool_() {
  const test = !LC.ov || LC.ov.engine.mode !== 'production';
  return batAll_().filter(c => c.review_status === 'confirmed' && (test ? batIsTest_(c) : !batIsTest_(c)) &&
    (SGL.group === 'all' || c.bucket === SGL.group));
}
function sglMatches_() {
  const f = SGL.filters;
  return sglPool_().filter(c => (!f.area.length || f.area.includes(c.area)) && (!f.tags.length || (c.tags || []).some(t => f.tags.includes(t))));
}
const sglPicked_ = () => sglMatches_().filter(c => !SGL.off.has(c.contact_id));
const sglName_ = c => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.contact_id;

function sglRender_() {
  if (!SGL.layer) return;
  const at = SGL_STEPS.findIndex(s => s[0] === SGL.step), last = at === SGL_STEPS.length - 1;
  const n = sglPicked_().length, okDetails = SGL.name.trim() && SGL.date >= batToday_() && SGL.time;
  const canNext = SGL.step === 'details' ? okDetails : n > 0;
  const body = !LC.contacts ? '<div class="lc-sk" style="height:240px"></div>' : SGL.step === 'details' ? sglDetails_() : SGL.step === 'people' ? sglPeople_() : sglReview_();
  SGL.layer.querySelector('.lc-imp').innerHTML = '<header class="lc-imp-h"><div><h2>New single email</h2><ol class="lc-steps">' +
    SGL_STEPS.map(([k, l], i) => '<li class="' + (i < at ? 'done' : i === at ? 'on' : '') + '"><span>' + (i < at ? LC_ICON.check : i + 1) + '</span>' + l + '</li>').join('') + '</ol></div>' +
    '<button class="lc-icon-btn" data-sgl="close" aria-label="Close"' + (SGL.busy ? ' disabled' : '') + '>' + LC_ICON.x + '</button></header>' +
    '<div class="lc-imp-body">' + body + '<div class="lc-imp-f"><button class="lc-btn" data-sgl="' + (at ? 'back' : 'close') + '">' + (at ? 'Back' : 'Cancel') + '</button>' +
    '<div class="lc-wiz-sum">' + (SGL.step !== 'details' && n ? n + (n === 1 ? ' person' : ' people') : '') + '</div>' +
    (last ? '<button class="lc-btn primary" data-sgl="create"' + (n ? '' : ' disabled') + '>Schedule it and write the email</button>'
      : '<button class="lc-btn primary" data-sgl="next"' + (canNext ? '' : ' disabled') + '>Next</button>') + '</div></div>';
}
function sglDetails_() {
  return '<div class="lc-imp-row"><label class="lc-fld grow"><span>Name (only you see it)</span><input class="lc-input" data-sgl-in="name" maxlength="80" value="' + lcEsc_(SGL.name) + '" placeholder="e.g. Holiday hours 2026"></label></div>' +
    '<div class="lc-imp-row"><label class="lc-fld"><span>Day</span><input class="lc-input" type="date" min="' + batToday_() + '" value="' + SGL.date + '" data-sgl-in="date"></label>' +
    '<label class="lc-fld"><span>Send time</span><select class="lc-input" data-sgl-in="time" style="width:200px">' + cmpTimeOptions_(SGL.time) + '</select></label></div>' +
    '<p class="lc-note">You write the email after this step. It goes out only once its email is approved, on this day at this time (' + lcEsc_(lcZoneOn_(SGL.date)) + '). ' +
    'Each person gets at most one lifecycle email a day, so someone already getting another email that day gets this one the next day.</p>';
}
function sglPeople_() {
  const pool = sglPool_(), m = sglMatches_(), test = LC.ov && LC.ov.engine.mode !== 'production';
  const count = (key, val) => pool.filter(c => key === 'tags' ? (c.tags || []).includes(val) : c[key] === val).length;
  const opts = key => [...new Set(pool.flatMap(c => key === 'tags' ? (c.tags || []) : [c[key]]).filter(Boolean))].sort();
  const chips = (key, label) => { const o = opts(key); return o.length ? '<div class="lc-fld"><span>' + label + '</span><div class="lc-chips">' + o.map(v =>
    '<button class="lc-chip' + (SGL.filters[key].includes(v) ? ' on' : '') + '" data-sgl="chip" data-key="' + key + '" data-val="' + lcEsc_(v) + '">' + lcEsc_(v) + ' <small>' + count(key, v) + '</small></button>').join('') + '</div></div>' : ''; };
  const seg = [['B', 'MCP Legacy'], ['C', 'MCP Startup'], ['Z', 'Staff'], ['all', 'Everyone']].map(([k, l]) => '<button data-sgl="group" data-v="' + k + '" class="' + (SGL.group === k ? 'on' : '') + '">' + l + '</button>').join('');
  const rows = m.slice(0, 300).map(c => '<li><label class="lc-check"><input type="checkbox" data-sgl-pick="' + lcEsc_(c.contact_id) + '"' + (SGL.off.has(c.contact_id) ? '' : ' checked') + '><span><b>' + lcEsc_(sglName_(c)) +
    '</b> <small class="lc-dim">' + lcEsc_([LC_SEQ[c.bucket], c.area].filter(Boolean).join(' · ')) + '</small></span></label></li>').join('');
  return (test ? '<div class="lc-wiz-warn">' + LC_ICON.alert + '<div><b>Test mode</b><small>Only test contacts can get it until the engine goes live.</small></div></div>' : '') +
    '<div class="lc-imp-row"><div class="lc-fld"><span>From</span><div class="lc-seg">' + seg + '</div></div></div>' + chips('area', 'Area') + chips('tags', 'Tags') +
    '<div class="lc-fld"><span>' + m.length + ' match · untick anyone to leave them out</span></div>' +
    (m.length ? '<ul class="lc-list lc-sgl-people">' + rows + '</ul>' + (m.length > 300 ? '<p class="lc-note">Showing the first 300; all ' + m.length + ' are included unless left out.</p>' : '')
      : '<div class="lc-empty" style="text-align:left">Nobody matches. Only confirmed contacts can get it; people waiting in Needs review can’t.</div>') +
    '<p class="lc-note">Unsubscribed people are skipped automatically when it sends.</p>';
}
function sglReview_() {
  const n = sglPicked_().length, cap = 80, days = Math.max(1, Math.ceil(n / cap));
  const day = new Date(SGL.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return '<dl class="lc-kv lc-sgl-rev"><dt>Name</dt><dd>' + lcEsc_(SGL.name) + '</dd><dt>Sends</dt><dd>' + lcEsc_(day) + ' at ' + lcEsc_(lcClock_(SGL.time)) + ' ' + lcEsc_(lcZoneOn_(SGL.date)) + '</dd>' +
    '<dt>To</dt><dd>' + n + (n === 1 ? ' person' : ' people') + (days > 1 ? ' <span class="lc-dim">· about ' + days + ' days to reach everyone (Tony’s account sends about ' + cap + ' a day)</span>' : '') + '</dd>' +
    '<dt>From</dt><dd>' + lcEsc_((LC.ov && LC.ov.engine.sender_name) || 'Tony') + '’s email address</dd></dl>' +
    '<div class="lc-wiz-warn info">' + LC_ICON.check + '<div><b>Next: write the email</b><small>The editor opens right after this. It sends only once the email is approved.</small></div></div>';
}
function sglOnInput_(e) {
  const t = e.target;
  if (t.dataset.sglIn) { SGL[t.dataset.sglIn] = t.value; if (e.type === 'change' || t.dataset.sglIn !== 'name') sglRender_(); else sglFooter_(); }
  else if (t.dataset.sglPick && e.type === 'change') { if (t.checked) SGL.off.delete(t.dataset.sglPick); else SGL.off.add(t.dataset.sglPick); sglFooter_(); }
}
// Typing the name or ticking people updates the footer only, so focus and scroll stay put.
function sglFooter_() {
  const n = sglPicked_().length, sum = SGL.layer.querySelector('.lc-wiz-sum'), next = SGL.layer.querySelector('[data-sgl="next"],[data-sgl="create"]');
  if (sum) sum.textContent = SGL.step !== 'details' && n ? n + (n === 1 ? ' person' : ' people') : '';
  if (next) next.disabled = SGL.step === 'details' ? !(SGL.name.trim() && SGL.date >= batToday_() && SGL.time) : !n;
}
function sglOnClick_(e) {
  const t = e.target.closest('[data-sgl]'); if (!t || t.disabled) return;
  const a = t.dataset.sgl, order = SGL_STEPS.map(s => s[0]);
  if (a === 'close') sglClose_();
  else if (a === 'next') { SGL.step = order[Math.min(order.indexOf(SGL.step) + 1, order.length - 1)]; sglRender_(); }
  else if (a === 'back') { SGL.step = order[Math.max(order.indexOf(SGL.step) - 1, 0)]; sglRender_(); }
  else if (a === 'group') { SGL.group = t.dataset.v; SGL.filters = { area: [], tags: [] }; SGL.off = new Set(); sglRender_(); }
  else if (a === 'chip') { const l = SGL.filters[t.dataset.key], v = t.dataset.val, i = l.indexOf(v); if (i === -1) l.push(v); else l.splice(i, 1); sglRender_(); }
  else if (a === 'create') sglCreate_(t);
}
async function sglCreate_(btn) {
  if (SGL.busy) return;
  const ids = sglPicked_().map(c => c.contact_id);
  SGL.busy = true; lcBusyBtn_(btn, true);
  const r = await lcAdmin_('create_single', { name: SGL.name.trim(), date: SGL.date, send_time: SGL.time, contact_ids: ids }).catch(() => ({ ok: false, error: 'Network error' }));
  SGL.busy = false; lcBusyBtn_(btn, false);
  if (!r.ok) return lcToast_(r.error === 'unknown action' ? 'The engine needs an update before single emails can be made.' : (r.error || 'That didn’t work'), true);
  sglClose_();
  lcToast_(r.count + (r.count === 1 ? ' person' : ' people') + ' lined up' + ((r.skipped || []).length ? ' · ' + r.skipped.length + ' skipped' : '') + '. Now write the email.');
  // Fresh rules (the new email), then its drawer with the editor open.
  const data = await lcFetch_('overview', { mode: LC.mode || '', fresh: '1' }).catch(() => null);
  if (data) { LC.ov = data; sglNames_(data); lcRender_(); }
  lcOpenDrawer_('step', r.step_id);
  const wait = setInterval(() => { if (LC.drawer && LC.drawer.data) { clearInterval(wait); LC.drawer.tab = 'templates'; lcRenderDrawer_(); edOpen_(''); } }, 150);
  setTimeout(() => clearInterval(wait), 15000);
}

// ── The drawer's Setup tab for a single email ─────────────────────────────────
function sglSetupTab_(D) {
  const s = D.data.step, can = lcCan_('edit_contacts'), sent = (s.counts || {}).sent || 0, off = s.status === 'off';
  if (D.sgl) {
    return '<div class="lc-sec"><h4>Change it</h4><div class="lc-imp-row">' +
      '<label class="lc-fld grow"><span>Name</span><input class="lc-input" data-sgl-edit="name" maxlength="80" value="' + lcEsc_(D.sgl.name) + '"></label></div>' +
      '<div class="lc-imp-row" style="margin-top:10px"><label class="lc-fld"><span>Day</span><input class="lc-input" type="date" min="' + batToday_() + '" value="' + lcEsc_(D.sgl.date) + '" data-sgl-edit="date"' + (sent ? ' disabled' : '') + '></label>' +
      '<label class="lc-fld"><span>Send time</span><select class="lc-input" data-sgl-edit="time" style="width:180px">' + cmpTimeOptions_(D.sgl.time, D.sgl.time ? '' : '<option value="" selected>Keep as is</option>') + '</select></label></div>' +
      (sent ? '<p class="lc-note">It has started sending, so the day can’t change.</p>' : '') + '</div>' +
      '<div class="lc-imp-f"><button class="lc-btn" data-act="sgl-setup" data-do="cancel-edit">Cancel</button><button class="lc-btn primary" data-act="sgl-setup" data-do="save">Save</button></div>';
  }
  return (off ? '<div class="lc-wiz-warn">' + LC_ICON.alert + '<div><b>Cancelled</b><small>' + (sent ? sent + ' had already gone out; nobody else gets it.' : 'Nobody gets it.') + '</small></div></div>' : '') +
    '<div class="lc-sec"><h4 style="display:flex;align-items:center">Sends' + (can && !off ? '<button class="lc-btn sm" data-act="sgl-setup" data-do="edit" style="margin-left:auto">Edit</button>' : '') + '</h4>' +
    '<dl class="lc-kv"><dt>When</dt><dd>' + lcEsc_(sglWhen_(s) || s.timing.date) + '</dd><dt>To</dt><dd>' + (s.enrolled || 0) + ' people, picked when it was made</dd>' +
    '<dt>Spread</dt><dd>Up to ' + (s.timing.window_days || 3) + ' days if the daily limit is reached</dd><dt>Type</dt><dd>Marketing (unsubscribes are respected)</dd></dl></div>' +
    (can && !off ? '<div class="lc-sec"><h4>Cancel</h4><p class="lc-note" style="margin-top:0">Stops it for everyone who hasn’t got it yet.</p><button class="lc-btn danger" data-act="sgl-setup" data-do="cancel">Cancel this email</button></div>' : '');
}
async function sglSetupAct_(t) {
  const D = LC.drawer; if (!D || !D.data) return;
  const s = D.data.step, what = t.dataset.do;
  if (what === 'edit') { D.sgl = { name: s.name, date: s.timing.date, time: sglTimeOf_(s.bucket) }; return lcRenderDrawer_(); }
  if (what === 'cancel-edit') { D.sgl = null; return lcRenderDrawer_(); }
  if (what === 'save') {
    const el = k => D.layer.querySelector('[data-sgl-edit="' + k + '"]');
    const p = { sequence_id: s.bucket };
    const name = el('name').value.trim(), date = el('date').value, time = el('time').value;
    if (name && name !== s.name) p.name = name;
    if (date && date !== s.timing.date && !el('date').disabled) p.date = date;
    if (time && time !== D.sgl.time) p.send_time = time;
    if (Object.keys(p).length === 1) { D.sgl = null; lcRenderDrawer_(); return lcToast_('Nothing changed'); }
    const r = await lcAdmin_('update_single', p).catch(() => ({ ok: false, error: 'Network error' }));
    if (!r.ok) return lcToast_(r.error || 'That didn’t work', true);
    if (p.send_time) LC.ov.single_times = Object.assign({}, LC.ov.single_times, { [s.bucket]: p.send_time });
    D.sgl = null; lcToast_('Saved');
    return sglAfter_(D);
  }
  if (what === 'cancel') {
    const r = await lcConfirm_({ title: 'Cancel “' + s.name + '”?', ok: 'Cancel email', danger: true,
      body: 'Nobody who hasn’t got it yet will get it. This can’t be undone; make a new single email to send it later.',
      run: () => lcAdmin_('cancel_single', { sequence_id: s.bucket }) });
    if (!r) return;
    lcToast_('Cancelled' + (r.stopped ? ' · ' + r.stopped + ' won’t get it' : ''));
    return sglAfter_(D);
  }
}
function sglAfter_(D) {
  lcRefresh_(true);
  return lcFetch_('step', { id: D.id, mode: LC.mode || '', fresh: '1' }).then(data => { if (LC.drawer === D) { D.data = data; lcRenderDrawer_(); } }).catch(() => {});
}
