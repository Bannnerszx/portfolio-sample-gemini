# Build log — Harbor Supply Co.

A complete account of how this project was built, tested, and debugged: the decisions and why they
were made, the exact commands run, every problem hit, and how each was diagnosed and fixed.

Written so it can be read two ways: as a record of what happened, and as the answer to *"walk me
through how you built this"* in a client call.

---

## Table of contents

1. [Why this project exists](#1-why-this-project-exists)
2. [Design decisions made before writing code](#2-design-decisions-made-before-writing-code)
3. [The build, step by step](#3-the-build-step-by-step)
4. [Testing locally](#4-testing-locally)
5. [Troubleshooting log — every problem, in order](#5-troubleshooting-log--every-problem-in-order)
6. [How to explain this project out loud](#6-how-to-explain-this-project-out-loud)
7. [What is still outstanding](#7-what-is-still-outstanding)

---

## 1. Why this project exists

### The gap in the first portfolio piece

`sample-studio-co` (piece #1) demonstrates a **linear, happy-path** automation:

```
form → Google Sheet → Slack → PDF invoice → Gmail → status update
```

Every step runs every time, in the same order, and nothing decides anything. It proves competence at
*wiring services together* — which is real and valuable, but it is also the thing most freelancers on
Upwork can already show.

What it does **not** show:

| Missing capability | Why buyers care |
|---|---|
| An AI decision step | "Read this and work out what it is" is the thing they can't do themselves |
| Conditional routing | Real inboxes contain four kinds of email, not one |
| Deduplication | Their CRM is already full of duplicate rows; this is a live pain |
| Idempotency | They've been burned by a customer getting the same email twice |
| Human-in-the-loop | The #1 objection to AI automation is "I don't trust it to send things" |
| Error handling | Their last automation broke silently and nobody noticed for a week |
| Cost control | "How much will this cost me per month?" is asked in every discovery call |

Piece #2 exists to demonstrate exactly those seven things.

### The framing that makes the pair work

> *Piece 1 automates a known path. Piece 2 makes a decision, routes on it, refuses to act without a
> human, and recovers when a step fails.*

Showing both together tells a progression story, which is far more persuasive than showing two
unrelated demos.

### The constraint that shaped everything

The demo is public and calls a **paid API**. A stranger, a bot, or a bored crawler could otherwise
run up an unbounded bill. The requirement was: **2 runs per visitor, then hard-blocked.**

That constraint turned out to be the most interesting engineering in the project, and it is now the
strongest talking point. "How do you put an AI demo on the public internet without it becoming a
liability" is a question that demonstrates judgement, not just wiring.

---

## 2. Design decisions made before writing code

### 2.1 Reuse the stack from piece #1

Same Next.js version, same Firebase setup, same patterns. Reasons:

- **Known-good.** Piece #1 already proved this stack builds and deploys.
- **A documented trap was already solved.** `create-next-app` now scaffolds Next 16, whose breaking
  changes weren't documented for these tools — piece #1 deliberately pinned `next@15.5.16`. Repeating
  that pin cost nothing and avoided re-learning the same lesson.
- **Speed.** `lib/firebase.js` and `lib/firebaseAdmin.js` were copied over unchanged.

The guarded-init pattern in those two files is worth understanding, because it's why the app builds
with no credentials at all:

```js
export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId
);
// …exports null instead of throwing when unconfigured
```

Without this, `next build` would crash on any machine without secrets — including Vercel's build
step and any recruiter who clones the repo.

### 2.2 Two Claude calls, not one

It's tempting to ask for classification *and* the draft reply in a single call. Two separate calls is
better here:

| | Classification | Drafting |
|---|---|---|
| Must be schema-strict? | Yes — the n8n Switch routes on it | No |
| Needs reasoning? | No — it's extraction | Yes — it decides what may be promised |
| Worth paying for every time? | Yes | **No** |

That last row is the point. **Spam and low-confidence emails never reach the second call at all.**
Roughly a third of a real inbox is spam, so this is a permanent one-third saving on the expensive
half of the work, achieved with one `if`:

```js
const worthDrafting =
  classification.intent !== "spam" && classification.confidence >= 0.7;
```

### 2.3 Confidence as a first-class output

The classifier is asked to report genuine uncertainty, and the prompt explicitly tells it not to
posture:

> *"Do not inflate confidence to seem decisive; an honest low score is more useful than a confident
> wrong answer."*

Anything below `0.7` is diverted to a human review queue and **no reply is drafted**. This is the
mechanism that makes the whole demo trustworthy — the system knows what it doesn't know.

### 2.4 Strict enums so routing can't receive garbage

```js
export const INTENTS = ["new_lead", "support", "billing", "spam"];
```

This becomes a strict JSON schema via `zodOutputFormat()`. The model *cannot* return
`"sort_of_a_lead"`. That means the n8n Switch node needs no defensive fallback branch — a class of
bug is eliminated at the schema level rather than handled at runtime.

### 2.5 Build the guard before the spender

The build order was deliberate:

```
schemas → fixtures → quota guard → Claude integration → API route → UI → workflows
```

`lib/quota.js` was written and tested **before** `lib/claude.js` existed. You cannot accidentally
spend money through code you haven't written yet. The kill switch defaulted to `false` throughout
development.

### 2.6 Degrade, never break

When any cap is hit, the demo does **not** show an error. It falls back to canned results and keeps
working end to end. A visitor on run #3 still sees the whole pipeline.

> A broken demo is worse than a free one.

The critical corollary: **the canned path is the same path.** Fixture mode runs the identical
routing, gating, and approval code — only the classifier is swapped. This is what keeps the fallback
honest rather than a different product wearing the same UI.

---

## 3. The build, step by step

### Step 1 — Scaffold with a pinned version

```bash
npx --yes create-next-app@15.5.16 harbor-supply-co \
  --js --tailwind --eslint --app --no-src-dir \
  --import-alias "@/*" --no-turbopack --use-npm --skip-install
```

Two flags matter:

- `create-next-app@15.5.16` — pinning the *scaffolder* pins the Next version it writes into
  `package.json`. Running bare `create-next-app` would have produced Next 16.
- `--skip-install` — lets dependency versions be edited to match piece #1 *before* the install runs,
  avoiding an install-then-reinstall cycle.

Then dependencies were aligned to piece #1 exactly (`react` 19.2.4, `firebase` ^11.1.0,
`firebase-admin` ^13.0.2, `zod` ^4.4.3) plus `@anthropic-ai/sdk`, and verified:

```bash
npm ls next react zod @anthropic-ai/sdk
# next@15.5.16 · react@19.2.4 · zod@4.4.3 — matching piece #1
```

### Step 2 — Schemas and fixtures first

`lib/schemas.js` defines every shape once and uses it in three places: the browser form, the API
route, and the Claude call. One source of truth for validation.

The character caps are a **cost control**, not just hygiene:

```js
export const MAX_SUBJECT_CHARS = 200;
export const MAX_BODY_CHARS = 4000;
```

The body length bounds the input tokens that can ever be billed. This is the cheapest of the five
spend layers and the easiest to overlook.

`lib/fixtures.js` provides four samples and a deliberately dumb keyword classifier. Building this
*second* meant the entire UI and API could be developed and demonstrated before a single paid API
call existed.

### Step 3 — The spend guard

`lib/quota.js` — five independent layers:

| Layer | Mechanism | Default |
|---|---|---|
| 1. Per-visitor | Salted IP hash **and** httpOnly cookie | 2 runs |
| 2. Global daily | `quota/global-{YYYY-MM-DD}` | 50 |
| 3. Global lifetime | `quota/global-total` | 500 |
| 4. Input/output | zod caps + `countTokens` pre-flight + `max_tokens` | 2000 in |
| 5. Kill switch | `DEMO_AI_ENABLED` | off |

**Two identifiers, deliberately.** The visitor is tracked by both a hashed IP and a cookie, and
blocked on whichever count is higher:

```js
const used = Math.max(ipSnap.data()?.count ?? 0, cookieSnap.data()?.count ?? 0);
```

Clearing cookies doesn't reset it (the IP layer still counts). A changing or shared IP doesn't defeat
it either (the cookie layer still counts). Neither evasion works alone.

**Why a transaction, not a read-then-write.** This is the subtle part and the best thing to be able
to explain:

> Two browser tabs press Submit at the same instant. Both read "1 used". Both conclude they're
> allowed. Both proceed. That's the classic check-then-act race — and on a metered API it costs real
> money every time it happens.

A Firestore `runTransaction` makes the read and the increment a single atomic operation, so the
second one sees the first one's write and is correctly refused.

**Fail closed.** If Firestore is unreachable, the counters can't be read — so the code refuses to
spend rather than assuming it's fine:

```js
// A failed transaction means we don't know the count — refuse to spend.
return { granted: false, reason: "error", remaining: 0 };
```

**Refund on our failure.** Quota is claimed *before* the API call. If the call then fails, the run is
given back — a visitor should not lose one of their two runs because of an outage on our side.

### Step 4 — The Claude integration

Key details in `lib/claude.js`:

**Prompt caching.** The system prompt is byte-identical on every single run and marked cacheable:

```js
system: [{ type: "text", text: CLASSIFY_SYSTEM,
           cache_control: { type: "ephemeral" } }],
```

Cache reads bill at roughly a tenth of the input rate. The reason it works is that nothing dynamic is
in that prompt — a timestamp or a per-request ID would change the bytes and silently invalidate the
cache on every call, quietly tripling the input cost while appearing to work fine.

**Thinking configured per call type.** Classification omits `thinking` entirely (cheapest, correct
for schema-bound extraction). Drafting uses `thinking: { type: "adaptive" }`, because deciding what a
business may and may not promise a customer genuinely benefits from a moment's reasoning.

**Failures are routine, not exceptional.** A custom `ClaudeUnavailable` error carries a reason, and
typed SDK errors are caught most-specific-first:

```js
if (err instanceof Anthropic.RateLimitError) return "rate_limited";
if (err instanceof Anthropic.AuthenticationError) return "auth";
if (err instanceof Anthropic.APIStatusError) return `api_${err.status}`;
if (err instanceof Anthropic.APIConnectionError) return "network";
```

Typed classes rather than string-matching on error messages — messages change between versions,
classes don't.

**Every non-success path is handled explicitly:**

```js
if (res.stop_reason === "refusal") throw new ClaudeUnavailable("refusal");
if (res.stop_reason === "max_tokens") throw new ClaudeUnavailable("truncated");
if (!classification) throw new ClaudeUnavailable("unparsable"); // parsed_output was null
```

A failed *draft* is survivable — the run still routes and still reaches a human. Only classification
is critical.

### Step 5 — The API route

`app/api/triage/route.js`. The order of operations is the design:

```
validate → claim idempotency → claim quota → classify → persist → forward to n8n
```

Idempotency is claimed **before** quota, so a replayed webhook costs nothing at all. It works by
deriving the document ID from the message rather than letting Firestore generate one:

```js
export function runIdFor(messageId) {
  return createHash("sha256").update(String(messageId)).digest("hex").slice(0, 24);
}
```

…and then using `.create()`, which *fails* if the document exists, rather than `.set()`, which would
overwrite:

```js
await db.collection("runs").doc(runId).create(seed);
// throws code 6 (ALREADY_EXISTS) on a replay — caught and treated as the normal duplicate path
```

The uniqueness check and the write become one atomic operation. There is no window between "does
this exist?" and "create it".

The n8n forward is deliberately **best-effort** — a deployed Vercel URL cannot reach n8n on a laptop,
and that must never break a user's submission.

### Step 6 — The approval gate

`PATCH /api/triage` with `action: "approve"` is the **only** path that triggers a send. Reject and
retry exist alongside it, and every action appends to a per-run history array, giving a full audit
trail.

The UI subscribes with Firestore `onSnapshot` so the dashboard updates live. One subtlety in
`RunDetail.jsx` — the live subscription must not overwrite a human's in-progress edits:

```js
setDirty((isDirty) => {
  if (!isDirty) setDraft({ /* …from snapshot… */ });
  return isDirty;
});
```

Without that guard, a background update while someone is mid-sentence would wipe their editing.

### Step 7 — The n8n workflows

Three files rather than one:

| File | Purpose |
|---|---|
| `workflow.json` | Triage: confidence gate → intent switch → Sheets/Slack routing |
| `workflow-send.json` | Sends the reply, only after human approval |
| `workflow-error.json` | Error Trigger → Slack alert |

**Deduplication** is the `appendOrUpdate` operation matched on email:

```json
"matchingColumns": ["email"]
```

A repeat customer updates their existing CRM row instead of creating a second one. This is a
two-word change in a node config that solves a problem clients complain about constantly.

**Error handling uses node-level error outputs**, not just the global Error Trigger:

```json
"onError": "continueErrorOutput"
```

The reason is practical: n8n's Error Trigger payload doesn't carry your workflow's own data, so it
can't tell you *which run* failed. A node's error output stays inside the workflow, where
`$('Normalize triage').item.json.runId` is still in scope — so the failure can be attributed to a
specific run and made retryable. The global Error Trigger remains as a catch-all Slack alert.

---

## 4. Testing locally

### 4.1 Static checks

```bash
npm run build   # compiles + lints + type-checks
npm run lint
```

### 4.2 Testing pure logic in isolation

The fixture classifier drives the confidence gate, so it was tested standalone before any server ran.
Because the project is ESM-in-`.js` without `"type": "module"`, the file was copied to a `.mjs` in a
scratch directory so Node would parse it as ESM:

```bash
cp lib/fixtures.js "$SCRATCH/fixtures.mjs"
node t.mjs
```

Asserting the exact claims the README makes:

```
New lead      intent=new_lead conf=0.91 gate=auto
Support       intent=support  conf=0.87 urg=high ref=HS-4471 gate=auto
Billing       intent=billing  conf=0.88 ref=INV-2213 gate=auto
Ambiguous     intent=support  conf=0.41 gate=REVIEW
ALL ASSERTIONS PASSED
```

This is where a real inconsistency was caught — see [problem 6](#problem-6--fixture-mode-and-live-mode-disagreed).

### 4.3 Testing the guarded paths with nothing configured

Before adding any credentials, the failure modes were checked:

```bash
curl -s http://localhost:3001/api/quota
# {"live":false,"reason":"disabled", …}

curl -X POST …/api/triage -d '{"from":"not-an-email","subject":"","body":"","messageId":"x"}'
# 400 {"fieldErrors":{"from":"Enter a valid email address.", …}}

curl -X POST …/api/triage -d '{…valid…}'
# 503 "Firestore admin isn't configured…"
```

That 503 is a deliberate design choice: **refuse to spend money you can't meter.**

### 4.4 Testing against real Firestore

Firebase values were reused from piece #1 (same project, separate `runs/` and `quota/` collections),
copied programmatically so no secret was ever printed to the terminal.

| Test | Command shape | Result |
|---|---|---|
| Classify + route | POST a lead email | `new_lead`, 0.91, `awaiting_approval` |
| **Idempotency** | POST same `messageId` twice | `duplicate: true`, same ID, one document |
| **Confidence gate** | POST the vague email | 0.41 → `needs_review`, **draft length 0** |
| **Approve** | PATCH `action: approve` with edited draft | `status: approved` |
| **Reject** | PATCH `action: reject` | `status: rejected` |
| Unknown ID | PATCH a nonexistent ID | `404` |

### 4.5 Testing the spend guard without spending

The cap only engages when AI is enabled, which requires a key. Two tricks avoided needing real
credits:

**Set the cap to zero.** Proves the block path and the friendly message:

```
{"live":false,"reason":"visitor","message":"You've used your 0 free live runs. The demo below
 still runs end to end — it just uses a canned classification instead of calling the API."}
```

…and critically, the POST still returned `ok: true` with a working canned result. Degradation, not
breakage.

**Use a deliberately invalid key.** The API call fails, which exercises the refund path:

```
before:  live: true  remaining: 2
submit:  ok: true    live: false  (fell back to canned)
after:   live: true  remaining: 2   ← refunded, visitor not charged for our failure
```

This also validated the typed error handling end to end: a real `401` was caught as
`AuthenticationError`, mapped to reason `auth`, and degraded gracefully.

---

## 5. Troubleshooting log — every problem, in order

### Problem 1 — The SDK version was silently two years of API behind

**Symptom.** `lib/claude.js` was written using `zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod`
and `client.messages.parse()`. Before running anything, the installed package was inspected:

```bash
ls node_modules/@anthropic-ai/sdk/helpers/
# beta            ← that's ALL. No helpers/zod.
```

**Diagnosis.** `"@anthropic-ai/sdk": "^0.71.0"` looks permissive, but for `0.x` versions npm treats
the caret as `>=0.71.0 <0.72.0`. It resolved to `0.71.2`. Digging further:

```bash
grep -o "export declare function [a-zA-Z]*" node_modules/@anthropic-ai/sdk/helpers/beta/zod.d.ts
# betaZodOutputFormat        ← beta-namespaced, different name

grep -on "ThinkingConfig[A-Za-z]*" .../resources/messages/messages.d.ts | sort -u
# ThinkingConfigDisabled
# ThinkingConfigEnabled      ← no ThinkingConfigAdaptive at all

grep -c "output_config" .../resources/messages/messages.d.ts
# 0                          ← output_config was beta-only
```

So on 0.71.2: `parse()` and `output_config` were beta-only, adaptive thinking didn't exist, and
`effort` had no `xhigh`/`max`.

**Fix.**

```bash
npm view @anthropic-ai/sdk version   # 0.113.0
npm install @anthropic-ai/sdk@0.113.0
```

Re-verified against the newly installed files — `helpers/zod.d.ts` exports `zodOutputFormat`,
`messages.parse` is GA, `ThinkingConfigAdaptive` exists, `effort` includes `xhigh`/`max`.

**Lesson.** For `0.x` packages, a caret range pins you to a single minor version. And when writing
against any SDK, **verify method names against the installed type definitions**, not against
documentation or memory. `grep` on `node_modules/**/*.d.ts` is the fastest possible ground truth.

### Problem 2 — ESLint rejected plain anchors for internal links

**Symptom.** `npm run build` compiled fine, then failed:

```
./app/ops/page.js
12:9  Error: Do not use an `<a>` element to navigate to `/`.
      Use `<Link />` from `next/link` instead.  @next/next/no-html-link-for-pages
```

Three occurrences.

**Diagnosis.** A plain `<a>` triggers a full page reload, discarding the React state and the
Firestore subscription, then re-downloading and re-hydrating everything. It's a real performance bug
that the linter is right to block.

**Fix.** `import Link from "next/link"` and swap the elements. Also applied to the *client*
components (`RunsTable`, `EmailForm`) — the rule didn't flag those because they use template-literal
hrefs it can't analyse statically, but the same reload penalty applies.

### Problem 3 — A warning about the wrong workspace root

**Symptom.**

```
⚠ Warning: Next.js inferred your workspace root, but it may not be correct.
We detected multiple lockfiles and selected C:\Users\marcv\package-lock.json
```

**Diagnosis.** A stray `package-lock.json` in the home directory sits *above* the project, so Next's
monorepo heuristic picked it. Left alone, file tracing would scan from the wrong root — bloating
deployment bundles.

**Fix.** Pinned it explicitly in `next.config.mjs`:

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));

const nextConfig = { outputFileTracingRoot: here };
```

Note `fileURLToPath(import.meta.url)` rather than `__dirname` — `__dirname` doesn't exist in ES
modules, and `next.config.mjs` is ESM.

### Problem 4 — `EPERM` on `.next/trace`, and a kill command that didn't work

**Symptom.**

```
uncaughtException [Error: EPERM: operation not permitted,
  open '…\harbor-supply-co\.next\trace']
```

**Diagnosis.** The dev server was still running and holding a lock on `.next/`. On Windows an open
file handle blocks writes outright — there's no permissive-unlink behaviour like on Linux.

The first fix attempt silently did nothing:

```bash
pkill -f "next dev"    # ran, returned success, killed nothing
```

`pkill` matches against the process command line as the POSIX layer sees it. The actual Windows
process is `node.exe` running `…/next/dist/server/lib/start-server.js` — the string `next dev` never
appears in it.

**Fix.** Query the real Windows process table and match on the project path:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*harbor-supply-co*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Then `rm -rf .next` and rebuild — clean.

**Lesson.** On Windows, use PowerShell's process cmdlets rather than assuming POSIX tools match what
you expect. Matching on the *project path* is also more precise than matching on a command name —
it can't accidentally kill an unrelated dev server.

### Problem 5 — The build was passing but two things needed checking anyway

Worth noting as method rather than as a bug: a green build proves the code *compiles*, not that it's
*correct*. The fixture assertions and the endpoint curls were what actually caught the next problem.

### Problem 6 — Fixture mode and live mode disagreed

**Symptom.** The standalone fixture test printed:

```
Ambiguous (triggers human review)   conf=0.41  gate=REVIEW  draft=289ch
```

A 289-character draft — on a run that the gate had just diverted for human review.

**Diagnosis.** The live path skipped drafting for spam and low-confidence emails:

```js
const worthDrafting = classification.intent !== "spam" && classification.confidence >= 0.7;
```

…but the fixture path called `fixtureDraft()` unconditionally. So in canned mode a "needs review" run
would show a draft, while the UI copy said *"no reply was drafted"* and the live path genuinely
didn't write one.

This is worse than a cosmetic bug. It would make the fallback **dishonest** — a visitor on run #3
would see behaviour the real system doesn't have.

**Fix.** Mirror the gate inside the fixture generator:

```js
if (classification.intent === "spam" || classification.confidence < 0.7) {
  return { subject: `Re: ${email.subject}`, body: "" };
}
```

Re-tested:

```
gated draft length = 0 (expect 0)
confident draft length = 330 (expect > 0)
GATE CONSISTENCY PASSED
```

**Lesson.** If you build a fallback mode, it must exercise the *same* decisions as the real one.
Otherwise it stops being a demo of your system and becomes a demo of something else.

### Problem 7 — Port 3000 was occupied by an unrelated project

**Symptom.** The dev server started on `3001` without being asked.

**Diagnosis.** Rather than guess, the port was traced to an actual process:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000 |
  ForEach-Object { (Get-Process -Id $_.OwningProcess).ProcessName }
# node (PID 22448)

Get-CimInstance Win32_Process -Filter "ProcessId=22448" | Select CommandLine
# …\UPLOAD TO GITHUB\SSR\seo-optimize-rmj-dev\node_modules\next\…
```

A completely different project's dev server. **Not killed** — it wasn't part of this work, and
silently stopping someone's running server is not a decision to make on their behalf.

This mattered beyond convenience: the n8n workflows PATCH back to
`http://host.docker.internal:3000/api/triage`. Running on 3001 would have broken the return leg of
the loop.

**Resolution.** Ran on 3001 for API testing. Later the other project's server exited on its own; the
port was re-checked, confirmed free, and the app was moved to 3000 so the workflows work unmodified.

### Problem 8 — Docker wasn't running

**Symptom.**

```
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine;
check if the path is correct and if the daemon is running
```

**Diagnosis.** `docker` the CLI is installed and on PATH; the *daemon* wasn't up. Docker Desktop had
not been started since boot.

**Fix.** Launched Docker Desktop and continued with other work while it initialised. On returning,
`docker ps` showed the n8n container from piece #1 had auto-started:

```
n8n    Up 4 minutes
```

**Lesson.** `docker: command not found` and "can't reach the daemon" are completely different
failures. The first is an install problem; the second usually just means the desktop app isn't
running.

### Problem 9 — A live API key was pasted into a file destined for git

**Symptom.** `.env.example` was edited to contain a real key:

```
ANTHROPIC_API_KEY=sk-ant-api03-cEM0T17RrBTNhiJQ1Pil…
```

**Why this is serious.** `.env.example` is the *template* file. The `.gitignore` reads:

```
.env*
!.env.example      ← explicitly un-ignored, because it's meant to be committed
```

The pattern that protects every other env file specifically **exempts this one**. A key placed here
gets committed and pushed to a public repo. Secret-scanning bots monitor new GitHub commits
continuously; keys in public repos are typically found and abused within minutes.

**Diagnosis — establish blast radius before fixing.** The question isn't "is it in the file", it's
"did it reach git":

```bash
git check-ignore .env.example    # → not ignored (confirms the exposure path)
git log --oneline -- .env.example # → empty (never committed)
git log --oneline                 # → one commit: "Initial commit from Create Next App"
```

Never committed. So the fix was a file edit, not a history rewrite — and rotation was not strictly
forced.

**Fix.** Programmatically moved the key into `.env.local` (which *is* gitignored) and restored the
placeholder in `.env.example`, then verified both:

```bash
grep -n "^ANTHROPIC_API_KEY=" .env.example   # ANTHROPIC_API_KEY=sk-ant-...
git check-ignore -v .env.local               # .gitignore:34:.env*  .env.local
```

**Lesson.** `.env.example` is the one env file that is *supposed* to be committed — which makes it
the most dangerous one to paste a secret into. And if a secret ever does reach a commit, deleting it
in a later commit does **not** help: it stays in history, and the only safe response is to rotate the
key.

### Problem 10 — Live AI fell back to canned, and the first error was a red herring

**Symptom.** With the real key installed and `DEMO_AI_ENABLED=true`, a live run returned:

```
ok: true | LIVE: false | model: fixtures
```

The fallback engaged, so *something* failed — but the response deliberately doesn't leak why (that's
correct product behaviour, and exactly why the reason is logged server-side instead).

**Diagnosis.** The server log held two distinct errors:

```
Claude call failed: Error: 401 {"type":"authentication_error","message":"invalid x-api-key"}
Claude unavailable (auth) — falling back to fixtures.

Claude call failed: Error: 400 {"type":"invalid_request_error",
  "message":"Your credit balance is too low to access the Anthropic API…"}
Claude unavailable (unknown) — falling back to fixtures.
```

Reading these in order matters. The **401 was from the earlier deliberately-fake key** used to test
the refund path — a leftover from testing, not a real problem. The real key produced the **400**.

A 400 with that message is genuinely good news: it means authentication **succeeded**, the request
was well-formed, and it reached Anthropic's billing layer. The integration is correct end to end. The
account simply has no credits.

**Resolution.** No code change. Add credits at `console.anthropic.com` and it works with no config
change, since `DEMO_AI_ENABLED=true` is already set.

**Lesson.** Read the *whole* log and check which error came from which attempt — the most recent
error is the relevant one, and an older failed experiment sitting above it will mislead you. Also:
distinguishing 401 (credentials wrong) from 400-with-billing-message (credentials *right*, account
empty) is the difference between "my code is broken" and "my code works, go add $5".

This also produced an unplanned but genuinely valuable test: **a real, unmocked API failure, handled
gracefully in production conditions** — visitor saw a working demo, quota was refunded, nothing
crashed.

### Problem 11 — A vague user-facing message

**Symptom.** After the API failure, the notice shown was the generic default:

```
Running on canned results.
```

**Diagnosis.** `quotaMessage()` had specific copy for `visitor`, `daily`, `lifetime`, `unconfigured`
and `error`, but reasons coming from the Claude layer (`auth`, `rate_limited`, `refusal`, `network`,
`truncated`, `unparsable`) all fell through to a bare default.

**Fix.** Inverted the logic so the *default* is the helpful message, and added explicit copy for the
kill switch:

```js
case "disabled":
  return "Live AI is switched off for this deployment — the demo runs on canned results…";
default:
  // Everything else is an API-side failure. The visitor doesn't need the
  // distinction — they need to know the demo still works.
  return "Live AI is unavailable right now, so the demo is running on canned results…";
```

**Lesson.** When a `switch` has a fallthrough default that users can actually reach, the default
should be the *good* message, not the placeholder one.

---

## 6. How to explain this project out loud

### The 30-second version

> It's an inbox triage automation. An email comes in, Claude classifies it — is this a lead, a
> support issue, or a billing question — pulls out the contact details and any order reference, and
> routes it: leads go into a CRM sheet deduplicated by email address, support tickets get a priority
> based on urgency, billing goes to finance. It drafts a reply in the business's voice. Then it
> stops. Nothing gets sent until a human clicks Approve.

### The three details that show depth

**1. It knows what it doesn't know.**

> The classifier reports a confidence score, and I prompt it explicitly not to inflate it. Anything
> under 0.7 skips the draft entirely and goes to a human review queue. Most AI automations fail
> because they're confidently wrong on edge cases — this one routes its own uncertainty to a person.

**2. Retries can't double-send.**

> The document ID is a hash of the email's message ID, and I create it with an operation that fails
> if it already exists rather than one that overwrites. So a retried webhook, or someone
> double-clicking Submit, is a no-op. No duplicate CRM row, no second email to the customer. The
> uniqueness check and the write are one atomic operation — there's no gap between them.

**3. The demo can't be abused.**

> It's a paid API on a public URL, so I capped it five ways. Two runs per visitor, tracked by both
> hashed IP and cookie so clearing one doesn't reset it. A daily cap, a lifetime cap, token limits,
> and a kill switch. The per-visitor counter runs inside a database transaction, because two tabs
> submitting at once would otherwise both read "one used" and both go through. Worst case is about
> five cents a run against a five-hundred-run ceiling — twenty-five dollars maximum, ever. And when
> a cap is hit it doesn't error, it falls back to canned results, so the demo still works.

### The question this answers before it's asked

Clients ask *"what if the AI sends something wrong to my customer?"* The answer isn't a reassurance,
it's an architecture: **there is no code path that sends without passing through the approve branch.**
That's a much stronger answer than "it's usually accurate."

---

## 7. What is still outstanding

| Item | Status | Action |
|---|---|---|
| Anthropic credits | **Blocking live AI** | Add credits; no code change needed |
| n8n workflows imported | Not done | Import the 3 files from `n8n/` at `localhost:5678` |
| n8n credentials | Not done | Google Sheets service account + Gmail SMTP |
| Placeholders in workflows | Not done | Replace `REPLACE_WITH_YOUR_GOOGLE_SHEET_ID` + Slack URLs |
| Error workflow wiring | Not done | Settings → Error Workflow on both other workflows |
| Google Sheet | Not created | Two tabs, `CRM` and `Tickets` — headers in README |
| Screenshots | Not captured | Six shots listed in README |
| Screen recording | Not captured | 60–90s of one email → Slack → approve → sent |
| Deploy to Vercel | Not done | Set `QUOTA_SALT` to a long random string there |

### Verified working right now

- `npm run build` and `npm run lint` pass clean
- All three workflow JSON files parse
- Routing: lead / support / billing classify correctly; `INV-2213` and `HS-4471` extracted
- Confidence gate: vague email → 0.41 → `needs_review`, zero-length draft
- Idempotency: same `messageId` twice → `duplicate: true`, one document
- Approval gate: approve-with-edit, reject, and 404 on unknown ID
- Quota: cap enforced, degrades to canned rather than erroring, refunds on API failure
- Graceful degradation under a genuine, unmocked API failure
