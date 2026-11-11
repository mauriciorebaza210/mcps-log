// ══════════════════════════════════════════════════════════════════════════════
// ENV: the Apps Script side of EngineCore's `env` adapter (see EE_ENV_SHAPE
// notes in EngineCore.js). Everything here is a thin wrapper over Google
// services; the logic it serves is tested in Node against a fake of this shape.
//
// Two sheet rules that the core depends on:
//   - every engine column is plain text (set by Setup), so Sheets never turns
//     "2026-11-02" into a date or "1" into a number behind our back;
//   - numeric fields are converted back on read (NUMERIC), because the core
//     compares them exactly (e.g. a delivery's attempt).
// ══════════════════════════════════════════════════════════════════════════════

var EE_TABLES = {
  Contacts: ['contact_id', 'email_norm', 'alt_emails', 'first_name', 'last_name', 'phone', 'address', 'city', 'state', 'zip', 'area',
    'pool_build_year', 'language', 'bucket', 'sub_bucket', 'tags', 'review_status', 'review_reason', 'is_test', 'pool_school',
    'pool_school_date', 'source', 'quote_id', 'pool_id', 'startup_date', 'startup_source', 'notes', 'imported_by', 'created_at',
    'updated_at', 'last_seq', 'send_time', 'restart_ok'],
  Enrollments: ['enrollment_id', 'contact_id', 'sequence_id', 'rule_rev', 'mode', 'status', 'enrolled_on', 'anchor_snapshot',
    'stop_reason', 'stopped_on', 'completed_on', 'stopped_branches', 'stopped_steps', 'flags', 'last_seq', 'send_time'],
  Deliveries: ['delivery_id', 'key', 'enrollment_id', 'contact_id', 'step_id', 'occurrence', 'mode', 'email_norm', 'bucket',
    'category', 'revision_id', 'state', 'attempt', 'token', 'run_id', 'gen', 'claimed_at', 'draft_id', 'send_invoked_at',
    'message_id', 'thread_id', 'sent_at', 'error', 'resolved_by', 'adopted_from_gen', 'resend_requested_by', 'last_seq'],
  Inbox: ['inbox_id', 'type', 'mode', 'email_norm', 'scope', 'contact_id', 'enrollment_id', 'step_id', 'signal', 'confidence',
    'received_at', 'secondary', 'last_seq'],
  Secondaries: ['op_ref', 'kind', 'email_norm', 'scope', 'status', 'last_seq'],
  Suppressions_Test: ['email_norm', 'scope'],
  Holds: ['key', 'held_days', 'last_held_on', 'reason'],
  Revisions: ['revision_id', 'step_id', 'rev_no', 'subject', 'preheader', 'details_box', 'body_file_id', 'body_sha256',
    'blocks_json', 'fields_json', 'status', 'editor', 'approver', 'approved_at', 'content_hash', 'parent_revision_id', 'last_seq',
    // Template Library: 'body' (MCPS frame) or 'full' (complete file), and where it came from (Templates.js).
    'format', 'source_file_id', 'source_name', 'source_modified', 'created_at', 'published_as'],
  Rulesets: ['rule_rev', 'json', 'published_at', 'published_by'],
  Fields: ['field', 'source', 'key', 'fallback', 'required', 'format'],
  Config: ['key', 'value'],
  Meta: ['key', 'value'],
  Runs: ['run_id', 'trigger', 'owner', 'started_at', 'finished_at', 'sent', 'skipped', 'cancelled', 'reconcile', 'adopted',
    'failed', 'stopped_reason', 'plan_json', 'scan_json', 'planned_for'],
  Alerts: ['at', 'kind', 'detail'],
  // Who can do what in the portal's Lifecycle Email page (read by api/email.js).
  // Roles: viewer, editor, approver, operator (PLAN.md → Configuration & authorization).
  Permissions: ['username', 'roles', 'active', 'note', 'updated_at', 'updated_by'],
  // Per-delivery tracking summary, derived from the raw Events (Tracking.js).
  Engagement: ['delivery_id', 'contact_id', 'enrollment_id', 'step_id', 'mode', 'classifier_version', 'opens_total', 'opens_low',
    'opens_medium', 'first_open_at', 'last_open_at', 'clicks_total', 'clicks_low', 'clicks_medium', 'clicks_high', 'first_click_at',
    'last_click_at', 'first_verified_click_at', 'links_json', 'recent_clicks', 'unsubscribed_at', 'form_submitted_at',
    'replied_at', 'other_replied_at', 'last_reply_snippet', 'auto_replies', 'soft_bounces', 'bounced_at', 'bounce_kind', 'updated_at'],
  // Per-thread cursor for the reply scan (Replies.js): messages already handled.
  Threads: ['thread_id', 'message_count', 'seen_json', 'last_scanned_at'],
  // Every action taken from the portal (Admin.js), with the portal user who took it.
  ChangeLog: ['id', 'at', 'actor', 'action', 'detail', 'result'],
  // Batches that start contacts from Needs review on a date (Admin.js → create_batch).
  Batches: ['batch_id', 'name', 'group', 'filters_json', 'count', 'order', 'pick', 'start_on', 'contact_ids', 'status',
    'created_by', 'created_at', 'started_at', 'started_count', 'skipped_json', 'cancelled_by', 'cancelled_at', 'send_time', 'restart_ids'],
  // A person's change to one planned send (Admin.js → send_override; PLAN.md → Per-send overrides).
  Overrides: ['key', 'kind', 'date', 'enrollment_id', 'step_id', 'by', 'at']
};
// Raw tracking observations, one tab per month (Events_YYYY_MM) so reads stay bounded.
var EE_EVENT_HEADERS = ['event_id', 'delivery_id', 'enrollment_id', 'contact_id', 'mode', 'type', 'link_id', 'received_at',
  'seconds_since_send', 'method', 'ua_raw', 'ua_family', 'ip_prefix_hash', 'beacon_present', 'burst_count', 'confidence',
  'reasons', 'classifier_version', 'source', 'gmail_message_id', 'snippet'];
var EE_ID_FIELD = { Contacts: 'contact_id', Enrollments: 'enrollment_id', Deliveries: 'delivery_id', Inbox: 'inbox_id',
  Secondaries: 'op_ref', Suppressions_Test: 'email_norm', Holds: 'key', Revisions: 'revision_id', Rulesets: 'rule_rev',
  Fields: 'field', Config: 'key', Meta: 'key', Runs: 'run_id', Permissions: 'username', Engagement: 'delivery_id', Threads: 'thread_id', ChangeLog: 'id', Batches: 'batch_id', Overrides: 'key' };
var EE_NUMERIC = { occurrence: 1, attempt: 1, gen: 1, last_seq: 1, held_days: 1, rev_no: 1, adopted_from_gen: 1, seq: 1,
  opens_total: 1, opens_low: 1, opens_medium: 1, clicks_total: 1, clicks_low: 1, clicks_medium: 1, clicks_high: 1,
  auto_replies: 1, soft_bounces: 1, message_count: 1, count: 1, started_count: 1 };
var EE_JOURNAL_HEADERS = ['seq', 'op_id', 'type', 'entity_id', 'data', 'prev_hash', 'hash', 'at'];
var EE_TZ = 'America/Chicago';

function EE_props_() { return PropertiesService.getScriptProperties(); }
function EE_mainSs_() { return SpreadsheetApp.openById(EE_props_().getProperty('EE_MAIN_SS_ID')); }

function EE_decode_(key, v) {
  if (v instanceof Date) return /(_date|_on)$/.test(key) ? Utilities.formatDate(v, EE_TZ, 'yyyy-MM-dd') : v.toISOString();
  if (v === '' || v === null) return EE_NUMERIC[key] ? 0 : '';
  if (EE_NUMERIC[key]) return Number(v);
  if (typeof v === 'string' && (v.charAt(0) === '{' || v.charAt(0) === '[')) { try { return JSON.parse(v); } catch (e) { /* plain text */ } }
  return v;
}
function EE_encode_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
  return String(v);
}

// A header-indexed table. Rows are found by id with TextFinder (exact cell
// match), so reads stay fast without loading the whole sheet.
function EE_table_(ss, name, idField) {
  var sh = ss.getSheetByName(name);
  // A tab added in a later version is created on first use (plain text, like eeSetup does).
  if (!sh && EE_TABLES[name]) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, EE_TABLES[name].length).setValues([EE_TABLES[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), Math.max(sh.getMaxColumns(), EE_TABLES[name].length)).setNumberFormat('@');
  }
  if (!sh) throw new Error('engine tab "' + name + '" is missing; run eeSetup()');
  function headers() { return sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String); }
  function toObj(h, vals) { var o = {}; h.forEach(function (k, i) { if (k) o[k] = EE_decode_(k, vals[i]); }); return o; }
  function findRow(id) {
    var last = sh.getLastRow();
    if (last < 2) return 0;
    var col = headers().indexOf(idField) + 1;
    var cell = sh.getRange(2, col, last - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
    return cell ? cell.getRow() : 0;
  }
  return {
    rows: function () {
      var last = sh.getLastRow(); if (last < 2) return [];
      var h = headers();
      return sh.getRange(2, 1, last - 1, h.length).getValues().map(function (vals) { return toObj(h, vals); });
    },
    get: function (id) {
      var r = findRow(id); if (!r) return null;
      var h = headers();
      return toObj(h, sh.getRange(r, 1, 1, h.length).getValues()[0]);
    },
    upsert: function (row) {
      var h = headers();
      var extra = Object.keys(row).filter(function (k) { return h.indexOf(k) === -1; });
      if (extra.length) {                                // schema evolution: new columns go at the end
        sh.getRange(1, h.length + 1, 1, extra.length).setValues([extra]);
        sh.getRange(1, h.length + 1, sh.getMaxRows(), extra.length).setNumberFormat('@');
        h = h.concat(extra);
      }
      var values = [h.map(function (k) { return EE_encode_(row[k]); })];
      var r = findRow(row[idField]);
      if (r) sh.getRange(r, 1, 1, h.length).setValues(values);
      else sh.getRange(sh.getLastRow() + 1, 1, 1, h.length).setValues(values);
    }
  };
}

// The Journal lives in its own spreadsheet. Append-only: record `seq` is at sheet row seq + 1.
function EE_journal_(ss) {
  var sh = ss.getSheetByName('Journal');
  function rec(vals) {
    return { seq: Number(vals[0]), op_id: String(vals[1]), type: String(vals[2]), entity_id: String(vals[3]),
      data: JSON.parse(String(vals[4] || '{}')), prev_hash: String(vals[5]), hash: String(vals[6]), at: String(vals[7]) };
  }
  return {
    last: function () { var lr = sh.getLastRow(); return lr < 2 ? null : rec(sh.getRange(lr, 1, 1, 8).getValues()[0]); },
    get: function (seq) {
      if (seq < 1 || seq + 1 > sh.getLastRow()) return null;
      var r = rec(sh.getRange(seq + 1, 1, 1, 8).getValues()[0]);
      return r.seq === seq ? r : null;                   // a mismatch surfaces as chain_broken in the core
    },
    from: function (seq) {
      var lr = sh.getLastRow(); if (seq + 1 > lr) return [];
      return sh.getRange(seq + 1, 1, lr - seq, 8).getValues().map(rec);
    },
    findByOpId: function (opId) {
      var lr = sh.getLastRow(); if (lr < 2) return null;
      var cell = sh.getRange(2, 2, lr - 1, 1).createTextFinder(opId).matchEntireCell(true).findNext();
      return cell ? rec(sh.getRange(cell.getRow(), 1, 1, 8).getValues()[0]) : null;
    },
    append: function (r) {
      sh.getRange(sh.getLastRow() + 1, 1, 1, 8).setValues([[String(r.seq), r.op_id, r.type, r.entity_id,
        JSON.stringify(r.data), r.prev_hash, r.hash, r.at]]);
    }
  };
}

// The shared Comms_Optouts tab in the portal's Settings spreadsheet ("Chem Log").
function EE_optouts_(settingsSs) {
  var sh = settingsSs.getSheetByName('Comms_Optouts');
  if (!sh) throw new Error('Comms_Optouts tab not found in the Settings spreadsheet');
  function headers() { return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String); }
  function matches(col, value) {
    var lr = sh.getLastRow(); if (lr < 2) return [];
    return sh.getRange(2, col, lr - 1, 1).createTextFinder(value).matchEntireCell(true).findAll()
      .map(function (c) { return c.getRow(); });
  }
  return {
    scope: function (email) {
      var h = headers(), rows = matches(h.indexOf('email') + 1, email), scope = '';
      rows.forEach(function (r) {
        var vals = sh.getRange(r, 1, 1, h.length).getValues()[0];
        if (vals[h.indexOf('removed_at')]) return;       // tombstoned: no longer opted out
        var sc = String(vals[h.indexOf('scope')] || 'all');
        scope = (sc === 'all' || scope === 'all') ? 'all' : 'marketing';
      });
      return scope;
    },
    hasSource: function (source) { return matches(headers().indexOf('source') + 1, source).length > 0; },
    append: function (row) {
      var h = headers();
      var rec = { email: row.email, scope: row.scope === 'marketing' ? 'marketing_announcements' : 'all',
        opted_out_at: new Date().toISOString(), source: row.source };
      sh.appendRow(h.map(function (k) { return rec[k] === undefined ? '' : rec[k]; }));
    }
  };
}

function EE_sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
// Hex HMAC-SHA256, matching Node's crypto for ASCII input (see api/_lib/notify.js).
function EE_hmacHex_(secret, message) {
  return Utilities.computeHmacSha256Signature(String(message), String(secret))
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function EE_events_(ss) {
  var tabs = {};
  function tab(ms) {
    var name = 'Events_' + Utilities.formatDate(new Date(ms), EE_TZ, 'yyyy_MM');
    if (tabs[name]) return tabs[name];
    var sh = EE_ensureTab_(ss, name, EE_EVENT_HEADERS);
    // A tab made before a column was added: complete its header row in place.
    if (sh.getLastColumn() < EE_EVENT_HEADERS.length) sh.getRange(1, 1, 1, EE_EVENT_HEADERS.length).setValues([EE_EVENT_HEADERS]).setFontWeight('bold');
    return (tabs[name] = sh);
  }
  return {
    has: function (id, ms) {
      var sh = tab(ms), last = sh.getLastRow();
      return last > 1 && !!sh.getRange(2, 1, last - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
    },
    append: function (row) {
      var sh = tab(Date.parse(row.received_at));
      sh.getRange(sh.getLastRow() + 1, 1, 1, EE_EVENT_HEADERS.length)
        .setValues([EE_EVENT_HEADERS.map(function (k) { return EE_encode_(row[k]); })]);
    }
  };
}
function EE_readVerified_(fileId, sha) {
  var text = DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8');
  if (EE_sha256Hex_(text) !== sha) throw new Error('integrity: file ' + fileId + ' changed after approval');
  return text;
}
function EE_config_(store) {
  var c = {};
  store.rows('Config').forEach(function (r) { c[r.key] = r.value; });
  return c;
}

// opts (sandbox suite only): { mainId, journalId, settingsId, prefix }. The
// prefix namespaces the run lease, safety pause and cache keys, so a sandbox run
// can never pause, block or suppress the real engine.
function EE_env(opts) {
  opts = opts || {};
  var props = EE_props_();
  var main = opts.mainId ? SpreadsheetApp.openById(opts.mainId) : EE_mainSs_();
  var journalSs = SpreadsheetApp.openById(opts.journalId || props.getProperty('EE_JOURNAL_SS_ID'));
  var pre = opts.prefix || '';
  var tables = {};
  var table = function (name) { return tables[name] || (tables[name] = EE_table_(main, name, EE_ID_FIELD[name])); };
  var store = { rows: function (n) { return table(n).rows(); }, get: function (n, id) { return table(n).get(id); },
    upsert: function (n, row) { table(n).upsert(row); } };
  var optoutsApi = null;
  var optouts = function () { return optoutsApi || (optoutsApi = EE_optouts_(SpreadsheetApp.openById(opts.settingsId || props.getProperty('EE_SETTINGS_SS_ID')))); };
  var cache = CacheService.getScriptCache();

  var env = {
    now: function () { return Date.now(); },
    uuid: function () { return Utilities.getUuid(); },
    sha256: EE_sha256Hex_,
    user: function () { return Session.getEffectiveUser().getEmail(); },
    flush: function () { SpreadsheetApp.flush(); },
    withLock: function (fn) {
      var lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try { return fn(); } finally { lock.releaseLock(); }
    },
    props: { get: function (k) { return props.getProperty(pre + k); }, set: function (k, v) { props.setProperty(pre + k, v); },
      del: function (k) { props.deleteProperty(pre + k); } },
    cache: { get: function (k) { return cache.get(pre + k); }, put: function (k, v, s) { cache.put(pre + k, v, s || 21600); } },
    journal: EE_journal_(journalSs),
    events: EE_events_(main),
    store: store,
    meta: { get: function (k) { var r = store.get('Meta', k); return r ? r.value : null; },
      set: function (k, v) { store.upsert('Meta', { key: k, value: String(v) }); } },
    optouts: { scope: function (e) { return optouts().scope(e); }, hasSource: function (s) { return optouts().hasSource(s); },
      append: function (r) { optouts().append(r); } },
    config: {
      ownerEmail: function () { return props.getProperty('EE_OWNER_EMAIL') || ''; },
      engineEnabled: function () { return String(EE_config_(store).engine_enabled) !== 'false'; },
      quotaReserve: function () { var v = EE_config_(store).quota_reserve; return v === undefined || v === '' ? 20 : Number(v); },
      pausedBuckets: function () { return String(EE_config_(store).paused_buckets || '').split(',').map(function (s) { return s.trim(); }).filter(String); }
    },
    stepStatus: function (stepId) {
      var c = EE_config_(store);
      var rs = store.get('Rulesets', c.rule_rev);
      var step = rs && (rs.json.steps || []).filter(function (s) { return s.step_id === stepId; })[0];
      return step ? step.status : 'missing';
    },
    revisionStatus: function (id) { var r = store.get('Revisions', id); return r ? r.status : 'missing'; },
    quota: function () { return MailApp.getRemainingDailyQuota(); },
    alert: function (kind, detail) {
      try { store.upsert('Alerts', { at: new Date().toISOString() + ' ' + Utilities.getUuid().slice(0, 4), kind: kind, detail: String(detail) }); } catch (e) { /* the alert email below still goes */ }
      var to = EE_config_(store).alert_email;
      if (to) MailApp.sendEmail(to, '[Email engine] ' + kind, String(detail));
    },
    gmail: {
      createDraft: function (msg) {
        var c = EE_config_(store);
        return GmailApp.createDraft(msg.to, msg.subject, msg.text, { htmlBody: msg.html,
          name: c.sender_display_name || 'Tony | Mission Custom Pool Solutions' }).getId();
      },
      draftExists: function (id) { try { GmailApp.getDraft(id); return true; } catch (e) { return false; } },
      deleteDraft: function (id) { try { GmailApp.getDraft(id).deleteDraft(); } catch (e) { /* already gone */ } },
      sendDraft: function (id) {
        var m = GmailApp.getDraft(id).send();
        return { message_id: m.getId(), thread_id: m.getThread().getId() };
      },
      searchSent: function (token) {
        var threads = GmailApp.search('in:sent "' + token + '"', 0, 3);
        for (var i = 0; i < threads.length; i++) {
          var msgs = threads[i].getMessages();
          for (var j = 0; j < msgs.length; j++) {
            if (msgs[j].getPlainBody().indexOf(token) !== -1) return { message_id: msgs[j].getId(), thread_id: threads[i].getId() };
          }
        }
        return null;
      },
      // Inbound mail for Replies.js.
      threadMessages: function (threadId) {
        var t; try { t = GmailApp.getThreadById(threadId); } catch (e) { return []; }
        return t ? t.getMessages().map(EE_msgInfo_) : [];
      },
      bounceMessages: function (days) {
        var out = [];
        GmailApp.search('from:(mailer-daemon OR postmaster) newer_than:' + Number(days || 7) + 'd', 0, 50)
          .forEach(function (t) { t.getMessages().forEach(function (m) { out.push(EE_msgInfo_(m)); }); });
        return out;
      },
      aliases: function () { return GmailApp.getAliases(); },
      findDraftsByToken: function (token) {
        return GmailApp.getDrafts().filter(function (d) { return d.getMessage().getPlainBody().indexOf(token) !== -1; })
          .map(function (d) { return d.getId(); });
      }
    },
    render: function (row) { return EE_renderDelivery_(store, row); }
  };
  return env;
}

function EE_msgInfo_(m) {
  var h = function (name) { try { return String(m.getHeader(name) || ''); } catch (e) { return ''; } };
  return { id: m.getId(), from: m.getFrom(), date: m.getDate().getTime(), subject: m.getSubject(),
    body: String(m.getPlainBody() || '').slice(0, 8000),
    headers: { auto_submitted: h('Auto-Submitted'), x_autoreply: h('X-Autoreply'), x_autorespond: h('X-Autorespond'),
      precedence: h('Precedence'), content_type: h('Content-Type') } };
}

// Revision + contact + settings → the email. Throws (failing the delivery) on
// any problem: missing or revoked revision, a file changed after approval,
// a test-mode recipient that isn't on the allowlist, or renderer errors.
function EE_renderDelivery_(store, row) {
  var rev = store.get('Revisions', row.revision_id);
  if (!rev) throw new Error('revision ' + row.revision_id + ' not found');
  if (rev.status === 'revoked') throw new Error('revision ' + row.revision_id + ' was revoked');
  var c = EE_config_(store);
  var contact = store.get('Contacts', row.contact_id);
  if (!contact) throw new Error('contact ' + row.contact_id + ' not found');
  var allow = String(c.test_recipients || '').toLowerCase().split(',').map(function (s) { return s.trim(); });
  if (row.mode === 'test' && allow.indexOf(String(contact.email_norm).toLowerCase()) === -1) {
    throw new Error('test-mode recipient ' + contact.email_norm + ' is not on the test allowlist');
  }
  var blocks = {};
  (rev.blocks_json || []).forEach(function (b) { blocks[b.name] = { flag: b.flag, html: EE_readVerified_(b.file_id, b.sha256) }; });
  var webapp = EE_props_().getProperty('EE_WEBAPP_URL');
  // Tracked links (api/email.js) once the link secret is set; until then plain
  // links and the interim Apps Script unsubscribe page.
  var linkSecret = EE_props_().getProperty('EE_LINK_SECRET');
  var L = linkSecret && c.track_base ? MCPS_EMAIL_TRACKING.links({ base: c.track_base, token: row.token, mode: row.mode,
    hmacHex: function (m) { return EE_hmacHex_(linkSecret, m); } }) : null;
  var out = MCPS_EMAIL_RENDER.render({
    revision: { subject: rev.subject, preheader: rev.preheader, details_box: rev.details_box, format: rev.format || '',
      body_html: EE_readVerified_(rev.body_file_id, rev.body_sha256) },
    blocks: blocks, fields: rev.fields_json || [], contact: contact,
    context: { sender_name: c.sender_name, deliveryToken: row.token,
      business: { name: c.business_name, address: c.business_address, phone: c.business_phone, website: c.business_website },
      unsubscribeUrl: L ? L.unsubscribe() : (webapp ? webapp + '?action=unsubscribe&t=' + encodeURIComponent(row.token) : ''),
      openPixelUrl: L ? L.open() : '', trackLink: L ? L.click : null,
      // Test contacts use allowlisted addresses (Mau's), so no "meant for" banner is needed.
      links: { quote: c.link_quote }, testBanner: null }
  });
  if (!out.ok) throw new Error(out.errors.join('; '));
  return { to: contact.email_norm, subject: out.subject, html: out.html, text: out.text };
}
