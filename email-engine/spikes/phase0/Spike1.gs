// Spike 1: who does the engine run as?
//
// Paste into the Apps Script project bound to the "MCPS Email Engine"
// spreadsheet, created while signed in as Tony (antonio@). It sends nothing
// and touches nothing outside its own spreadsheet. It answers:
//   1. Does code run from the editor as Tony?
//   2. Does the web app ("Execute as: Me") run as Tony?
//   3. After MAU redeploys a new version, does the web app still run as Tony?
//   4. Does a trigger Tony installs run as Tony, and is it invisible to Mau?
// Every answer is written to the "spike1" tab of the bound spreadsheet.
// Steps: email-engine/spikes/phase0/SPIKE1.md

// Mau changes this to 'v2' before redeploying, so the web app's answer proves
// which version of the code replied.
const SPIKE1_VERSION = 'v1';

function spike1_identity_(context) {
  const row = {
    at: new Date().toISOString(),
    context: context,
    version: SPIKE1_VERSION,
    effective_user: Session.getEffectiveUser().getEmail(),
    active_user: Session.getActiveUser().getEmail() || '(not visible)',
  };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('spike1') || ss.insertSheet('spike1');
  const keys = Object.keys(row);
  if (sh.getLastRow() === 0) sh.appendRow(keys);
  sh.appendRow(keys.map(k => row[k]));
  return row;
}

// Step A3: run from the editor (as Tony), then later as Mau.
function spike1_whoamiEditor() {
  Logger.log(JSON.stringify(spike1_identity_('editor run')));
}

// The web app. "Who has access: Anyone" lets Claude call it without signing in.
// It only reports identity; it accepts no input and changes nothing else.
function doGet() {
  return ContentService.createTextOutput(JSON.stringify(spike1_identity_('web app')))
    .setMimeType(ContentService.MimeType.JSON);
}

// Step A5: run as Tony. Fires once, about a minute later, as whoever installed it.
function spike1_installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'spike1_triggerFired')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('spike1_triggerFired').timeBased().after(60 * 1000).create();
  Logger.log('Trigger installed by ' + Session.getEffectiveUser().getEmail() + '. It fires in about a minute.');
}
function spike1_triggerFired() {
  spike1_identity_('trigger');
}

// Step B5: run as Mau. getProjectTriggers() only returns the CURRENT user's
// triggers, so Mau should see 0 even though Tony's trigger exists.
function spike1_listTriggers() {
  const mine = ScriptApp.getProjectTriggers();
  const row = spike1_identity_('trigger list: ' + mine.length + ' visible (' +
    mine.map(t => t.getHandlerFunction()).join(', ') + ')');
  Logger.log(JSON.stringify(row));
}
