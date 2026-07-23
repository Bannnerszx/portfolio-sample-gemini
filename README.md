# Harbor Supply Co. — AI Inbox Triage & Reply Approval

A portfolio demo of an automation that **makes a decision** and then **refuses to act on it without a
human**. An inbound email is classified and routed automatically, a reply is drafted in the
business's voice, and everything stops there until someone clicks Approve.

> **Harbor Supply Co.** is a *fictional* wholesale supplier. No real customer data is used.

**Stack:** Next.js 15.5.16 (App Router, JavaScript) · Gemini API (`gemini-3.1-flash-lite`) ·
Firebase Firestore · n8n (self-hosted, Docker) · Google Sheets · Slack · Gmail SMTP.

---

## The loop

```
Inbound email
  ├─ real:  n8n Gmail Trigger
  └─ demo:  "Simulate an inbound email" form on the site
       │
       ▼
  POST /api/triage
    ├─ validate + size caps (zod)
    ├─ idempotency: doc id = sha256(messageId) — a retry costs nothing
    ├─ anti-abuse: origin · honeypot · burst breaker
    ├─ quota check — 3 live runs per visitor, then canned results
    ├─ Gemini: classify + extract  → intent, urgency, sentiment, confidence, contact, orderRef
    ├─ Gemini: draft a reply       → skipped for spam and low confidence
    ├─ write to Firestore          → /ops updates live (onSnapshot)
    └─ forward to n8n (best-effort)
         │
         ▼
    n8n — workflow.json
      ├─ IF confidence < 0.7 ──► needs_review · Slack ping · stop, no draft
      └─ Switch on intent
           ├─ new_lead ─► Google Sheets appendOrUpdate, matched on email  ← dedupe
           ├─ support  ─► Sheets ticket row, priority derived from urgency
           ├─ billing  ─► Slack #finance
           └─ spam     ─► logged, no reply
      └─ Slack: "ready for approval" + link to /ops/{id}
      └─ any node fails ─► error output ─► PATCH status=failed ─► Retry button in /ops

  Human opens /ops/{id} → Approve / Edit / Reject
      └─ approve ─► n8n workflow-send.json ─► Gmail sends ─► PATCH status=sent
```

**Nothing is ever sent without a human clicking Approve.** There is no code path that sends without
passing through the `approve` branch of `PATCH /api/triage`.

---

## What this demonstrates

| | |
|---|---|
| **AI decision step** | Structured classification against a strict JSON schema, so downstream routing can't receive a value it doesn't handle |
| **Conditional routing** | An IF confidence gate plus a 4-way Switch on intent |
| **Deduplication** | Google Sheets `appendOrUpdate` matched on email — a repeat customer updates their row instead of creating a second one |
| **Idempotency** | Document ID derived from the message ID; a replayed webhook or a double-click is a no-op |
| **Human-in-the-loop** | Draft → review → approve/edit/reject, with a full audit trail per run |
| **Error handling** | Node-level error outputs mark the run `failed` with the message; retryable from the dashboard |
| **Cost control** | Five spend caps plus a four-layer anti-abuse system, described below |

---

## Cost control (why this demo is safe to put on the public internet)

This calls a paid API from a public URL, so the interesting problem isn't the AI — it's making sure
a stranger can't run up a bill. Five independent layers, in `lib/quota.js`:

1. **Per-visitor: 3 live runs.** Tracked by *both* a salted IP hash and an httpOnly cookie, blocking
   on whichever count is higher — so clearing cookies doesn't reset it and neither does a changing
   IP. Claimed in a Firestore transaction, because two tabs submitting at once would otherwise both
   read "1 used" and both proceed.
2. **Global daily cap** (`DEMO_RUNS_PER_DAY`, default 50), resets at UTC midnight.
3. **Global lifetime cap** (`DEMO_RUNS_TOTAL`, default 500) — the hard ceiling on total spend.
4. **Input and output caps.** Body capped at 4 000 characters by the schema, a `countTokens`
   pre-flight rejecting anything over 2 000 input tokens, and `max_tokens` of 700 / 900 on the two
   calls.
5. **Kill switch.** `DEMO_AI_ENABLED=false` serves canned results.

**Worst case:** ~2 000 in + ~1 600 out per run at $0.25/$1.50 per MTok ≈ **$0.003 per run**. With
the 500-run lifetime cap that is **about $1.50, ever**. Live token usage and computed cost are written onto
each run and totalled on `/ops` — you can't manage a budget you can't see.

Two design choices worth calling out:

- **Hitting a cap is not an error.** The demo falls back to canned results and keeps working. A
  broken demo is worse than a free one.
- **The canned path is the same path.** Fixture mode runs the identical routing, gating, and
  approval code — only the classifier is swapped. It skips drafting for spam and low-confidence
  emails exactly as the live path does, so what a visitor sees on run #3 is honest.

Quota is claimed *before* the API call and refunded if that call then fails, so an outage on our
side doesn't cost a visitor one of their runs.

---

## Anti-abuse (`lib/lockdown.js`)

The caps above bound how much can be spent. These four layers stop automated traffic from burning
through that budget — or Google's rate limits — in the first place. All of them run **before**
Firestore is touched or the model is called, so a bot costs CPU cycles and nothing else.

| Layer | What it does | Bypassable? |
|---|---|---|
| **Origin check** | Rejects POSTs whose `Origin`/`Referer` isn't ours. Requests with neither are allowed — that's what n8n's server-to-server calls look like. | Yes, trivially — it's a free filter for lazy traffic, not security |
| **Honeypot** | A hidden `company_website` field. Off-screen, `aria-hidden`, `tabIndex={-1}` — a human can't fill it, a DOM-walking bot will. Returns a **fake success** so the operator doesn't learn they were caught. | Yes, by anything that skips hidden inputs |
| **Circuit breaker** | More than `DEMO_BURST_THRESHOLD` submissions in `DEMO_BURST_WINDOW_MINUTES` → canned mode for `DEMO_BREAKER_COOLDOWN_MINUTES`, Slack alert, then self-heals. | **No** — it doesn't care how requests arrive |
| **Panic switch** | `DEMO_LOCKDOWN=true` forces canned mode for everyone, instantly. | No |

Three implementation details that matter:

- **Breaker state lives in Firestore, not memory.** On serverless each request may hit a different
  instance, so an in-process counter would reset constantly and never fire. This is the usual way
  home-rolled rate limiting fails, and it fails *silently*.
- **Burst counting happens before the quota check**, so a bot that has already exhausted its
  per-visitor allowance still registers. Otherwise it could hammer the endpoint invisibly.
- **It fails safe.** If breaker state can't be read, it's assumed tripped. Being wrong costs canned
  results; being wrong the other way costs an unprotected endpoint.

Deliberately not built: **Cloudflare Turnstile** (stronger, but needs a third-party signup — the
obvious next addition if the demo ever gets real traffic) and **IP blocking** (IPs are shared and
rotate cheaply, so it punishes innocent visitors more than attackers).

---

## Setup

```bash
npm install
cp .env.example .env.local   # fill in your values
npm run dev                  # http://localhost:3000
```

> **[`docs/RUNBOOK.md`](docs/RUNBOOK.md)** has the day-to-day version: how to start and stop each
> service, what to do when something misbehaves, and every config knob in one table.

Firestore is required to persist runs and to count quota. Without it `/api/triage` returns a clear
503 rather than spending money it can't meter.

### Prerequisites (all free tiers)

1. **Node.js 20+** and **Docker Desktop** (for `host.docker.internal`).
2. **Gemini API key** — <https://aistudio.google.com/apikey>.
3. **Firebase** — a project with **Firestore** (test mode). You need the web config (public) and a
   service-account key (Project settings → Service accounts → Generate key).
4. **Google Sheets** — enable the Sheets API, create a service account, and provision a spreadsheet
   with two tabs, `CRM` and `Tickets`.

   Unlike Firestore, Sheets will not create the columns for you — `appendOrUpdate` matches rows by
   header name, so the header row has to exist first. Three ways to create it:

   ```bash
   npm run setup:sheet -- --dry   # see what it would do
   npm run setup:sheet            # create tabs + headers (idempotent)
   ```

   …or import the CSV templates in [`docs/sheet-template/`](docs/sheet-template/), or paste the
   headers by hand.

   **[`docs/SPREADSHEET.md`](docs/SPREADSHEET.md)** has the full column contract, why the two tabs
   use different dedupe keys, and troubleshooting.

   Then share the sheet with the service-account email as **Editor** — skipping this is the most
   common cause of a 403.
5. **Slack** — an Incoming Webhook (or three, for `#orders`, `#finance`, `#ops`).
6. **Gmail** — 2FA enabled and an **App Password** for SMTP.

### Firestore security rules (demo)

Public **read** so the dashboard works when deployed; **no client writes** (all writes go through
the Admin SDK). Quota counters are readable by nobody.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /runs/{doc} {
      allow read: if true;
      allow write: if false;
    }
    match /quota/{doc} {
      allow read, write: if false;
    }
  }
}
```

Trade-off: fine for a demo, not for production — a real build puts `/ops` behind auth.

### Run n8n (Docker)

```bash
docker run -d --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n
```

Open <http://localhost:5678>, create the owner account, then import all three workflows
(Workflows → ⋯ → Import from File):

| File | What it does |
|---|---|
| `n8n/workflow.json` | Triage: confidence gate → intent switch → Sheets/Slack routing |
| `n8n/workflow-send.json` | Sends the reply *after* a human approves |
| `n8n/workflow-error.json` | Error Trigger → Slack alert (set as the error workflow on the other two) |

After importing you must:

- **Select credentials** on the Google Sheets and Gmail SMTP nodes — credentials never transfer with
  an export.
- Replace `REPLACE_WITH_YOUR_GOOGLE_SHEET_ID` and the Slack webhook URLs.
- Set the **from address** on the send workflow's email node.
- In each workflow's **Settings → Error Workflow**, select *Harbor Supply Co. — Error Handler*.
- Copy the two production webhook URLs into `N8N_WEBHOOK_URL` and `N8N_APPROVE_WEBHOOK_URL` in
  `.env.local`, then **activate** both workflows. Restart `npm run dev` after changing env.

> **Docker networking:**
> - Host → n8n: `http://localhost:5678/...` (your `.env.local`).
> - n8n (container) → host: `http://host.docker.internal:3000/...` (the PATCH nodes). Inside the
>   container, `localhost` is the container itself, not your app.

---

## Deploy (GitHub + Vercel)

1. Push to a public GitHub repo.
2. Import into Vercel and add the env vars from `.env.example`.
3. Deploy. The live URL serves the form and the dashboard. The full n8n loop is demoed **locally**,
   because a public URL can't reach n8n on your laptop — the forward is best-effort and its failure
   never breaks a submission. *(Optional: expose local n8n with a Cloudflare Tunnel and point
   `N8N_WEBHOOK_URL` at it for a genuinely live loop.)*

Set `QUOTA_SALT` to a long random string in the Vercel env — without it, IP hashes are guessable.

---

## Project structure

```
harbor-supply-co/
├─ app/
│  ├─ page.js                  landing + simulate-an-email form
│  ├─ ops/page.js              live run list + spend counter
│  ├─ ops/[id]/page.js         review one run: approve / edit / reject
│  └─ api/
│     ├─ triage/route.js       POST triage · PATCH approve|reject|retry|status
│     └─ quota/route.js        GET remaining live runs
├─ components/                 EmailForm · RunsTable · RunDetail · ui
├─ lib/
│  ├─ gemini.js                classify + draft, JSON-schema output, typed error handling
│  ├─ lockdown.js              origin check, honeypot, circuit breaker, panic switch
│  ├─ quota.js                 the five spend caps
│  ├─ idempotency.js           sha256(messageId) → create-if-absent
│  ├─ schemas.js               zod: input, classification, draft, PATCH
│  ├─ fixtures.js              canned results for zero-spend mode
│  └─ firebase.js / firebaseAdmin.js
└─ n8n/                        the three workflows
```

---

## Verification

```bash
npm run build      # passes
npm run lint       # passes
```

Manual checks, in order:

1. **Canned mode** (`DEMO_AI_ENABLED=false`): submit each of the four samples. Confirm the first
   three route to `new_lead` / `support` / `billing` and the "ambiguous" one lands on
   `needs_review` with **no draft** — that's the confidence gate.
2. **Quota:** submit three times. The third returns canned results with the cap notice. Clear
   cookies → still capped (IP layer). Delete the `quota/ip-*` doc in Firestore → still capped
   (cookie layer).
3. **Global caps:** set `DEMO_RUNS_PER_DAY=1` and confirm a second visitor degrades to canned mode
   rather than erroring.
4. **Idempotency:** POST the same `messageId` twice → one run document, one quota decrement, and
   `duplicate: true` on the second response.
5. **Live AI** (`DEMO_AI_ENABLED=true`): one email of each intent. Confirm the classification, and
   that token usage and cost appear on the run.
6. **Approval gate:** confirm no email is sent until Approve is clicked. Edit the draft, approve,
   confirm the edited version is what sends. Reject → nothing sent.
7. **Error path:** stop `npm run dev` mid-workflow. The Sheets/Slack node's error output marks the
   run `failed`; restart and use Retry in `/ops`.

---

## How this was built

Two full build logs — design decisions, how each part was tested, and every problem hit with its
diagnosis and fix:

- [`docs/BUILD-LOG.md`](docs/BUILD-LOG.md) — the original build. An SDK version trap, a Windows
  file-lock, a fixture/live behaviour mismatch, a leaked key caught before it reached git.
- [`docs/BUILD-LOG-GEMINI.md`](docs/BUILD-LOG-GEMINI.md) — migrating to Gemini and adding the
  anti-abuse layer. Includes a circuit breaker that could never reopen, and how the test that
  caught it differed from the one that missed it.

---

## Screenshots

_Replace with your captures:_

| | |
|---|---|
| **n8n canvas — the gate and the switch** | `docs/n8n-canvas.png` |
| **Ops dashboard with a run awaiting approval** | `docs/ops.png` |
| **The approval screen** | `docs/approve.png` |
| **Slack "ready for approval" card** | `docs/slack.png` |
| **CRM sheet showing a deduplicated row** | `docs/sheet.png` |
| **Quota cap message after 2 runs** | `docs/quota.png` |

---

## Portfolio entry (copy for Upwork)

> **Harbor Supply Co. — AI inbox triage with a human approval gate (personal demo project)**
> Built an email automation that classifies inbound mail with Claude, routes it by intent
> (leads → CRM with deduplication, support → ticket queue, billing → finance), drafts a reply in the
> business's voice, and then holds everything for human approval before anything is sent.
> Low-confidence emails are diverted to a review queue instead of being answered. Includes
> idempotent processing, node-level error handling with retry, and a five-layer API spend cap so the
> public demo can't be abused. Stack: Next.js, Claude API, n8n (self-hosted), Firebase, Google
> Sheets, Slack, Gmail. Live demo + full source below.

Labelled honestly as a personal/demo project. A 60–90 second screen recording of one email flowing
from the form through Slack to an approved send is the single most persuasive addition.
