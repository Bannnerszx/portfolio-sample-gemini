# The spreadsheet layout

Why the Google Sheet needs setting up by hand when Firestore doesn't, what the columns are, and
three ways to create them.

---

## Why this is needed at all

Firestore never needed provisioning. This just works on a brand-new project:

```js
await db.collection("runs").doc(runId).create(seed);
```

There is no "create collection" call anywhere in this codebase, because in Firestore a collection
isn't a real object — it's a **namespace that documents happen to share**. It springs into existence
with the first document and disappears when the last one is deleted. Each document carries its own
fields, so there is no shared shape to declare. That's **schema-on-read**: meaning is applied when
you query, not when you write.

Google Sheets is the opposite. The n8n node does this:

```json
"operation": "appendOrUpdate",
"matchingColumns": ["email"],
"columns": { "value": { "email": "…", "name": "…", … } }
```

`appendOrUpdate` has to answer two questions on every row: *which column is `email`?* and *does a
row already exist with this value?* It answers both by reading the **header row** and matching
column names as text. If row 1 is blank there are no column names, so the node has nothing to match
against and the step fails.

That's **schema-on-write**: the shape has to exist before the first write, and the header row *is*
the schema.

| | Firestore | Google Sheets |
|---|---|---|
| Container created by | first write, implicitly | you, in advance |
| Shape lives in | each document | the header row |
| Add a field later | just write it | add a column first |
| Wrong/missing shape | impossible | the write fails |
| Model | schema-on-read | schema-on-write |

### What the thing you're asking for is called

- The blank sheet with only row 1 filled in is a **template** (or a *seed* / *bootstrap* template).
- Row 1 itself is the **header row**, and it functions as the **schema contract** between this repo
  and the spreadsheet.
- Creating it is **provisioning** (or *bootstrapping*). Doing it in a way that's safe to re-run is
  **idempotent provisioning** — that's what `scripts/bootstrap-sheet.mjs` does.

Sheets has no built-in equivalent of Firestore's lazy creation, so the closest you can get is to
write the provisioning step yourself and make it idempotent. Which is what we did.

---

## The contract

One spreadsheet, two tabs. **Names are case-sensitive and must match exactly** — n8n matches header
text literally, so `Email` will not match `email`.

### Tab: `CRM`

Written by *CRM upsert (dedupe by email)*. **Match key: `email`** — a returning customer updates
their existing row instead of creating a duplicate.

| Column | Source | Example |
|---|---|---|
| `email` | `classification.contact.email` — **the dedupe key** | `dana@brightlinecafe.com` |
| `name` | `classification.contact.name` | `Dana Whitfield` |
| `company` | `classification.contact.company` | `Brightline Cafe` |
| `stage` | literal `"Lead"` | `Lead` |
| `lastSubject` | the email subject | `Wholesale pricing for 200 units?` |
| `lastSummary` | `classification.summary` | `Wants wholesale pricing for 200 units/month.` |
| `owner` | `classification.suggestedOwner` | `Sales` |
| `updatedAt` | ISO timestamp | `2026-07-23T02:41:09.482Z` |

### Tab: `Tickets`

Written by *Ticket upsert (dedupe by runId)*. **Match key: `runId`** — deliberately *not* `email`,
because one customer can raise many separate tickets. Using `runId` means a retried workflow updates
the same ticket rather than creating a second one.

| Column | Source | Example |
|---|---|---|
| `runId` | the Firestore run id — **the dedupe key** | `d6b31612e338703a78c3d69e` |
| `email` | sender address | `m.okafor@gmail.com` |
| `orderRef` | `classification.orderRef`, `""` when absent | `HS-4471` |
| `subject` | the email subject | `Order HS-4471 arrived damaged` |
| `priority` | derived: `urgency === "high" ? "P1" : "P3"` | `P1` |
| `sentiment` | `classification.sentiment` | `negative` |
| `owner` | `classification.suggestedOwner` | `Support` |
| `updatedAt` | ISO timestamp | `2026-07-23T02:41:09.482Z` |

> **Two tabs, two different dedupe keys, for a reason.** A CRM row is *per person*; a ticket is *per
> incident*. Getting this wrong is the classic version of the duplicate-row problem — key the tickets
> on email and every new complaint overwrites the last one.

---

## Three ways to create it

### Option A — Automatic (closest to how Firestore behaves)

Idempotent. Creates missing tabs, writes missing headers, and reports mismatches without touching
data. Safe to re-run any time.

```bash
npm run setup:sheet -- --dry   # show what it would do
npm run setup:sheet            # apply
```

One-time config in `.env.local`:

```ini
GSHEETS_SPREADSHEET_ID=       # the long id in the sheet URL
GSHEETS_CLIENT_EMAIL=         # service account email
GSHEETS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"
```

> These are only for this script. **n8n uses its own credential store** for the Sheets nodes — the
> same service account, entered separately inside n8n.

Sample output:

```
Spreadsheet: 1AbC…
Title: Harbor Supply Co. — Demo Data

[created] tab "CRM"
[header written] CRM: email, name, company, stage, lastSubject, lastSummary, owner, updatedAt
[ok] Tickets — header matches (match key: runId)

2 change(s) applied. The sheet is ready.
```

**What it will not do:** rename or reorder an existing column. Renaming a column that already has
data under it silently detaches every value in it, so the script reports the mismatch and stops.
Destructive schema changes should be a human decision.

### Option B — Import the CSV templates

Zero setup, no credentials, no dependencies.

1. Create a Google Sheet
2. **File → Import → Upload** → [`docs/sheet-template/CRM.csv`](sheet-template/CRM.csv)
   → *Insert new sheet(s)*
3. Repeat with [`docs/sheet-template/Tickets.csv`](sheet-template/Tickets.csv)
4. Rename the imported tabs to exactly `CRM` and `Tickets` (Sheets names them after the file, which
   is usually already right)
5. Delete the default `Sheet1`

### Option C — By hand

Create two tabs named `CRM` and `Tickets`, then paste into cell **A1** of each:

**CRM**
```
email	name	company	stage	lastSubject	lastSummary	owner	updatedAt
```

**Tickets**
```
runId	email	orderRef	subject	priority	sentiment	owner	updatedAt
```

Those are tab-separated, so pasting spreads them across columns automatically.

---

## After creating it

1. **Share the sheet** with your service-account email as **Editor**. Everything else can be right
   and it will still fail with 403 if you skip this — it's the most common mistake.
2. Copy the spreadsheet id from the URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
3. Paste it into the two Google Sheets nodes in n8n, replacing
   `REPLACE_WITH_YOUR_GOOGLE_SHEET_ID`.

Verify by submitting a lead email and a support email. You should see exactly one row in each tab.
Submit the *same* lead again — the CRM row should **update**, not duplicate. That's the dedupe
working, and it's worth screenshotting for the portfolio.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `The caller does not have permission` (403) | The sheet isn't shared with the service account |
| `Requested entity was not found` (404) | Wrong spreadsheet id, or you pasted the whole URL |
| `Unable to parse range: CRM!A1` | No tab named exactly `CRM` — check spelling and case |
| Rows append but never update | The match-key column is missing or renamed |
| Every run adds a duplicate row | Operation is `append`, not `appendOrUpdate` |
| Values land in the wrong columns | Header text doesn't match — check for trailing spaces |
| Columns appear empty | The field was genuinely empty; absent values are written as `""` by design |

### Adding a column later

The order that avoids breakage:

1. Add the column to the sheet's header row **first**
2. Add it to the node's `columns.value` mapping in `n8n/workflow.json`
3. Add it to `TABS` in `scripts/bootstrap-sheet.mjs` so the schema stays authoritative
4. Re-import the workflow into n8n

Do it in the other order and the node writes to a column that doesn't exist yet.
