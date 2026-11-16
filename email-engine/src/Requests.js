// ══════════════════════════════════════════════════════════════════════════════
// CHATGPT REQUESTS (Plan changes 2026-11-16): the one place ChatGPT writes.
//
// ChatGPT (Tony's, through Google Drive) never types into the engine's own tabs:
// they are the Journal's saved copy and the engine rewrites whole rows. Instead it
// adds a row to the ChatGPT_Requests tab; every 15 minutes (and at each run) the
// engine applies new rows through the same actions the portal uses, then writes
// back status (done | refused | error), a plain result, and when.
//
//   update_contact     field = first_name | last_name | phone | address | city | zip | area | email, value = new value
//   add_tags           value = tags, comma-separated
//   remove_tags        value = tags, comma-separated
//   opt_out            value = '' / all (every email) | marketing (marketing only). The contact can be any address.
//   stop_emails        stops the person's running sequence
//   flag               value = reason. Holds someone waiting (Needs review / awaiting approval) out of batches and approvals
//   unflag             back to where they were waiting
//   move_to_batch      value = YYYY-MM-DD: into that day's planned batch (made if there isn't one)
//   remove_from_batch  out of their planned batch, back to Needs review with no date
//
// Not here on purpose (portal only): approving people or templates, turning emails
// on or off, settings, sending, adding contacts (Contacts → Import checks duplicates).
// Rows are only ever written back in the status, result and done_at cells, so a row
// ChatGPT is adding at the same moment is never overwritten.
// ══════════════════════════════════════════════════════════════════════════════

var EE_REQUESTS_TAB = 'ChatGPT_Requests';
var EE_REQUESTS_HEADERS = ['action', 'contact', 'field', 'value', 'note', 'added_at', 'status', 'result', 'done_at'];
var EE_REQUESTS_MAX = 40;                 // per pass; the rest wait for the next one
var EE_REQUEST_ACTOR = 'chatgpt';
var EE_REQUEST_FIELDS = { first_name: 'first_name', last_name: 'last_name', phone: 'phone', address: 'address', city: 'city', zip: 'zip', area: 'area', email: 'email_norm' };
var EE_REQUEST_ACTIONS = { update_contact: 1, add_tags: 1, remove_tags: 1, opt_out: 1, stop_emails: 1, flag: 1, unflag: 1, move_to_batch: 1, remove_from_batch: 1 };

// sheet: { rows() -> [{ row, action, contact, field, value, note, status }], write(row, { status, result, done_at }) }
// deps: what EE_adminRun_ needs (scheduleRun, planRuns)
function EE_processRequests_(env, core, sheet, deps) {
  var pending = sheet.rows().filter(function (r) { return String(r.action || '').trim() && !String(r.status || '').trim(); });
  var out = { done: 0, refused: 0, error: 0, left: Math.max(0, pending.length - EE_REQUESTS_MAX) };
  pending.slice(0, EE_REQUESTS_MAX).forEach(function (r) {
    var res;
    try { res = EE_applyRequest_(env, core, r, deps || {}); }
    catch (e) { res = { status: 'error', result: String(e && e.message || e).slice(0, 200) }; }
    sheet.write(r.row, { status: res.status, result: res.result, done_at: new Date(env.now()).toISOString() });
    out[res.status]++;
  });
  return out;
}

function EE_requestContact_(env, who) {
  who = String(who || '').trim();
  if (!who) return null;
  var c = env.store.get('Contacts', who);
  if (!c) {
    var e = who.toLowerCase();
    c = env.store.rows('Contacts').filter(function (x) {
      return String(x.email_norm || '').toLowerCase() === e ||
        String(x.alt_emails || '').toLowerCase().split(',').map(function (s) { return s.trim(); }).indexOf(e) !== -1;
    }).sort(function (a, b) { return (a.review_status === 'merged') - (b.review_status === 'merged'); })[0] || null;
  }
  if (c && c.review_status === 'merged' && c.merged_into) c = env.store.get('Contacts', c.merged_into) || c;
  return c;
}
function EE_requestLog_(env, action, r, res) {
  try {
    env.withLock(function () {
      env.store.upsert('ChangeLog', { id: 'chg_' + env.uuid(), at: new Date(env.now()).toISOString(), actor: EE_REQUEST_ACTOR, action: 'request:' + action,
        detail: JSON.stringify({ contact: r.contact, field: r.field, value: r.value }).slice(0, 300), result: res.status === 'done' ? 'ok' : String(res.result).slice(0, 120) });
    });
  } catch (e) { /* the request itself is done; the log is best effort */ }
  return res;
}
function EE_reqAdmin_(env, core, action, params, deps) {
  return EE_adminRun_(env, core, { action: action, params: params, actor: EE_REQUEST_ACTOR }, deps);
}
function EE_tagList_(s) {
  return String(s || '').split(',').map(function (t) { return t.toLowerCase().replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40); }).filter(Boolean);
}

function EE_applyRequest_(env, core, r, deps) {
  var action = String(r.action || '').trim().toLowerCase(), value = String(r.value == null ? '' : r.value).trim();
  var refuse = function (why) { return { status: 'refused', result: why }; };
  var done = function (what) { return { status: 'done', result: what }; };
  if (!EE_REQUEST_ACTIONS[action]) return refuse('unknown action "' + action + '". Use one of: ' + Object.keys(EE_REQUEST_ACTIONS).join(', '));

  if (action === 'opt_out') {
    var email = String(r.contact || '').trim().toLowerCase(), known = EE_requestContact_(env, email);
    if (known && !EE_EMAIL_RE.test(email)) email = String(known.email_norm || '').toLowerCase();
    if (!EE_EMAIL_RE.test(email)) return refuse('opt_out needs an email address in contact');
    var scope = value.toLowerCase() === 'marketing' ? 'marketing' : 'all';
    if (value && !/^(all|marketing)$/i.test(value)) return refuse('value must be blank, all or marketing');
    var o = core.ingest({ event_id: 'req_' + env.sha256(email + ':' + scope).slice(0, 16), type: 'unsubscribe', mode: 'production', email_norm: email, scope: scope });
    if (!o.ok) return EE_requestLog_(env, action, r, { status: 'error', result: 'the opt-out could not be saved; try again' });
    return EE_requestLog_(env, action, r, done(email + ' opted out of ' + (scope === 'all' ? 'all emails' : 'marketing emails')));
  }

  var c = EE_requestContact_(env, r.contact);
  if (!c) return refuse('no contact with that email or contact_id');
  var who = (c.email_norm || c.contact_id), res;

  if (action === 'update_contact') {
    var f = EE_REQUEST_FIELDS[String(r.field || '').trim().toLowerCase()];
    if (!f) return refuse('field must be one of: ' + Object.keys(EE_REQUEST_FIELDS).join(', '));
    if (f === 'email_norm' && !EE_EMAIL_RE.test(value.toLowerCase())) return refuse('that is not a valid email address');
    var fields = {}; fields[f] = value;
    res = EE_reqAdmin_(env, core, 'update_contacts', { changes: [{ contact_id: c.contact_id, fields: fields }] }, deps);
    if (!res.ok) return refuse(res.error || 'refused');
    if (!res.updated) return refuse(f === 'email_norm' ? 'no change: same email, or that email belongs to another contact' : 'no change: it already has that value');
    return done(who + ': ' + r.field + ' is now "' + value + '"');
  }
  if (action === 'add_tags' || action === 'remove_tags') {
    var have = EE_tagList_(Array.isArray(c.tags) ? c.tags.join(',') : c.tags), asked = EE_tagList_(value);
    if (!asked.length) return refuse('value must list the tags, comma-separated');
    var next = action === 'add_tags' ? have.concat(asked.filter(function (t) { return have.indexOf(t) === -1; }))
      : have.filter(function (t) { return asked.indexOf(t) === -1; });
    if (next.join(',') === have.join(',')) return refuse('no change: ' + (action === 'add_tags' ? 'already tagged' : 'none of those tags are on this contact'));
    res = EE_reqAdmin_(env, core, 'update_contacts', { changes: [{ contact_id: c.contact_id, fields: { tags: next.join(',') } }] }, deps);
    if (!res.ok || !res.updated) return refuse(res.error || 'not saved');
    return done(who + ': tags are now ' + (next.join(', ') || '(none)'));
  }
  if (action === 'stop_emails') {
    var running = env.store.rows('Enrollments').filter(function (e) { return e.contact_id === c.contact_id && /^(active|waiting_anchor|paused)$/.test(e.status); });
    if (!running.length) return refuse('no running emails for ' + who + ' (' + c.review_status + '). To keep someone waiting out of batches, use flag.');
    EE_stopRunning_(env, core, c.contact_id, 'stopped_by_request');
    return EE_requestLog_(env, action, r, done(who + ': ' + running.length + ' running sequence' + (running.length > 1 ? 's' : '') + ' stopped'));
  }
  if (action === 'flag') {
    if (!value) return refuse('value must give the reason for the flag');
    if (c.review_status === 'flagged') return refuse('already flagged (' + (c.flag_reason || '') + ')');
    if (c.review_status !== 'needs_review' && c.review_status !== 'awaiting_approval') return refuse('only people still waiting can be flagged; ' + who + ' is ' + c.review_status + (c.review_status === 'confirmed' ? ' (use stop_emails)' : ''));
    var inBatch = env.store.rows('Batches').some(function (b) { return b.status === 'planned' && (b.contact_ids || []).indexOf(c.contact_id) !== -1; });
    if (inBatch) {
      res = EE_reqAdmin_(env, core, 'set_batch_date', { contact_ids: [c.contact_id], start_on: '' }, deps);
      if (!res.ok) return refuse('could not take them out of their batch: ' + (res.error || 'refused'));
    }
    core.commitEntity('contact', { contact_id: c.contact_id, review_status: 'flagged', flag_reason: value.slice(0, 200),
      review_reason: 'flagged by ' + EE_REQUEST_ACTOR + ' on ' + EE_today_(env) }, 'contact:' + c.contact_id + ':flag:' + env.now());
    return EE_requestLog_(env, action, r, done(who + ' flagged' + (inBatch ? ' and taken out of their planned batch' : '')));
  }
  if (action === 'unflag') {
    if (c.review_status !== 'flagged') return refuse(who + ' is not flagged (' + c.review_status + ')');
    res = EE_reqAdmin_(env, core, 'clear_flag', { contact_ids: [c.contact_id] }, deps);
    if (!res.ok) return refuse(res.error || 'refused');
    return done(who + ' unflagged: waiting in ' + (c.intro_sent_on ? 'awaiting approval' : 'Needs review'));
  }
  if (action === 'move_to_batch' || action === 'remove_from_batch') {
    var to = action === 'remove_from_batch' ? '' : value;
    if (action === 'move_to_batch' && !/^\d{4}-\d{2}-\d{2}$/.test(to)) return refuse('value must be the batch day as YYYY-MM-DD');
    res = EE_reqAdmin_(env, core, 'set_batch_date', { contact_ids: [c.contact_id], start_on: to }, deps);
    if (!res.ok) return refuse(res.error || 'refused');
    return done(to ? who + ' is in the ' + to + ' batch' + (res.created ? ' (new batch)' : '') : who + ' is out of batches, waiting in Needs review');
  }
  return refuse('unknown action');
}

// ── Apps Script side ──
function EE_requestsSheet_() {
  var ss = EE_mainSs_(), sh = ss.getSheetByName(EE_REQUESTS_TAB);
  if (!sh) {
    sh = ss.insertSheet(EE_REQUESTS_TAB);
    sh.getRange(1, 1, 1, EE_REQUESTS_HEADERS.length).setValues([EE_REQUESTS_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), EE_REQUESTS_HEADERS.length).setNumberFormat('@');
    sh.getRange(1, 1).setNote('ChatGPT adds one row per change. Leave status, result and done_at empty: the engine fills them. ' +
      'See "Email Engine Dictionary - ChatGPT" in MCPS Marketing.');
  }
  var h = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(function (x) { return String(x).trim().toLowerCase(); });
  return {
    rows: function () {
      var last = sh.getLastRow(); if (last < 2) return [];
      return sh.getRange(2, 1, last - 1, h.length).getDisplayValues().map(function (v, i) {
        var o = { row: i + 2 }; h.forEach(function (k, j) { if (k) o[k] = v[j]; }); return o;
      });
    },
    write: function (row, vals) {
      Object.keys(vals).forEach(function (k) { var col = h.indexOf(k) + 1; if (col) sh.getRange(row, col).setValue(vals[k]); });
      SpreadsheetApp.flush();
    }
  };
}
// Every 15 minutes (installed by EE_ensureRequestsTrigger_). Also refreshes the dictionary in Drive.
function EE_requestsTrigger() {
  var props = PropertiesService.getScriptProperties(), stamp = function (k, v) { try { props.setProperty(k, v); } catch (e) { /* best effort */ } };
  stamp('EE_REQ_LAST_START', new Date().toISOString());
  var cache = CacheService.getScriptCache();
  if (cache.get('ee_requests_busy')) { stamp('EE_REQ_LAST_RESULT', 'busy'); return { busy: true }; }
  cache.put('ee_requests_busy', '1', 300);
  try {
    try { EE_publishDictionary_(); } catch (e) { stamp('EE_REQ_DICT_ERROR', String(e && e.message || e).slice(0, 200)); }
    var x = EE_core_();
    var out = EE_processRequests_(x.env, x.core, EE_requestsSheet_(), { scheduleRun: EE_scheduleRunNow_, planRuns: function () { return EE_planRuns_(x.env, EE_triggerDeps_()); } });
    stamp('EE_REQ_LAST_RESULT', 'ok ' + new Date().toISOString());
    return out;
  } catch (e) {
    stamp('EE_REQ_LAST_RESULT', 'error ' + String(e && e.message || e).slice(0, 200));
    throw e;
  } finally { cache.remove('ee_requests_busy'); }
}
function EE_ensureRequestsTrigger_() {
  var have = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'EE_requestsTrigger'; });
  if (!have) ScriptApp.newTrigger('EE_requestsTrigger').timeBased().everyMinutes(15).create();
  return !have;
}
