# Phase 0 spike report (CP1)

Each spike records what was measured, how, and what it changes in PLAN.md. CP1 closes when every spike has a result and the plan's *Guarantees* section matches them.

| # | Spike | Status | Result |
|---|---|---|---|
| 1 | Engine project ownership, binding, web-app identity after redeploy, trigger ownership | waiting on Tony (~15 min) | |
| 2 | Gmail send boundary: draft removal, interrupted and delayed sends, orphan drafts, Sent-search latency (G/G2), auto-reply headers, execution lifetime | waiting on account choice | |
| 3 | Concurrency: unsubscribe during a long run; lock-hold p50/p95 per critical-section type | waiting on account choice | |
| 4 | Service-account read latency and bytes per op on a synthetic engine spreadsheet | not started | |
| 5 | `Comms_Optouts` and `Comms_Log` exist in the live Settings spreadsheet | not started | |
| 6 | Node test glob discovers the whole suite | **done 2026-11-02** | see below |

## 6. Node test glob (done 2026-11-02)
**Setup:** Node v24.14.1, a scratch folder with `tests/email-engine-a.test.js` and `-b.test.js` (both pass), `-c.test.js` (`process.exit(1)`), and an unrelated `tests/other.test.js`.

| Command | Files run | Exit code | Verdict |
|---|---|---|---|
| `node --test "tests/email-engine-*.test.js"` (quoted), all passing | a, b (other.test.js excluded) | 0 | ✔ |
| Same, with c failing | a, b, c; reports "fail 1" and names c | 1 | ✔ |
| `node --test tests/email-engine-*.test.js` (unquoted, shell-expanded) | a, b, c | 1 | ✔ also works |
| `node tests/email-engine-*.test.js` (no `--test`) | **only a**; b and c are passed as arguments to a | **0, despite c failing** | ✖ the trap the reviewer flagged |

**Conclusion:** `npm run test:ee` = `node --test "tests/email-engine-*.test.js"` is correct. Each file runs in its own process, so any non-zero exit fails the suite. No plan change needed; the plan's command already matches. The plain `node <glob>` form must never be used.
