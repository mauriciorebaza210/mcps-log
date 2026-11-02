# Lifecycle Email Engine: Progress

Plan: [PLAN.md](PLAN.md) · Branch: `feat/email-engine` · Worktree: `~/mcps-log-email-engine`
Resume in any Claude Code session with `/email-engine`.

## Now
- **Checkpoint in progress:** CP2 `rules`
- **Goal:** `js/lib/lifecycle-rules.js`, a pure scheduling module (`decide()`) that the browser, Vercel and the engine will all share. It covers enrollment/startup/previous anchors, holds, deadlines and the three-layer stop model. Worked examples 1–7, 9, 11–16 must pass under `npm run test:ee`.
- **Built 2026-11-02:** `js/lib/lifecycle-rules.js` (`decide()`, `decideEnrollment()`), the B/C seed `email-engine/seed/ruleset-bc.json`, and `tests/email-engine-rules.test.js`: 27 tests pass under `npm run test:ee`, covering worked examples 1–9 and 11–16 plus stop rules, suppression scopes, test-mode isolation, in-flight deliveries, pauses, needs-review, deferred timing, the Apps Script global load, and the Chicago clock across DST. Discovery proven (a temporary failing file made the suite exit 1).
- **Next action:** close CP2 (`/email-engine checkpoint`), then CP3: the Journal, fenced lease and delivery state machine.
- **Blocked on / waiting for:** nothing.
- **Open decisions (not blocking yet):** (1) the 3-1 report layout (CP8 portal work); (2) final Safety Guidelines + Startup Guide PDFs (can be added after launch through the Attachment Library); (3) A "positive service milestone"; (4) Referral Campaign timing.
- **Settled 2026-11-02:** 3-1 report = 3-day startup summary; summary email contents come from its template; all emails send from Tony's address; PDFs via the Attachment Library.

## Checkpoint log
| CP | Tag | Date | Commit | Evidence | Next |
|---|---|---|---|---|---|
| CP0 | `ee/cp0-setup` | 2026-11-02 | (this commit) | Worktree + branch; PLAN.md + PROGRESS.md committed; `/email-engine` skill; memory note; mockup v3 signed off by Mau (claude.ai/artifact/K3PVxvC3B82UisqAASpWxz) | CP1 spikes |
| CP1 | `ee/cp1-spikes` | 2026-11-02 | (this commit) | SPIKES.md: engine identity (deploys must be done as Tony), send boundary (drafts removed, G = 2 min / G2 = 15 min), unsubscribe ordering 6/6, lock-hold p95 1.70 s, read budgets met at launch size, Settings + Comms tabs confirmed; 2c inconclusive and 2d bounce rows invalid (documented). Guarantees section updated. | CP2 rules |

## Parking lot
Sidetracks and tweaks to come back to. Add with `/email-engine park "<note>"`.
- Vercel CLI is outdated (52.x). Upgrade before CP5 (`vercel build` checks).

## Session notes
- 2026-10-17 → 10-29: exploration, mockups v1–v2, and three plan reviews (7 → 8.5 → 9 → 9.3/10). Timing source: Mau's Oct 19 notebook.
