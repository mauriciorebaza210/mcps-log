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
    test_recipients: cfg.test_recipients.join(','), alert_email: 'mauricio@mcpoolsolutions.org', paused_buckets: '' };
  Object.keys(seedCfg).forEach(function (k) {
    if (!env.store.get('Config', k)) { env.store.upsert('Config', { key: k, value: seedCfg[k] }); log.push('config ' + k + ' = ' + seedCfg[k]); }
  });
  if (!env.store.get('Rulesets', EE_SEED.ruleset.rule_rev)) {
    env.store.upsert('Rulesets', { rule_rev: EE_SEED.ruleset.rule_rev, json: EE_SEED.ruleset,
      published_at: new Date().toISOString(), published_by: me });
    log.push('ruleset ' + EE_SEED.ruleset.rule_rev + ' seeded');
  }
  EE_SEED.fields.forEach(function (f) { if (!env.store.get('Fields', f.field)) env.store.upsert('Fields', f); });

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
