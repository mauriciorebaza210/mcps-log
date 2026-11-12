// ══════════════════════════════════════════════════════════════════════════════
// NIGHTLY BACKUP (PLAN.md → Operations → Backup / restore; RUNBOOK.md → Restore).
// Runs with the midnight scheduler (Schedule.js → EE_scheduleTrigger), so no extra
// trigger: copies the main spreadsheet and the Journal into
// MCPS Email Engine/Backups, names them with the date and the main sheet's
// applied_seq (the Journal records it already includes), and keeps the newest 30
// of each. A failed backup alerts but never stops the day's sends.
// ══════════════════════════════════════════════════════════════════════════════

var EE_BACKUPS_KEPT = 30;

function eeBackupNow() { return EE_backup_(); }
function EE_backup_() {
  var props = EE_props_(), env = EE_env();
  var applied = Number(env.meta.get('applied_seq') || 0);
  var day = Utilities.formatDate(new Date(), EE_TZ, 'yyyy-MM-dd');
  var root = DriveApp.getFolderById(props.getProperty('EE_FOLDER_ROOT'));
  var folder = EE_folder_(props, 'EE_FOLDER_BACKUPS', 'Backups', root);
  var made = [];
  [['main', props.getProperty('EE_MAIN_SS_ID')], ['journal', props.getProperty('EE_JOURNAL_SS_ID')]].forEach(function (x) {
    var copy = DriveApp.getFileById(x[1]).makeCopy('EE backup ' + x[0] + ' ' + day + ' seq ' + applied, folder);
    copy.setDescription(JSON.stringify({ kind: x[0], day: day, applied_seq: applied, source: x[1] }));
    made.push(copy.getName());
    // Keep the newest 30 of this kind.
    var it = folder.searchFiles('title contains "EE backup ' + x[0] + ' "'), all = [];
    while (it.hasNext()) all.push(it.next());
    all.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); }).slice(EE_BACKUPS_KEPT).forEach(function (f) { f.setTrashed(true); });
  });
  props.setProperty('EE_LAST_BACKUP', JSON.stringify({ at: new Date().toISOString(), applied_seq: applied }));
  return made;
}
