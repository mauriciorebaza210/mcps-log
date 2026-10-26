# QuickBooks Online payroll integration

When an admin clicks **Record Paycheck** in the Payroll tab, the paycheck is saved to the
`Employee_Paychecks` Google Sheet (source of truth) and then posted to QuickBooks Online as one
**balanced Journal Entry**. QBO failures never block the save — the paycheck row shows a
"Failed — Retry" chip you can re-run anytime.

## Accounting model (one JE per paycheck)

| Side | Bucket | Amount |
|---|---|---|
| Dr | `wages_expense` | gross |
| Dr | `payroll_tax_expense` | er_ss + er_med + futa + suta |
| Cr | `federal_income_tax_payable` | fed |
| Cr | `fica_payable` | ss + med + er_ss + er_med |
| Cr | `futa_payable` | futa |
| Cr | `suta_payable` | suta |
| Cr | `bank_checking` | net |

Always balances (`net = gross − fed − ss − med`). Each bucket maps to a real QBO account chosen once
in the **QuickBooks** setup modal (Payroll tab, admin). Multiple buckets may point at the same account.

Idempotency: each JE uses `DocNumber = PR-<paycheck_id>`. Retrying never creates a duplicate — if a
JE with that DocNumber already exists, it's reused.

## One-time setup

1. **Create an Intuit developer app** at https://developer.intuit.com → an app with the
   **Accounting** scope (`com.intuit.quickbooks.accounting`). Grab the Client ID / Client Secret
   from the **Production** keys (or **Development** keys while testing against the sandbox).
2. **Set the redirect URI** on the Intuit app to:
   `https://<your-vercel-domain>/api/qbo/callback`
   (and `http://localhost:3000/api/qbo/callback` for `vercel dev`).
3. **Add env vars** (Vercel project settings + `.env.local`):

   | Var | Value |
   |---|---|
   | `QBO_CLIENT_ID` | Intuit app client id |
   | `QBO_CLIENT_SECRET` | Intuit app client secret |
   | `QBO_REDIRECT_URI` | the callback URL from step 2 |
   | `QBO_ENV` | `sandbox` while testing, `production` when live |
   | `QBO_STATE_SECRET` | any long random string (signs the OAuth `state`) |
   | `QBO_CONFIG_SPREADSHEET_ID` | *(optional)* spreadsheet for `QBO_Tokens`/`QBO_Account_Map`; defaults to the CRM spreadsheet |

   The Google service account (`GOOGLE_CLIENT_EMAIL`) must have **edit** access to whatever
   spreadsheet `QBO_CONFIG_SPREADSHEET_ID` points at (the CRM spreadsheet already grants this).
4. **Connect**: Payroll tab → **📘 QuickBooks** → *Connect QuickBooks* → authorize → return and
   *refresh*. The `QBO_Tokens` tab is created automatically.
5. **Map accounts**: in the same modal, pick a QBO account for each of the 7 buckets → *Save mapping*.

## Endpoints (`/api/qbo/*`)

- `connect` — GET, admin: redirects to Intuit consent.
- `callback` — GET: Intuit redirect target; stores tokens.
- `status` — GET, portal token: `{ connected, companyName, mapComplete, missing }`.
- `accounts` — GET, admin: active chart of accounts for the dropdowns.
- `map` — GET/POST, admin: read/save the bucket→account map.
- `journal` — POST, admin: post the balanced JE for a saved paycheck (idempotent).
- `disconnect` — POST, admin: revoke + clear tokens.

Tokens auto-refresh (access ~1h, refresh ~100d) with a concurrency-safe write in `_qbo.js`.

## Testing against the sandbox

With `QBO_ENV=sandbox` and sandbox keys, run `vercel dev`, connect to an Intuit **sandbox** company,
map accounts, then record a paycheck and confirm the JE in QBO (Accounting → Journal Entries). It
should balance, be dated on the **pay date**, and clicking *Post to QuickBooks* twice must not create
a second entry.

---

# Monthly service invoices (Clients tab)

Automates the monthly "duplicate last month's invoice, change the number to the new month, send" routine.
Financial Hub → **Clients** → **Invoices · <Month>** panel.

**How an invoice is built:** the client's most recent QBO invoice whose number is a month name
("September") is copied: same item(s), description, qty, rate, tax code, terms, note to customer, billing
email/CC/BCC and addresses. The new one is numbered with the billed month ("October"), dated today
(America/Chicago), and created **unsent**. `TxnTaxDetail` is omitted so automated sales tax recalculates.
Repair/startup invoices (non-month numbers) are never used as templates.

**Never billed twice:** every portal-created invoice carries `PrivateNote = mcps-auto:<quote_id>:<YYYY-MM>`.
Before creating, the client's recent invoices are checked for that note *or* a hand-made invoice with the same
month name dated from ~10 days before the month through the end of the next month (catch-up invoices happen).
If found, it's returned instead of creating a new one. Month names repeat across customers, so creation uses
`?include=allowduplicatedocnum`.

**Nothing is emailed without two switches:** step 1 in the UI only creates drafts; step 2 calls `invoice_send`,
which the server refuses unless **`QBO_INVOICE_SEND=on`**. It also refuses any invoice the portal didn't create for
that client. Leave the variable unset until a reviewed batch is ready to go out.

**Card-on-file clients** (toggle per client): the QBO API can't charge stored cards, so these are listed under
"Charge in QuickBooks" with direct links; they aren't emailed unless "Also email card-on-file clients" is ticked.

**Paid detection:** on Clients tab load, portal-tracked invoices from this and last month are checked; a zero
balance flips the client to Paid.

**Customer links** live in a hidden `QBO_Customer_Map` tab (`Quote_ID`, `QBO_Customer_ID`, `QBO_Customer_Name`,
`Card_On_File`, `Updated_At`) beside `QBO_Account_Map`. First run auto-matches by email, then exact name; a
match is saved once confirmed.

| Op | Method | Does |
|---|---|---|
| `customers` | GET | Active QBO customers (id, name, email) |
| `customer_map` | GET / POST `{ entries }` | Read / merge customer links |
| `invoice_prepare` | POST `{ clients[] }` | Read-only preview: template, existing invoice, rate mismatch |
| `invoice_create` | POST `{ quote_id, qbo_customer_id, month_key }` | Create one unsent invoice (idempotent) |
| `invoice_send` | POST `{ quote_id, invoice_id }` | Email through QBO, only if `QBO_INVOICE_SEND=on` |
| `invoice_status` | POST `{ ids[] }` | Balances for paid detection |

## Previewing locally

On `localhost`, the Clients tab runs in **DRY RUN**: Pause / Lost / invoice day / payment-status writes and
customer-link saves are logged to the console instead of sent to Apps Script (append `?live=1` to override).
QuickBooks calls still go to whatever company `QBO_Tokens` holds, so preview against a **sandbox** company
(`QBO_ENV` unset) and keep `QBO_INVOICE_SEND` unset.

⚠️ `QBO_Tokens` lives in a shared spreadsheet. After production is connected, local `vercel dev` would read the
production tokens. To keep previewing against the sandbox, point local at a separate config sheet with
`QBO_CONFIG_SPREADSHEET_ID` in `.env.local`.
