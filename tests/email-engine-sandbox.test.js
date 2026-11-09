// The sandbox suite (email-engine/src/Sandbox.js) dry-run against the fake env,
// with simulated time, so a real run in Tony's account only tests Gmail, not
// the suite. Also checks the suite can fail: a broken Sent search must show up.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { fakeWorld } = require('./helpers/ee-fake-env.js');
const SRC = path.join(__dirname, '..', 'email-engine', 'src');

function suiteWorld() {
  const w = fakeWorld();
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error, Infinity };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'EngineCore.js'), 'utf8') + '\n' + fs.readFileSync(path.join(SRC, 'Sandbox.js'), 'utf8'), ctx);
  const data = { tag: 't1', results: {}, expect: {}, n: 0, revisions: { b_intro: 'rev_b_intro_1' } };
  const clone = o => JSON.parse(JSON.stringify(o));
  let snap = null;
  const h = {
    data,
    now: () => w.now,
    save() { JSON.stringify(data); },                  // must stay serialisable (Script Properties)
    env: spec => ctx.EE_SB_wrapEnv_(w.env, spec),
    core: env => ctx.EE_createCore(env),
    addr: n => 'mauricio+sbt1' + n + '@mcpoolsolutions.org',
    revisionId: s => data.revisions[s],
    countSent: a => w.outbox.filter(m => m.to === a && m.visible_at <= w.now).length,
    sandboxOptoutsHas: e => w.optouts.some(o => o.email === e),
    realOptoutsHas: () => false,
    prodSafetyPause: () => null,
    backup() { snap = clone({ tables: w.tables, meta: w.meta }); },
    restore() { w.tables = clone(snap.tables); w.meta = clone(snap.meta); }
  };
  function runAll() {
    let t, ticks = 0;
    while (!(t = ctx.EE_SB_tick_(h, 150000)).done) {
      w.now = Math.max(w.now + 1, t.nextAt);
      assert.ok(++ticks < 100, 'scheduler never finished');
    }
    return { report: ctx.EE_SB_report_(data), ticks, minutes: (w.now - require('./helpers/ee-fake-env.js').T0) / 60000 };
  }
  return { w, h, ctx, runAll };
}

test('Sandbox suite: every SB row passes against the fake env, with the waits for G and G2', () => {
  const s = suiteWorld();
  const { report, minutes } = s.runAll();
  assert.equal(report.pass, report.total, report.text);
  assert.ok(minutes >= 16 && minutes < 30, 'the G2 check waits past 15 min (' + minutes + ')');
  // External effect: exactly the expected emails, and nothing left in Drafts.
  const expected = Object.values(s.h.data.expect).reduce((a, b) => a + b, 0);
  assert.equal(s.w.outbox.length, expected);
  assert.equal(Object.keys(s.w.drafts).length, 0);
});

test('Sandbox suite: a broken Sent search is reported as a failure, not a pass', () => {
  const s = suiteWorld();
  s.w.env.gmail.searchSent = () => null;
  const { report } = s.runAll();
  assert.ok(report.pass < report.total);
  assert.match(report.text, /FAIL row1_after_G/);
  assert.match(report.text, /FAIL row5_after_G/);
});
