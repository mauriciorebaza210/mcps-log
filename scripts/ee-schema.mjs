// Schema range and rollback-floor checks for the guarded deploy (scripts/ee-deploy.mjs;
// PLAN.md → Security boundary & rollback, Deployment). Pure, so tests can run it.
//
//   localSchema   EE_SCHEMA from email-engine/src/Main.js: { read_min, read_max, writes }
//   liveDataSchema  the live engine's Meta data_schema (whoami), 0 if unknown
//   rollbackTo    the Apps Script version a --rollback asks for (null for a normal deploy)
//   floor         email-engine/rollback-floor.json → floor (0 = none yet)
export function deployCheck({ localSchema, liveDataSchema, rollbackTo, floor }) {
  if (rollbackTo != null) {
    if (floor && rollbackTo < floor) return 'refusing to roll back to @' + rollbackTo + ': below the rollback floor @' + floor + ' (a semantic migration was contracted there)';
    return '';
  }
  if (!localSchema) return 'EE_SCHEMA not found in email-engine/src/Main.js';
  const ds = Number(liveDataSchema || 0);
  if (ds && (ds > localSchema.read_max || ds < localSchema.read_min)) {
    return 'this code reads schema ' + localSchema.read_min + '..' + localSchema.read_max + ' but the live data is schema ' + ds;
  }
  return '';
}
export function readLocalSchema(mainJs) {
  const m = String(mainJs).match(/var EE_SCHEMA = (\{[^}]*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/(\w+):/g, '"$1":')); } catch (_) { return null; }
}
