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
  } else {
    // Columns added in later versions go on the end; existing ones never move.
    var have = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
    var missing = headers.filter(function (h) { return have.indexOf(h) === -1; });
    if (missing.length) {
      var at = have.filter(String).length + 1;
      if (sh.getMaxColumns() < at + missing.length - 1) sh.insertColumnsAfter(sh.getMaxColumns(), at + missing.length - 1 - sh.getMaxColumns());
      sh.getRange(1, at, 1, missing.length).setValues([missing]).setFontWeight('bold');
      if (log) log.push(name + ': added ' + missing.join(', '));
    }
  }
  // Plain text everywhere, so Sheets never converts our values (see Env.js).
  sh.getRange(1, 1, sh.getMaxRows(), Math.max(sh.getMaxColumns(), headers.length)).setNumberFormat('@');
  return sh;
}
function EE_folder_(props, key, name, parent) {
  var id = props.getProperty(key);
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ } }
  // A folder made by an earlier version without a saved id: adopt it instead of making a twin.
  var same = parent ? parent.getFoldersByName(name) : null;
  if (same && same.hasNext()) { var found = same.next(); props.setProperty(key, found.getId()); return found; }
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

// Marketing kit for Tony (run once as Tony; safe to re-run). Creates, in his Drive:
//   MCPS Marketing/
//     Email Templates/ (MCP Legacy/<one folder per email>, MCP Startup/<one per email>, Shared blocks)
//                                                                 ← the Template Library (CP7) reads here
//     START HERE - ChatGPT instructions.txt                         ← ChatGPT reads it through its Drive connector
//     Example - MCP x MCPS Intro (full template).html               ← a compliant starting point
// and shares the folder with Mau. Nothing is emailed except Drive's own "shared with you" note to Mau.

function eeSetupMarketingKit() {
  var props = EE_props_(), log = [];
  var root = EE_folder_(props, 'EE_FOLDER_MARKETING', 'MCPS Marketing', null);
  var tpl = EE_folder_(props, 'EE_FOLDER_TEMPLATES', 'Email Templates', root);
  // One folder per sequence, and inside it one per email, so each email can hold several templates.
  // Folder ids are kept in Script Properties (EE_FOLDER_STEP_<step_id>): renaming a folder in Drive never breaks the link.
  var seqName = { B: 'MCP Legacy', C: 'MCP Startup' };
  Object.keys(seqName).forEach(function (seq) {
    var sf = EE_folder_(props, 'EE_FOLDER_SEQ_' + seq, seqName[seq], tpl);
    EE_SEED.ruleset.steps.filter(function (st) { return st.sequence_id === seq; }).sort(function (a, b) { return a.order - b.order; })
      .forEach(function (st) {
        var key = 'EE_FOLDER_STEP_' + st.step_id, before = props.getProperty(key);
        EE_folder_(props, key, st.order + ' - ' + st.name, sf);
        if (!before) log.push('folder Email Templates/' + seqName[seq] + '/' + st.order + ' - ' + st.name);
      });
  });
  EE_folder_(props, 'EE_FOLDER_BLOCKS', 'Shared blocks', tpl);

  // Instructions for ChatGPT, and an example full template it can start from.
  // The instructions are the kit's own file: always refreshed to the current version.
  var guideName = 'START HERE - ChatGPT instructions.txt', guides = root.getFilesByName(guideName);
  if (guides.hasNext()) { guides.next().setContent(EE_CHATGPT_GUIDE); log.push('updated ' + guideName); }
  else { root.createFile(guideName, EE_CHATGPT_GUIDE, MimeType.PLAIN_TEXT); log.push('file ' + guideName); }
  // The example lives in its email's folder; an earlier run left it loose in Email Templates: move it there.
  var exName = 'Example - MCP x MCPS Intro (full template).html';
  var introFolder = DriveApp.getFolderById(props.getProperty('EE_FOLDER_STEP_b_intro'));
  if (!introFolder.getFilesByName(exName).hasNext()) {
    var loose = tpl.getFilesByName(exName);
    if (loose.hasNext()) { loose.next().moveTo(introFolder); log.push('moved the example into MCP Legacy/1 - MCP x MCPS Intro'); }
    else { introFolder.createFile(exName, EE_exampleFullTemplate_(), MimeType.HTML); log.push('file MCP Legacy/1 - MCP x MCPS Intro/' + exName); }
  }

  try { root.addEditor('mauricio@mcpoolsolutions.org'); log.push('shared with Mau'); } catch (e) { log.push('share with Mau failed: ' + e.message); }
  Logger.log(log.join('\n') + '\nFolder: ' + root.getUrl());
  // The structure as it now stands, so a remote run (maintenance action) can be checked.
  var tree = [];
  [['MCP Legacy', 'B'], ['MCP Startup', 'C']].forEach(function (q) {
    var it = DriveApp.getFolderById(props.getProperty('EE_FOLDER_SEQ_' + q[1])).getFolders(), names = [];
    while (it.hasNext()) { var f = it.next(), files = f.getFiles(), n = 0; while (files.hasNext()) { files.next(); n++; } names.push(f.getName() + (n ? ' (' + n + ' file' + (n > 1 ? 's' : '') + ')' : '')); }
    tree.push(q[0] + ': ' + names.sort().join(' | '));
  });
  return { url: root.getUrl(), changes: log, tree: tree };
}

// The current Intro, rendered through the MCPS frame into one complete file,
// with the merge fields put back as placeholders. Rendered with stand-in values
// first, because the renderer refuses output that still contains {{…}}.
function EE_exampleFullTemplate_() {
  var c = EE_SEED.content.steps.b_intro, cfg = EE_SEED.config;
  var out = MCPS_EMAIL_RENDER.render({
    revision: { subject: c.subject, preheader: c.preheader, body_html: EE_SEED.templates[c.body] },
    blocks: {}, fields: EE_SEED.fields, contact: { first_name: 'ZZFIRSTZZ', last_name: 'ZZLASTZZ' },
    context: { sender_name: cfg.sender_name, business: cfg.business, links: cfg.links, unsubscribeUrl: 'https://zzunsubzz.invalid/', deliveryToken: '' } });
  if (!out.ok) throw new Error('example render failed: ' + out.errors.join('; '));
  var quote = new RegExp(String(cfg.links.quote).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'), 'g');
  return out.html.replace(/ZZFIRSTZZ/g, '{{FirstName}}').replace(/ZZLASTZZ/g, '{{LastName}}')
    .replace(/https:\/\/zzunsubzz\.invalid\//g, '{{UnsubscribeLink}}').replace(quote, '{{QuoteLink}}');
}

// The ChatGPT instructions in Drive follow this file: when the text changes, bump the version and the next
// Templates list (Templates.js) rewrites the Drive copy. No maintenance run needed.
var EE_CHATGPT_GUIDE_VERSION = '2026-11-11b';
function EE_refreshGuide_(props) {
  if (typeof DriveApp === 'undefined' || props.getProperty('EE_GUIDE_VERSION') === EE_CHATGPT_GUIDE_VERSION) return false;
  var rootId = props.getProperty('EE_FOLDER_MARKETING'); if (!rootId) return false;
  var root = DriveApp.getFolderById(rootId), name = 'START HERE - ChatGPT instructions.txt', it = root.getFilesByName(name);
  if (it.hasNext()) it.next().setContent(EE_CHATGPT_GUIDE); else root.createFile(name, EE_CHATGPT_GUIDE, MimeType.PLAIN_TEXT);
  props.setProperty('EE_GUIDE_VERSION', EE_CHATGPT_GUIDE_VERSION);
  return true;
}
var EE_CHATGPT_GUIDE = [
  'MCPS EMAIL TEMPLATES WITH CHATGPT',
  '',
  'In ChatGPT, connect Google Drive once (Settings > Connectors > Google Drive). Then just say:',
  '  "Read START HERE - ChatGPT instructions in my MCPS Marketing folder and write the MCP Legacy follow-up email."',
  'ChatGPT follows the rules below and can use the Example file in Email Templates > MCP Legacy > 1 - MCP x MCPS Intro.',
  '(If it can\'t open Drive, attach this file and the example to the chat instead.)',
  '',
  'When an email is ready: download the .html file and drop it into that email\'s own folder, e.g.',
  'Email Templates > MCP Legacy > 2 - MCPS Follow Up. A folder can hold several versions; in the portal you pick',
  'which one is live (or split between them to compare results). Nothing sends until it is checked and approved.',
  'To edit one later: ask ChatGPT to open it from that folder (or attach it) and say what to change.',
  '',
  '------------------------------------------------------------------------------',
  'You write HTML email templates for Mission Custom Pool Solutions (MCPS), a pool service company in the',
  'San Antonio area. Every email is sent from Tony at MCPS. Follow these rules every time:',
  '',
  'OUTPUT',
  '- One complete HTML file per email, from <!DOCTYPE html> to </html>, ready to save. No explanations inside it.',
  '- Also give, outside the file: a subject line (under 50 characters) and preview text (under 90 characters).',
  '- When asked to change a template, return the full updated file, not a fragment.',
  '',
  'REQUIRED IN EVERY TEMPLATE (it will be rejected without them)',
  '- An unsubscribe link: <a href="{{UnsubscribeLink}}">Unsubscribe</a>, in the footer.',
  '- The business address in the footer: 4640 South Flores Road, Elmendorf, TX 78112',
  '- The company name: Mission Custom Pool Solutions.',
  '',
  'PERSONAL DETAILS: use these placeholders exactly, never real names',
  '- {{FirstName}}  {{LastName}}  {{Address}}  {{StartupDate}}  {{SenderName}} (who signs the email)',
  '- Example greeting: Hi {{FirstName}},',
  '',
  'DESIGN RULES (email apps are strict)',
  '- 600 px wide, centered, built with <table> layout and inline style="" attributes. No <script>, no forms,',
  '  no external CSS files; a <style> block is ignored by many apps.',
  '- Brand colors: Primary Teal #0D3D3E (headers), Aqua #1FA7A8 (buttons, accents), Light Gray #F3F5F6 (panels),',
  '  Charcoal #222222 (text). Fonts: Montserrat for headings, Open Sans for text, with Arial as fallback.',
  '- Images: only https:// links, each with alt text. Logo: https://mcps-email-assets.vercel.app/mcps-lockup-badge.png',
  '  (214 x 59). Never put important words inside an image.',
  '- One main button per email, asking them to request service / get a free quote. Its link is always href="{{QuoteLink}}".',
  '  {{QuoteLink}} opens the MCPS service request form. The system tracks the click AND the form: once someone requests',
  '  service, they get no more of these emails. Never type a website address for this button; only {{QuoteLink}} is tracked',
  '  that way. Other links are fine (they are click-tracked too) but keep them few.',
  '- Mobile friendly: text at least 15px, buttons at least 44px tall.',
  '',
  'VOICE',
  '- Professional, clear, reliable, direct, caring. Short paragraphs. No pressure tactics, no ALL CAPS, no emojis.',
  '- Never list service tasks. Say the technician will complete the service following our standard procedures.',
  '- Sign off as {{SenderName}}, Mission Custom Pool Solutions (the name is filled in by the system). The tagline is "Every pool matters."',
  '',
  'AUDIENCE',
  '- MCP Legacy: past customers of Mission Custom Pools (the builder) being introduced to MCPS, the service side of',
  '  the same family. Goal: a free quote for weekly pool service.',
  '- MCP Startup: owners of brand-new pools in their first weeks; MCPS handles the startup.',
  ''
].join('\n');
