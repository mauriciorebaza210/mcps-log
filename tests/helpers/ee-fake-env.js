// Shared fake Apps Script environment for the email-engine tests: a fake Gmail
// and in-memory sheets with fault injection, driving the real EngineCore.js.
// Not a test file itself (the runner only picks up tests/email-engine-*.test.js).
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const CORE_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'email-engine', 'src', 'EngineCore.js'), 'utf8');
function loadCore() {
  const ctx = { JSON, Math, Date, Object, Array, String, Number, Error };
  vm.createContext(ctx);
  vm.runInContext(CORE_SRC, ctx, { filename: 'EngineCore.js' });
  return ctx;
}
const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-02T15:00:00Z');
const OWNER = 'antonio@mcpoolsolutions.org';
const ID = { Deliveries: 'delivery_id', Enrollments: 'enrollment_id', Contacts: 'contact_id', Revisions: 'revision_id', Holds: 'key', Inbox: 'inbox_id', Secondaries: 'op_ref', Suppressions_Test: 'email_norm', Engagement: 'delivery_id', Threads: 'thread_id' };

function fakeWorld() {
  const w = { now: T0, user: OWNER, owner: OWNER, enabled: true, paused: [], quota: 1500,
    props: {}, cache: {}, lockHeld: false, dead: false, n: 0,
    journal: [], tables: { Deliveries: [], Enrollments: [], Contacts: [], Revisions: [], Holds: [], Inbox: [], Secondaries: [], Suppressions_Test: [], Engagement: [], Threads: [] }, meta: {},
    events: [],
    optouts: [], drafts: {}, outbox: [], alerts: [], steps: {}, revisions: {}, faults: {}, hooks: {} };
  const fault = name => { const f = w.faults[name]; if (!f) return null; if (f.times !== undefined && f.times-- <= 0) return null; return f; };
  const alive = () => { if (w.dead) throw { killed: true, message: 'process is dead' }; };
  const noLock = what => { if (w.lockHeld) throw new Error('LOCK RULE BROKEN: ' + what + ' called while holding the script lock'); };
  const table = name => w.tables[name];
  w.env = {
    now: () => w.now,
    uuid: () => '00000000-0000-4000-8000-' + String(++w.n).padStart(12, '0'),
    sha256: s => crypto.createHash('sha256').update(s).digest('hex'),
    user: () => w.user,
    flush: () => {},
    withLock(fn) {
      alive();
      if (w.lockHeld) throw new Error('re-entrant lock');
      w.lockHeld = true;
      try { return fn(); } finally { w.lockHeld = false; }
    },
    props: { get: k => (alive(), w.props[k] === undefined ? null : w.props[k]), set: (k, v) => { alive(); w.props[k] = v; }, del: k => { alive(); delete w.props[k]; } },
    cache: { get: k => w.cache[k] || null, put: (k, v) => { w.cache[k] = v; } },
    alert: (kind, detail) => w.alerts.push(kind + ':' + detail),
    journal: {
      last() { if (fault('journal.unavailable')) throw new Error('journal spreadsheet unavailable'); return w.journal[w.journal.length - 1] || null; },
      get: seq => w.journal.find(r => r.seq === seq) || null,
      from: seq => w.journal.filter(r => r.seq >= seq),
      findByOpId: id => w.journal.find(r => r.op_id === id) || null,
      append(rec) {
        const f = fault('journal.append');
        if (f && f.mode === 'throw') throw new Error('append failed');
        w.journal.push(JSON.parse(JSON.stringify(rec)));
        if (f && f.mode === 'ack_lost') throw new Error('append timed out after writing');
      }
    },
    store: {
      rows: name => table(name).map(r => Object.assign({}, r)),
      get: (name, id) => { const r = table(name).find(x => x[ID[name]] === id); return r ? Object.assign({}, r) : null; },
      upsert(name, row) {
        // Only consume the fault on the write it targets (e.g. the "sending" update).
        const f = w.faults['store.upsert:' + name];
        if (f && (!f.state || f.state === row.state) && (f.times === undefined || f.times-- > 0)) throw new Error('main sheet write failed');
        const i = table(name).findIndex(x => x[ID[name]] === row[ID[name]]);
        if (i >= 0) table(name)[i] = Object.assign({}, row); else table(name).push(Object.assign({}, row));
      }
    },
    meta: { get: k => w.meta[k] === undefined ? null : w.meta[k], set: (k, v) => { w.meta[k] = v; } },
    events: { has: id => w.events.some(e => e.event_id === id), append: row => { w.events.push(Object.assign({}, row)); } },
    optouts: {
      append(row) { if (fault('optouts.append')) throw new Error('Comms_Optouts write failed'); w.optouts.push(row); },
      hasSource: src => w.optouts.some(r => r.source === src),
      scope(email) {
        if (fault('optouts.scope')) throw new Error('Comms_Optouts unreadable');
        const r = w.optouts.filter(o => o.email === email);
        return r.some(o => o.scope === 'all') ? 'all' : r.length ? 'marketing' : '';
      }
    },
    gmail: {
      createDraft(msg) {
        noLock('createDraft'); alive();
        const id = 'r-' + (++w.n);
        w.drafts[id] = { token: msg.token, msg };
        if (fault('createDraft.kill')) { w.dead = true; throw { killed: true }; }
        return id;
      },
      draftExists: id => (noLock('draftExists'), !!w.drafts[id]),
      deleteDraft: id => { noLock('deleteDraft'); delete w.drafts[id]; },
      sendDraft(id) {
        noLock('sendDraft'); alive();
        if (w.hooks.beforeSend) w.hooks.beforeSend(id);
        if (fault('send.timeout')) throw new Error('Gmail: timed out');           // nothing sent
        if (fault('send.killBefore')) { w.dead = true; throw { killed: true }; }   // nothing sent
        const d = w.drafts[id];
        if (!d) throw new Error('draft not found');
        delete w.drafts[id];
        const delayed = fault('send.delayed');
        const msg = { token: d.token, message_id: 'm-' + (++w.n), thread_id: 't-' + w.n,
          visible_at: w.now + (delayed ? delayed.ms : 0), to: d.msg.to };
        w.outbox.push(msg);
        if (fault('send.kill')) { w.dead = true; throw { killed: true }; }         // accepted, then the process died
        if (fault('send.ackLost')) throw new Error('Gmail: timed out');           // accepted, then an error
        return { message_id: msg.message_id, thread_id: msg.thread_id };
      },
      searchSent(token) {
        noLock('searchSent');
        const m = w.outbox.find(x => x.token === token && x.visible_at <= w.now);
        return m ? { message_id: m.message_id, thread_id: m.thread_id } : null;
      },
      findDraftsByToken: token => (noLock('findDraftsByToken'), Object.keys(w.drafts).filter(id => w.drafts[id].token === token))
    },
    config: { ownerEmail: () => w.owner, engineEnabled: () => w.enabled, pausedBuckets: () => w.paused },
    stepStatus: id => w.steps[id] || 'active',
    revisionStatus: id => w.revisions[id] || 'published',
    render: row => ({ to: row.email_norm, subject: 'Hello', html: '<p>Hi</p><p>Ref ' + row.token + '</p>', text: 'Hi. Ref ' + row.token }),
    quota: () => w.quota
  };
  w.core = loadCore().EE_createCore(w.env);
  w.revive = () => { w.dead = false; w.lockHeld = false; };
  w.sentTo = email => w.outbox.filter(m => m.to === email).length;
  w.delivery = key => w.tables.Deliveries.find(r => r.delivery_id === key);
  return w;
}
function enroll(w, id, extra) {
  w.tables.Enrollments.push(Object.assign({ enrollment_id: id, status: 'active', stopped_branches: [] }, extra || {}));
}
function item(key, extra) {
  return Object.assign({ key, enrollment_id: 'e1', contact_id: 'c1', step_id: 'b_intro', occurrence: 1, mode: 'production',
    email_norm: 'maria@example.com', bucket: 'B', category: 'marketing' }, extra || {});
}
// The Journal is authoritative: replaying it from zero must rebuild the main
// sheet exactly (PLAN.md → Journal).
function assertReplayable(w) {
  const fresh = fakeWorld();
  fresh.journal = w.journal.map(r => JSON.parse(JSON.stringify(r)));
  fresh.core.catchUp();
  for (const t of ['Deliveries', 'Inbox']) {
    const key = r => r[ID[t]];
    const a = [...w.tables[t]].sort((x, y) => key(x) < key(y) ? -1 : 1);
    const b = [...fresh.tables[t]].sort((x, y) => key(x) < key(y) ? -1 : 1);
    assert.deepEqual(b, a, t + ' rebuilt from the Journal differs from the live sheet');
  }
}

module.exports = { fakeWorld, enroll, item, assertReplayable, loadCore, MIN, T0, OWNER, ID };
