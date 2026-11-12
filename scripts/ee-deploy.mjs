// Guarded deploy of the Lifecycle Email Engine (PLAN.md → Deployment).
//
//   node scripts/ee-deploy.mjs "what changed"     sync, test, push, deploy as Tony, verify
//   node scripts/ee-deploy.mjs --rollback 7       redeploy version 7 as Tony, verify
//
// Spike 1 showed the web app runs as whoever deployed it LAST. So every deploy
// here uses clasp's named login for Tony (one-time: `clasp --user tony login`,
// signed in as antonio@), and afterwards the script asks the live engine who
// it runs as. Wrong identity or wrong version → it redeploys the previous
// version as Tony and exits non-zero.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployCheck, readLocalSchema } from './ee-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'email-engine');
const EXPECTED_SCRIPT_ID = '1LTV5PyIU7_NqlPsGy6EZd0L5rgXUHzgPf9WGiBjEP2yq6iAQQWR6qZ78';
const DEPLOYMENT_ID = 'AKfycby4cJlb1hFupST63Wdjp6R1EeURsSgCGbpqcKkfFfadLMKrbbjS7kzTB7STAyAZsBpx';
const WEBAPP = `https://script.google.com/macros/s/${DEPLOYMENT_ID}/exec`;
const OWNER = 'antonio@mcpoolsolutions.org';
const CLASP_USER = 'tony';

const fail = msg => { console.error('\n✖ ' + msg); process.exit(1); };
const run = (cmd, args, opts = {}) => {
  try { return execFileSync(cmd, args, { cwd: opts.cwd || ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { if (opts.allowFail) return (e.stdout || '') + (e.stderr || ''); fail(`${cmd} ${args.join(' ')} failed:\n${(e.stdout || '') + (e.stderr || '')}`); }
};
const clasp = (args, opts) => run('clasp', ['--user', CLASP_USER, ...args], { cwd: ENGINE, ...opts });

function currentVersion() {
  const out = clasp(['deployments']);
  const line = out.split('\n').find(l => l.includes(DEPLOYMENT_ID));
  if (!line) fail('the engine deployment ' + DEPLOYMENT_ID + ' is not listed by `clasp deployments` (wrong project or login?)');
  const m = line.match(/@(\d+)/);
  return m ? Number(m[1]) : null;
}
// wantVersion: keep asking (up to ~60 s) until that version answers; a just-deployed
// version can take a while to replace the old one behind /exec.
async function whoami(wantVersion) {
  let last = null;
  for (let i = 0; i < (wantVersion ? 20 : 4); i++) {
    try {
      const r = await fetch(WEBAPP, { redirect: 'follow' });
      const j = JSON.parse(await r.text());
      if (j && j.effective_user) { last = j; if (!wantVersion || j.version === wantVersion) return j; }
    } catch (e) { /* the new version can take a few seconds to answer */ }
    await new Promise(res => setTimeout(res, 3000));
  }
  return last;
}
function codeVersion() {
  const m = fs.readFileSync(path.join(ENGINE, 'src', 'Main.js'), 'utf8').match(/var EE_VERSION = '([^']+)'/);
  return m ? m[1] : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const rollback = argv[0] === '--rollback' ? Number(argv[1]) : null;
  const desc = rollback ? 'rollback to @' + rollback : (argv.join(' ') || 'engine update');

  const claspJson = JSON.parse(fs.readFileSync(path.join(ENGINE, '.clasp.json'), 'utf8'));
  if (claspJson.scriptId !== EXPECTED_SCRIPT_ID) fail('email-engine/.clasp.json points at ' + claspJson.scriptId + ', not the engine project');
  const who = clasp(['show-authorized-user'], { allowFail: true });
  if (!new RegExp(OWNER.replace('.', '\\.'), 'i').test(who)) fail(`clasp user "${CLASP_USER}" is not ${OWNER}. Run: clasp --user ${CLASP_USER} login  (sign in as Tony)\n${who}`);
  const before = currentVersion();
  console.log('✔ project, deployment and Tony login checked (live version @' + before + ')');
  // Schema range and rollback floor (row 32): never put code on data it can't read.
  const liveBefore = await whoami();
  const floor = Number(JSON.parse(fs.readFileSync(path.join(ENGINE, 'rollback-floor.json'), 'utf8')).floor || 0);
  const why = deployCheck({ localSchema: readLocalSchema(fs.readFileSync(path.join(ENGINE, 'src', 'Main.js'), 'utf8')),
    liveDataSchema: liveBefore && liveBefore.data_schema, rollbackTo: rollback, floor });
  if (why) fail(why);
  console.log('✔ schema range and rollback floor checked (live data schema ' + ((liveBefore && liveBefore.data_schema) || 'not recorded yet') + (floor ? ', floor @' + floor : '') + ')');

  if (!rollback) {
    run(process.execPath, ['scripts/ee-sync.mjs']);
    run(process.execPath, ['scripts/ee-sync.mjs', '--check']);
    console.log('✔ shared rules, renderer and seeds synced into email-engine/src');
    const t = run('npm', ['run', '-s', 'test:ee'], { allowFail: true });
    if (!/ℹ fail 0/.test(t)) fail('tests failed; not deploying:\n' + t.split('\n').filter(l => /✖|ℹ (pass|fail)/.test(l)).join('\n'));
    console.log('✔ ' + (t.match(/ℹ pass (\d+)/) || [])[1] + ' tests pass');
    const push = clasp(['push', '--force']);
    if (/Skipping push/i.test(push)) fail('clasp skipped the push (see memory: clasp push branch trap):\n' + push);
    console.log('✔ pushed');
  }
  const dep = clasp(rollback ? ['deploy', '-i', DEPLOYMENT_ID, '-V', String(rollback), '-d', desc] : ['deploy', '-i', DEPLOYMENT_ID, '-d', desc]);
  const after = currentVersion();
  console.log('✔ deployed as Tony: @' + before + ' → @' + after + '\n' + dep.trim());

  const wantVersion = rollback ? null : codeVersion();
  const live = await whoami(wantVersion);
  const okUser = live && String(live.effective_user).toLowerCase() === OWNER;
  const okVersion = !wantVersion || (live && live.version === wantVersion);
  if (okUser && okVersion) {
    console.log(`✔ live engine runs as ${live.effective_user}, version ${live.version}, journal ${live.applied_seq}/${live.journal_head}` +
      (live.safety_pause ? `  ⚠ SAFETY PAUSE: ${live.safety_pause}` : ''));
    return;
  }
  console.error('✖ live check failed: ' + JSON.stringify(live));
  if (!rollback && before) {
    console.error('  rolling back to @' + before + ' as Tony…');
    clasp(['deploy', '-i', DEPLOYMENT_ID, '-V', String(before), '-d', 'automatic rollback']);
    const again = await whoami();
    console.error('  after rollback: ' + JSON.stringify(again));
  }
  process.exit(1);
}
main();
