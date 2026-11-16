// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE EMAIL — people waiting on a person's yes (Plan changes 2026-11-12)
//
//   awaiting_approval  imported after getting the MCP Legacy Intro by hand; they never
//                      get it again and start at the Follow Up once approved
//   late               a planned start date from the file has passed (no batch was made)
//   flagged            held out of batches with the reason from the file
//
// Banner on Activity and Contacts (from the overview's `waiting`), status tags and
// filters in the Contacts list, and the Approve / Clear flag actions
// (engine Admin.js → approve_waiting, clear_flag).
// ══════════════════════════════════════════════════════════════════════════════

const WT_TODAY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const wtDay_ = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const wtDaysSince_ = d => Math.max(0, Math.round((Date.parse(WT_TODAY() + 'T12:00:00Z') - Date.parse(d + 'T12:00:00Z')) / 86400000));
function wtPlus_(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }

// Which waiting group a contact is in, or ''.
function wtKind_(c) {
  if (c.review_status === 'awaiting_approval') return c.followup_sent_on ? 'awaiting_checkin' : 'awaiting_approval';
  if (c.review_status === 'flagged') return 'flagged';
  if (c.review_status === 'needs_review' && c.planned_start && c.planned_start < WT_TODAY()) return 'late';
  // Approved but not started yet: the next run starts them. Undo approval is still possible.
  if (c.review_status === 'confirmed' && /^approved by /.test(c.review_reason || '') && !c.sequence) return 'approved';
  return '';
}
// The Contacts list's review filter: Needs review, or one of the waiting groups.
function wtReviewMatch_(c) {
  if (!LC.review) return true;
  if (LC.review === 'needs_review') return c.review_status === 'needs_review';
  return wtKind_(c) === LC.review;
}
// Status tag for someone not yet in a sequence; '' = use the usual one.
function wtStatusTag_(c) {
  const k = wtKind_(c);
  if (k === 'awaiting_checkin') {
    const due = wtPlus_(c.followup_sent_on, 9), late = wtDaysSince_(due);
    return lcTag_('Waiting for approval', 'warn') + '<small class="wt-sub">Intro ' + lcEsc_(wtDay_(c.intro_sent_on)) + ' · Follow Up ' + lcEsc_(wtDay_(c.followup_sent_on)) +
      ' · Check-In ' + (late ? 'overdue ' + late + ' d' : 'due ' + lcEsc_(wtDay_(due))) + '</small>';
  }
  if (k === 'awaiting_approval') {
    const due = c.intro_sent_on ? wtPlus_(c.intro_sent_on, 4) : '';
    return lcTag_('Waiting for approval', 'warn') + (due ? '<small class="wt-sub">Intro ' + lcEsc_(wtDay_(c.intro_sent_on)) + ' · Follow Up overdue ' + wtDaysSince_(due) + ' d</small>' : '');
  }
  if (k === 'flagged') return '<span title="' + lcEsc_(c.flag_reason || c.review_reason || '') + '">' + lcTag_('Flagged', 'warn') + '</span><small class="wt-sub">' + lcEsc_(c.flag_reason || c.review_reason || '') + '</small>';
  if (k === 'approved') return lcTag_('Approved · not sent yet', 'live') + '<small class="wt-sub">' + (() => { const m = /^approved by (.+) on (\d{4}-\d{2}-\d{2})/.exec(c.review_reason || ''); return m ? 'By ' + lcEsc_(m[1]) + ' · ' + lcEsc_(wtDay_(m[2])) + ' · ' : ''; })() + 'Starts at the next run.</small>';
  if (k === 'late') return lcTag_('Start overdue', 'warn') + '<small class="wt-sub">Planned ' + lcEsc_(wtDay_(c.planned_start)) + '</small>';
  if (c.review_status === 'needs_review' && c.planned_start) return lcTag_('Planned', '') + '<small class="wt-sub">' + lcEsc_(wtDay_(c.planned_start)) + '</small>';
  return '';
}

// The banner: one line per waiting group, each opening the filtered list.
function wtBanner_() {
  const w = LC.ov && LC.ov.waiting;
  if (!w || !(w.intro_done || w.followup_done || (w.late_starts || []).length || w.flagged || w.approved)) return '';
  const lateN = (w.late_starts || []).reduce((n, x) => n + x.count, 0);
  const line = (n, title, sub, filter) => '<li><span class="lc-li-ic warn">' + LC_ICON.alert + '</span><div class="main"><b>' + title + '</b><small>' + sub + '</small></div>' +
    '<button class="lc-btn sm" data-act="wt-show" data-key="' + filter + '">Review ' + n + '</button></li>';
  return '<div class="lc-card wt-banner"><div class="lc-card-h"><h3>Waiting for your approval</h3><small>Nothing goes to these people until someone approves them</small></div><ul class="lc-list">' +
    (w.intro_done ? line(w.intro_done, w.intro_done + (w.intro_done === 1 ? ' person' : ' people') + ' already got the Intro by hand',
      'Follow Up overdue' + (w.followup_due_since ? ' since ' + lcEsc_(wtDay_(w.followup_due_since)) : '') + '. Approve them to send the Follow Up, then the Check-In. They never get the Intro again.', 'awaiting_approval') : '') +
    (w.followup_done ? line(w.followup_done, w.followup_done + (w.followup_done === 1 ? ' person' : ' people') + ' already got the Intro and the Follow Up by hand',
      'Check-In ' + (w.checkin_due_since && w.checkin_due_since <= WT_TODAY() ? 'due since ' : 'due ') + lcEsc_(wtDay_(w.checkin_due_since)) + '. Approve them to send the Personal Check-In. They never get the first two again.', 'awaiting_checkin') : '') +
    (lateN ? line(lateN, lateN + (lateN === 1 ? ' person’s' : ' people’s') + ' planned start has passed',
      'Planned for ' + w.late_starts.map(x => lcEsc_(wtDay_(x.date)) + ' (' + x.count + ')').join(', ') + '. Approve to start them with the Intro.', 'late') : '') +
    (w.approved ? line(w.approved, w.approved + (w.approved === 1 ? ' person' : ' people') + ' approved, nothing sent yet',
      'They start at the next run. Undo the approval, or mark an email they already got by hand, before then.', 'approved') : '') +
    (w.flagged ? line(w.flagged, w.flagged + ' flagged in the file', 'Possible business, duplicate, bounced or excluded. Batches skip them until the flag is cleared.', 'flagged') : '') +
    '</ul></div>';
}

// Filter chips next to Needs review, and the action bar for the open waiting filter.
function wtChips_() {
  if (!LC.contacts) return '';
  const all = LC.contacts.contacts, n = k => all.filter(c => wtKind_(c) === k).length;
  return [['awaiting_approval', 'Follow Up next'], ['awaiting_checkin', 'Check-In next'], ['late', 'Start overdue'], ['approved', 'Approved, not sent yet'], ['flagged', 'Flagged']].map(([k, l]) => {
    const c = n(k);
    if (LC.review !== k) return '';            // the banner's Review buttons open these; the chip only shows the open filter
    return '<button class="lc-btn sm' + (LC.review === k ? ' primary' : '') + '" data-act="wt-show" data-key="' + k + '">' + l + ' · ' + c + ' ✕</button>';
  }).join('');
}
function wtActionBar_(rows) {
  if (!lcCan_('edit_contacts') || !['awaiting_approval', 'awaiting_checkin', 'late', 'flagged', 'approved'].includes(LC.review)) return '';
  const pick = wtPicked_(rows);
  const what = pick.length === rows.length ? 'all ' + rows.length + ' shown' : pick.length + ' selected';
  if (!pick.length) return '';
  // Sent by hand: the email they'd get next, when it's one the engine can record.
  const handStep = LC.review === 'awaiting_approval' ? 'b_followup' : LC.review === 'late' ? 'b_intro' : '';
  const hand = handStep && rows.every(c => c.bucket === 'B') ? '<button class="lc-btn" data-act="wt-hand" data-step="' + handStep + '">' + (handStep === 'b_intro' ? 'Intro' : 'Follow Up') + ' sent by hand…</button>' : '';
  if (LC.review === 'approved') {
    const fu = rows.filter(c => pick.includes(c.contact_id)).every(c => c.bucket === 'B' && c.intro_sent_on && !c.followup_sent_on);
    return '<div class="wt-bar"><span>Nothing has gone to them yet. Undo puts them back where they were waiting.</span>' +
      (fu ? '<button class="lc-btn" data-act="wt-hand" data-step="b_followup">Follow Up sent by hand…</button>' : '') +
      '<button class="lc-btn danger" data-act="wt-unapprove">Undo approval · ' + what + '</button></div>';
  }
  return '<div class="wt-bar">' + (LC.review === 'flagged'
    ? '<span>Clearing a flag puts them back in line. Nobody is emailed until they’re in a batch or approved.</span><button class="lc-btn" data-act="wt-unflag">Clear flag · ' + what + '</button>'
    : '<span>' + (LC.review === 'awaiting_approval' ? 'They get the Follow Up at today’s send time, then the Check-In.' : LC.review === 'awaiting_checkin' ? 'They get the Personal Check-In at today’s send time.' : 'They get the Intro at today’s send time.') + '</span>' + hand + '<button class="lc-btn primary" data-act="wt-approve">Approve ' + what + '</button>') + '</div>';
}
// The selected people among the shown rows, or all shown when nothing is selected.
function wtPicked_(rows) {
  const sel = typeof TAGS !== 'undefined' && TAGS.sel ? rows.filter(c => TAGS.sel.has(c.contact_id)) : [];
  return (sel.length ? sel : rows).map(c => c.contact_id);
}
function wtShownRows_() {
  return (LC.contacts ? LC.contacts.contacts : []).filter(c => (!LC.bucket || c.bucket === LC.bucket) && wtReviewMatch_(c));
}

async function wtAct_(act, t) {
  if (act === 'wt-show') {
    LC.review = LC.review === t.dataset.key && LC.tab === 'contacts' ? '' : t.dataset.key;
    if (LC.tab !== 'contacts') { LC.tab = 'contacts'; if (!LC.contacts) lcLoadContacts_(); lcRenderTabs_(); }
    lcRenderBody_();
    return;
  }
  const ids = wtPicked_(wtShownRows_());
  if (!ids.length) return;
  if (act === 'wt-approve') {
    const intro = LC.review === 'awaiting_approval', check = LC.review === 'awaiting_checkin';
    const r = await lcConfirm_({ title: 'Approve ' + ids.length + (ids.length === 1 ? ' person' : ' people') + '?',
      body: check ? 'They already got the Intro and the Follow Up by hand, so they never get those again. The Personal Check-In goes out at today’s send time (or the next run). A reply stops it.'
        : intro ? 'They already got the Intro by hand, so they never get it again. The Follow Up goes out at today’s send time (or the next run if that has passed), then the Check-In 9 days later. A reply stops both.'
        : 'Their planned start has passed. They get the Intro at today’s send time (or the next run), then the rest of MCP Legacy.',
      ok: 'Approve', run: () => lcAdmin_('approve_waiting', { contact_ids: ids }) });
    if (!r || !r.ok) return;
    lcToast_(r.approved + ' approved' + ((r.skipped || []).length ? ' · ' + r.skipped.length + ' skipped (' + r.skipped[0].reason + ')' : '') + '.');
  } else if (act === 'wt-unapprove') {
    const r = await lcConfirm_({ title: 'Undo approval for ' + ids.length + (ids.length === 1 ? ' person' : ' people') + '?',
      body: 'Nothing has been sent to them. They go back to waiting, exactly where they were, until someone approves them again.',
      ok: 'Undo approval', danger: true, run: () => lcAdmin_('unapprove_waiting', { contact_ids: ids }) });
    if (!r || !r.ok) return;
    lcToast_(r.undone + ' back to waiting' + ((r.skipped || []).length ? ' · ' + r.skipped.length + ' skipped (' + r.skipped[0].reason + ')' : '') + '.');
  } else if (act === 'wt-hand') {
    const step = t.dataset.step, name = step === 'b_intro' ? 'Intro' : 'Follow Up', next = step === 'b_intro' ? 'Follow Up' : 'Personal Check-In';
    const r = await lcConfirm_({ title: name + ' sent by hand to ' + ids.length + (ids.length === 1 ? ' person' : ' people') + '?',
      html: '<p>The engine records it and never sends them the ' + name + '. They wait for approval again, with the ' + next + ' as their next email.</p>' +
        '<label class="lc-fld"><span>Sent on</span><input class="lc-input" type="date" data-hand-date value="' + WT_TODAY() + '" max="' + WT_TODAY() + '"></label>',
      ok: 'Record it', run: layer => lcAdmin_('mark_hand_sent', { contact_ids: ids, step_id: step, date: layer.querySelector('[data-hand-date]').value }) });
    if (!r || !r.ok) return;
    lcToast_(r.marked + ' recorded' + ((r.skipped || []).length ? ' · ' + r.skipped.length + ' skipped (' + r.skipped[0].reason + ')' : '') + '.');
  } else if (act === 'wt-unflag') {
    const r = await lcConfirm_({ title: 'Clear the flag for ' + ids.length + (ids.length === 1 ? ' person' : ' people') + '?',
      body: 'Only if you’ve checked them. They go back to Needs review (or Waiting for approval, if they already got the Intro). Nobody is emailed by this.',
      ok: 'Clear flag', run: () => lcAdmin_('clear_flag', { contact_ids: ids }) });
    if (!r || !r.ok) return;
    lcToast_(r.cleared + ' cleared.');
  }
  if (typeof TAGS !== 'undefined' && TAGS.sel) TAGS.sel.clear();
  LC.contacts = null; lcLoadContacts_(true); lcRefresh_(true);
}
