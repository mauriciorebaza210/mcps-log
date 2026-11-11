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
  const out = { waiting: [], lined: [], active: [], finished: [], stopped: [], later: 0 };
  all.forEach(c => {
    const s = c.sequence && (!c.sequence.mode || c.sequence.mode === LC.mode) ? c.sequence : null;
    if (s && /^(active|waiting_anchor|paused)$/.test(s.status)) out.active.push(c);
    else if (held.has(c.contact_id)) out.lined.push(c);
    else if (s && s.status === 'completed') out.finished.push(c);
    else if (s && s.status === 'stopped') out.stopped.push(c);
    else if (c.review_status === 'needs_review' && !c.is_test) out.waiting.push(c);
  });
  // "Pick on the day" batches hold a number, not people yet.
  out.later = planned.filter(x => x.pick === 'at_start').reduce((a, x) => a + Number(x.count || 0), 0);
  return out;
}
const cmpCount_ = (p, k) => p[k].length + (k === 'lined' ? p.later : 0);

// ── Planned sends: each email's next date per person, from its timing ────────
// Same order of rules as the engine (enrollment → previous chain; startup offsets
// with repeats); holds and daily caps can still move a send by a day or two.
function cmpForecast_(b) {
  const steps = cmpSteps_(b), today = batToday_(), days = {};
  const at = d => (days[d] = days[d] || { batches: [], sends: {} });
  const add = (d, s, who) => {
    if (d < today) d = today;
    const e = at(d).sends[s.step_id] = at(d).sends[s.step_id] || { step: s, people: [], extra: 0 };
    if (typeof who === 'number') e.extra += who; else e.people.push(who);
  };
  const chain = (start, from, who) => {
    let d = start;
    for (let i = from; i < steps.length; i++) {
      const t = steps[i].timing || {};
      if (t.anchor === 'startup') return;
      if (i > from || t.anchor === 'enrollment') d = batAddDays_(d, Number(t.offset) || 0);
      add(d, steps[i], who);
    }
  };
  const byId = {};
  ((LC.contacts && LC.contacts.contacts) || []).forEach(c => { byId[c.contact_id] = c; });
  cmpPeople_(b).active.forEach(c => {
    const last = c.last_email, k = last ? steps.findIndex(s => s.step_id === last.step_id) : -1;
    if (steps.some(s => (s.timing || {}).anchor === 'startup')) {
      if (!c.startup_date) return;
      const lastDay = last ? cmpLocal_(last.sent_at) : '';
      steps.forEach((s, i) => {
        const t = s.timing || {}, n = t.repeat_every ? Number(t.repeat_count) || 1 : 1;
        for (let r = 0; r < n; r++) {
          const d = batAddDays_(c.startup_date, (Number(t.offset) || 0) + r * (Number(t.repeat_every) || 0));
          if (d >= today && (i > k || (i === k && d > lastDay))) add(d, s, c);
        }
      });
      return;
    }
    if (k === -1) chain(today, 0, c);
    else if (k + 1 < steps.length) chain(batAddDays_(cmpLocal_(last.sent_at), Number((steps[k + 1].timing || {}).offset) || 0), k + 1, c);
  });
  ((LC.contacts && LC.contacts.batches) || []).filter(x => x.group === b && x.status === 'planned').forEach(x => {
    const d = x.start_on < today ? today : x.start_on;
    at(d).batches.push(x);
    const who = (x.contact_ids || []).length ? x.contact_ids.map(id => byId[id] || { contact_id: id }) : null;
    if (steps.length && (steps[0].timing || {}).anchor !== 'startup') {
      if (who) who.forEach(c => chain(d, 0, c)); else chain(d, 0, Number(x.count) || 0);
    }
  });
  return days;
}
const cmpSendCount_ = e => e.people.length + e.extra;

// ── Rendering ─────────────────────────────────────────────────────────────────
function lcCampaigns_() {
  if (!LC.contacts) return '<div class="lc-sk" style="height:220px;margin-bottom:16px"></div><div class="lc-sk" style="height:320px"></div>';
  if (CMP.id && cmpSteps_(CMP.id).length) return cmpPage_(CMP.id);
  return '<div class="lc-cmp-grid">' + ['B', 'C'].filter(b => cmpSteps_(b).length).map(cmpCard_).join('') + '</div>';
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
  const stages = CMP_STAGES.map(([k, l]) => '<div class="' + (k === 'active' ? 'on' : '') + '"><b>' + cmpCount_(p, k) + '</b><span>' + l + '</span></div>').join('');
  return '<article class="lc-cmp-card"><button class="lc-cmp-open" data-act="cmp-open" data-id="' + b + '" aria-label="Open ' + LC_SEQ[b] + '"></button>' +
    '<header><span class="lc-bkt">' + b + '</span><div class="grow"><h2>' + LC_SEQ[b] + '</h2><small>' + steps.length + ' emails · ' + live + ' approved</small></div>' + cmpStatus_(b) + '</header>' +
    '<div class="lc-cmp-mini">' + stages + '</div>' +
    '<footer><span class="lc-cmp-next">' + CMP_ICON.cal + (nb ? lcEsc_(nb.count + ' start ' + batDayLabel_(nb.start_on)) : 'No batches lined up') + '</span>' +
    (lcCan_('edit_contacts') ? '<button class="lc-btn sm primary" data-act="cmp-batch" data-id="' + b + '">' + CMP_ICON.plus + 'Start a batch</button>' : '') + '</footer></article>';
}

function cmpPage_(b) {
  const p = cmpPeople_(b);
  const head = '<div class="lc-cmp-head"><button class="lc-back" data-act="cmp-back">' + CMP_ICON.back + 'Campaigns</button>' +
    '<div class="lc-cmp-title"><span class="lc-bkt">' + b + '</span><h2>' + LC_SEQ[b] + '</h2>' + cmpStatus_(b) + '</div>' +
    '<div class="lc-cmp-acts"><div class="lc-seg" role="group" aria-label="View">' + [['list', 'List'], ['calendar', 'Calendar']].map(([k, l]) =>
      '<button data-act="cmp-view" data-view="' + k + '" class="' + (CMP.view === k ? 'on' : '') + '">' + l + '</button>').join('') + '</div>' +
    (lcCan_('edit_contacts') ? '<button class="lc-btn primary" data-act="cmp-batch" data-id="' + b + '">' + CMP_ICON.plus + 'Start a batch</button>' : '') + '</div></div>';
  const pipe = '<div class="lc-pipe" role="tablist" aria-label="Where people are">' + CMP_STAGES.map(([k, l, hint], i) =>
    '<button role="tab" aria-selected="' + (CMP.stage === k) + '" data-act="cmp-stage" data-stage="' + k + '" class="' + (CMP.stage === k ? 'on' : '') + (i > 2 ? ' end' : '') + '">' +
    '<b>' + cmpCount_(p, k) + '</b><span>' + l + '</span><small>' + hint + '</small></button>').join('') + '</div>';
  return head + pipe + (CMP.view === 'calendar' ? cmpCalendar_(b) : cmpList_(b, p));
}

function cmpList_(b, p) {
  const fc = cmpForecast_(b), dates = Object.keys(fc).sort();
  const nextOf = id => { for (const d of dates) { const e = fc[d].sends[id]; if (e) return { d, n: cmpSendCount_(e) }; } return null; };
  const emails = cmpSteps_(b).map(s => {
    const t = s.tracking || {}, n = nextOf(s.step_id);
    return '<button class="lc-cmp-em" data-act="step" data-id="' + lcEsc_(s.step_id) + '"><span class="lc-step">' + s.order + '</span><div class="main"><b>' + lcEsc_(s.name) + '</b><small>' +
      lcEsc_(cmpWhen_(s)) + '</small></div><div class="nums">' + (s.published ? '<span><b>' + s.counts.sent + '</b> sent</span><span><b>' + (t.clicked || 0) + '</b> clicked</span><span><b>' + (t.replied || 0) + '</b> replied</span>'
      : lcTag_('Not approved', '')) + '</div><div class="next">' + (n ? '<b>' + lcEsc_(batDayLabel_(n.d)) + '</b><small>' + n.n + (n.n === 1 ? ' person' : ' people') + '</small>' : '<small>Nothing planned</small>') + '</div></button>';
  }).join('');
  return '<div class="lc-cmp-cols"><section class="lc-card"><div class="lc-card-h"><h3>Batches</h3><small>' + cmpCount_(p, 'lined') + ' lined up</small></div>' + cmpBatches_(b) + '</section>' +
    '<section class="lc-card"><div class="lc-card-h"><h3>Emails</h3><small>Next send</small></div><div class="lc-cmp-ems">' + emails + '</div></section></div>' + cmpStageTable_(b, p);
}

function cmpBatches_(b) {
  const list = ((LC.contacts && LC.contacts.batches) || []).filter(x => x.group === b && x.status !== 'cancelled')
    .sort((x, y) => (x.status === 'planned') === (y.status === 'planned') ? String(x.status === 'planned' ? x.start_on : y.start_on).localeCompare(x.status === 'planned' ? y.start_on : x.start_on) : x.status === 'planned' ? -1 : 1);
  if (!list.length) return '<div class="lc-empty">No batches yet.' + (lcCan_('edit_contacts') ? ' <button class="lc-link" data-act="cmp-batch" data-id="' + b + '">Start one</button>' : '') + '</div>';
  return '<ol class="lc-btl">' + list.slice(0, 8).map(x => {
    const f = x.filters || {}, what = [].concat(f.area || [], f.tags || [], f.source || []).join(', ');
    const planned = x.status === 'planned', d = planned ? x.start_on : cmpLocal_(x.started_at);
    const dt = new Date(d + 'T12:00:00');
    return '<li class="' + (planned ? 'planned' : 'done') + '"><time><b>' + dt.getDate() + '</b><span>' + dt.toLocaleDateString('en-US', { month: 'short' }) + '</span></time>' +
      '<div class="main"><b>' + (planned ? x.count : (x.started_count || x.count)) + ' people' + (what ? ' · ' + lcEsc_(what) : '') + '</b><small>' +
      (planned ? (x.pick === 'at_start' ? 'Picked that morning' : 'People chosen') + ' · ' + (x.order === 'oldest' ? 'oldest first' : 'random') : 'Started') + '</small></div>' +
      (planned ? lcTag_('Planned', 'warn') + (lcCan_('edit_contacts') ? '<button class="lc-btn sm danger" data-act="cancelbatch" data-id="' + lcEsc_(x.batch_id) + '">Cancel</button>' : '') : lcTag_('Started', 'live')) + '</li>';
  }).join('') + '</ol>';
}

function cmpStageTable_(b, p) {
  const rows = p[CMP.stage] || [];
  const label = (CMP_STAGES.find(s => s[0] === CMP.stage) || [])[1];
  const fc = cmpForecast_(b), next = {};
  Object.keys(fc).sort().forEach(d => Object.values(fc[d].sends).forEach(e => e.people.forEach(c => { if (!next[c.contact_id]) next[c.contact_id] = { d, s: e.step }; })));
  const head = '<div class="lc-card-h"><h3>' + lcEsc_(label) + '</h3><small>' + rows.length + (rows.length === 1 ? ' person' : ' people') +
    (CMP.stage === 'lined' && p.later ? ' · ' + p.later + ' more picked on their start day' : '') + '</small></div>';
  if (!rows.length) return '<section class="lc-card" style="margin-top:16px">' + head + '<div class="lc-empty">No one here.</div></section>';
  const col = { waiting: 'Added', lined: 'Starts', active: 'Next email', finished: 'Last email', stopped: 'Why' }[CMP.stage];
  const cell = c => {
    if (CMP.stage === 'active') { const n = next[c.contact_id]; return n ? lcEsc_(n.s.name) + ' <span class="lc-dim">· ' + lcEsc_(batDayLabel_(n.d)) + '</span>' : '<span class="lc-dim">–</span>'; }
    if (CMP.stage === 'stopped') return lcTag_(lcStopWord_(c.sequence.stop_reason), 'warn');
    if (CMP.stage === 'lined') { const x = (LC.contacts.batches || []).find(y => y.status === 'planned' && (y.contact_ids || []).includes(c.contact_id)); return x ? lcEsc_(batDayLabel_(x.start_on)) : ''; }
    if (CMP.stage === 'finished') return c.last_email ? lcEsc_(lcDay_(c.last_email.sent_at)) : '';
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
  const fc = cmpForecast_(b);
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
      day.batches.forEach(x => chips.push('<span class="lc-cal-chip batch"' + (can && x.status === 'planned' ? ' draggable="true" data-drag="' + lcEsc_(x.batch_id) + '"' : '') + '><em>Batch starts</em><b>' + x.count + '</b></span>'));
      Object.values(day.sends).sort((a, c) => a.step.order - c.step.order).forEach(e => chips.push('<span class="lc-cal-chip' + (e.step.published ? '' : ' draft') + '" title="' + lcEsc_(e.step.name) + '"><i>' + e.step.order + '</i><em>' + lcEsc_(e.step.name) + '</em><b>' + cmpSendCount_(e) + '</b></span>'));
    }
    const more = chips.length > 3 ? '<span class="lc-cal-more">+' + (chips.length - 3) + ' more</span>' : '';
    cells += '<button class="lc-cal-d' + (past ? ' past' : '') + (other ? ' other' : '') + (d === today ? ' today' : '') + (d === CMP.day ? ' sel' : '') + '" data-act="cmp-day" data-day="' + d + '"' +
      (past ? ' disabled' : '') + ' data-drop="' + d + '"><span class="n">' + dt.getDate() + '</span>' + chips.slice(0, 3).join('') + more + '</button>';
  }
  const grid = '<section class="lc-card lc-cal"><div class="lc-cal-h"><h3>' + title + '</h3><div class="lc-cal-nav">' +
    '<button class="lc-btn sm" data-act="cmp-today">Today</button><button class="lc-icon-btn" data-act="cmp-month" data-dir="-1" aria-label="Previous month">' + CMP_ICON.back + '</button>' +
    '<button class="lc-icon-btn" data-act="cmp-month" data-dir="1" aria-label="Next month">' + LC_ICON.chev + '</button></div></div>' +
    '<div class="lc-cal-w">' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(w => '<span>' + w + '</span>').join('') + '</div><div class="lc-cal-g">' + cells + '</div>' +
    '<div class="lc-cal-key"><span><i class="batch"></i>Batch starts</span>' + cmpSteps_(b).map(s => '<span><i class="n">' + s.order + '</i>' + lcEsc_(s.name) + (s.published ? '' : ' <span class="lc-dim">(not approved)</span>') + '</span>').join('') + (can ? '<span class="hint">Click a day to start a batch on it · drag a batch to move it</span>' : '') + '</div></section>';
  return '<div class="lc-cal-wrap' + (CMP.day ? ' has-day' : '') + '">' + grid + (CMP.day ? cmpDayPanel_(b, fc[CMP.day], CMP.day) : '') + '</div>';
}

function cmpDayPanel_(b, day, d) {
  const can = lcCan_('edit_contacts');
  const batches = (day ? day.batches : []).map(x => '<div class="lc-day-batch"><div><b>' + x.count + ' people start</b><small>' +
    (x.pick === 'at_start' ? 'Picked that morning' : 'People chosen') + ' · ' + (x.order === 'oldest' ? 'oldest first' : 'random') + '</small></div>' +
    (can ? '<div class="acts"><label class="lc-move"><span>Move to</span><input class="lc-input" type="date" min="' + batToday_() + '" value="' + x.start_on + '" data-cmp-move="' + lcEsc_(x.batch_id) + '"></label>' +
      '<button class="lc-btn sm danger" data-act="cancelbatch" data-id="' + lcEsc_(x.batch_id) + '">Cancel</button></div>' : '') + '</div>').join('');
  const sends = day ? Object.values(day.sends).sort((a, c) => a.step.order - c.step.order).map(e => '<details class="lc-day-send" open><summary><b>' + lcEsc_(e.step.name) + '</b><span>' + cmpSendCount_(e) + '</span></summary>' +
    (e.step.published ? '' : '<p class="lc-day-draft">Not approved yet: nothing goes out until it is.</p>') + '<ul>' +
    e.people.slice(0, 50).map(c => '<li><div class="row"><span class="who">' + lcEsc_(cmpName_(c)) + '</span>' + (can ? '<button class="lc-btn sm" data-act="cmp-more">Change</button></div><span class="acts"><button class="lc-btn sm" data-act="cmp-send" data-do="skip" data-id="' + lcEsc_(c.contact_id) + '" data-step="' + lcEsc_(e.step.step_id) + '">Skip</button>' +
      '<button class="lc-btn sm" data-act="cmp-send" data-do="move" data-id="' + lcEsc_(c.contact_id) + '" data-step="' + lcEsc_(e.step.step_id) + '">Move</button>' +
      '<button class="lc-btn sm" data-act="cmp-send" data-do="next_run" data-id="' + lcEsc_(c.contact_id) + '" data-step="' + lcEsc_(e.step.step_id) + '">Send next run</button></span>' : '</div>') + '</li>').join('') +
    (e.extra ? '<li><span class="who lc-dim">' + e.extra + ' people picked on their start day</span></li>' : '') + '</ul></details>').join('') : '';
  return '<aside class="lc-card lc-day"><div class="lc-card-h"><h3>' + lcEsc_(cmpLong_(d)) + '</h3><button class="lc-icon-btn" data-act="cmp-day-close" aria-label="Close">' + LC_ICON.x + '</button></div>' +
    '<div class="lc-day-b">' + batches + sends +
    (!batches && !sends ? '<div class="lc-empty">Nothing planned on this day.</div>' : '') +
    (can ? '<button class="lc-btn primary lc-day-new" data-act="cmp-batch" data-id="' + b + '" data-day="' + d + '">' + CMP_ICON.plus + 'Start a batch on ' + lcEsc_(batDayLabel_(d)) + '</button>' : '') + '</div></aside>';
}

// ── Actions ───────────────────────────────────────────────────────────────────
function cmpOnClick_(t) {
  const a = t.dataset.act;
  if (a === 'cmp-open') { CMP.id = t.dataset.id; CMP.stage = 'active'; CMP.day = ''; lcRenderBody_(); window.scrollTo({ top: 0 }); }
  else if (a === 'cmp-back') { CMP.id = ''; CMP.day = ''; lcRenderBody_(); }
  else if (a === 'cmp-view') { CMP.view = t.dataset.view; CMP.day = ''; lcRenderBody_(); }
  else if (a === 'cmp-stage') { CMP.stage = t.dataset.stage; lcRenderBody_(); }
  else if (a === 'cmp-batch') lcOpenBatch_({ group: t.dataset.id, start_on: t.dataset.day || '' });
  else if (a === 'cmp-month') { const [y, m] = CMP.month.split('-').map(Number), d = new Date(y, m - 1 + Number(t.dataset.dir), 1); CMP.month = d.toLocaleDateString('en-CA').slice(0, 7); CMP.day = ''; lcRenderBody_(); }
  else if (a === 'cmp-today') { CMP.month = batToday_().slice(0, 7); CMP.day = ''; lcRenderBody_(); }
  else if (a === 'cmp-day') {
    const d = t.dataset.day, fc = cmpForecast_(CMP.id);
    // An empty day goes straight to setup; a day with plans shows them first.
    if (!fc[d] && lcCan_('edit_contacts')) lcOpenBatch_({ group: CMP.id, start_on: d });
    else { CMP.day = CMP.day === d ? '' : d; lcRenderBody_(); }
  }
  else if (a === 'cmp-day-close') { CMP.day = ''; lcRenderBody_(); }
  else if (a === 'cmp-more') t.closest('li').classList.toggle('open');
  else if (a === 'cmp-send') lcToast_('Per-send changes are not connected yet');
}
async function cmpMoveBatch_(id, to) {
  const x = ((LC.contacts && LC.contacts.batches) || []).find(y => y.batch_id === id);
  if (!x || !to || to === x.start_on) return;
  if (to < batToday_()) return lcToast_('Pick today or a later day', true);
  if (!await lcConfirm_({ title: 'Move ' + x.count + ' people to ' + batDayLabel_(to) + '?', ok: 'Move',
    body: 'Their first email goes out on ' + cmpLong_(to) + ' instead of ' + cmpLong_(x.start_on) + '.' })) { lcRenderBody_(); return; }
  lcToast_('Moving batches is not connected yet');
  lcRenderBody_();
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
