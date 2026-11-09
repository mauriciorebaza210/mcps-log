# Lifecycle Email Engine: Progress

Plan: [PLAN.md](PLAN.md) · Branch: `feat/email-engine` · Worktree: `~/mcps-log-email-engine`
Resume in any Claude Code session with `/email-engine`.

## Now
- **Checkpoint in progress:** CP5 `tracking-api`
- **Goal (PLAN.md → Checkpoints):** `api/email.js` (authenticated reads, c/o/beacon/u, heartbeat) + the quotes merge; `vercel build` + import checks; API rows pass; quote flows OK on preview.
- **Steps (proposed):**
  1. ✅ **5a Quotes merge** (2026-11-09, cda1c5c): `api/quotes/index.js` + rewrite `/api/quotes/:op` → `/api/quotes?op=:op`; no caller changed. `vercel build` lists 10 functions; the built bundle imports and routes all three ops (`tests/quotes-dispatch.test.js`). Still to do: a quote get/save on the preview deploy (batched with the CP5 preview check).
  2. ✅ **5b `api/email.js` read path** (2026-11-09, 8d78760): `op=read` views overview / contacts / contact; Bearer-only token; engine Permissions tab (seeded mau + tony: editor, approver, operator); raw cache 15 s, redaction per request; row 31 tests (`tests/email-engine-api.test.js`). Read-only check on the real engine sheet: 1.45 s cold, 10 KB. Note: the raw cache is a 15 s TTL, not the plan's `data_version` key (a version check would itself cost the read it saves); writes from the portal will bust it.
  3. ✅ **5c Tracking** (2026-11-09, 0b4174d, 9cf1279, c362e9c): `js/lib/email-tracking.js` (signed links over token/link/mode/destination, beacon, classifier c1); `api/email.js` c/o/beacon/u; signed relay → engine `EE_relay_` → `Tracking.js` (Events_YYYY_MM, Engagement, stop requests only for verified clicks, forms, unsubscribes); `/service` sends the beacon and passes it on submit as a form signal; overview shows per-step evidence counts. Rows 22, 23, 28, 40 (click + unsubscribe) offline. Reply/bounce scanning (rows 20, 21) moves to CP6 prep (engine-only).
  4. ✅ **5d Heartbeat** (35b9c4b): Vercel Cron 15:00 UTC → `/api/email/heartbeat` (CRON_SECRET); alerts through the portal's existing signed mail relay (`sendEngineAlert` in notify.js) instead of a new `ee_alert` GAS action: same independence (portal project + account), no portal GAS deploy.
  5. **5e Deploy + live check:** engine @9 cp5-1 deployed (links stay plain until `EE_LINK_SECRET` is set; relay refuses until `EE_RELAY_SECRET` is set; verified live). Secrets generated in the session scratchpad (`ee-secrets.txt`, never in the repo). Waiting on Mau: push the branch for a preview, preview env vars, Script Properties, `eeSetup`, then a tracked test send.
- **Preview (2026-11-09):** branch pushed; alias https://mcps-log-git-feat-ema-65ac9a-mauricio-rebaza-figueroas-projects.vercel.app (behind Vercel SSO, so Gmail's image proxy can't record opens here; clicks from a browser signed in to Vercel work). Branch-scoped preview env: EE_ENGINE_SS_ID, EE_ENGINE_WEBAPP_URL, EE_LINK_SECRET, EE_RELAY_SECRET, EE_FIRST_PARTY_HOSTS. Checked on the deploy: quote routes reach their handlers, signed click → 302 + beacon, forged → 400.
- **⚠️ Revert before go-live:** engine Config `track_base` and `link_quote` point at the preview for the test; set back to https://mcps-log.vercel.app and https://mcps-log.vercel.app/service. Production env needs the same vars (minus EE_FIRST_PARTY_HOSTS) plus CRON_SECRET.
- **Next action:** Mau, in Tony's Apps Script: Script Properties EE_LINK_SECRET + EE_RELAY_SECRET (from the scratchpad file), `eeSetup`, Config track_base/link_quote → preview, `eeAddTrackingTestContact`, `eeRunNow`; click the email's button in a browser signed in to Vercel; then a quote open + save on the preview.
- **Needed from Mau at the CP5 deploy (batched):** Vercel env `EE_ENGINE_SS_ID` (+ the link and relay secrets from 5c, also set as Script Properties); Tony reruns `eeSetup` once (adds the Permissions tab); a quote open/save on the preview URL.
- **Blocked on / waiting for:** nothing. Deploys run as Tony via `npm run ee:deploy` (live @8, cp4-5). Tony's clasp login expires now and then: `clasp --user tony login`.
- **Open decisions (not blocking yet):** (1) the 3-1 report layout (CP8 portal work); (2) final Safety Guidelines + Startup Guide PDFs (can be added after launch through the Attachment Library); (3) A "positive service milestone"; (4) Referral Campaign timing.
- **Settled 2026-11-02:** 3-1 report = 3-day startup summary; summary email contents come from its template; all emails send from Tony's address; PDFs via the Attachment Library; test emails may go to Mau.

## Checkpoint log
| CP | Tag | Date | Commit | Evidence | Next |
|---|---|---|---|---|---|
| CP0 | `ee/cp0-setup` | 2026-11-02 | (this commit) | Worktree + branch; PLAN.md + PROGRESS.md committed; `/email-engine` skill; memory note; mockup v3 signed off by Mau (claude.ai/artifact/K3PVxvC3B82UisqAASpWxz) | CP1 spikes |
| CP1 | `ee/cp1-spikes` | 2026-11-02 | (this commit) | SPIKES.md: engine identity (deploys must be done as Tony), send boundary (drafts removed, G = 2 min / G2 = 15 min), unsubscribe ordering 6/6, lock-hold p95 1.70 s, read budgets met at launch size, Settings + Comms tabs confirmed; 2c inconclusive and 2d bounce rows invalid (documented). Guarantees section updated. | CP2 rules |
| CP2 | `ee/cp2-rules` | 2026-11-02 | 9104e20 | `js/lib/lifecycle-rules.js` + `email-engine/seed/ruleset-bc.json`; `npm run test:ee` 27/27 incl. worked examples 1–9, 11–16 as multi-week simulations; discovery proven with a temporary failing file | CP3 journal |
| CP3 | `ee/cp3-journal` | 2026-11-02 | 4f1b711 | `email-engine/src/EngineCore.js`; `npm run test:ee` 60/60; FG matrix rows 1–8, 10, 11, 15, 26–29, 35a/b, 36–38, 40–46 pass; lock rule and Journal replay checked in every test; mutation check (fencing, orphan cleanup, quiescence, gate) each caught | CP4 sandbox-send |
| CP4 | `ee/cp4-sandbox-send` | 2026-11-09 | (this commit) | Engine live in Tony's project (@8 cp4-5, runs as antonio@, guarded deploy `npm run ee:deploy`); B Intro + C Welcome revisions approved; branded test emails delivered and checked on mobile (logo badge added for dark mode); sandbox suite against real Gmail 18/18 ([sandbox-runs/2026-11-09.md](sandbox-runs/2026-11-09.md)): SB rows 1–5, 9, 35a/b, 36–41; row 40 unsubscribe part only (bounce/click/reply at CP5); `npm run test:ee` 88/88, incl. the suite dry-run + 5 mutation checks | CP5 tracking-api |

## Parking lot
Sidetracks and tweaks to come back to. Add with `/email-engine park "<note>"`.
- Vercel CLI is outdated (52.x). Upgrade before CP5 (`vercel build` checks).

## Session notes
- 2026-10-17 → 10-29: exploration, mockups v1–v2, and three plan reviews (7 → 8.5 → 9 → 9.3/10). Timing source: Mau's Oct 19 notebook.
