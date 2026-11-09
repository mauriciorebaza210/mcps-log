// Every file in email-engine/src loads together in ONE global scope, the way
// Apps Script runs them: no name defined twice, nothing used at load time that
// doesn't exist yet, and every entry point the setup steps tell Tony to run exists.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'email-engine', 'src');

test('All engine files load together like Apps Script, and expose the entry points', () => {
  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.js')).sort();
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Intl, encodeURIComponent, decodeURIComponent };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // Concatenate like Apps Script does: one scope, so a duplicate `const`/`let`/`function` would surface here.
  const all = files.map(f => fs.readFileSync(path.join(SRC, f), 'utf8') + '\n').join('');
  vm.runInContext(all, ctx, { filename: 'email-engine/src (all files)' });
  for (const fn of ['eeSetup', 'eeAddTestContacts', 'eeApprove', 'eeApproveBIntro', 'eeApproveCWelcome', 'eeRunNow', 'eeDiagnostics', 'eeInstall', 'EE_dailyTrigger', 'doGet', 'doPost',
    'EE_createCore', 'EE_planDay', 'EE_runDay', 'EE_env', 'eeSandboxSuite', 'eeSandboxStatus', 'EE_sbContinue']) {
    assert.equal(typeof ctx[fn], 'function', fn);
  }
  assert.equal(typeof ctx.MCPS_LIFECYCLE.decide, 'function');
  assert.equal(typeof ctx.MCPS_EMAIL_RENDER.render, 'function');
  assert.equal(ctx.EE_SEED.config.business.address, '4640 South Flores Road, Elmendorf, TX 78112');
  assert.ok(ctx.EE_SEED.templates['B/b_intro.html'].includes('{{button:Get your free quote|quote}}'));
});
