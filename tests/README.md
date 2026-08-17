# Tests

No framework, no dependencies. Each file is a plain Node script that loads the
**real** source from `appscript/` or `js/` into a `vm` context with the Apps
Script services and sheet helpers stubbed, then asserts behaviour.

```bash
node tests/followups.test.js     # exits non-zero on failure
node tests/contracts-ui.test.js  # Contracts page + amendment UI wiring
```

## Why these exist

`appscript/Followups.js` emails real customers on an hourly trigger with no human
in the loop. Its failure modes — a duplicate chase, a burnt touch, mail sent to
someone who already signed — are invisible until a customer complains. The suite
covers them directly:

- eligibility is strictly `status === 'SENT'`
- state re-validated under the lock (customer signs, or the agreement is resent,
  between snapshot and claim)
- two overlapping sweeps send exactly once
- a sweep that loses its claim aborts instead of clobbering the new owner
- crash-after-send is never re-sent; Gmail failure is always retried
- the per-run cap counts attempts, so an outage can't hammer the whole book
- `FOLLOWUPS_DRY_RUN` changes nothing at all — not lifecycle state, not schema

## `funnel-parity.test.js` deserves special mention

The Contracts funnel is computed in **two** places — `api/contracts.js` (fast, reads Sheets directly)
and `handleGetSalesFunnel_` in `appscript/SalesHub.js` (fallback). The page silently uses whichever
answers, so if the two ever disagree it reports different numbers on different loads, with no error.

A shared implementation is impossible across the two runtimes, so this test is the substitute: one
fixture through both, assert identical output.

⚠️ **Its fixture is deliberately shaped.** It contains a June-sent/July-signed deal (cohort
attribution), an amendment (must not inflate close rate), an empty current month, and **four signed
deals with a skewed spread** so the median (13.5) differs from the mean (32). That last one exists
because an earlier version of the fixture had one signed deal per month — where median and mean are
identical — and swapping one for the other went undetected.

## Writing more

⚠️ **Freeze time properly.** Overriding `Date.now()` alone is not enough —
`new Date()` ignores it, and the schedule maths then runs against the real wall
clock, so boundary cases pass or fail at random. Stub the `Date` class itself
(see `FrozenDate` in `followups.test.js`).

⚠️ **Model the real code path.** A harness that takes a shortcut around the code
under test will pass while the app is broken — building a session's `pages` from
`ROLE_PAGES` instead of `unionPages_()` hid a bug that made two whole pages
invisible.
