// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE HELP — the guided tour and "Request a change" (PLAN.md → Plan changes
// 2026-11-11: handoff to Tony). Tony is the main user, so the page has to explain
// itself, and anything he wants changed reaches Mau with enough context to act on.
//
//   Tour      Driver.js (vendored, also used by js/features/tour.js) over the real
//             screens, in short chapters. Help (header) restarts any chapter; the
//             chapters someone has seen are remembered per user on this device.
//   Request   a corner button on every Lifecycle screen → a panel: what to change,
//             "Point at it" (click the part you mean), files, and an automatic
//             screenshot with that part outlined. Sent through api/email.js
//             (op=request): saved privately, emailed to Mau from the portal's own
//             Gmail, never through the engine (it sends as Tony).
// Depends on lifecycle.js (LC, lcEsc_, lcToast_, lcRenderTabs_, lcRenderBody_).
// ══════════════════════════════════════════════════════════════════════════════

const HLP = { menu: false, offer: null, rq: null, d: null, doing: null };
const HLP_ICON = {
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
  msg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
};

// ── Tour ──────────────────────────────────────────────────────────────────────
// Interactive: a "do" step highlights a real button and waits for the person to
// click it (Next is hidden); the tour moves on once the screen it opens is there.
// "Look" steps lock the page under the highlight, so a stray click can't run
// anything or end the tour. Only safe clicks are ever asked for (opening tabs,
// campaigns, emails, people; the batch wizard is opened and then cancelled).
const hlp$ = sel => document.querySelector(sel);
const hlpCard_ = title => () => [...document.querySelectorAll('.lc .lc-card')].find(c => { const h = c.querySelector('h3'); return h && h.textContent.trim() === title; });
const hlpGone_ = sel => () => !document.querySelector(sel);
const hlpSec_ = heading => () => [...document.querySelectorAll('.lc-drawer .lc-sec')].find(s => { const h = s.querySelector('h4'); return h && h.textContent.trim().startsWith(heading); });
const HLP_CHAPTERS = [
  { id: 'start', title: 'The basics', steps: [
    { title: 'Welcome to Lifecycle Email', text: 'This page runs MCPS’s automatic emails: <b>MCP Legacy</b> for past MCP customers and <b>MCP Startup</b> for new pool owners. They go out from your Gmail on a schedule, and stop by themselves when someone replies, clicks or unsubscribes.<br><br>This tour has you click through the real page. Nothing is changed or sent.' },
    { el: '.lc [data-lc="tabs"]', title: 'Four tabs', text: '<b>Campaigns</b>: start and plan sends. <b>Emails</b>: each email’s wording, approval and timing. <b>Activity</b>: what went out and anything that needs you. <b>Contacts</b>: everyone on the lists.' },
    { el: '.lc .lc-status .lc-pill:not(.test)', title: 'Is everything OK?', text: 'Green means the last send went fine. If something needs you, this turns amber or red; click it to see what.' }
  ] },
  { id: 'campaigns', title: 'Campaigns and batches', start: 'campaigns', steps: [
    { el: '.lc [data-act="cmp-open"][data-id="B"]', title: 'Open a campaign', text: 'Each card is one series of emails.', click: 'the MCP Legacy card', next: '.lc .lc-pipe' },
    { el: '.lc .lc-pipe', title: 'Where everyone is', text: '<b>Waiting</b>: imported, not started. <b>Lined up</b>: in a planned batch. <b>In sequence</b>: getting the emails. <b>Finished</b>, or <b>Stopped</b> because they replied, clicked or unsubscribed. Click a stage to see the people in it.' },
    { el: '.lc [data-act="cmp-view"][data-view="calendar"]', title: 'The calendar', text: 'Every planned email, by day.', click: 'Calendar', next: '.lc [data-act="cmp-day"]' },
    { el: '.lc .lc-cal, .lc [data-act="cmp-day"]', title: 'Plan by day', text: 'Click a day to see who gets what. There you can <b>Skip</b> one person, <b>Move</b> them to another day, or <b>Send in the next run</b>. Drag a batch to another day to move all of it.' },
    { el: '.lc [data-lc="body"] [data-act="cmp-batch"]', title: 'Start a batch', text: 'This is how people get the series.', click: 'Start a batch', next: '.lc-wiz .lc-steps' },
    { el: '.lc-wiz .lc-steps', title: 'Four short steps', text: '<b>Who</b> (and how many), <b>When</b> (one day, or several batches a week apart), <b>People</b> (check the list), <b>Review</b>. Nothing is sent until the start day, and a planned batch can be moved or cancelled.' },
    { el: '.lc-wiz .lc-imp-h [data-bat="close"]', title: 'Close it for now', text: 'You’ll start real batches when you’re ready.', click: 'the ✕', next: hlpGone_('.lc-wiz') },
    { el: '.lc [data-act="cmp-back"]', title: 'Back to all campaigns', text: '', click: 'All campaigns', next: '.lc .lc-cmp-card' }
  ] },
  { id: 'emails', title: 'Emails and approval', start: 'campaigns', steps: [
    { el: '.lc [data-lc="tabs"] [data-tab="emails"]', title: 'The Emails tab', text: 'Every email, its status and how it’s doing.', click: 'Emails', next: '.lc [data-act="step"]' },
    { el: '.lc [data-lc="body"] table', title: 'Each email', text: '<b>Live</b> emails are approved and on. <b>Not approved</b> ones wait for their wording to be approved. The numbers show sends, opens, clicks and replies.' },
    { el: () => hlp$('.lc [data-act="step"][data-id="c_welcome"]') || hlp$('.lc [data-act="step"]'), title: 'Open an email', text: '', click: 'Welcome Email', next: '.lc-drawer [data-act="dtab"]' },
    { el: '.lc-drawer .lc-dr-tabs', title: 'Everything about one email', text: '<b>Performance</b> and <b>Recipients</b> show how it’s doing and who got it. <b>Templates</b> is the wording. <b>Setup</b> is when it sends.' },
    { el: '.lc-drawer [data-act="dtab"][data-tab="templates"]', title: 'The wording', text: '', click: 'Templates', next: '.lc-drawer [data-act^="tpl-"]' },
    { el: '.lc-drawer', title: 'Change the wording safely', text: '<b>Edit</b> opens the email as people will see it: click any text and type. Your change is saved as a <b>draft</b>. Nothing changes until it’s <b>approved</b>, and the old version stays in history.' },
    { el: hlpSec_('In Drive'), title: 'Templates from Google Drive', text: 'Wrote an email somewhere else, like in ChatGPT? Save it as an .html file in Google Drive → <b>MCPS Marketing → Email Templates</b> → the campaign → this email’s folder, and it shows up here. <b>Preview</b> checks it, <b>Use as draft</b> turns it into a draft, and it still needs approval before anyone gets it.' },
    { el: '.lc-drawer [data-act="dtab"][data-tab="setup"]', title: 'The timing', text: '', click: 'Setup', next: '.lc-drawer [data-act="setup-edit"]' },
    { el: '.lc-drawer', title: 'When it sends', text: 'When it goes out, what stops it, and <b>On / Off</b>. <b>Change</b> edits it; when you save, pick who it applies to. “Only people who join from now on” is the safe choice, and nobody ever gets the same email twice.' },
    { el: '.lc-drawer [data-act="close"]', title: 'Close the email', text: '', click: 'the ✕', next: hlpGone_('.lc-drawer') },
    { el: '.lc [data-act="att-open"]', title: 'Files that go with an email', text: 'PDFs your emails carry.', click: 'Attachments', next: '.lc-att .lc-imp-h' },
    { el: '.lc-att .lc-imp-h', title: 'Like the Welcome email’s guides', text: 'The Welcome email can carry the <b>Safety Guidelines</b> and the <b>Startup Guide</b> PDFs. To add one, drop the PDF into Google Drive → <b>MCPS Marketing → Email Attachments</b>, then <b>Add</b> it here and approve it. To send it with an email, pick it when you edit that email. Uploading a newer version of a PDF only needs that PDF approved, not the email again.' },
    { el: '.lc-att [data-act="att-close"][aria-label="Close"]', title: 'Close it', text: '', click: 'the ✕', next: hlpGone_('.lc-att') }
  ] },
  { id: 'activity', title: 'Activity and problems', start: 'campaigns', steps: [
    { el: '.lc [data-lc="tabs"] [data-tab="activity"]', title: 'The Activity tab', text: 'What went out, and anything that needs you.', click: 'Activity', next: hlpCard_('Health') },
    { el: '.lc .lc-ctrls', title: 'Pause anytime', text: 'These switches stop all sending, or one series. Paused emails just wait; nothing is lost.' },
    { el: '.lc .lc-ctrl-run', title: 'Send due emails now', text: 'Emails go out by themselves at your send times. If something is already due and you don’t want to wait (say you just approved an email), this sends it right away. It never sends early and never twice, so you’ll rarely need it.' },
    { el: hlpCard_('Needs a decision'), title: 'When Gmail doesn’t confirm', text: 'Rarely a send isn’t confirmed. Check your Sent folder for it, then choose <b>Mark sent</b> or <b>Resend</b>. Resend waits a few minutes first, so nobody gets two.' },
    { el: hlpCard_('Change requests'), title: 'Your requests', text: 'Everything you send with <b>Request a change</b> is listed here, with whether Mau has done it.' }
  ] },
  { id: 'contacts', title: 'Contacts', start: 'campaigns', steps: [
    { el: '.lc [data-lc="tabs"] [data-tab="contacts"]', title: 'The Contacts tab', text: 'Everyone on the lists.', click: 'Contacts', next: '.lc [data-act="import"]' },
    { el: '.lc [data-act="import"]', title: 'Import your list', text: 'Drop in any spreadsheet. The page finds the columns, tidies names, and checks everyone against the list, the opt-outs and current customers. Anyone already here gets your newer details, so there are never duplicates. New people wait in <b>Needs review</b> until a batch picks them.' },
    { el: '.lc [data-act="contact"]', title: 'Open a person', text: '', click: 'a name', next: '.lc-drawer' },
    { el: '.lc-drawer', title: 'Their whole history', text: 'Every email they got, what they did with it, and why their emails stopped. You can add tags here to group people.' },
    { el: '.lc-drawer [data-act="close"]', title: 'Close', text: '', click: 'the ✕', next: hlpGone_('.lc-drawer') }
  ] },
  { id: 'rules', title: 'Good to know', start: 'campaigns', steps: [
    { title: 'A few rules', text: '<ul class="lc-hlp-list"><li>Don’t reply to test emails.</li><li>Don’t edit the engine’s spreadsheet by hand; use this page.</li><li>Replies and unsubscribes always stop the emails. That can’t be turned off.</li></ul>' },
    { el: '.lc-rq-fab', title: 'Request a change', text: 'Want something different, or something looks wrong? Click here, say what you want and point at the part you mean. Mau gets it with a screenshot.' },
    { el: '.lc [data-act="help"]', title: 'Come back anytime', text: '<b>Help</b> replays any part of this tour.' }
  ] }
];
const hlpKey_ = () => 'mcps_lc_tour_' + ((typeof _s !== 'undefined' && _s && _s.username) || 'me');
function hlpSeen_() { try { return JSON.parse(localStorage.getItem(hlpKey_()) || '{}'); } catch (_) { return {}; } }
function hlpMark_(id) { try { const s = hlpSeen_(); s[id] = new Date().toISOString(); localStorage.setItem(hlpKey_(), JSON.stringify(s)); } catch (_) { /* private window: the tour still works */ } }
function hlpDismissOffer_() { try { const s = hlpSeen_(); s._offer = 'no'; localStorage.setItem(hlpKey_(), JSON.stringify(s)); } catch (_) { /* fine */ } HLP.offer = false; hlpRenderOffer_(); }

// Header pieces, called from lifecycle.js (lcRenderHead_).
function hlpHeadBtn_() {
  return '<span class="lc-hlp-wrap"><button class="lc-btn sm ghost" data-act="help" aria-haspopup="menu" aria-expanded="' + HLP.menu + '">' + HLP_ICON.help + 'Help</button>' + (HLP.menu ? hlpMenu_() : '') + '</span>';
}
function hlpMenu_() {
  const seen = hlpSeen_();
  return '<div class="lc-hlp-menu" role="menu"><p>Take the tour, or replay one part. You click through the real page; nothing is changed.</p>' +
    HLP_CHAPTERS.map((c, i) => '<button role="menuitem" data-act="help-ch" data-id="' + c.id + '"><span class="n">' + (seen[c.id] ? HLP_ICON.check : (i + 1)) + '</span><span>' + lcEsc_(c.title) + '<small>' + c.steps.length + ' steps</small></span></button>').join('') +
    '<div class="lc-hlp-menu-f"><button class="lc-btn sm primary" data-act="help-ch" data-id="all">Start from the beginning</button></div></div>';
}
// First visit: a quiet offer above the tabs (never a popup on load).
function hlpRenderOffer_() {
  const el = LC.root && LC.root.querySelector('[data-lc="hlp"]'); if (!el) return;
  if (HLP.offer === null) { const s = hlpSeen_(); HLP.offer = !s._offer && !Object.keys(s).length; }
  el.innerHTML = HLP.offer ? '<div class="lc-hlp-offer">' + HLP_ICON.help + '<div><b>New here? Take the 5-minute tour.</b><span>You click through the real page, one step at a time. Nothing is changed or sent.</span></div>' +
    '<button class="lc-btn sm primary" data-act="help-ch" data-id="all">Start the tour</button><button class="lc-btn sm ghost" data-act="help-later">Not now</button></div>' : '';
}
function hlpAct_(t) {
  const act = t.dataset.act;
  if (act === 'help') { HLP.menu = !HLP.menu; lcRenderHead_(); return; }
  if (act === 'help-later') return hlpDismissOffer_();
  if (act === 'help-ch') { HLP.menu = false; HLP.offer = false; hlpRenderOffer_(); lcRenderHead_(); return hlpTour_(t.dataset.id); }
}
document.addEventListener('click', e => { if (HLP.menu && !e.target.closest('.lc-hlp-wrap')) { HLP.menu = false; lcRenderHead_(); } });

// A clean starting point: no drawer, no wizard, the campaign list.
function hlpReset_(tab) {
  if (LC.drawer && typeof lcCloseDrawer_ === 'function') lcCloseDrawer_();
  if (typeof BAT !== 'undefined' && BAT.layer && BAT.layer.isConnected) BAT.layer.remove();
  document.querySelectorAll('.lc-wiz').forEach(w => { const l = w.closest('.lc-layer'); if (l) l.remove(); });
  if (typeof CMP !== 'undefined') { CMP.id = ''; CMP.view = 'list'; CMP.day = ''; }
  LC.tab = tab || 'campaigns';
  lcRenderTabs_(); lcRenderBody_();
}
const hlpFind_ = el => typeof el === 'function' ? el() : el ? document.querySelector(el) : null;
// Waits (up to 8 s) for what a click opens, then moves on.
function hlpWait_(cond, done) {
  const ok = typeof cond === 'function' ? cond : () => document.querySelector(cond);
  const t0 = Date.now();
  (function poll() { if (!HLP.d) return; if (ok() || Date.now() - t0 > 8000) return done(); setTimeout(poll, 120); })();
}
// One listener for every "do" step: a click on the step's target advances the tour.
document.addEventListener('click', e => {
  const s = HLP.doing; if (!s || !HLP.d) return;
  const target = hlpFind_(s.el);
  if (!target || !(target === e.target || target.contains(e.target))) return;
  HLP.doing = null;
  if (s.last) hlpMark_(s.chapter.id);
  hlpWait_(s.next, () => { if (HLP.d && HLP.d.isActive()) HLP.d.moveNext(); });
}, true);

async function hlpTour_(which, startAt) {
  await Promise.all([!LC.contacts && typeof lcLoadContacts_ === 'function' ? lcLoadContacts_() : null, RQL.list === null ? rqLoadList_() : null].map(p => Promise.resolve(p).catch(() => {})));
  const chapters = which === 'all' ? HLP_CHAPTERS : HLP_CHAPTERS.filter(c => c.id === which);
  const steps = [];
  chapters.forEach(c => c.steps.forEach((s, i) => steps.push({ ...s, chapter: c, last: i === c.steps.length - 1 })));
  if (!steps.length || !window.driver || !window.driver.js) return lcToast_('The tour couldn’t load. Refresh the page and try again.', true);
  hlpReset_(chapters[0].start);
  const d = window.driver.js.driver({
    showProgress: true, progressText: '{{current}} of {{total}}', nextBtnText: 'Next', prevBtnText: 'Back', doneBtnText: 'Done',
    popoverClass: 'lc-tour', animate: !HLP.still, overlayOpacity: 0.45, stagePadding: 6, stageRadius: 10,
    allowClose: true, overlayClickBehavior: () => {},          // only ✕ or Esc end the tour
    steps: steps.map((s, i) => {
      const prev = steps[i - 1];
      return {
        element: s.el ? () => hlpFind_(s.el) || document.querySelector('.lc [data-lc="body"]') : undefined,
        disableActiveInteraction: !s.click,
        popover: {
          title: '<small>' + lcEsc_(s.chapter.title) + '</small>' + lcEsc_(s.title),
          description: (s.text || '') + (s.click ? '<p class="lc-tour-do">' + HLP_ICON.target + '<span>Click <b>' + lcEsc_(s.click) + '</b> to continue</span></p>' : ''),
          side: 'bottom', align: 'start',
          // A click step has no Next; Back only when the step before didn't change the screen.
          showButtons: (s.click ? [] : ['next']).concat(prev && !prev.click && prev.chapter === s.chapter ? ['previous'] : []).concat(['close']),
          onNextClick: () => { if (s.last) hlpMark_(s.chapter.id); d.moveNext(); }
        },
        onHighlightStarted: () => { HLP.doing = s.click ? s : null; }
      };
    }),
    onDestroyed: () => { HLP.d = null; HLP.doing = null; lcRenderHead_(); }
  });
  HLP.d = d;
  d.drive(startAt || 0);
}
// The page redrew under an open step (data arrived, a drawer filled in): point the step at the new element.
function hlpAfterRender_() {
  const d = HLP.d;
  if (!d || !d.isActive || !d.isActive() || HLP.reattach) return;
  HLP.reattach = true;
  setTimeout(() => { HLP.reattach = false; if (d.isActive()) { const i = d.getActiveIndex(); if (typeof i === 'number') d.moveTo(i); } }, 60);
}

// ── Request a change ──────────────────────────────────────────────────────────
const RQ_MAX_FILES = 3, RQ_MAX_BYTES = 3 * 1024 * 1024;
function rqMount_() {
  if (document.querySelector('.lc-rq-fab')) return;
  const b = document.createElement('button');
  b.className = 'lc-rq-fab lc-layer'; b.type = 'button';
  b.innerHTML = HLP_ICON.msg + '<span>Request a change</span>';
  b.addEventListener('click', () => rqOpen_());
  document.body.appendChild(b);
  rqSyncFab_();
}
// The button only shows on the Lifecycle page (the portal swaps pages without reloading).
function rqSyncFab_() {
  const b = document.querySelector('.lc-rq-fab'); if (!b) return;
  const page = document.getElementById('page-lifecycle');
  b.hidden = !!(page && page.offsetParent === null) || !!HLP.rq;
}
setInterval(rqSyncFab_, 800);

// Where the person is, so Mau can find it without asking.
function rqContext_() {
  const c = { tab: LC.tab, url: location.href, user: (typeof _s !== 'undefined' && _s && _s.username) || '', at: new Date().toISOString(),
    version: (document.querySelector('script[src*="lifecycle.js"]') || {}).src ? String(document.querySelector('script[src*="lifecycle.js"]').src).split('?v=')[1] || '' : '',
    screen: window.innerWidth + '×' + window.innerHeight };
  if (typeof CMP !== 'undefined' && CMP.id && LC.tab === 'campaigns') { c.campaign = (LC_SEQ && LC_SEQ[CMP.id]) || CMP.id; c.view = CMP.view || 'list'; if (CMP.day) c.day = CMP.day; }
  if (LC.drawer && LC.drawer.id) { c.drawer = LC.drawer.type + ':' + LC.drawer.id; c.drawer_tab = LC.drawer.tab || ''; c.drawer_title = ((LC.drawer.data && LC.drawer.data.step && LC.drawer.data.step.name) || '') }
  return c;
}
function rqWhere_(c) {
  const tab = { campaigns: 'Campaigns', emails: 'Emails', activity: 'Activity', contacts: 'Contacts' }[c.tab] || c.tab;
  return [tab, c.campaign, c.view === 'calendar' ? 'Calendar' : '', c.drawer_title].filter(Boolean).join(' › ');
}
async function rqOpen_() {
  HLP.rq = { text: '', files: [], target: null, shot: null, shooting: true, ctx: rqContext_(), sending: false, sent: false };
  rqSyncFab_(); rqRender_();
  HLP.rq.shot = await rqShot_(null).catch(() => null);
  if (HLP.rq) { HLP.rq.shooting = false; rqRender_(); }
}
function rqClose_() { HLP.rq = null; const l = document.querySelector('.lc-rq'); if (l) l.remove(); rqSyncFab_(); }

// Screenshot of the visible screen (panel hidden), with the chosen part outlined.
// html2canvas loads only when someone opens the panel.
function rqLoadShotLib_() {
  if (window.html2canvas) return Promise.resolve();
  if (rqLoadShotLib_.p) return rqLoadShotLib_.p;
  rqLoadShotLib_.p = new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  return rqLoadShotLib_.p;
}
async function rqShot_(target) {
  await rqLoadShotLib_();
  const ignore = el => el.classList && (el.classList.contains('lc-rq') || el.classList.contains('lc-rq-fab') || el.classList.contains('lc-rq-pick'));
  const canvas = await window.html2canvas(document.body, { x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight,
    scale: Math.min(1, 1600 / window.innerWidth), useCORS: true, logging: false, ignoreElements: ignore, backgroundColor: '#F5F4EB' });
  if (target) {
    const r = target.getBoundingClientRect(), k = canvas.width / window.innerWidth, g = canvas.getContext('2d');
    g.lineWidth = Math.max(3, 4 * k); g.strokeStyle = '#E5484D';
    g.strokeRect((r.left - 4) * k, (r.top - 4) * k, (r.width + 8) * k, (r.height + 8) * k);
  }
  return canvas.toDataURL('image/jpeg', 0.82);
}
// "Point at it": the panel steps aside, the part under the pointer is outlined, a click picks it.
function rqPick_() {
  const panel = document.querySelector('.lc-rq'); if (panel) panel.classList.add('away');
  const layer = document.createElement('div'); layer.className = 'lc-rq-pick lc-layer';
  layer.innerHTML = '<div class="lc-rq-pick-bar">' + HLP_ICON.target + '<span>Click the part you mean</span><button class="lc-btn sm ghost" data-x>Cancel</button></div><div class="lc-rq-hl"></div>';
  document.body.appendChild(layer);
  const hl = layer.querySelector('.lc-rq-hl');
  const under = (x, y) => { layer.style.pointerEvents = 'none'; const el = document.elementFromPoint(x, y); layer.style.pointerEvents = ''; return el; };
  const pickable = el => el && el.closest && el.closest('.lc button, .lc a, .lc tr, .lc li, .lc .lc-card, .lc .lc-kpi, .lc h1, .lc h3, .lc .lc-pill, .lc-layer:not(.lc-rq):not(.lc-rq-pick) button, .lc-drawer section, .lc-drawer [class*="lc-"]');
  let cur = null;
  const move = e => { const el = pickable(under(e.clientX, e.clientY)); cur = el; if (!el) { hl.hidden = true; return; } const r = el.getBoundingClientRect(); hl.hidden = false; Object.assign(hl.style, { left: r.left - 4 + 'px', top: r.top - 4 + 'px', width: r.width + 8 + 'px', height: r.height + 8 + 'px' }); };
  const done = async picked => {
    layer.remove(); document.removeEventListener('keydown', esc, true);
    if (panel) panel.classList.remove('away');
    if (!HLP.rq || !picked) return;
    HLP.rq.target = { selector: rqSelector_(picked), text: (picked.innerText || picked.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 140), tag: picked.tagName.toLowerCase() };
    HLP.rq.shooting = true; rqRender_();
    HLP.rq.shot = await rqShot_(picked).catch(() => HLP.rq && HLP.rq.shot);
    if (HLP.rq) { HLP.rq.shooting = false; HLP.rq.ctx = rqContext_(); rqRender_(); }
  };
  const esc = e => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
  layer.addEventListener('mousemove', move);
  layer.addEventListener('click', e => { if (e.target.closest('[data-x]')) return done(null); e.preventDefault(); done(cur); });
  document.addEventListener('keydown', esc, true);
}
function rqSelector_(el) {
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && parts.length < 5 && !n.classList.contains('lc'); n = n.parentElement) {
    let p = n.tagName.toLowerCase();
    if (n.dataset && n.dataset.act) p += '[data-act="' + n.dataset.act + '"]' + (n.dataset.id ? '[data-id="' + n.dataset.id + '"]' : '');
    else if (n.classList.length) p += '.' + [...n.classList].filter(c => /^lc-/.test(c)).slice(0, 2).join('.');
    parts.unshift(p.replace(/\.$/, ''));
  }
  return parts.join(' > ');
}
function rqRender_() {
  const R = HLP.rq; if (!R) return;
  let el = document.querySelector('.lc-rq');
  if (!el) {
    el = document.createElement('div'); el.className = 'lc-rq lc-layer'; document.body.appendChild(el);
    el.addEventListener('click', rqOnClick_); el.addEventListener('input', e => { if (e.target.matches('textarea')) { R.text = e.target.value; const s = el.querySelector('[data-rq="send"]'); if (s) s.disabled = !R.text.trim() || R.sending; } });
    el.addEventListener('change', e => { if (e.target.matches('input[type=file]')) rqAddFiles_(e.target.files); });
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drop'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('drop'); rqAddFiles_(e.dataTransfer.files); });
  }
  if (R.sent) {
    el.innerHTML = '<aside class="lc-rq-panel" role="dialog" aria-label="Request a change"><div class="lc-rq-done">' + HLP_ICON.check + '<h3>Sent to Mau</h3><p>He has your note, the screenshot and where you were on the page. You don’t need to do anything else.</p>' +
      '<button class="lc-btn primary" data-rq="close">Done</button></div></aside>';
    return;
  }
  const t = R.target, size = R.files.reduce((a, f) => a + f.size, 0);
  el.innerHTML = '<aside class="lc-rq-panel" role="dialog" aria-label="Request a change">' +
    '<header><div><h3>Request a change</h3><p>Goes straight to Mau.</p></div><button class="lc-icon-btn" data-rq="close" aria-label="Close">' + HLP_ICON.x + '</button></header>' +
    '<div class="lc-rq-body">' +
    '<label class="lc-rq-l" for="rq-text">What would you like changed?</label>' +
    '<textarea id="rq-text" rows="5" placeholder="e.g. Can the Intro email go out on Tuesdays instead? Or: this number looks wrong.">' + lcEsc_(R.text) + '</textarea>' +
    '<div class="lc-rq-l">The part you mean <small>optional</small></div>' +
    (t ? '<div class="lc-rq-target">' + HLP_ICON.target + '<span><b>' + lcEsc_(t.text || t.tag) + '</b><small>' + lcEsc_(rqWhere_(R.ctx)) + '</small></span><button class="lc-link" data-rq="point">Change</button></div>'
      : '<button class="lc-rq-point" data-rq="point">' + HLP_ICON.target + '<span><b>Point at it</b><small>Click the button, number or text on the page</small></span></button>') +
    '<div class="lc-rq-l">Screenshot</div>' +
    '<div class="lc-rq-shot">' + (R.shooting ? '<div class="lc-sk" style="height:100%"></div>' : R.shot ? '<img alt="Screenshot of the page" src="' + R.shot + '">' : '<span class="lc-dim">No screenshot (the page couldn’t be captured).</span>') + '</div>' +
    (R.shot && !R.shooting ? '<div class="lc-rq-shot-f"><span class="lc-dim">' + (t ? 'The part you picked is outlined in red.' : 'Of the screen as it was when you opened this.') + '</span><button class="lc-link" data-rq="noshot">Don’t include</button></div>' : '') +
    '<div class="lc-rq-l">Files <small>optional · pictures or PDFs, up to 3</small></div>' +
    '<div class="lc-rq-files">' + R.files.map((f, i) => '<span class="lc-rq-file">' + HLP_ICON.clip + lcEsc_(f.name) + '<small>' + Math.max(1, Math.round(f.size / 1024)) + ' KB</small><button aria-label="Remove ' + lcEsc_(f.name) + '" data-rq="rmfile" data-i="' + i + '">' + HLP_ICON.x + '</button></span>').join('') +
    (R.files.length < RQ_MAX_FILES ? '<label class="lc-rq-add">' + HLP_ICON.clip + 'Add a file<input type="file" accept="image/*,application/pdf" multiple hidden></label>' : '') + '</div>' +
    (size > RQ_MAX_BYTES ? '<p class="lc-rq-err">Files are too big together (3 MB max).</p>' : '') +
    '<p class="lc-rq-ctx">Also sent: where you are (' + lcEsc_(rqWhere_(R.ctx)) + '), your name and the time.</p>' +
    '</div><footer><button class="lc-btn ghost" data-rq="close">Cancel</button><button class="lc-btn primary" data-rq="send"' + (!R.text.trim() || R.sending || size > RQ_MAX_BYTES ? ' disabled' : '') + '>' + (R.sending ? 'Sending…' : 'Send to Mau') + '</button></footer></aside>';
}
function rqAddFiles_(list) {
  const R = HLP.rq; if (!R) return;
  [...(list || [])].filter(f => /^image\/|^application\/pdf$/.test(f.type)).slice(0, RQ_MAX_FILES - R.files.length).forEach(f => R.files.push(f));
  rqRender_();
}
const rqDataUrl_ = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); });
async function rqOnClick_(e) {
  const b = e.target.closest('[data-rq]'); const R = HLP.rq;
  if (!b || !R) { if (e.target === e.currentTarget) rqClose_(); return; }
  const k = b.dataset.rq;
  if (k === 'close') return rqClose_();
  if (k === 'point') return rqPick_();
  if (k === 'noshot') { R.shot = null; return rqRender_(); }
  if (k === 'rmfile') { R.files.splice(Number(b.dataset.i), 1); return rqRender_(); }
  if (k === 'send') {
    if (R.sending || !R.text.trim()) return;
    R.sending = true; rqRender_();
    let files = [];
    try { files = await Promise.all(R.files.map(async f => ({ name: f.name, type: f.type, data: await rqDataUrl_(f) }))); } catch (_) { /* send without them */ }
    const r = await lcAuthFetch_('/api/email?op=request', { method: 'POST', body: JSON.stringify({ text: R.text.trim(), context: { ...R.ctx, target: R.target }, screenshot: R.shot || '', files }) })
      .then(x => x.json()).catch(() => ({ ok: false, error: 'Network error' }));
    if (!HLP.rq) return;
    R.sending = false;
    if (!r.ok) { rqRender_(); return lcToast_(r.error || 'That didn’t send. Try again.', true); }
    R.sent = true; rqRender_();
    if (typeof rqLoadList_ === 'function') rqLoadList_(true);
  }
}
// Same session header as every other Lifecycle call.
function lcAuthFetch_(url, opts) {
  const tok = typeof currentSessionToken_ === 'function' ? currentSessionToken_() : ((typeof _s !== 'undefined' && _s && _s.token) || '');
  return fetch(url, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok, ...((opts && opts.headers) || {}) } });
}

// ── Change requests list (Activity tab) ─────────────────────────────────────────
// Everyone with access sees the requests and their state; marking one done needs edit_config.
const RQL = { list: null, busy: false };
function rqLoadList_(fresh) {
  if (RQL.busy) return;
  RQL.busy = true;
  return lcAuthFetch_('/api/email?op=request' + (fresh ? '&fresh=1' : ''), { method: 'GET' }).then(x => x.json()).then(r => { RQL.list = r.ok ? r.requests : []; })
    .catch(() => { RQL.list = RQL.list || []; }).finally(() => { RQL.busy = false; const slot = document.querySelector('.lc [data-rq-list]'); if (slot) slot.outerHTML = rqListCard_(); });
}
function rqListCard_() {
  if (RQL.list === null) { rqLoadList_(); return '<div data-rq-list></div>'; }
  const open = RQL.list.filter(r => r.status !== 'done'), done = RQL.list.filter(r => r.status === 'done').slice(0, 3);
  const row = r => '<li class="lc-rq-li' + (r.status === 'done' ? ' done' : '') + '"><div class="main"><b>' + lcEsc_(r.text.length > 110 ? r.text.slice(0, 110) + '…' : r.text) + '</b>' +
    '<small>' + lcEsc_(r.user) + ' · ' + lcEsc_(lcStamp_(r.at)) + (r.where ? ' · ' + lcEsc_(r.where) : '') + (r.files ? ' · ' + r.files + ' file' + (r.files === 1 ? '' : 's') : '') + '</small></div>' +
    '<div class="lc-rq-acts"><button class="lc-btn sm" data-act="rq-view" data-id="' + lcEsc_(r.id) + '">View</button>' +
    (r.status !== 'done' && lcCan_('edit_config') ? '<button class="lc-btn sm" data-act="rq-done" data-id="' + lcEsc_(r.id) + '">Mark done</button>' : r.status === 'done' ? lcTag_('Done', '') : '') + '</div></li>';
  return '<div class="lc-card" data-rq-list><div class="lc-card-h"><h3>Change requests</h3>' + (open.length ? '<small>' + open.length + ' open</small>' : '') + '</div>' +
    (RQL.list.length ? '<ul class="lc-list">' + open.concat(done).map(row).join('') + '</ul>' : '<div class="lc-empty">None yet. Use <b>Request a change</b> in the corner to send one.</div>') + '</div>';
}
function rqAct_(t) {
  if (t.dataset.act === 'rq-done') return rqDone_(t.dataset.id);
  if (t.dataset.act === 'rq-view') return rqView_(t.dataset.id);
}
// One request, read-only: the note, where it was made, the screenshot and files (fetched with the session).
async function rqView_(id) {
  const r = (RQL.list || []).find(x => x.id === id); if (!r) return;
  rqClose_();
  const el = document.createElement('div'); el.className = 'lc-rq lc-layer'; document.body.appendChild(el);
  const c = r.context || {}, t = r.target;
  const rows = [['From', r.user], ['When', lcStamp_(r.at)], ['Where', r.where], t ? ['Pointed at', t.text || t.tag] : null, ['Page', c.url], ['Screen', [c.screen, c.version && 'v' + c.version].filter(Boolean).join(' · ')]].filter(x => x && x[1]);
  el.innerHTML = '<aside class="lc-rq-panel" role="dialog" aria-label="Change request"><header><div><h3>Change request</h3><p>' + (r.status === 'done' ? 'Done' + (r.done_by ? ' · ' + lcEsc_(r.done_by) : '') : 'Open') + '</p></div>' +
    '<button class="lc-icon-btn" data-x aria-label="Close">' + HLP_ICON.x + '</button></header><div class="lc-rq-body">' +
    '<p class="lc-rq-text">' + lcEsc_(r.text) + '</p><dl class="lc-rq-dl">' + rows.map(([k, v]) => '<dt>' + lcEsc_(k) + '</dt><dd>' + lcEsc_(v) + '</dd>').join('') + '</dl>' +
    (r.shot ? '<div class="lc-rq-l">Screenshot</div><a class="lc-rq-shot big" data-shot target="_blank" rel="noopener"><div class="lc-sk" style="height:100%"></div></a>' : '') +
    (r.file_list.length ? '<div class="lc-rq-l">Files</div><div class="lc-rq-files">' + r.file_list.map((f, i) => '<button class="lc-rq-file" data-file="' + i + '">' + HLP_ICON.clip + lcEsc_(f.name) + '<small>' + Math.max(1, Math.round(f.size / 1024)) + ' KB</small></button>').join('') + '</div>' : '') +
    '</div></aside>';
  const blobUrl = p => lcAuthFetch_('/api/email?op=request&file=' + encodeURIComponent(p), { method: 'GET' }).then(x => x.ok ? x.blob() : null).then(b => b ? URL.createObjectURL(b) : null).catch(() => null);
  el.addEventListener('click', async e => {
    if (e.target === el || e.target.closest('[data-x]')) return el.remove();
    const fb = e.target.closest('[data-file]');
    if (fb) { const u = await blobUrl(r.file_list[Number(fb.dataset.file)].pathname); if (u) window.open(u, '_blank', 'noopener'); else lcToast_('Couldn’t open that file', true); }
  });
  if (r.shot) { const u = await blobUrl(r.shot), a = el.querySelector('[data-shot]'); if (a) { if (u) { a.href = u; a.innerHTML = '<img alt="Screenshot" src="' + u + '">'; } else a.innerHTML = '<span class="lc-dim">Couldn’t load the screenshot.</span>'; } }
}
async function rqDone_(id) {
  const r = await lcAuthFetch_('/api/email?op=request', { method: 'POST', body: JSON.stringify({ done: id }) }).then(x => x.json()).catch(() => ({ ok: false }));
  if (!r.ok) return lcToast_(r.error || 'Couldn’t save that', true);
  const it = (RQL.list || []).find(x => x.id === id); if (it) it.status = 'done';
  lcRenderBody_();
}
