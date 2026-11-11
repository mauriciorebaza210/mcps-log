// ══════════════════════════════════════════════════════════════════════════════
// SETUP: creates and seeds everything the engine needs. Safe to re-run: it
// only adds what's missing and never overwrites data that's already there.
// Run as Tony (the engine owner) from the Apps Script editor.
// ══════════════════════════════════════════════════════════════════════════════

var EE_SETTINGS_SS_DEFAULT = '1WdmY9qUqlvA7Xswmf8K8n0FYP02FKEBxM7Zd_V5Er_U'; // "Chem Log" (spike 5)
var EE_WEBAPP_URL_DEFAULT = 'https://script.google.com/macros/s/AKfycby4cJlb1hFupST63Wdjp6R1EeURsSgCGbpqcKkfFfadLMKrbbjS7kzTB7STAyAZsBpx/exec'; // spike 1 deployment

function eeSetup() {
  var props = EE_props_(), log = [];
  var me = Session.getEffectiveUser().getEmail();
  var owner = props.getProperty('EE_OWNER_EMAIL');
  if (!owner) { props.setProperty('EE_OWNER_EMAIL', me); owner = me; log.push('engine owner set to ' + me); }
  if (owner.toLowerCase() !== me.toLowerCase()) throw new Error('Run setup as the engine owner (' + owner + '), not ' + me + '.');

  var main = SpreadsheetApp.getActiveSpreadsheet();
  props.setProperty('EE_MAIN_SS_ID', main.getId());
  if (!props.getProperty('EE_SETTINGS_SS_ID')) props.setProperty('EE_SETTINGS_SS_ID', EE_SETTINGS_SS_DEFAULT);
  var settings = SpreadsheetApp.openById(props.getProperty('EE_SETTINGS_SS_ID'));
  ['Comms_Optouts', 'Comms_Log'].forEach(function (t) {
    if (!settings.getSheetByName(t)) throw new Error('Settings spreadsheet is missing ' + t + '; stop and check before going on.');
  });
  log.push('Settings spreadsheet OK: ' + settings.getName());

  // Journal: its own file, so restoring the main sheet never rolls it back.
  var journalId = props.getProperty('EE_JOURNAL_SS_ID'), journal;
  if (journalId) journal = SpreadsheetApp.openById(journalId);
  else {
    journal = SpreadsheetApp.create('MCPS Email Engine Journal');
    props.setProperty('EE_JOURNAL_SS_ID', journal.getId());
    log.push('created Journal spreadsheet ' + journal.getUrl());
  }
  EE_ensureTab_(journal, 'Journal', EE_JOURNAL_HEADERS, log);
  var j0 = journal.getSheetByName('Sheet1'); if (j0 && journal.getSheets().length > 1) journal.deleteSheet(j0);

  Object.keys(EE_TABLES).forEach(function (name) { EE_ensureTab_(main, name, EE_TABLES[name], log); });

  var env = EE_env();
  if (!env.store.get('Meta', 'applied_seq')) env.meta.set('applied_seq', '0');
  var cfg = EE_SEED.config, seedCfg = {
    engine_enabled: 'true', engine_mode: 'test', rule_rev: EE_SEED.ruleset.rule_rev, run_hour: '9',
    daily_cap: String(cfg.daily_cap), sender_name: cfg.sender_name,
    sender_display_name: cfg.sender_name + ' | ' + cfg.business.name,
    business_name: cfg.business.name, business_address: cfg.business.address, business_phone: cfg.business.phone,
    business_website: cfg.business.website, link_quote: cfg.links.quote,
    test_recipients: cfg.test_recipients.join(','), alert_email: 'mauricio@mcpoolsolutions.org', paused_buckets: '',
    quota_reserve: '20', track_base: cfg.track_base || 'https://mcps-log.vercel.app' };
  Object.keys(seedCfg).forEach(function (k) {
    if (!env.store.get('Config', k)) { env.store.upsert('Config', { key: k, value: seedCfg[k] }); log.push('config ' + k + ' = ' + seedCfg[k]); }
  });
  if (!env.store.get('Rulesets', EE_SEED.ruleset.rule_rev)) {
    env.store.upsert('Rulesets', { rule_rev: EE_SEED.ruleset.rule_rev, json: EE_SEED.ruleset,
      published_at: new Date().toISOString(), published_by: me });
    log.push('ruleset ' + EE_SEED.ruleset.rule_rev + ' seeded');
  }
  EE_SEED.fields.forEach(function (f) { if (!env.store.get('Fields', f.field)) env.store.upsert('Fields', f); });
  (cfg.permissions || []).forEach(function (p) {
    if (env.store.get('Permissions', p.username)) return;      // never overwrite an edited row
    env.store.upsert('Permissions', { username: p.username, roles: p.roles, active: 'Y', note: p.note || '',
      updated_at: new Date().toISOString(), updated_by: me });
    log.push('permission ' + p.username + ' = ' + p.roles);
  });

  // Drive: drafts (editable), revisions (immutable approved copies), attachments.
  var root = EE_folder_(props, 'EE_FOLDER_ROOT', 'MCPS Email Engine', null);
  ['Drafts', 'Revisions', 'Attachments'].forEach(function (n) { EE_folder_(props, 'EE_FOLDER_' + n.toUpperCase(), n, root); });
  var drafts = DriveApp.getFolderById(props.getProperty('EE_FOLDER_DRAFTS'));
  Object.keys(EE_SEED.templates).forEach(function (path) {
    var name = path.replace(/\//g, '__');
    if (!drafts.getFilesByName(name).hasNext()) { drafts.createFile(name, EE_SEED.templates[path], MimeType.HTML); log.push('draft ' + name); }
  });
  if (!props.getProperty('EE_WEBAPP_URL')) { props.setProperty('EE_WEBAPP_URL', EE_WEBAPP_URL_DEFAULT); log.push('web app URL set (unsubscribe links)'); }
  Logger.log(log.join('\n'));
  return log;
}

function EE_ensureTab_(ss, name, headers, log) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (log) log.push('created tab ' + name);
  }
  // Plain text everywhere, so Sheets never converts our values (see Env.js).
  sh.getRange(1, 1, sh.getMaxRows(), Math.max(sh.getMaxColumns(), headers.length)).setNumberFormat('@');
  return sh;
}
function EE_folder_(props, key, name, parent) {
  var id = props.getProperty(key);
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ } }
  var f = parent ? parent.createFolder(name) : DriveApp.createFolder(name);
  props.setProperty(key, f.getId());
  return f;
}

// Two test contacts at Mau's address (allowlisted), one B and one C, so the
// sandbox run sends the B Intro and the C Welcome. Journaled like any contact.
function eeAddTestContacts() {
  var x = EE_core_();
  var today = MCPS_LIFECYCLE.localDate(new Date(), EE_TZ);
  var contacts = [
    { contact_id: 'test_mau_b', email_norm: 'mauricio@mcpoolsolutions.org', first_name: 'Mau', last_name: 'Test',
      bucket: 'B', sub_bucket: 'B1', review_status: 'confirmed', is_test: 'Y', source: 'sandbox', created_at: new Date().toISOString() },
    { contact_id: 'test_mau_c', email_norm: 'mauricio@mcpoolsolutions.org', first_name: 'Mau', last_name: 'Test',
      bucket: 'C', sub_bucket: '', review_status: 'confirmed', is_test: 'Y', pool_school: 'Y',
      address: '4640 South Flores Road, Elmendorf, TX 78112', startup_date: MCPS_LIFECYCLE.addDays(today, 3),
      source: 'sandbox', created_at: new Date().toISOString() }];
  contacts.forEach(function (c) {
    if (x.env.store.get('Contacts', c.contact_id)) return;
    x.core.commitEntity('contact', c, 'contact:' + c.contact_id + ':create');
  });
  Logger.log('Test contacts ready (both at mauricio@). The C contact starts up on ' + contacts[1].startup_date + '.');
}

// CP5 live tracking test: a fresh B contact at a new plus-address of Mau's, so
// clicking, unsubscribing or replying on it never blocks the other test contacts.
// Adds the address to the test allowlist (test mode only sends to listed addresses).
function eeAddTrackingTestContact() {
  var x = EE_core_(), store = x.env.store;
  var n = store.rows('Contacts').filter(function (c) { return /^test_trk_/.test(c.contact_id); }).length + 1;
  var email = 'mauricio+trk' + n + '@mcpoolsolutions.org', id = 'test_trk_' + n;
  var cfg = EE_config_(store);
  var allow = String(cfg.test_recipients || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  if (allow.indexOf(email) === -1) { allow.push(email); store.upsert('Config', { key: 'test_recipients', value: allow.join(',') }); }
  x.core.commitEntity('contact', { contact_id: id, email_norm: email, first_name: 'Mau', last_name: 'Tracking ' + n,
    bucket: 'B', sub_bucket: 'B1', review_status: 'confirmed', is_test: 'Y', source: 'tracking_test', created_at: new Date().toISOString() },
    'contact:' + id + ':create');
  Logger.log('Added ' + id + ' at ' + email + '. Run eeRunNow to send its B Intro with tracked links (track_base: ' + (cfg.track_base || 'NOT SET') + ').');
}

// Demo walkthrough (CP6d, email-engine/docs/DEMO.md). Mau only: every demo
// address is a plus-address of Mau's, so nothing reaches Tony or a customer.
// One round = two MCP Legacy contacts (one to click, one to reply) and one MCP
// Startup contact whose startup is in 3 days, so its Welcome is due today.
// Run again for a fresh round (rehearsal, then the real walkthrough).
function eeDemoSetup() {
  var x = EE_core_(), store = x.env.store, cfg = EE_config_(store);
  if (cfg.engine_mode === 'production') throw new Error('Demo contacts are for test mode only.');
  var round = store.rows('Contacts').filter(function (c) { return /^demo\d+_/.test(c.contact_id); })
    .reduce(function (m, c) { return Math.max(m, Number(c.contact_id.match(/^demo(\d+)_/)[1])); }, 0) + 1;
  var today = MCPS_LIFECYCLE.localDate(new Date(), EE_TZ), startup = MCPS_LIFECYCLE.addDays(today, 3);
  var allow = String(cfg.test_recipients || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  var made = [];
  [['b1', 'B', 'Click'], ['b2', 'B', 'Reply'], ['c1', 'C', 'Startup']].forEach(function (d) {
    var id = 'demo' + round + '_' + d[0], email = 'mauricio+demo' + round + d[0] + '@mcpoolsolutions.org';
    if (allow.indexOf(email) === -1) allow.push(email);
    var c = { contact_id: id, email_norm: email, first_name: 'Mau', last_name: d[2] + ' ' + round, bucket: d[1],
      sub_bucket: d[1] === 'B' ? 'B1' : '', review_status: 'confirmed', is_test: 'Y', source: 'demo', created_at: new Date().toISOString() };
    if (d[1] === 'C') { c.startup_date = startup; c.address = '4640 South Flores Road, Elmendorf, TX 78112'; c.pool_school = 'Y'; }
    x.core.commitEntity('contact', c, 'contact:' + id + ':create');
    made.push(email);
  });
  store.upsert('Config', { key: 'test_recipients', value: allow.join(',') });
  Logger.log('Demo round ' + round + ' ready (all to Mau):\n  ' + made.join('\n  ') + '\nStartup date for the MCP Startup contact: ' + startup +
    '\nNext: Run now from the Lifecycle Email page. Expect 3 emails: 2 intros, 1 welcome.');
}
