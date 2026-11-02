// Phase 0 spikes for the Lifecycle Email Engine (CP1).
//
// Runs in a THROWAWAY standalone Apps Script project in Mau's account. It never
// touches the portal. Test emails go only to the account running the script.
// Everything it measures is written to a spreadsheet it creates on first run,
// "EE Phase 0 Spike Results". See README.md next to this file for the steps,
// and email-engine/docs/SPIKES.md for what each result means for the plan.
//
// Functions to run, in order (each is safe to re-run):
//   spike2_sendLatency      ~3 min. Draft removal on send + Sent-search latency (G/G2).
//   spike2c_install         Installs a 10-minute trigger that runs 8 deliberately
//                           interrupted executions (~80 min unattended).
//   spike2c_report          After those 8 runs: what each interruption left behind.
//   spike2d_headers         Auto-reply and bounce headers on existing mail (read-only).
//   spike3_setup            Creates the scratch spreadsheets for the concurrency test.
//   spike3_run              ~4 min. A fake send loop with real locks; a trigger fires
//                           unsubscribes at it mid-run. No Gmail sends.
//   spike3_report           Unsubscribe ordering + lock-hold p50/p95 per section.
//   spike5_checkComms       Read-only: do Comms_Optouts / Comms_Log exist in Settings?
//   spike_cleanup           Deletes spike triggers and the [EE spike] test drafts.

const P = PropertiesService.getScriptProperties();
const SUBJECT_TAG = '[EE spike]';
// Paste the Settings spreadsheet ID (the one the portal's Apps Script is bound to).
const SETTINGS_SS_ID = '';

function me_() { return Session.getEffectiveUser().getEmail(); }
function token_() { return 'dlv_' + Utilities.getUuid().replace(/-/g, ''); }
function nowIso_() { return new Date().toISOString(); }

function results_() {
  const id = P.getProperty('RESULTS_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create('EE Phase 0 Spike Results');
  P.setProperty('RESULTS_ID', ss.getId());
  return ss;
}
function log_(tab, row) {
  const ss = results_();
  const sh = ss.getSheetByName(tab) || ss.insertSheet(tab);
  const keys = Object.keys(row);
  if (sh.getLastRow() === 0) sh.appendRow(keys);
  sh.appendRow(keys.map(k => row[k]));
}
function makeDraft_(token, label) {
  return GmailApp.createDraft(me_(), SUBJECT_TAG + ' ' + label + ' ' + token.slice(0, 12),
    'Spike message. Ref ' + token,
    { htmlBody: '<p>Spike message for the email engine. Safe to delete.</p>' +
                '<p style="font-size:11px;color:#888">Ref ' + token + '</p>' });
}
// getDrafts() is authoritative; getDraft(id) behaviour on a missing id is part
// of what we're checking, so both are recorded.
function draftExists_(draftId) {
  return GmailApp.getDrafts().some(d => d.getId() === draftId);
}
function getDraftThrows_(draftId) {
  try { GmailApp.getDraft(draftId); return 'no'; } catch (e) { return 'yes: ' + String(e.message).slice(0, 80); }
}
function foundIn_(where, token) {
  return GmailApp.search('in:' + where + ' "' + token + '"', 0, 5).length > 0;
}
function pct_(arr, p) {
  if (!arr.length) return '';
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))];
}

// ───────── Spike 2a/2b: draft removal on send, Sent-search latency ─────────
function spike2_sendLatency() {
  const n = 8, sent = [];
  for (let i = 0; i < n; i++) {
    const token = token_();
    const d = makeDraft_(token, 'latency #' + (i + 1));
    const draftId = d.getId();
    const t0 = Date.now();
    const msg = d.send();
    const sendMs = Date.now() - t0;
    sent.push({ i: i + 1, token, draftId, sentAt: Date.now(), sendMs,
      returnedMessageId: msg ? msg.getId() : '', threadId: msg ? msg.getThread().getId() : '',
      draftGoneAfterSend: draftExists_(draftId) ? 'NO (draft still listed)' : 'yes',
      getDraftThrows: getDraftThrows_(draftId) });
  }
  // Poll the Sent search for every token together, every 5 s, up to ~4 min.
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline && sent.some(s => !s.foundMs)) {
    sent.filter(s => !s.foundMs).forEach(s => { if (foundIn_('sent', s.token)) s.foundMs = Date.now() - s.sentAt; });
    if (sent.some(s => !s.foundMs)) Utilities.sleep(5000);
  }
  sent.forEach(s => log_('2ab_send_latency', {
    run_at: nowIso_(), n: s.i, send_call_ms: s.sendMs, draft_gone_after_send: s.draftGoneAfterSend,
    getDraft_on_missing_throws: s.getDraftThrows, returned_message_id: s.returnedMessageId, thread_id: s.threadId,
    sent_search_found_ms: s.foundMs || 'NOT FOUND within 240s', token: s.token }));
  const f = sent.filter(s => s.foundMs).map(s => s.foundMs);
  Logger.log('Sent-search latency ms: p50=%s p95=%s max=%s (found %s of %s)', pct_(f, 50), pct_(f, 95), Math.max.apply(null, f), f.length, n);
}

// ───────── Spike 2c: interrupted sends and orphan drafts ─────────
// Each trigger execution busy-waits until just before the 6-minute execution
// limit, then calls send() (or createDraft()) so the platform kills it mid-call.
// Offsets vary across runs; some calls will complete, which maps the boundary.
const C_OFFSETS_S = [357.5, 358.5, 359.2, 359.6, 357.5, 358.5, 359.2, 359.6];

function spike2c_install() {
  spike_cleanupTriggers_('spike2c_tick');
  P.setProperty('C_NEXT', '0');
  ScriptApp.newTrigger('spike2c_tick').timeBased().everyMinutes(10).create();
  Logger.log('Installed. 8 runs, one every 10 minutes (~80 min). Then run spike2c_report.');
}
function spike2c_tick() {
  const start = Date.now();
  const idx = Number(P.getProperty('C_NEXT') || '0');
  if (idx >= C_OFFSETS_S.length) { spike_cleanupTriggers_('spike2c_tick'); return; }
  P.setProperty('C_NEXT', String(idx + 1));
  const phase = idx % 2 === 0 ? 'send' : 'createDraft';
  const token = token_();
  const rec = { idx, phase, offset_s: C_OFFSETS_S[idx], token, started: start, stage: 'waiting' };
  if (phase === 'send') rec.draftId = makeDraft_(token, 'interrupted send #' + (idx + 1)).getId();
  P.setProperty('C_' + idx, JSON.stringify(rec));
  // Heartbeat every second: the last beat shows how long the execution lived.
  const target = start + C_OFFSETS_S[idx] * 1000;
  while (Date.now() < target) { Utilities.sleep(Math.min(1000, Math.max(10, target - Date.now()))); P.setProperty('C_BEAT_' + idx, String(Date.now())); }
  rec.stage = 'call_started'; rec.callAt = Date.now(); P.setProperty('C_' + idx, JSON.stringify(rec));
  if (phase === 'send') GmailApp.getDraft(rec.draftId).send();
  else rec.draftId = makeDraft_(token, 'interrupted draft #' + (idx + 1)).getId();
  rec.stage = 'call_returned'; rec.returnedAt = Date.now(); P.setProperty('C_' + idx, JSON.stringify(rec));
}
function spike2c_report() {
  for (let idx = 0; idx < C_OFFSETS_S.length; idx++) {
    const raw = P.getProperty('C_' + idx);
    if (!raw) { log_('2c_interrupted', { idx, note: 'did not run yet' }); continue; }
    const r = JSON.parse(raw);
    const beat = Number(P.getProperty('C_BEAT_' + idx) || '0');
    log_('2c_interrupted', {
      idx, phase: r.phase, offset_s: r.offset_s, last_stage: r.stage,
      killed_during_call: r.stage === 'call_started' ? 'YES' : 'no',
      observed_lifetime_s: beat ? ((Math.max(beat, r.callAt || 0) - r.started) / 1000).toFixed(1) : '',
      draft_id_recorded: r.draftId ? 'yes' : 'NO (orphan if a draft exists)',
      draft_still_exists: r.draftId ? draftExists_(r.draftId) : '',
      token_in_sent: foundIn_('sent', r.token), token_in_drafts: foundIn_('drafts', r.token),
      token: r.token });
  }
  Logger.log('Written to tab 2c_interrupted.');
}

// ───────── Spike 2d: automation and bounce headers (read-only) ─────────
function spike2d_headers() {
  const queries = [
    ['auto-reply', 'newer_than:365d (subject:"automatic reply" OR subject:"out of office" OR subject:autoreply OR subject:"auto-reply")'],
    ['bounce', 'newer_than:365d from:(mailer-daemon OR postmaster)'],
    ['normal', 'newer_than:30d in:inbox -from:(mailer-daemon OR postmaster)']];
  queries.forEach(([kind, q]) => {
    GmailApp.search(q, 0, 5).forEach(t => {
      const m = t.getMessages()[0];
      log_('2d_headers', { kind, from: m.getFrom(), subject: m.getSubject().slice(0, 80),
        auto_submitted: m.getHeader('Auto-Submitted'), x_autoreply: m.getHeader('X-Autoreply'),
        x_autorespond: m.getHeader('X-Autorespond'), precedence: m.getHeader('Precedence'),
        content_type: m.getHeader('Content-Type').slice(0, 80) });
    });
  });
  Logger.log('Written to tab 2d_headers.');
}

// ───────── Spike 3: unsubscribe ordering + lock-hold latency ─────────
// A fake send loop that follows the plan's lock rules exactly: no Gmail,
// Drive or UrlFetch inside the lock; Journal append + apply + flush inside it.
// A one-shot trigger fires unsubscribes at recipients the loop hasn't reached
// yet, at the recipient being authorized right now, and at one in flight.
const S3_N = 45;

function spike3_setup() {
  const eng = SpreadsheetApp.create('EE Spike Engine (scratch)');
  const main = eng.getSheets()[0].setName('Main');
  main.getRange(1, 1, S3_N + 1, 3).setValues([['rid', 'email', 'state']].concat(
    Array.from({ length: S3_N }, (_, i) => ['r' + String(i + 1).padStart(2, '0'), 'r' + (i + 1) + '@example.invalid', 'pending'])));
  eng.insertSheet('Inbox').appendRow(['rid', 'recorded_at', 'run_stage_for_rid']);
  eng.insertSheet('Journal').appendRow(['seq', 'op_id', 'rid', 'state', 'at']);
  // A separate file standing in for the shared Comms_Optouts, ~2,000 rows.
  const opt = SpreadsheetApp.create('EE Spike Optouts (scratch)');
  opt.getSheets()[0].getRange(1, 1, 2001, 2).setValues([['email', 'scope']].concat(
    Array.from({ length: 2000 }, (_, i) => ['someone' + i + '@example.invalid', 'all'])));
  P.setProperty('S3_ENG', eng.getId()); P.setProperty('S3_OPT', opt.getId());
  Logger.log('Scratch spreadsheets created. Now run spike3_run.');
}
function spike3_stage_(idx, stage) { P.setProperty('S3_STAGE', JSON.stringify({ idx, stage, at: Date.now() })); }
function timed_(fn) { const t = Date.now(); const v = fn(); return [Date.now() - t, v]; }

function spike3_run() {
  const eng = SpreadsheetApp.openById(P.getProperty('S3_ENG'));
  const opt = SpreadsheetApp.openById(P.getProperty('S3_OPT')).getSheets()[0];
  const main = eng.getSheetByName('Main'), inbox = eng.getSheetByName('Inbox'), journal = eng.getSheetByName('Journal');
  spike_cleanupTriggers_('spike3_unsubBurst');
  ScriptApp.newTrigger('spike3_unsubBurst').timeBased().after(1000).create();
  const lock = LockService.getScriptLock();
  let seq = journal.getLastRow();
  for (let i = 0; i < S3_N; i++) {
    const rid = 'r' + String(i + 1).padStart(2, '0');
    spike3_stage_(i, 'preparing');
    Utilities.sleep(2000);                       // stands in for render + createDraft
    spike3_stage_(i, 'authorizing');
    const tWait = Date.now(); lock.waitLock(30000); const waitMs = Date.now() - tWait;
    const tHold = Date.now();
    const [inboxMs, hit] = timed_(() => inbox.createTextFinder(rid).matchEntireCell(true).findNext());
    const [optMs] = timed_(() => opt.createTextFinder(rid + '@example.invalid').findNext());
    let authorized = !hit, appendMs = '', applyMs = '', flushMs = '';
    if (authorized) {
      [appendMs] = timed_(() => journal.appendRow([++seq, Utilities.getUuid(), rid, 'sending', nowIso_()]));
      [applyMs] = timed_(() => main.getRange(i + 2, 3).setValue('sending'));
    } else {
      [applyMs] = timed_(() => main.getRange(i + 2, 3).setValue('cancelled (opt-out before authorization)'));
    }
    [flushMs] = timed_(() => SpreadsheetApp.flush());
    const holdMs = Date.now() - tHold;
    lock.releaseLock();
    log_('3_sections', { rid, section: 'authorize', authorized, lock_wait_ms: waitMs, hold_ms: holdMs,
      inbox_find_ms: inboxMs, optout_find_ms: optMs, journal_append_ms: appendMs, apply_ms: applyMs, flush_ms: flushMs });
    if (!authorized) continue;
    spike3_stage_(i, 'in_flight');
    Utilities.sleep(1500);                       // stands in for draft.send(), outside the lock
    lock.waitLock(30000); const tB = Date.now();
    journal.appendRow([++seq, Utilities.getUuid(), rid, 'sent', nowIso_()]);
    main.getRange(i + 2, 3).setValue('sent'); SpreadsheetApp.flush();
    const bHold = Date.now() - tB; lock.releaseLock();
    log_('3_sections', { rid, section: 'bookkeeping', authorized: true, hold_ms: bHold });
    spike3_stage_(i, 'done');
  }
  spike3_stage_(S3_N, 'finished');
  Logger.log('Run finished. Now run spike3_report.');
}
// Separate execution (trigger): records unsubscribes the way the engine's
// ingest will, competing for the same script lock.
function spike3_unsubBurst() {
  const eng = SpreadsheetApp.openById(P.getProperty('S3_ENG'));
  const inbox = eng.getSheetByName('Inbox');
  const lock = LockService.getScriptLock();
  const plan = [['ahead', 3], ['current', 0], ['ahead', 6], ['current', 0], ['in_flight', -1], ['ahead', 9]];
  plan.forEach(([kind, delta], k) => {
    Utilities.sleep(k === 0 ? 0 : 7000);
    let st = JSON.parse(P.getProperty('S3_STAGE') || '{"idx":0,"stage":"preparing"}');
    if (st.stage === 'finished') return;
    if (kind === 'in_flight') {                  // wait (briefly) until some recipient is in flight
      const until = Date.now() + 8000;
      while (st.stage !== 'in_flight' && Date.now() < until) { Utilities.sleep(100); st = JSON.parse(P.getProperty('S3_STAGE')); }
    }
    const idx = Math.min(S3_N - 1, Math.max(0, st.idx + Math.max(delta, 0)));
    const rid = 'r' + String(idx + 1).padStart(2, '0');
    const t0 = Date.now(); lock.waitLock(30000); const waitMs = Date.now() - t0;
    // Read the recipient's state under the SAME lock the run authorizes under.
    // 'pending' = not yet authorized, so the contract says it must end cancelled.
    const stateAtRecord = eng.getSheetByName('Main').getRange(idx + 2, 3).getValue();
    const stageAtRecord = JSON.parse(P.getProperty('S3_STAGE'));
    const runStage = stageAtRecord.idx === idx ? stageAtRecord.stage : (stageAtRecord.idx < idx ? 'not reached yet' : 'already past');
    const tH = Date.now(); inbox.appendRow([rid, nowIso_(), runStage]); SpreadsheetApp.flush(); const holdMs = Date.now() - tH;
    lock.releaseLock();
    log_('3_ingest', { rid, aimed_at: kind, state_when_recorded: stateAtRecord, run_stage_for_rid_when_recorded: runStage,
      lock_wait_ms: waitMs, hold_ms: holdMs, total_ms: Date.now() - t0 });
  });
}
function spike3_report() {
  const ss = results_();
  const ingest = ss.getSheetByName('3_ingest').getDataRange().getValues().slice(1);
  const main = SpreadsheetApp.openById(P.getProperty('S3_ENG')).getSheetByName('Main').getDataRange().getValues();
  const stateOf = rid => (main.find(r => r[0] === rid) || [])[2];
  ingest.forEach(r => {
    const rid = r[0], stateWhen = r[2], stage = r[3], final = stateOf(rid);
    // Contract: recorded before authorization ⇒ never authorized; recorded after ⇒ may complete.
    const before = stateWhen === 'pending';
    const ok = before ? String(final).indexOf('cancelled') === 0 : final === 'sent';
    log_('3_report', { rid, state_when_recorded: stateWhen, run_stage: stage, final_state: final,
      expected: before ? 'cancelled' : 'sent (already authorized)', contract: ok ? 'HELD' : 'VIOLATED' });
  });
  const sec = ss.getSheetByName('3_sections').getDataRange().getValues();
  const h = sec[0], rows = sec.slice(1), col = n => h.indexOf(n);
  ['authorize', 'bookkeeping'].forEach(name => {
    const v = rows.filter(r => r[col('section')] === name).map(r => Number(r[col('hold_ms')]));
    log_('3_lock_hold', { section: name, n: v.length, p50_ms: pct_(v, 50), p95_ms: pct_(v, 95), max_ms: Math.max.apply(null, v), budget_p95_ms: 2000 });
  });
  const ig = ss.getSheetByName('3_ingest').getDataRange().getValues();
  const ih = ig.slice(1).map(r => Number(r[ig[0].indexOf('hold_ms')]));
  log_('3_lock_hold', { section: 'ingest', n: ih.length, p50_ms: pct_(ih, 50), p95_ms: pct_(ih, 95), max_ms: Math.max.apply(null, ih), budget_p95_ms: 2000 });
  Logger.log('Written to tabs 3_report and 3_lock_hold.');
}

// ───────── Spike 5: shared Comms tabs (read-only) ─────────
function spike5_checkComms() {
  if (!SETTINGS_SS_ID) throw new Error('Paste the Settings spreadsheet ID into SETTINGS_SS_ID first.');
  const ss = SpreadsheetApp.openById(SETTINGS_SS_ID);
  ['Comms_Optouts', 'Comms_Log'].forEach(name => {
    const sh = ss.getSheetByName(name);
    log_('5_comms_tabs', { tab: name, exists: !!sh, rows: sh ? sh.getLastRow() - 1 : '',
      headers: sh && sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].join(', ') : '' });
  });
  Logger.log('Written to tab 5_comms_tabs. Nothing in Settings was changed.');
}

// ───────── Cleanup ─────────
function spike_cleanupTriggers_(fnName) {
  ScriptApp.getProjectTriggers().filter(t => !fnName || t.getHandlerFunction() === fnName).forEach(t => ScriptApp.deleteTrigger(t));
}
function spike_cleanup() {
  spike_cleanupTriggers_();
  GmailApp.getDrafts().filter(d => d.getMessage().getSubject().indexOf(SUBJECT_TAG) === 0).forEach(d => d.deleteDraft());
  Logger.log('Triggers and [EE spike] drafts removed. Sent test messages are left for reference; search "[EE spike]" to delete them.');
}
