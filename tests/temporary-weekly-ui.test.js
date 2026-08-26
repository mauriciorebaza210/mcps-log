// Temporary weekly visit UI guard.
//
//   node tests/temporary-weekly-ui.test.js
//
// The specific-pool scheduler must not regress to the old startup-only,
// hardcoded-four-visits flow.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const routes = fs.readFileSync(path.join(ROOT, 'js/features/routes.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0;
let fail = 0;
function t(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log('  ok - ' + name);
  } else {
    fail += 1;
    console.log('  FAIL - ' + name + (detail ? ' ' + detail : ''));
  }
}

console.log('\nTemporary weekly visit UI');

t('pool action sheet has a week-count input',
  /id="pas-fm-weeks-input"/.test(html) &&
  /min="1"/.test(html) &&
  /max="26"/.test(html));

t('copy no longer hardcodes Schedule 4 visits',
  !/Schedule 4 visits/.test(html + routes) &&
  /Schedule temporary weekly visits/.test(html + routes));

t('UI calls the generic temporary weekly action with visit_count',
  /schedule_temporary_weekly_visits/.test(routes) &&
  /visit_count:\s*visitCount/.test(routes));

t('temporary scheduler is available outside startup-only controls',
  /function pasUpdateSchedulingSections_/.test(routes) &&
  /if \(wrap\) wrap\.style\.display = 'block'/.test(routes) &&
  /if \(temp\) temp\.style\.display = ''/.test(routes));

t('recurring start can follow the selected temporary span',
  /visitCount \* 7/.test(routes) &&
  /After temp visits/.test(html));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
