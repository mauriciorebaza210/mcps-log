// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE EMAIL → Campaigns → Start a batch: the campaign setup flow (CP7).
// Who (campaign, filters, how many, order) → When (start date, how many batches,
// how far apart, pick now or on the day) → People (the picked list; anyone who
// already had the campaign is marked and named in a warning) → Review → launch.
// Opened from a campaign, its calendar (with the clicked day), or Contacts.
// Selection: js/lib/batches.js (MCPS_BATCHES), the same code the engine runs on
// the start date. Writes: /api/email?op=admin create_batch / cancel_batch.
// Shares helpers with js/features/lifecycle.js.
// ══════════════════════════════════════════════════════════════════════════════

const BAT = { layer: null, step: 'who', group: 'B', filters: { area: [], tags: [], source: [] }, count: 20, order: 'random', pick: 'now',
  start_on: '', send_time: '', batches: 1, every: 7, restart: false, removed: new Set(), seed: 1, busy: false };
const BAT_STEPS = [['who', 'Who'], ['when', 'When'], ['people', 'People'], ['review', 'Review']];
// Restarts: people who finished or stopped the campaign, started again on purpose (people chosen now only).
var LC_RESTART_READY = true;   // engine support: Admin.js restart_ids (cp7-5)

const batToday_ = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const batAddDays_ = (d, n) => { const t = new Date(d + 'T12:00:00'); t.setDate(t.getDate() + n); return t.toLocaleDateString('en-CA'); };
const batDayLabel_ = d => d === batToday_() ? 'today' : new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
function batRandom_(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

function lcOpenBatch_(opts) {
  opts = opts || {};
  // Only MCP Legacy is started in batches; MCP Startup's people come from the portal.
  Object.assign(BAT, { step: 'who', group: 'B', filters: { area: [], tags: [], source: [] },
    count: 20, order: 'random', pick: 'now', start_on: opts.start_on && opts.start_on > batToday_() ? opts.start_on : batToday_(), send_time: '', batches: 1, every: 7,
    restart: false, removed: new Set(), seed: Date.now() % 2147483646 + 1, busy: false });
  const layer = document.createElement('div');
  layer.className = 'lc-layer';
  layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim" data-bat="close"></div><section class="lc-imp lc-wiz" role="dialog" aria-modal="true" aria-label="Start a batch"></section>';
  document.body.appendChild(layer);
  BAT.layer = layer;
  layer.addEventListener('click', batOnClick_);
  layer.addEventListener('change', batOnChange_);
  document.addEventListener('keydown', batOnKey_);
  batRender_();
}
function batClose_(changed) {
  if (!BAT.layer || BAT.busy) return;
  BAT.layer.remove(); BAT.layer = null;
  document.removeEventListener('keydown', batOnKey_);
  if (changed) { LC.contacts = null; lcRefresh_(true); }
}
function batOnKey_(e) { if (e.key === 'Escape') batClose_(); }

// ── Who can be picked ─────────────────────────────────────────────────────────
// People held by a planned batch aren't picked again; people left out by hand neither.
function batExcluded_() {
  const ids = new Set();
  ((LC.contacts && LC.contacts.batches) || []).forEach(b => { if (b.status === 'planned') (b.contact_ids || []).forEach(id => ids.add(id)); });
  BAT.removed.forEach(id => ids.add(id));
  return ids;
}
const batAll_ = () => (LC.contacts && LC.contacts.contacts) || [];
const batIsTest_ = c => c.is_test === true || String(c.is_test || '').toUpperCase() === 'Y';
// Already had this campaign and it ended (stopped or finished): only a person can restart them.
// Restart candidates are shown to MCPS_BATCHES as if waiting, so the shared filters and
// ordering apply to them too; _orig maps them back.
const batAsWaiting_ = c => ({ ...c, review_status: 'needs_review', sequence: null, _orig: c });
const batCanRestart_ = c => c.bucket === BAT.group && !batIsTest_(c) && c.sequence && /^(stopped|completed)$/.test(c.sequence.status);
function batCandidates_() {
  return batAll_().concat(BAT.restart && LC_RESTART_READY ? batAll_().filter(batCanRestart_).map(batAsWaiting_) : []);
}
const batSpecOf_ = count => ({ group: BAT.group, filters: BAT.filters, exclude: [...batExcluded_()], count, order: BAT.order });
function batRestartPool_() {
  return MCPS_BATCHES.eligible(batAll_().filter(batCanRestart_).map(batAsWaiting_), batSpecOf_(0)).map(c => c._orig);
}
function batPool_() { return MCPS_BATCHES.eligible(batCandidates_(), batSpecOf_(0)).map(c => c._orig || c); }
const batTotal_ = () => BAT.count * BAT.batches;
// The batch's send time: its own, else the campaign default.
const batTime_ = () => BAT.send_time || lcSendTime_(BAT.group);
const batNowCT_ = () => new Date().toLocaleTimeString('en-GB', { timeZone: LC_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const batWhenLabel_ = d => (d <= batToday_() ? 'Today' : new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })) +
  ' · ' + lcClock_(batTime_()) + ' ' + lcZoneOn_(d);
// The people, batch by batch (pick now), in the same order the engine would take them.
function batPlan_() {
  const pool = batPool_(), dates = Array.from({ length: BAT.batches }, (_, i) => batAddDays_(BAT.start_on, i * BAT.every));
  let picked = [];
  if (BAT.pick === 'now') picked = MCPS_BATCHES.pick(batCandidates_(), batSpecOf_(batTotal_()), batRandom_(BAT.seed)).map(c => c._orig || c);
  let left = BAT.pick === 'now' ? picked.length : pool.length;
  return dates.map((d, i) => {
    const people = BAT.pick === 'now' ? picked.slice(i * BAT.count, (i + 1) * BAT.count) : [];
    const n = BAT.pick === 'now' ? people.length : Math.min(BAT.count, Math.max(0, left));
    if (BAT.pick !== 'now') left -= n;
    return { start_on: d, people, count: n };
  }).filter(b => b.count > 0);
}
const batRestarting_ = plan => plan.flatMap(b => b.people).filter(c => c.sequence);

// ── Rendering ─────────────────────────────────────────────────────────────────
function batRender_() {
  if (typeof hlpAfterRender_ === 'function') hlpAfterRender_();
  if (!BAT.layer) return;
  const steps = BAT.pick === 'now' ? BAT_STEPS : BAT_STEPS.filter(s => s[0] !== 'people');
  const at = steps.findIndex(s => s[0] === BAT.step);
  const plan = batPlan_();
  const body = BAT.step === 'who' ? batWho_() : BAT.step === 'when' ? batWhen_(plan) : BAT.step === 'people' ? batPeople_(plan) : batReview_(plan);
  const n = plan.reduce((a, b) => a + b.count, 0);
  const last = at === steps.length - 1;
  const startsNow = plan.length && plan[0].start_on <= batToday_();
  const go = !n ? 'No one to start' : startsNow && plan.length === 1 ? 'Start ' + n + ' now'
    : startsNow ? 'Start ' + plan[0].count + ' today · line up ' + (n - plan[0].count)
    : plan.length === 1 ? 'Line up ' + n + ' for ' + batDayLabel_(plan[0].start_on) : 'Line up ' + plan.length + ' batches · ' + n + ' people';
  BAT.layer.querySelector('.lc-imp').innerHTML = '<header class="lc-imp-h"><div><h2>Start a batch · ' + lcEsc_(LC_SEQ[BAT.group] || BAT.group) + '</h2><ol class="lc-steps">' +
    steps.map(([k, l], i) => '<li class="' + (i < at ? 'done' : i === at ? 'on' : '') + '"><span>' + (i < at ? LC_ICON.check : i + 1) + '</span>' + l + '</li>').join('') + '</ol></div>' +
    '<button class="lc-icon-btn" data-bat="close" aria-label="Close"' + (BAT.busy ? ' disabled' : '') + '>' + LC_ICON.x + '</button></header>' +
    '<div class="lc-imp-body">' + body + '<div class="lc-imp-f"><button class="lc-btn" data-bat="' + (at ? 'back' : 'close') + '">' + (at ? 'Back' : 'Cancel') + '</button>' +
    '<div class="lc-wiz-sum">' + (n ? n + (n === 1 ? ' person' : ' people') + (plan.length > 1 ? ' in ' + plan.length + ' batches' : '') : '') + '</div>' +
    (last ? '<button class="lc-btn primary" data-bat="create"' + (n && !BAT.busy ? '' : ' disabled') + '>' + (BAT.busy ? 'Saving…' : lcEsc_(go)) + '</button>'
      : '<button class="lc-btn primary" data-bat="next"' + (n ? '' : ' disabled') + '>Next</button>') + '</div></div>';
}

const batSeg_ = (name, val, items) => '<div class="lc-seg">' + items.map(([v, l]) => '<button data-bat="set" data-name="' + name + '" data-val="' + v + '" class="' + (String(val) === String(v) ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';

function batWho_() {
  const opts = MCPS_BATCHES.filterOptions(batAll_(), BAT.group);
  const chips = (key, label) => opts[key].length ? '<div class="lc-fld"><span>' + label + '</span><div class="lc-chips">' +
    opts[key].map(o => '<button class="lc-chip' + (BAT.filters[key].includes(o.value) ? ' on' : '') + '" data-bat="chip" data-key="' + key + '" data-val="' + lcEsc_(o.value) + '">' +
      lcEsc_(o.value) + ' <small>' + o.count + '</small></button>').join('') + '</div></div>' : '';
  const waiting = MCPS_BATCHES.eligible(batAll_(), { group: BAT.group, filters: BAT.filters, exclude: [...batExcluded_()] }).length;
  const re = LC_RESTART_READY ? batRestartPool_().length : 0;
  return '<div class="lc-wiz-stat"><b>' + waiting + '</b><span>waiting in Needs review' + (Object.values(BAT.filters).some(l => l.length) ? ' match these filters' : '') + '</span>' +
    '<span class="lc-wiz-links"><button class="lc-link" data-bat="crm">MCP leads</button><button class="lc-link" data-bat="import">Import a file</button></span></div>' +
    '<div class="lc-imp-row"><div class="lc-fld"><span>Campaign</span>' + batSeg_('group', BAT.group, [['B', 'MCP Legacy']]) + '</div>' +
    '<label class="lc-fld"><span>People per batch</span><input class="lc-input" type="number" min="1" max="500" value="' + BAT.count + '" data-bat-num="count" style="width:110px"></label>' +
    '<div class="lc-fld"><span>Order</span>' + batSeg_('order', BAT.order, [['random', 'Random'], ['oldest', 'Oldest first']]) + '</div></div>' +
    chips('area', 'Area') + chips('tags', 'Tags') + chips('source', 'Source') +
    (re ? '<label class="lc-wiz-re' + (BAT.restart ? ' on' : '') + '"><input type="checkbox" data-bat-check="restart"' + (BAT.restart ? ' checked' : '') + '><div><b>Also include ' + re + (re === 1 ? ' person' : ' people') +
      ' who already had ' + lcEsc_(LC_SEQ[BAT.group]) + '</b><small>They start again from the first email. You’ll see who before anything is saved.</small></div></label>' : '');
}

function batWhen_(plan) {
  const pool = batPool_().length, short = BAT.pick === 'now' && pool < batTotal_();
  return '<div class="lc-imp-row"><label class="lc-fld"><span>First batch starts</span><input class="lc-input" type="date" min="' + batToday_() + '" value="' + BAT.start_on + '" data-bat-date></label>' +
    '<label class="lc-fld"><span>Send time</span><select class="lc-input" data-bat-time style="width:250px">' +
      cmpTimeOptions_(BAT.send_time, '<option value=""' + (BAT.send_time ? '' : ' selected') + '>Campaign default (' + lcEsc_(lcClock_(lcSendTime_(BAT.group))) + ')</option>') + '</select></label>' +
    '<label class="lc-fld"><span>Batches</span><input class="lc-input" type="number" min="1" max="12" value="' + BAT.batches + '" data-bat-num="batches" style="width:90px"></label>' +
    (BAT.batches > 1 ? '<div class="lc-fld"><span>Every</span>' + batSeg_('every', BAT.every, [[7, 'Week'], [14, '2 weeks'], [30, '30 days']]) + '</div>' : '') +
    '<div class="lc-fld"><span>Choose people</span>' + (BAT.restart ? batSeg_('pick', 'now', [['now', 'Now']]) + '<small class="lc-dim">Restarts need people chosen now</small>' : batSeg_('pick', BAT.pick, [['now', 'Now'], ['at_start', 'On each start day']])) + '</div></div>' +
    '<ol class="lc-wiz-dates">' + plan.map((b, i) => '<li><span class="lc-step">' + (i + 1) + '</span><b>' + lcEsc_(batWhenLabel_(b.start_on)) +
      '</b><span>' + b.count + (b.count === 1 ? ' person' : ' people') + '</span>' + (b.start_on <= batToday_() ? lcTag_(batTime_() <= batNowCT_() ? 'Sends right away' : 'Starts today', 'live') : '') + '</li>').join('') + '</ol>' +
    (short ? '<p class="lc-note">Only ' + pool + ' match, so the last batch is smaller' + (plan.length < BAT.batches ? ' and ' + (BAT.batches - plan.length) + ' would be empty' : '') + '.</p>' : '') +
    (BAT.pick === 'at_start' ? '<p class="lc-note">Each morning a batch starts, the engine picks from whoever is still waiting then, with these filters.</p>' : '');
}

function batPeople_(plan) {
  const restarting = batRestarting_(plan);
  const warn = restarting.length ? '<div class="lc-wiz-warn">' + LC_ICON.alert + '<div><b>' + restarting.length + (restarting.length === 1 ? ' person has' : ' people have') + ' had ' + lcEsc_(LC_SEQ[BAT.group]) + ' before</b>' +
    '<small>' + restarting.slice(0, 6).map(c => lcEsc_(cmpName_(c)) + ' (' + lcEsc_(batHistory_(c)) + ')').join(', ') + (restarting.length > 6 ? ' and ' + (restarting.length - 6) + ' more' : '') + '</small></div></div>' : '';
  const row = c => '<tr><td class="lc-fit"><div class="lc-person"><span class="lc-avatar">' + lcEsc_(lcInitials_(c.first_name, c.last_name)) + '</span><div><b>' + lcEsc_(cmpName_(c)) +
    (c.sequence ? ' <span class="lc-tag warn sm">Restart</span>' : '') + '</b><small>' + lcEsc_(c.email || '') + (c.area ? ' · ' + lcEsc_(c.area) : '') + (c.sequence ? ' · ' + lcEsc_(batHistory_(c)) : '') + '</small></div></div></td>' +
    '<td class="r"><button class="lc-icon-btn" data-bat="remove" data-id="' + lcEsc_(c.contact_id) + '" aria-label="Leave out" title="Leave out">' + LC_ICON.x + '</button></td></tr>';
  return warn + (BAT.order === 'random' && batPool_().length > batTotal_() ? '<div><button class="lc-btn sm" data-bat="shuffle">' + LC_ICON.refresh + 'Pick others</button></div>' : '') +
    plan.map(b => '<div class="lc-imp-sub">' + lcEsc_(batWhenLabel_(b.start_on)) +
      '<small>' + b.count + (b.count === 1 ? ' person' : ' people') + '</small></div><div class="lc-card"><table class="lc-table"><tbody>' + b.people.map(row).join('') + '</tbody></table></div>').join('');
}
function batHistory_(c) {
  const s = c.sequence || {};
  return (s.status === 'completed' ? 'finished' : 'stopped: ' + lcStopWord_(s.stop_reason)) + (c.last_email ? ' · ' + lcDay_(c.last_email.sent_at) : '');
}

function batReview_(plan) {
  const steps = typeof cmpSteps_ === 'function' ? cmpSteps_(BAT.group) : [];
  const chained = steps.length && (steps[0].timing || {}).anchor !== 'startup';
  const restarting = batRestarting_(plan);
  const f = BAT.filters, what = [].concat(f.area, f.tags, f.source).join(', ');
  const emails = b => {
    if (!chained) return 'Emails follow each person’s startup date';
    let d = b.start_on;
    return steps.map((s, i) => { if (i) d = batAddDays_(d, Number((s.timing || {}).offset) || 0); return lcEsc_(s.name) + ' ' + lcEsc_(batDayLabel_(d)); }).join(' → ') + ' · ' + lcEsc_(lcClock_(batTime_()));
  };
  return '<dl class="lc-kv lc-wiz-kv"><dt>Campaign</dt><dd>' + lcEsc_(LC_SEQ[BAT.group]) + '</dd><dt>Who</dt><dd>' + (what ? lcEsc_(what) : 'Everyone waiting') +
    (BAT.restart ? ', plus people who had it before' : '') + ' · ' + (BAT.order === 'oldest' ? 'oldest first' : 'random') + '</dd>' +
    '<dt>People</dt><dd>' + (BAT.pick === 'now' ? 'Chosen now (you saw the list)' : 'Chosen on each start day') + '</dd>' +
    '<dt>Send time</dt><dd>' + lcEsc_(lcClock_(batTime_()) + ' ' + lcZoneOn_(BAT.start_on)) + (BAT.send_time ? '' : ' (campaign default)') + ', for every email in the campaign</dd></dl>' +
    '<div class="lc-card"><table class="lc-table"><thead><tr><th>Starts</th><th class="r">People</th><th class="hide-sm">Emails (planned)</th></tr></thead><tbody>' +
    plan.map(b => '<tr><td>' + lcEsc_(batWhenLabel_(b.start_on)) + '</td><td class="r">' + b.count +
      '</td><td class="hide-sm lc-dim">' + emails(b) + '</td></tr>').join('') + '</tbody></table></div>' +
    (restarting.length ? '<div class="lc-wiz-warn">' + LC_ICON.alert + '<div><b>' + restarting.length + (restarting.length === 1 ? ' person restarts' : ' people restart') + ' ' + lcEsc_(LC_SEQ[BAT.group]) + '</b>' +
      '<small>Their earlier sequence is closed and they get every email again from the first one: ' + restarting.map(c => lcEsc_(cmpName_(c))).join(', ') + '.</small></div></div>' : '') +
    '<p class="lc-note">' + (plan[0] && plan[0].start_on <= batToday_() ? (batTime_() <= batNowCT_() ? 'Today’s send time has passed, so today’s batch goes out right away. ' : 'Today’s batch gets its first email at ' + lcClock_(batTime_()) + '. ') : '') + 'Planned batches can be cancelled or moved until their start day.</p>';
}

// ── Saving: one create_batch per batch ────────────────────────────────────────
async function batCreate_() {
  const plan = batPlan_();
  if (!plan.length) return;
  const n = plan.reduce((a, b) => a + b.count, 0), restarting = batRestarting_(plan);
  if (plan[0].start_on <= batToday_() && !await lcConfirm_({ title: 'Start ' + plan[0].count + ' today?', ok: 'Start',
    body: 'They leave Needs review and their first email goes out ' + (batTime_() <= batNowCT_() ? 'right away.' : 'at ' + lcClock_(batTime_()) + ' ' + lcZoneOn_() + '.') + (plan.length > 1 ? ' The other ' + (n - plan[0].count) + ' are lined up.' : '') })) return;
  if (restarting.length && !await lcConfirm_({ title: 'Restart ' + restarting.length + (restarting.length === 1 ? ' person?' : ' people?'), ok: 'Restart them',
    body: restarting.map(cmpName_).join(', ') + ' had ' + LC_SEQ[BAT.group] + ' before. They get every email again.' })) return;
  BAT.busy = true; batRender_();
  let made = 0, err = '';
  for (const b of plan) {
    const ids = b.people.map(c => c.contact_id), re = b.people.filter(c => c.sequence).map(c => c.contact_id);
    const r = await lcAdmin_('create_batch', { group: BAT.group, filters: BAT.filters, order: BAT.order, pick: BAT.pick, start_on: b.start_on, send_time: BAT.send_time,
      count: b.count, contact_ids: ids, restart_ids: re }).catch(() => ({ ok: false, error: 'Network error' }));
    if (!r.ok) { err = r.error || 'That didn’t work'; break; }
    made++;
  }
  BAT.busy = false;
  if (err) { lcToast_(made ? made + ' of ' + plan.length + ' batches saved. ' + err : err, true); if (made) batClose_(true); else batRender_(); return; }
  lcToast_(plan.length === 1 ? (plan[0].start_on <= batToday_() ? n + ' started' : n + ' lined up for ' + batDayLabel_(plan[0].start_on)) : plan.length + ' batches lined up · ' + n + ' people');
  batClose_(true);
}

function batOnClick_(e) {
  const t = e.target.closest('[data-bat]'); if (!t) return;
  const a = t.dataset.bat;
  const order = (BAT.pick === 'now' ? BAT_STEPS : BAT_STEPS.filter(s => s[0] !== 'people')).map(s => s[0]);
  if (a === 'close') batClose_();
  else if (a === 'next') { BAT.step = order[Math.min(order.indexOf(BAT.step) + 1, order.length - 1)]; batRender_(); }
  else if (a === 'back') { BAT.step = order[Math.max(order.indexOf(BAT.step) - 1, 0)]; batRender_(); }
  else if (a === 'set') {
    const k = t.dataset.name; BAT[k] = k === 'every' ? Number(t.dataset.val) : t.dataset.val;
    if (k === 'group') { BAT.filters = { area: [], tags: [], source: [] }; BAT.restart = false; BAT.removed = new Set(); }
    batRender_();
  }
  else if (a === 'chip') { const list = BAT.filters[t.dataset.key], v = t.dataset.val, i = list.indexOf(v); if (i === -1) list.push(v); else list.splice(i, 1); batRender_(); }
  else if (a === 'remove') { BAT.removed.add(t.dataset.id); batRender_(); }
  else if (a === 'shuffle') { BAT.seed = (BAT.seed * 48271) % 2147483647; batRender_(); }
  else if (a === 'import') { batClose_(); lcOpenImport_(); }
  else if (a === 'crm') { batClose_(); crmOpenLeads_(); }
  else if (a === 'create') batCreate_();
}
function batOnChange_(e) {
  const el = e.target;
  if (el.matches('[data-bat-num]')) { const k = el.dataset.batNum, max = k === 'batches' ? 12 : 500; BAT[k] = Math.max(1, Math.min(max, Number(el.value) || 1)); batRender_(); }
  else if (el.matches('[data-bat-date]')) { BAT.start_on = el.value < batToday_() ? batToday_() : el.value; batRender_(); }
  else if (el.matches('[data-bat-time]')) { BAT.send_time = el.value; batRender_(); }
  else if (el.matches('[data-bat-check="restart"]')) { BAT.restart = el.checked; if (el.checked) BAT.pick = 'now'; batRender_(); }
}
