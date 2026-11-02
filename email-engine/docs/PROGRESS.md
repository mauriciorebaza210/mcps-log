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
  4. **4d Guarded deploy:** `scripts/ee-deploy.mjs` + a one-time `clasp --user tony login` (Mau, in a terminal).
  5. **4e Sandbox sends:** as Tony, run setup, approve both revisions, add test contacts (Mau's address), Run now.
  6. **4f Sandbox suite:** the SB rows with deterministic fault injection, in a separate sandbox spreadsheet so the engine's real sheets stay clean.
- **Next action:** 4d, the guarded deploy script; then Mau runs `clasp --user tony login` once.
- **Blocked on / waiting for:** nothing until 4d (Mau's `clasp --user tony login`).
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
