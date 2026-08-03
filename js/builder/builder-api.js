// ══════════════════════════════════════════════════════════════════════════════
// BUILDER API — the staff/builder token boundary
//
// js/lib/api.js injects a token into any payload that omits one, reading `mcps_s`
// straight from localStorage (see withSessionToken_). The portal shares an origin
// with the staff SPA, so a staff session in the same browser is visible here.
//
// Two rules keep the two apart, and every portal request must follow both:
//   1. `token` is ALWAYS set — to '' — so the injector never fires. It is a
//      suppression field in the portal and never carries a session.
//   2. The builder session travels in `builder_token`, a key no staff handler reads.
// ══════════════════════════════════════════════════════════════════════════════

const BUILDER_SESSION_KEY = 'mcps_builder_s';

let _bs = null;   // { token, company_name, pool_company_id, email }

function bLoadSession() {
  try {
    const raw = localStorage.getItem(BUILDER_SESSION_KEY);
    _bs = raw ? JSON.parse(raw) : null;
  } catch (e) {
    _bs = null;
  }
  return _bs;
}

function bSaveSession(session) {
  _bs = session;
  try { localStorage.setItem(BUILDER_SESSION_KEY, JSON.stringify(session)); } catch (e) {}
}

function bClearSession() {
  _bs = null;
  try { localStorage.removeItem(BUILDER_SESSION_KEY); } catch (e) {}
}

function bToken() {
  return _bs && _bs.token ? _bs.token : '';
}

/**
 * Every portal call goes through here — never call api() directly from the portal.
 * Sets token:'' unconditionally, and attaches the builder session as builder_token.
 */
function bapi(payload) {
  const body = Object.assign({}, payload || {});
  body.token = '';                       // suppress the staff-token injector
  const t = bToken();
  if (t) body.builder_token = t;         // the actual builder session
  return api(body);
}

/** Pre-auth calls (invite lookup/claim, login) — same suppression, no session. */
function bapiPublic(payload) {
  const body = Object.assign({}, payload || {});
  body.token = '';
  delete body.builder_token;
  return api(body);
}
