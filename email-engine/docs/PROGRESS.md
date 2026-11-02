# Lifecycle Email Engine: Progress

Plan: [PLAN.md](PLAN.md) · Branch: `feat/email-engine` · Worktree: `~/mcps-log-email-engine`
Resume in any Claude Code session with `/email-engine`.

## Now
- **Checkpoint in progress:** CP3 `journal`
- **Goal:** the engine's safety core in `email-engine/src/`: the Journal (authoritative ordered record with op_ids, hash chain, catch-up replay, fail-closed pause), the fenced run lease, the delivery stages (claim → drafted → sending → sent | reconcile | unknown), reconcile, and the quiescence-gated Resend. All platform access goes through an `env` adapter, so the fake Gmail/Sheets tests exercise the same code Apps Script will run. Exit: the FG failure-matrix rows (incl. 42–46 fault injection) pass.
- **Built 2026-11-02:** `email-engine/src/EngineCore.js` and `tests/email-engine-core.test.js` (32 tests); the suite is 60/60 with the rules tests.
  - **Failure-matrix rows passing (fake Gmail):** 1–8, 10, 11, 15, 26–29, 35a, 35b, 36–38, 40–46.
  - **Checked in every test:** Gmail is never called while the lock is held (the fake fails the test), and the Journal alone rebuilds the main sheet exactly.
  - **Mutation check:** removing lease fencing, orphan-draft cleanup, the Resend quiescence wait, or the authorization gate each makes the matching rows fail.
  - **Not CP3 (later checkpoints):** 9, 12–14, 20–23, 30–34, 39 (sandbox mailbox, content and revisions, tracking, API, migrations, security audit, backup restore). Rows 16–19, 24 and 25 are covered by the CP2 rules tests.
- **Next action:** close CP3, then CP4: the Apps Script adapter (`Env.js`), the B Intro + C Welcome revisions, and test sends to Mau in the sandbox.
- **Blocked on / waiting for:** nothing. Mau OK'd sending test emails to himself when sandbox runs need it (CP4).
- **Open decisions (not blocking yet):** (1) the 3-1 report layout (CP8 portal work); (2) final Safety Guidelines + Startup Guide PDFs (can be added after launch through the Attachment Library); (3) A "positive service milestone"; (4) Referral Campaign timing.
- **Settled 2026-11-02:** 3-1 report = 3-day startup summary; summary email contents come from its template; all emails send from Tony's address; PDFs via the Attachment Library.

## Checkpoint log
| CP | Tag | Date | Commit | Evidence | Next |
|---|---|---|---|---|---|
| CP0 | `ee/cp0-setup` | 2026-11-02 | (this commit) | Worktree + branch; PLAN.md + PROGRESS.md committed; `/email-engine` skill; memory note; mockup v3 signed off by Mau (claude.ai/artifact/K3PVxvC3B82UisqAASpWxz) | CP1 spikes |
| CP1 | `ee/cp1-spikes` | 2026-11-02 | (this commit) | SPIKES.md: engine identity (deploys must be done as Tony), send boundary (drafts removed, G = 2 min / G2 = 15 min), unsubscribe ordering 6/6, lock-hold p95 1.70 s, read budgets met at launch size, Settings + Comms tabs confirmed; 2c inconclusive and 2d bounce rows invalid (documented). Guarantees section updated. | CP2 rules |
| CP2 | `ee/cp2-rules` | 2026-11-02 | 9104e20 | `js/lib/lifecycle-rules.js` + `email-engine/seed/ruleset-bc.json`; `npm run test:ee` 27/27 incl. worked examples 1–9, 11–16 as multi-week simulations; discovery proven with a temporary failing file | CP3 journal |

## Parking lot
Sidetracks and tweaks to come back to. Add with `/email-engine park "<note>"`.
- Vercel CLI is outdated (52.x). Upgrade before CP5 (`vercel build` checks).

## Session notes
- 2026-10-17 → 10-29: exploration, mockups v1–v2, and three plan reviews (7 → 8.5 → 9 → 9.3/10). Timing source: Mau's Oct 19 notebook.
