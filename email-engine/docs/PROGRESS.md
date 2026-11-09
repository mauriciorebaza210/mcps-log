# Lifecycle Email Engine: Progress

Plan: [PLAN.md](PLAN.md) · Branch: `feat/email-engine` · Worktree: `~/mcps-log-email-engine`
Resume in any Claude Code session with `/email-engine`.

## Now
- **Checkpoint in progress:** CP4 `sandbox-send`
- **Goal:** the engine runs in Tony's Apps Script project and sends branded test emails (B Intro, C Welcome) from antonio@ to Mau; the sandbox-mailbox failure rows (1–5, 9, 35a/b, 36–40) pass against real Gmail.
- **Steps:**
  1. ✅ **4a Renderer** (done 2026-11-02; 13 tests; previews checked in Chrome at desktop width, phone check happens on the real test emails in 4e): `js/lib/email-render.js` (shell + merge fields + blocks + validation; pure, shared with the portal preview) and the B Intro and C Welcome bodies + PoolSchool block, with Node tests.
  2. ✅ **4b Apps Script adapter** (built 2026-11-02; runs for real in 4e): `Env.js` over Sheets / PropertiesService / LockService / GmailApp; `Setup.js` creates the engine tabs, the separate Journal spreadsheet and the Drive folders; `Planner.js` builds today's plan with `decide()`.
  3. ✅ **4c Revisions** (built 2026-11-02; `eeApprove` dry-renders, freezes and hashes; send re-checks the hash): approve → immutable copy + sha256; integrity check at send.
  4. ✅ **4d Guarded deploy:** `scripts/ee-deploy.mjs` + a one-time `clasp --user tony login` (Mau, in a terminal).
  5. ✅ **4e Sandbox sends** (2026-11-02: the B Intro and C Welcome were delivered from antonio@ to Mau; an Intro interrupted by a Gmail-permission error was recovered as attempt 2, one email; 3 real-world fixes deployed: quota reserve 200→20 (Tony's quota is 100/day), clean stop on Gmail errors, crashed runs logged): as Tony, run setup, approve both revisions, add test contacts (Mau's address), Run now.
  6. **4f Sandbox suite** (built and deployed 2026-11-09, @8 cp4-5; waiting on the real run): `email-engine/src/Sandbox.js`. Mau clicks Run on `eeSandboxSuite` in Tony's window once; it creates a fresh sandbox sheet + Journal in the engine's Drive folder, runs rows 1–5, 9, 35a/b, 36–41 over ~25 min via its own triggers (G and G2 waits), and emails a pass/fail report. About 13 emails to `mauricio+sb<tag><n>@`. Isolation: `SB_` prefix on lease/pause/cache, a sandbox Comms_Optouts tab, alerts only in the sheet. Same scenarios dry-run in Node (`tests/email-engine-sandbox.test.js`, simulated time); 5 deliberate core breaks each make it fail. Row 40 covers unsubscribe isolation only: bounce/click/reply isolation needs CP5 tracking, so it's checked there.
  - Also 2026-11-09: logo now carries a white badge so it reads in Gmail dark mode (`mcps-lockup-badge.png` on the asset host, all 26 old files verified byte-identical).
- **Built:** 4d guarded deploy, `npm run ee:deploy "<what changed>"` (`scripts/ee-deploy.mjs`): it checks the project, the deployment and the Tony login, syncs, runs the tests, pushes, deploys as Tony, then checks the live engine runs as antonio@ on the new version, rolling back if not.
- **Next action:** Mau runs `eeSandboxSuite` once in Tony's Apps Script window (authorize the new trigger permission if asked), then waits for the report email (~25 min). All pass → close CP4 (tag `ee/cp4-sandbox-send`). Any fail → fix, redeploy, rerun.
- **Verified 2026-11-04:** second `eeRunNow` sent 0, contact test_mau_b moved B1 → B2, no alerts. Frame looks good on mobile.
- **Blocked on / waiting for:** Mau's run of the suite. Deploys run as Tony via `npm run ee:deploy` (live @8, cp4-5). Tony's clasp login expires now and then: `clasp --user tony login`.
- **Open decisions (not blocking yet):** (1) the 3-1 report layout (CP8 portal work); (2) final Safety Guidelines + Startup Guide PDFs (can be added after launch through the Attachment Library); (3) A "positive service milestone"; (4) Referral Campaign timing.
- **Settled 2026-11-02:** 3-1 report = 3-day startup summary; summary email contents come from its template; all emails send from Tony's address; PDFs via the Attachment Library; test emails may go to Mau.

## Checkpoint log
| CP | Tag | Date | Commit | Evidence | Next |
|---|---|---|---|---|---|
| CP0 | `ee/cp0-setup` | 2026-11-02 | (this commit) | Worktree + branch; PLAN.md + PROGRESS.md committed; `/email-engine` skill; memory note; mockup v3 signed off by Mau (claude.ai/artifact/K3PVxvC3B82UisqAASpWxz) | CP1 spikes |
| CP1 | `ee/cp1-spikes` | 2026-11-02 | (this commit) | SPIKES.md: engine identity (deploys must be done as Tony), send boundary (drafts removed, G = 2 min / G2 = 15 min), unsubscribe ordering 6/6, lock-hold p95 1.70 s, read budgets met at launch size, Settings + Comms tabs confirmed; 2c inconclusive and 2d bounce rows invalid (documented). Guarantees section updated. | CP2 rules |
| CP2 | `ee/cp2-rules` | 2026-11-02 | 9104e20 | `js/lib/lifecycle-rules.js` + `email-engine/seed/ruleset-bc.json`; `npm run test:ee` 27/27 incl. worked examples 1–9, 11–16 as multi-week simulations; discovery proven with a temporary failing file | CP3 journal |
| CP3 | `ee/cp3-journal` | 2026-11-02 | 4f1b711 | `email-engine/src/EngineCore.js`; `npm run test:ee` 60/60; FG matrix rows 1–8, 10, 11, 15, 26–29, 35a/b, 36–38, 40–46 pass; lock rule and Journal replay checked in every test; mutation check (fencing, orphan cleanup, quiescence, gate) each caught | CP4 sandbox-send |

## Parking lot
Sidetracks and tweaks to come back to. Add with `/email-engine park "<note>"`.
- Vercel CLI is outdated (52.x). Upgrade before CP5 (`vercel build` checks).

## Session notes
- 2026-10-17 → 10-29: exploration, mockups v1–v2, and three plan reviews (7 → 8.5 → 9 → 9.3/10). Timing source: Mau's Oct 19 notebook.
