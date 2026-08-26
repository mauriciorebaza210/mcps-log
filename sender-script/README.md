# Per-person sender script

Campaign mail leaves from the Gmail account of the staff member who created the
campaign — their Sent folder, their daily quota. Apps Script can't do that from
one project (`GmailApp` always sends as the executing account), so each person
deploys this tiny script under their own Google account and the portal calls it.

```
portal (appscript/)                        Tony's sender web app
───────────────────                        ─────────────────────
resolve sender at CREATION                 verify HMAC + freshness
render subject/body                        reject replayed nonce
POST signed payload  ──────────────────►   GmailApp.sendEmail(...)
record what actually sent  ◄───────────    { ok, sender }
```

> ### ⚠️ Never copy `Code.gs` into `appscript/`
> It declares its own `doPost`. `clasp push` would install it into the portal
> project next to `WebhookReceiver`'s `doPost`, the second declaration would win,
> and **the entire portal API would stop answering**. This is a separate,
> standalone Apps Script project. Nothing in this folder is ever pushed by clasp.

---

## Setup — once, for the whole company

Pick a shared secret and put it on the **portal** script (Apps Script editor →
Project Settings → Script Properties):

| Property | Value |
|---|---|
| `COMMS_SENDER_SECRET` | a long random string — generate one, don't invent it |

Every sender script gets the same secret. Anyone holding it can make any deployed
sender script send mail, so treat it like a password: don't paste it into Sheets,
tickets, or chat.

---

## Setup — once per staff member

**The staff member must do steps 1–5 themselves, signed into their own Google
account.** That's the entire point: the deploying account is the sending account.

1. Go to <https://script.google.com> → **New project**. Name it
   `MCPS Sender — <their name>`.
2. Replace the contents of `Code.gs` with this folder's `Code.gs`.
3. **Project Settings → Script Properties → Add script property**
   `MCPS_SENDER_SECRET` = the same secret as above.
4. **Deploy → New deployment → Web app**
   - Execute as: **Me (their own address)** ← this is what makes them the sender
   - Who has access: **Anyone**

   "Anyone" is required — the portal calls this server-to-server with no Google
   credentials. The HMAC signature is the access control, not Google's.
5. Run `whoAmI()` from the editor once. It authorises the Gmail scope (a consent
   screen appears the first time) and prints the sending account. **Confirm it
   prints their address**, then copy the `/exec` URL from the deployment.

6. An admin adds a row to the **`Comms_Senders`** sheet on the portal's bound
   spreadsheet:

   | username | sender_email | sender_name | sender_script_url | active |
   |---|---|---|---|---|
   | `tony` | `tony@mcpoolsolutions.org` | `Tony — MCPS` | `https://script.google.com/macros/s/…/exec` | `TRUE` |

   `username` must match their portal login exactly. `active` accepts
   `TRUE`/`yes`/`1`; **anything unrecognised counts as inactive**, so a typo
   fails closed rather than quietly authorising someone.

7. Prove it end to end before any customer sees it — from the portal, as an
   admin:

   ```js
   api({ action: 'comms_sender_probe', token: _s.token, username: 'tony' }).then(console.log)
   ```

   It sends one email **to your own address** (never a client-supplied one) and
   returns `sender_matches: true` when the account that actually sent matches the
   registry. Then check two things by hand: the `From` header on the message, and
   that a copy is sitting in Tony's Sent folder.

---

## Redeploying after an edit

Apps Script serves the deployed *version*, not the latest code. After editing
`Code.gs`: **Deploy → Manage deployments → pencil → Version: New version →
Deploy**. Keeping the same deployment preserves the `/exec` URL, so the registry
row stays valid. A brand-new deployment issues a different URL and the registry
row must be updated to match.

## Rotating the secret

Sender scripts reject anything they can't verify, so a rotation is a brief
outage unless it's ordered: update every sender script's `MCPS_SENDER_SECRET`
first, then the portal's `COMMS_SENDER_SECRET`. Campaigns mid-send will fail
their in-flight recipients while the two disagree; those rows are retried, not
lost.

## When someone leaves

Set their `active` cell to `FALSE`. Campaigns they already created are locked to
their sender at creation time and will fail on their remaining recipients once
the account is suspended — reassign by creating a fresh campaign under a sender
who is still active.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Sender script returned a sign-in page` | Deployed with access ≠ **Anyone**. Redeploy. |
| `bad signature` | The two `MCPS_SENDER_SECRET` / `COMMS_SENDER_SECRET` values differ. |
| `stale request (…s skew)` | Clock skew beyond 5 min, or a replayed capture. |
| `replayed nonce` | The same signed payload arrived twice — expected on a retry of an already-delivered send. |
| `sender not configured` | `MCPS_SENDER_SECRET` missing on that sender script. |
| Probe succeeds but `sender_matches: false` | The script was deployed as the wrong account — redeploy with *Execute as* set to its owner. |
