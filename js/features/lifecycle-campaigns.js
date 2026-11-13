// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE EMAIL → Campaigns (CP7): who gets a campaign and when.
// One page per campaign: the pipeline (Waiting → Lined up → In sequence →
// Finished / Stopped), its batches, its emails' results, and a List / Calendar
// switch. Start a batch (lifecycle-batches.js) is this tab's setup flow; the
// calendar opens it with the clicked day filled in.
// Reads only what the page already loads (overview + contacts); the calendar's
// planned sends are worked out here from each email's timing.
// Shares helpers with js/features/lifecycle.js and lifecycle-batches.js.
// ══════════════════════════════════════════════════════════════════════════════

const CMP = { id: '', view: 'list', stage: 'active', month: '', day: '' };
const CMP_STAGES = [['waiting', 'Waiting', 'In Needs review'], ['lined', 'Lined up', 'In a planned batch'],
  ['active', 'In sequence', 'Getting emails'], ['finished', 'Finished', 'Got every email'], ['stopped', 'Stopped', 'Replied, clicked or opted out']];
const CMP_ICON = {
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3.5 6.5 12 13 20.5 6.5"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><line x1="3.5" y1="10" x2="20.5" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
};

const cmpSteps_ = b => ((LC.ov && LC.ov.steps) || []).filter(s => s.bucket === b).sort((x, y) => x.order - y.order);
const cmpName_ = c => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.contact_id;
const cmpLocal_ = iso => { const t = Date.parse(iso || ''); return t ? new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) : String(iso || '').slice(0, 10); };
const cmpLong_ = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

// When an email goes out, in words (the drawer has the full rules).
function cmpWhen_(s) {
  const t = s.timing || {}, o = Number(t.offset) || 0, d = n => Math.abs(n) + (Math.abs(n) === 1 ? ' day' : ' days');
  if (t.anchor === 'enrollment') return o ? d(o) + ' after start' : 'On the start day';
  if (t.anchor === 'previous') return d(o) + ' after the last email';
  if (t.anchor === 'startup') {
    if (t.repeat_every) return 'Every ' + d(t.repeat_every) + ' from day ' + o + ' (' + t.repeat_count + ' times)';
    return o < 0 ? d(o) + ' before startup' : o ? 'Day ' + o + ' after startup' : 'On startup day';
  }
  return t.anchor || '';
}

// ── Where everyone in a campaign stands ───────────────────────────────────────
function cmpPeople_(b) {
  const all = ((LC.contacts && LC.contacts.contacts) || []).filter(c => c.bucket === b);
  const planned = ((LC.contacts && LC.contacts.batches) || []).filter(x => x.group === b && x.status === 'planned');
  const held = new Set();
  planned.forEach(x => (x.contact_ids || []).forEach(id => held.add(id)));
  const out = { waiting: [], joining: [], lined: [], active: [], finished: [], stopped: [], later: 0 };
  all.forEach(c => {
    const s = c.sequence && (!c.sequence.mode || c.sequence.mode === LC.mode) ? c.sequence : null;
    if (s && /^(active|waiting_anchor|paused)$/.test(s.status)) out.active.push(c);
    else if (held.has(c.contact_id)) out.lined.push(c);
    else if (s && s.status === 'completed') out.finished.push(c);
    else if (s && s.status === 'stopped') out.stopped.push(c);
    else if (c.review_status === 'needs_review' && !c.is_test) out.waiting.push(c);
    // Confirmed but not started yet: synced startups (they start on the next run; in test mode only at go-live).
    else if (c.review_status === 'confirmed' && !c.is_test && !s) out.joining.push(c);
  });
  // "Pick on the day" batches hold a number, not people yet.
  out.later = planned.filter(x => x.pick === 'at_start').reduce((a, x) => a + Number(x.count || 0), 0);
  return out;
}
const cmpCount_ = (p, k) => (k === 'waiting' ? p.waiting.length + p.joining.length : p[k].length) + (k === 'lined' ? p.later : 0);
// Stage labels per campaign: MCP Startup's people come from the portal, so its first stage is "Joining".
function cmpStages_(b) {
  if (cmpBatchable_(b)) return CMP_STAGES;
  return CMP_STAGES.filter(s => s[0] !== 'lined').map(s => s[0] === 'waiting' ? ['waiting', 'Joining', LC.ov && LC.ov.engine.mode !== 'production' ? 'From the portal · start at go-live' : 'From the portal, before their first email'] : s);
}

// ── Planned sends: from the engine's own decide() (api/email.js view=plan) ────
// The page never works out dates itself (PLAN.md → Planned sends on the page).
// Rows: [date, time, step_id, contact_id, key, weight, batch_id, flag, last_send_day, original_due]
CMP.plans = {};
function cmpLoadPlan_(b, fresh) {
  return lcLoad_('plan', { bucket: b, mode: LC.mode || '', fresh: fresh ? '1' : '' }, data => {
    CMP.plans[b] = data;
    if (LC.tab === 'campaigns' && CMP.id === b) lcRenderBody_();
  }, 'plan:' + b + ':' + (LC.mode || '')).catch(() => { /* the page keeps the cached plan, if any */ });
}
// { date: { batches: [...], sends: { step@time: { step, time, people: [{c, key, flag, last, orig}], extra } } } }, or null while loading.
function cmpForecast_(b) {
  const plan = CMP.plans[b];
  if (!plan) return null;
  const steps = {}, people = {}, days = {}, def = lcSendTime_(b), today = batToday_();
  cmpSteps_(b).forEach(s => { steps[s.step_id] = s; });
  ((LC.contacts && LC.contacts.contacts) || []).forEach(c => { people[c.contact_id] = c; });
  const at = d => (days[d] = days[d] || { batches: [], sends: {} });
  ((LC.contacts && LC.contacts.batches) || []).filter(x => x.group === b && x.status === 'planned').forEach(x => {
    at(x.start_on < today ? today : x.start_on).batches.push(Object.assign({}, x, { time: x.send_time || def }));
  });
  plan.rows.forEach(([d, time, stepId, cid, key, weight, batchId, flag, last, orig]) => {
    const s = steps[stepId]; if (!s) return;
    const k = stepId + '@' + time;
    const e = at(d).sends[k] = at(d).sends[k] || { step: s, time, people: [], extra: 0 };
    if (cid) e.people.push({ c: people[cid] || { contact_id: cid }, key, flag, last, orig, batch: batchId });
    else e.extra += Number(weight) || 0;
  });
  return days;
}
const cmpSendCount_ = e => e.people.length + e.extra;
const CMP_FLAG = { moved: ['Moved', 'warn'], next_run: ['Next run', 'teal'], held: ['Held a day', 'warn'] };
// A day's sends in the order they go out: by time, then email order.
const cmpSends_ = day => Object.values((day && day.sends) || {}).sort((a, c) => a.time.localeCompare(c.time) || a.step.order - c.step.order);
const cmpAt_ = (d, time) => lcClock_(time) + ' ' + lcZoneOn_(d);
// The campaign's default send time, editable by people who can change settings.
function cmpTimePill_(b) {
  const t = lcSendTime_(b), can = lcCan_('edit_config');
  return '<button class="lc-pill lc-time-pill" data-act="cmp-time" data-id="' + b + '"' + (can ? '' : ' disabled') + ' title="' + (can ? 'Change the default send time' : 'Default send time') + '">' +
    CMP_ICON_CLOCK + 'Sends ' + lcEsc_(cmpAt_('', t)) + (can ? '<em>Change</em>' : '') + '</button>';
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function lcCampaigns_() {
  if (!LC.contacts) return '<div class="lc-sk" style="height:220px;margin-bottom:16px"></div><div class="lc-sk" style="height:320px"></div>';
  if (typeof crmLoad_ === 'function' && !CRM.data && !CRM.loading) crmLoad_();
  if (CMP.id && cmpSteps_(CMP.id).length) return cmpPage_(CMP.id);
  return '<div class="lc-cmp-grid">' + ['B', 'C'].filter(b => cmpSteps_(b).length).map(cmpCard_).join('') + '</div>' + (typeof sglSection_ === 'function' ? sglSection_() : '');
}

function cmpStatus_(b) {
  const steps = cmpSteps_(b), live = steps.filter(s => s.published).length;
  if (!live) return lcTag_('No emails approved', '');
  if (LC.ov.engine.paused_buckets.includes(b)) return lcTag_('Paused', 'warn');
  return lcTag_('Live', 'live');
}
function cmpNextBatch_(b) {
  const list = ((LC.contacts && LC.contacts.batches) || []).filter(x => x.group === b && x.status === 'planned').sort((x, y) => String(x.start_on).localeCompare(y.start_on));
  return list[0] || null;
}

function cmpCard_(b) {
  const p = cmpPeople_(b), steps = cmpSteps_(b), nb = cmpNextBatch_(b);
  const live = steps.filter(s => s.published).length;
  const stages = cmpStages_(b).map(([k, l]) => '<div class="' + (k === 'active' ? 'on' : '') + '"><b>' + cmpCount_(p, k) + '</b><span>' + l + '</span></div>').join('');
  return '<article class="lc-cmp-card"><button class="lc-cmp-open" data-act="cmp-open" data-id="' + b + '" aria-label="Open ' + LC_SEQ[b] + '"></button>' +
    '<header><span class="lc-bkt">' + b + '</span><div class="grow"><h2>' + LC_SEQ[b] + '</h2><small>' + steps.length + ' emails · ' + live + ' approved</small></div>' + cmpStatus_(b) + '</header>' +
    '<div class="lc-cmp-mini' + (cmpBatchable_(b) ? '' : ' four') + '">' + stages + '</div>' +
    '<footer><span class="lc-cmp-next">' + CMP_ICON.cal + (b === 'C' && typeof crmStartupLine_ === 'function' ? crmStartupLine_(true) : nb ? lcEsc_(nb.count + ' start ' + batDayLabel_(nb.start_on) + ', ' + lcClock_(nb.send_time || lcSendTime_(b))) : 'No batches lined up') +
      (b === 'C' ? '' : '<span class="lc-dim">· sends ' + lcEsc_(lcClock_(lcSendTime_(b))) + '</span>') + '</span>' +
    (lcCan_('edit_contacts') && cmpBatchable_(b) ? '<button class="lc-btn sm primary" data-act="cmp-batch" data-id="' + b + '">' + CMP_ICON.plus + 'Start a batch</button>' : '') + '</footer></article>';
}

function cmpPage_(b) {
  const p = cmpPeople_(b);
  const head = '<div class="lc-cmp-head"><button class="lc-back" data-act="cmp-back">' + CMP_ICON.back + 'Campaigns</button>' +
    '<div class="lc-cmp-title"><span class="lc-bkt">' + b + '</span><h2>' + LC_SEQ[b] + '</h2>' + cmpStatus_(b) + cmpTimePill_(b) + '</div>' +
    '<div class="lc-cmp-acts"><div class="lc-seg" role="group" aria-label="View">' + [['list', 'List'], ['calendar', 'Calendar']].map(([k, l]) =>
      '<button data-act="cmp-view" data-view="' + k + '" class="' + (CMP.view === k ? 'on' : '') + '">' + l + '</button>').join('') + '</div>' +
    (lcCan_('edit_contacts') && cmpBatchable_(b) ? '<button class="lc-btn primary" data-act="cmp-batch" data-id="' + b + '">' + CMP_ICON.plus + 'Start a batch</button>' : '') + '</div></div>';
  const pipe = '<div class="lc-pipe' + (cmpBatchable_(b) ? '' : ' four') + '" role="tablist" aria-label="Where people are">' + cmpStages_(b).map(([k, l, hint], i) =>
    '<button role="tab" aria-selected="' + (CMP.stage === k) + '" data-act="cmp-stage" data-stage="' + k + '" class="' + (CMP.stage === k ? 'on' : '') + (i > 2 ? ' end' : '') + '">' +
    '<b>' + cmpCount_(p, k) + '</b><span>' + l + '</span><small>' + hint + '</small></button>').join('') + '</div>';
  return head + pipe + (b === 'C' && typeof crmStartupStrip_ === 'function' ? crmStartupStrip_() : '') + (CMP.view === 'calendar' ? cmpCalendar_(b) : cmpList_(b, p));
}

function cmpList_(b, p) {
  const fc = cmpForecast_(b) || {}, dates = Object.keys(fc).sort(), loading = !CMP.plans[b];
  const nextOf = id => {
    for (const d of dates) { const list = cmpSends_(fc[d]).filter(e => e.step.step_id === id); if (list.length) return { d, time: list[0].time, n: list.reduce((a, e) => a + cmpSendCount_(e), 0) }; }
    return null;
  };
  const emails = cmpSteps_(b).map(s => {
    const t = s.tracking || {}, n = nextOf(s.step_id);
    return '<button class="lc-cmp-em" data-act="step" data-id="' + lcEsc_(s.step_id) + '"><span class="lc-step">' + s.order + '</span><div class="main"><b>' + lcEsc_(s.name) + '</b><small>' +
      lcEsc_(cmpWhen_(s)) + '</small></div><div class="nums">' + (s.published ? '<span><b>' + s.counts.sent + '</b> sent</span><span><b>' + (t.clicked || 0) + '</b> clicked</span><span><b>' + (t.replied || 0) + '</b> replied</span>'
      : lcTag_('Not approved', '')) + '</div><div class="next">' + (loading ? '<span class="lc-sk" style="display:block;height:30px;width:80px;margin-left:auto"></span>' : n ? '<b>' + lcEsc_(batDayLabel_(n.d)) + '</b><small>' + lcEsc_(lcClock_(n.time)) + ' · ' + n.n + (n.n === 1 ? ' person' : ' people') + '</small>' : '<small>Nothing planned</small>') + '</div></button>';
  }).join('');
  return '<div class="lc-cmp-cols"><section class="lc-card"><div class="lc-card-h"><h3>' + (cmpBatchable_(b) ? 'Batches' : 'How people join') + '</h3><small>' + (cmpBatchable_(b) ? cmpCount_(p, 'lined') + ' lined up' : 'From the portal') + '</small></div>' + cmpBatches_(b) + '</section>' +
    '<section class="lc-card"><div class="lc-card-h"><h3>Emails</h3><small>Next send</small></div><div class="lc-cmp-ems">' + emails + '</div></section></div>' + cmpStageTable_(b, p);
}

// MCP Startup's people join on their own from the portal's startups; batches are for lists (MCP Legacy).
const cmpBatchable_ = b => b !== 'C';
function cmpBatches_(b) {
  if (!cmpBatchable_(b)) return '<div class="lc-empty">Startups join automatically when they’re approved in the portal.</div>';
  const list = ((LC.contacts && LC.contacts.batches) || []).filter(x => x.group === b && x.status !== 'cancelled')
    .sort((x, y) => (x.status === 'planned') === (y.status === 'planned') ? String(x.status === 'planned' ? x.start_on : y.start_on).localeCompare(x.status === 'planned' ? y.start_on : x.start_on) : x.status === 'planned' ? -1 : 1);
  if (!list.length) return '<div class="lc-empty">No batches yet.' + (lcCan_('edit_contacts') ? ' <button class="lc-link" data-act="cmp-batch" data-id="' + b + '">Start one</button>' : '') + '</div>';
  // A batch never starts people while the sequence's first email is off (engine EE_startBatch_).
  const first = ((LC.ov && LC.ov.steps) || []).filter(s => s.bucket === b).sort((x, y) => x.order - y.order)[0];
  const firstOff = first && first.status === 'off' ? first.name : '';
  return '<ol class="lc-btl">' + list.slice(0, 14).map(x => {
    const f = x.filters || {}, what = [].concat(f.area || [], f.tags || [], f.source || []).join(', ');
    const planned = x.status === 'planned', d = planned ? x.start_on : cmpLocal_(x.started_at);
    const dt = new Date(d + 'T12:00:00');
    return '<li class="' + (planned ? 'planned' : 'done') + '"><time><b>' + dt.getDate() + '</b><span>' + dt.toLocaleDateString('en-US', { month: 'short' }) + '</span></time>' +
      '<div class="main"><b>' + (planned ? x.count : (x.started_count || x.count)) + ' people' + (what ? ' · ' + lcEsc_(what) : '') + '</b><small>' +
      (planned ? 'Sends ' + lcEsc_(cmpAt_(x.start_on, x.send_time || lcSendTime_(b))) + ' · ' + (x.pick === 'at_start' ? 'picked that morning' : 'people chosen') + ' · ' + (x.order === 'oldest' ? 'oldest first' : 'random')
        : 'Started ' + lcEsc_(lcStamp_(x.started_at))) + '</small></div>' +
      (planned && firstOff ? '<span title="' + lcEsc_('Starts on its date once ' + firstOff + ' is turned on') + '">' + lcTag_('Waits for ' + firstOff, 'warn') + '</span>' + (lcCan_('edit_contacts') ? '<button class="lc-btn sm danger" data-act="cancelbatch" data-id="' + lcEsc_(x.batch_id) + '">Cancel</button>' : '') : '') +
      (planned && !firstOff ? lcTag_('Planned', 'warn') + (lcCan_('edit_contacts') ? '<button class="lc-btn sm danger" data-act="cancelbatch" data-id="' + lcEsc_(x.batch_id) + '">Cancel</button>' : '') : '') + (planned ? '' : lcTag_('Started', 'live')) + '</li>';
  }).join('') + '</ol>';
}

function cmpStageTable_(b, p) {
  const rows = CMP.stage === 'waiting' ? p.waiting.concat(p.joining) : (p[CMP.stage] || []);
  const label = (cmpStages_(b).find(s => s[0] === CMP.stage) || [])[1];
  const fc = cmpForecast_(b) || {}, next = {};
  Object.keys(fc).sort().forEach(d => cmpSends_(fc[d]).forEach(e => e.people.forEach(p => { if (!next[p.c.contact_id]) next[p.c.contact_id] = { d, s: e.step, time: e.time }; })));
  const head = '<div class="lc-card-h"><h3>' + lcEsc_(label) + '</h3><small>' + rows.length + (rows.length === 1 ? ' person' : ' people') +
    (CMP.stage === 'lined' && p.later ? ' · ' + p.later + ' more picked on their start day' : '') + '</small></div>';
  if (!rows.length) return '<section class="lc-card" style="margin-top:16px">' + head + '<div class="lc-empty">No one here.</div></section>';
  const col = { waiting: cmpBatchable_(b) ? 'Added' : 'Startup', lined: 'Starts', active: 'Next email', finished: 'Last email', stopped: 'Why' }[CMP.stage];
  const cell = c => {
    if (CMP.stage === 'active') { const n = next[c.contact_id]; return n ? lcEsc_(n.s.name) + ' <span class="lc-dim">· ' + lcEsc_(batDayLabel_(n.d) + ', ' + lcClock_(n.time)) + '</span>' : '<span class="lc-dim">–</span>'; }
    if (CMP.stage === 'stopped') return lcTag_(lcStopWord_(c.sequence.stop_reason), 'warn');
    if (CMP.stage === 'lined') { const x = (LC.contacts.batches || []).find(y => y.status === 'planned' && (y.contact_ids || []).includes(c.contact_id)); return x ? lcEsc_(batDayLabel_(x.start_on) + ', ' + lcClock_(x.send_time || lcSendTime_(CMP.id))) : ''; }
    if (CMP.stage === 'finished') return c.last_email ? lcEsc_(lcDay_(c.last_email.sent_at)) : '';
    if (c.startup_date) return 'Startup ' + lcEsc_(batDayLabel_(c.startup_date));
    return c.created_at ? lcEsc_(lcDay_(c.created_at)) : '<span class="lc-dim">–</span>';
  };
  return '<section class="lc-card" style="margin-top:16px">' + head + '<table class="lc-table"><thead><tr><th>Person</th><th class="hide-xs">Area</th><th>' + col + '</th></tr></thead><tbody>' +
    rows.slice(0, 200).map(c => '<tr class="click" data-act="contact" data-id="' + lcEsc_(c.contact_id) + '" tabindex="0"><td class="lc-fit"><div class="lc-person"><span class="lc-avatar">' +
      lcEsc_(lcInitials_(c.first_name, c.last_name)) + '</span><div><b>' + lcEsc_(cmpName_(c)) + '</b><small>' + lcEsc_(c.email || '') + '</small></div></div></td>' +
      '<td class="hide-xs">' + lcEsc_(c.area || '–') + '</td><td>' + cell(c) + '</td></tr>').join('') + '</tbody></table></section>';
}

// ── Calendar ──────────────────────────────────────────────────────────────────
function cmpCalendar_(b) {
  const today = batToday_();
  if (!CMP.month) CMP.month = today.slice(0, 7);
  const fc = cmpForecast_(b) || {}, loading = !CMP.plans[b];
  const [y, m] = CMP.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1), start = new Date(y, m - 1, 1 - first.getDay());
  const title = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const can = lcCan_('edit_contacts');
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const d = dt.toLocaleDateString('en-CA');
    if (i === 35 && dt.getMonth() !== m - 1) break;
    const day = fc[d], past = d < today, other = dt.getMonth() !== m - 1;
    const chips = [];
    if (day) {
      day.batches.forEach(x => chips.push('<span class="lc-cal-chip batch"' + (can && x.status === 'planned' ? ' draggable="true" data-drag="' + lcEsc_(x.batch_id) + '"' : '') + ' title="' + lcEsc_(x.count + ' start · ' + cmpAt_(d, x.time)) + '"><em>' + lcEsc_(lcClockShort_(x.time)) + '</em><b>' + x.count + '</b></span>'));
      cmpSends_(day).forEach(e => chips.push('<span class="lc-cal-chip' + (e.step.published ? '' : ' draft') + '" title="' + lcEsc_(e.step.name + ' · ' + cmpAt_(d, e.time)) + '"><i>' + e.step.order + '</i><em>' + lcEsc_(lcClockShort_(e.time)) + '</em><b>' + cmpSendCount_(e) + '</b></span>'));
    }
    const more = chips.length > 3 ? '<span class="lc-cal-more">+' + (chips.length - 3) + ' more</span>' : '';
    cells += '<button class="lc-cal-d' + (past ? ' past' : '') + (other ? ' other' : '') + (d === today ? ' today' : '') + (d === CMP.day ? ' sel' : '') + '" data-act="cmp-day" data-day="' + d + '"' +
      (past ? ' disabled' : '') + ' data-drop="' + d + '"><span class="n">' + dt.getDate() + '</span>' + chips.slice(0, 3).join('') + more + '</button>';
  }
  const grid = '<section class="lc-card lc-cal' + (loading ? ' loading' : '') + '"><div class="lc-cal-h"><h3>' + title + (loading ? ' <small class="lc-dim">Loading the plan…</small>' : '') + '</h3><div class="lc-cal-nav">' +
    '<button class="lc-btn sm" data-act="cmp-today">Today</button><button class="lc-icon-btn" data-act="cmp-month" data-dir="-1" aria-label="Previous month">' + CMP_ICON.back + '</button>' +
    '<button class="lc-icon-btn" data-act="cmp-month" data-dir="1" aria-label="Next month">' + LC_ICON.chev + '</button></div></div>' +
    '<div class="lc-cal-w">' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(w => '<span>' + w + '</span>').join('') + '</div><div class="lc-cal-g">' + cells + '</div>' +
    '<div class="lc-cal-key"><span><i class="batch"></i>Batch starts</span><span class="lc-dim">Times in ' + lcEsc_(lcZoneOn_(CMP.month + '-15')) + '</span>' + cmpSteps_(b).map(s => '<span><i class="n">' + s.order + '</i>' + lcEsc_(s.name) + (s.published ? '' : ' <span class="lc-dim">(not approved)</span>') + '</span>').join('') + (can ? '<span class="hint">Click a day to start a batch on it · drag a batch to move it</span>' : '') + '</div></section>';
  return '<div class="lc-cal-wrap' + (CMP.day ? ' has-day' : '') + '">' + grid + (CMP.day ? cmpDayPanel_(b, fc[CMP.day], CMP.day) : '') + '</div>';
}

function cmpDayPanel_(b, day, d) {
  const can = lcCan_('edit_contacts');
  const batchHtml = x => '<div class="lc-day-batch"><div><b>' + x.count + ' people start</b><small>' +
    (x.pick === 'at_start' ? 'Picked that morning' : 'People chosen') + ' · ' + (x.order === 'oldest' ? 'oldest first' : 'random') + '</small></div>' +
    (can ? '<div class="acts"><label class="lc-move"><span>Move to</span><input class="lc-input" type="date" min="' + batToday_() + '" value="' + x.start_on + '" data-cmp-move="' + lcEsc_(x.batch_id) + '"></label>' +
      '<button class="lc-btn sm danger" data-act="cancelbatch" data-id="' + lcEsc_(x.batch_id) + '">Cancel</button></div>' : '') + '</div>';
  const sendHtml = e => '<details class="lc-day-send" open><summary><b>' + lcEsc_(e.step.name) + '</b><span>' + cmpSendCount_(e) + '</span></summary>' +
    (e.step.published ? '' : '<p class="lc-day-draft">Not approved yet: nothing goes out until it is.</p>') + '<ul>' +
    e.people.slice(0, 80).map(p => cmpPersonRow_(p, e, d, can)).join('') +
    (e.extra ? '<li><span class="who lc-dim">' + e.extra + ' people picked on their start day</span></li>' : '') + '</ul></details>';
  // One group per send time, in the order they go out.
  const times = [...new Set([].concat((day ? day.batches : []).map(x => x.time), cmpSends_(day).map(e => e.time)))].sort();
  const groups = times.map(t => '<section class="lc-day-slot"><h4>' + CMP_ICON_CLOCK + lcEsc_(cmpAt_(d, t)) + '</h4>' +
    (day ? day.batches : []).filter(x => x.time === t).map(batchHtml).join('') + cmpSends_(day).filter(e => e.time === t).map(sendHtml).join('') + '</section>').join('');
  return '<aside class="lc-card lc-day"><div class="lc-card-h"><h3>' + lcEsc_(cmpLong_(d)) + '</h3><button class="lc-icon-btn" data-act="cmp-day-close" aria-label="Close">' + LC_ICON.x + '</button></div>' +
    '<div class="lc-day-b">' + groups +
    (!groups ? '<div class="lc-empty">Nothing planned on this day.</div>' : '') +
    (can && cmpBatchable_(b) ? '<button class="lc-btn primary lc-day-new" data-act="cmp-batch" data-id="' + b + '" data-day="' + d + '">' + CMP_ICON.plus + 'Start a batch on ' + lcEsc_(batDayLabel_(d)) + '</button>' : '') + '</div></aside>';
}

// One person's planned send in the day panel, with what can still be changed.
function cmpPersonRow_(p, e, d, can) {
  const f = CMP_FLAG[p.flag];
  const tag = f ? ' ' + lcTag_(f[0] + (p.flag === 'moved' && p.orig ? ' from ' + batDayLabel_(p.orig) : ''), f[1]) : '';
  const name = '<span class="who">' + lcEsc_(cmpName_(p.c)) + tag + '</span>';
  // Simulated sends (a batch not started yet) have nothing to change until it starts.
  if (!can || !p.key) return '<li><div class="row">' + name + (p.batch ? '<span class="lc-dim sm">with its batch</span>' : '') + '</div></li>';
  const btn = (act, label, cls) => '<button class="lc-btn sm' + (cls ? ' ' + cls : '') + '" data-act="cmp-send" data-do="' + act + '" data-key="' + lcEsc_(p.key) + '" data-step="' + lcEsc_(e.step.step_id) +
    '" data-name="' + lcEsc_(cmpName_(p.c)) + '" data-from="' + lcEsc_(p.orig || d) + '" data-last="' + lcEsc_(p.last || '') + '">' + label + '</button>';
  const acts = (p.flag === 'moved' || p.flag === 'next_run' ? btn('clear', 'Undo') : '') + btn('skip', 'Skip') + (p.last && p.last > (p.orig || d) ? btn('move', 'Move') : '') +
    (p.flag !== 'projected' && p.flag !== 'next_run' ? btn('next_run', 'Send next run') : '');
  return '<li><div class="row">' + name + '<button class="lc-btn sm" data-act="cmp-more">Change</button></div><span class="acts">' + acts + '</span></li>';
}

// ── Actions ───────────────────────────────────────────────────────────────────
function cmpOnClick_(t) {
  const a = t.dataset.act;
  if (a === 'cmp-open') { CMP.id = t.dataset.id; CMP.stage = 'active'; CMP.day = ''; cmpLoadPlan_(CMP.id); lcRenderBody_(); window.scrollTo({ top: 0 }); }
  else if (a === 'cmp-back') { CMP.id = ''; CMP.day = ''; lcRenderBody_(); }
  else if (a === 'cmp-view') { CMP.view = t.dataset.view; CMP.day = ''; lcRenderBody_(); }
  else if (a === 'cmp-stage') { CMP.stage = t.dataset.stage; lcRenderBody_(); }
  else if (a === 'cmp-batch') lcOpenBatch_({ group: t.dataset.id, start_on: t.dataset.day || '' });
  else if (a === 'cmp-month') { const [y, m] = CMP.month.split('-').map(Number), d = new Date(y, m - 1 + Number(t.dataset.dir), 1); CMP.month = d.toLocaleDateString('en-CA').slice(0, 7); CMP.day = ''; lcRenderBody_(); }
  else if (a === 'cmp-today') { CMP.month = batToday_().slice(0, 7); CMP.day = ''; lcRenderBody_(); }
  else if (a === 'cmp-day') {
    const d = t.dataset.day, fc = cmpForecast_(CMP.id) || {};
    // An empty day goes straight to setup; a day with plans shows them first.
    if (!fc[d] && lcCan_('edit_contacts') && cmpBatchable_(CMP.id)) lcOpenBatch_({ group: CMP.id, start_on: d });
    else { CMP.day = CMP.day === d ? '' : d; lcRenderBody_(); }
  }
  else if (a === 'cmp-day-close') { CMP.day = ''; lcRenderBody_(); }
  else if (a === 'cmp-time') cmpEditTime_(t.dataset.id);
  else if (a === 'cmp-more') t.closest('li').classList.toggle('open');
  else if (a === 'cmp-send') return cmpSendChange_(t.dataset);
}
async function cmpMoveBatch_(id, to) {
  const x = ((LC.contacts && LC.contacts.batches) || []).find(y => y.batch_id === id);
  if (!x || !to || to === x.start_on) return;
  if (to < batToday_()) return lcToast_('Pick today or a later day', true);
  if (!await lcConfirm_({ title: 'Move ' + x.count + ' people to ' + batDayLabel_(to) + '?', ok: 'Move',
    body: 'Their first email goes out on ' + cmpLong_(to) + ' instead of ' + cmpLong_(x.start_on) + '.',
    run: () => lcAdmin_('move_batch', { batch_id: id, start_on: to }) })) { lcRenderBody_(); return; }
  lcToast_(x.count + ' people now start ' + batDayLabel_(to));
  cmpAfterChange_();
}
// After any change: fresh people, batches and plan (the engine is the source of truth).
function cmpAfterChange_() {
  lcRefresh_(true);
  if (CMP.id) cmpLoadPlan_(CMP.id, true);
}
// Skip / Move / Send next run / Undo for one planned send (Admin.js → send_override).
async function cmpSendChange_(ds) {
  const step = lcStepName_(ds.step), who = ds.name;
  let date = '';
  if (ds.do === 'skip') {
    if (!await lcConfirm_({ title: 'Skip this email for ' + who + '?', ok: 'Skip', danger: true,
      body: who + ' won’t get “' + step + '”. Later emails still go out on their usual days.',
      run: () => lcAdmin_('send_override', { key: ds.key, kind: 'skip', date: '' }) })) return;
  } else {
    if (ds.do === 'move') {
      date = await cmpPickDate_('Move “' + step + '” for ' + who, ds.from < batToday_() ? batToday_() : ds.from, ds.last);
      if (!date) return;
    }
    const r = await lcAdmin_('send_override', { key: ds.key, kind: ds.do, date }).catch(() => ({ ok: false, error: 'Network error' }));
    if (!r.ok) return lcToast_(r.error || 'That didn’t work', true);
  }
  lcToast_(ds.do === 'skip' ? 'Skipped' : ds.do === 'move' ? 'Moved to ' + batDayLabel_(date) : ds.do === 'next_run' ? 'Goes out on the next run' : 'Back to its planned day');
  cmpAfterChange_();
}
// A date sheet limited to the email's window (the engine checks the same range).
function cmpPickDate_(title, min, max) {
  return new Promise(resolve => {
    const layer = document.createElement('div');
    layer.className = 'lc-layer';
    layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim" data-x="0"></div><div class="lc-sheet" role="dialog" aria-modal="true">' +
      '<h3>' + lcEsc_(title) + '</h3><p>Any day from ' + lcEsc_(batDayLabel_(min)) + ' to ' + lcEsc_(batDayLabel_(max)) + ' (its window). It still goes out at its send time.</p>' +
      '<label class="lc-fld" style="margin-top:14px"><span>New day</span><input class="lc-input" type="date" min="' + min + '" max="' + max + '" value="' + min + '" data-date></label>' +
      '<div class="row"><button class="lc-btn" data-x="0">Cancel</button><button class="lc-btn primary" data-x="1">Move</button></div></div>';
    const done = v => { layer.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); done(''); } };
    layer.addEventListener('click', e => {
      const x = e.target.closest('[data-x]'); if (!x) return;
      const v = layer.querySelector('[data-date]').value;
      done(x.dataset.x === '1' && v >= min && v <= max ? v : '');
    });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(layer);
    layer.querySelector('[data-date]').focus();
  });
}
// Drag a planned batch onto another day; the date input in the day panel does the same.
function cmpBind_(root) {
  if (root.dataset.cmpBound) return;
  root.dataset.cmpBound = '1';
  root.addEventListener('dragstart', e => { const c = e.target.closest('[data-drag]'); if (c) { e.dataTransfer.setData('text/plain', c.dataset.drag); e.dataTransfer.effectAllowed = 'move'; } });
  root.addEventListener('dragover', e => { const d = e.target.closest('[data-drop]'); if (d && !d.disabled) { e.preventDefault(); d.classList.add('over'); } });
  root.addEventListener('dragleave', e => { const d = e.target.closest('[data-drop]'); if (d) d.classList.remove('over'); });
  root.addEventListener('drop', e => { const d = e.target.closest('[data-drop]'); if (!d || d.disabled) return; e.preventDefault(); d.classList.remove('over'); cmpMoveBatch_(e.dataTransfer.getData('text/plain'), d.dataset.drop); });
  root.addEventListener('change', e => { if (e.target.matches('[data-cmp-move]')) cmpMoveBatch_(e.target.dataset.cmpMove, e.target.value); });
}

// Quarter hours from 6:00 AM to 8:00 PM (the engine accepts the same; Schedule.js).
const CMP_TIMES = Array.from({ length: 57 }, (_, i) => { const m = 360 + i * 15; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); });
const cmpTimeOptions_ = (sel, first) => (first || '') + CMP_TIMES.map(t => '<option value="' + t + '"' + (t === sel ? ' selected' : '') + '>' + lcClock_(t) + '</option>').join('');
function cmpEditTime_(b) {
  if (!lcCan_('edit_config')) return;
  const cur = lcSendTime_(b), zone = lcZoneOn_();
  const layer = document.createElement('div');
  layer.className = 'lc-layer';
  layer.innerHTML = '<div class="lc-scrim lc-sheet-scrim" data-x="0"></div><div class="lc-sheet" role="dialog" aria-modal="true" aria-label="Send time">' +
    '<h3>' + lcEsc_(LC_SEQ[b]) + ' send time</h3><p>Emails go out at this time (' + lcEsc_(zone) + '), unless their batch has its own.</p>' +
    '<label class="lc-fld" style="margin-top:14px"><span>Send at</span><select class="lc-input" data-time>' + cmpTimeOptions_(cur) + '</select></label>' +
    '<div class="row"><button class="lc-btn" data-x="0">Cancel</button><button class="lc-btn primary" data-x="1">Save</button></div></div>';
  const close = () => { layer.remove(); document.removeEventListener('keydown', key, true); };
  const key = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  layer.addEventListener('click', async e => {
    const x = e.target.closest('[data-x]'); if (!x) return;
    if (x.dataset.x !== '1') return close();
    const time = layer.querySelector('[data-time]').value;
    if (time === cur) return close();
    x.disabled = true; x.textContent = 'Saving…';
    const r = await lcAdmin_('set_send_time', { bucket: b, time }).catch(() => ({ ok: false, error: 'Network error' }));
    close();
    if (!r.ok) return lcToast_(r.error || 'That didn’t work', true);
    LC.ov.engine.send_times = Object.assign({}, LC.ov.engine.send_times, { [b]: time });
    lcToast_(LC_SEQ[b] + ' now sends at ' + lcClock_(time) + ' ' + zone);
    lcRenderBody_(); lcRefresh_(true);
  });
  document.addEventListener('keydown', key, true);
  document.body.appendChild(layer);
  layer.querySelector('[data-time]').focus();
}
