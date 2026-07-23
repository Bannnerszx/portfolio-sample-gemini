# Build log #2 — migrating to Gemini, and hardening against bots

The first build log ([`BUILD-LOG.md`](BUILD-LOG.md)) covers the original build on Claude. This one
covers the second phase: swapping the model provider to Google's cheapest model, raising the
per-visitor allowance, and adding a real anti-abuse layer.

Same format — decisions, commands, and every problem hit with its diagnosis.

---

## Table of contents

1. [Why change provider](#1-why-change-provider)
2. [Verifying the model before writing any code](#2-verifying-the-model-before-writing-any-code)
3. [The migration](#3-the-migration)
4. [The anti-bot layer — and why this is the right design](#4-the-anti-bot-layer--and-why-this-is-the-right-design)
5. [Testing](#5-testing)
6. [Troubleshooting log](#6-troubleshooting-log)
7. [How to explain the security work](#7-how-to-explain-the-security-work)
8. [Outstanding](#8-outstanding)

---

## 1. Why change provider

The demo does two small, tightly-specified jobs: classify an email against a fixed schema, and write
a short reply. Neither needs a frontier model. Paying frontier prices for schema-bound extraction is
the kind of thing a client will notice on their bill and quite reasonably ask about.

The economics of the switch:

| | Claude Opus 4.8 | Gemini 3.1 Flash Lite | Change |
|---|---|---|---|
| Input / 1M tokens | $5.00 | **$0.25** | 20× cheaper |
| Output / 1M tokens | $25.00 | **$1.50** | ~17× cheaper |
| Cost per run (~2k in / 1.6k out) | ~$0.050 | **~$0.003** | ~17× cheaper |
| 500-run lifetime cap | ~$25.00 | **~$1.50** | — |

**This changes the threat model, which is the important part.** The original design treated the
public demo as a *denial-of-wallet* risk — a stranger could cost real money. At a third of a cent per
run with a 500-run ceiling, the entire worst case is now about the price of a coffee.

So the caps stop being primarily financial protection and become:

- **rate-limit protection** — Tier 3 billing gives generous quotas, but a bot can still exhaust them
  and take the demo down for genuine visitors;
- **reputation protection** — an endpoint that lets anyone run arbitrary text through your paid API
  key is an open relay, and someone will eventually use it for something you don't want associated
  with your name.

That second point is why the anti-abuse work was worth doing even after the cost risk collapsed.

### Two decisions taken at the same time

- **Per-visitor allowance raised from 2 → 3.** Cheap enough now to be generous, and three is the
  number that lets a visitor try a lead, a support ticket, *and* the ambiguous email that trips the
  confidence gate — which is the one that actually demonstrates judgement.
- **Tier 3 paid billing**, on an existing personal Google API key. So the cost tracking in `/ops`
  uses real paid rates rather than showing $0.00, and rate limits are high enough that the burst
  detector — not Google — is the first thing to react to abuse.

---

## 2. Verifying the model before writing any code

The first build log's biggest lesson was: **never write against a remembered API surface.** That
applied twice here.

### 2.1 Confirming the model ID actually exists

`gemini-3.1-flash-lite` was not assumed. Search results disagreed about pricing — one source said
$0.25/$1.50, another $0.125/$0.75 — so the authoritative page was fetched directly:

> **Model ID:** `gemini-3.1-flash-lite`
> **Free tier:** yes
> **Paid:** $0.25 input (text/image/video), $1.50 output, per 1M tokens

Two conflicting third-party pricing pages is exactly the situation where you go to the vendor's own
docs. The $0.125/$0.75 figures likely refer to a preview variant or a promotional rate.

### 2.2 Confirming the SDK surface

```bash
npm view @google/genai version     # 2.13.0
npm install @google/genai@2.13.0
npm uninstall @anthropic-ai/sdk
```

Then — before writing a line of integration code — the installed type definitions were read:

```bash
grep -nE "^\s{2,4}(generateContent|countTokens)\b" node_modules/@google/genai/dist/genai.d.ts
#   generateContent: (params) => Promise<GenerateContentResponse>
#   countTokens(params): Promise<CountTokensResponse>

grep -nE "^\s{4}(responseSchema|responseJsonSchema|systemInstruction|thinkingConfig)\??:" …
#   systemInstruction?  responseSchema?  responseJsonSchema?  thinkingConfig?

grep -nE "^\s{4}(promptTokenCount|candidatesTokenCount|cachedContentTokenCount|thoughtsTokenCount)\??:" …
#   all four present
```

And the two details that mattered most:

```bash
sed -n '/interface ThinkingConfig/,+14p' …
#   thinkingBudget?: number   // "0 is DISABLED. -1 is AUTOMATIC."

grep -nE "declare class .*Error" …
#   export declare class ApiError extends Error { status: number }
```

`thinkingBudget: 0` is the cheapest possible configuration and is correct for schema-bound
extraction — there is nothing to reason about when you're copying fields out of an email. And
`ApiError.status` means error handling can branch on HTTP status rather than string-matching
messages.

---

## 3. The migration

### 3.1 What changed, file by file

| File | Change |
|---|---|
| `lib/claude.js` | **Deleted** |
| `lib/gemini.js` | **New** — same exported shape, so nothing downstream changed |
| `lib/lockdown.js` | **New** — anti-abuse layer |
| `lib/quota.js` | Per-visitor default 2 → 3; key check → `GEMINI_API_KEY`; two new messages |
| `lib/schemas.js` | Added the `company_website` honeypot field |
| `app/api/triage/route.js` | Origin check, honeypot, burst detection, lockdown gate |
| `components/EmailForm.jsx` | Renders the hidden honeypot input |
| `.env.example` / `.env.local` | Gemini key + six new lockdown settings |

**The interface was kept identical on purpose.** `lib/gemini.js` exports `triageEmail()` returning
`{ classification, draft, usage, cost, model }` and throws an `AiUnavailable` error — exactly what
`lib/claude.js` did. The API route needed a three-line change: the import, the error class name, and
a log string.

That's the payoff for having isolated the provider behind one module in the first place. **A
provider swap should be a one-file change, and it was.**

### 3.2 Structured output: same idea, different mechanism

Claude used a zod schema passed through `zodOutputFormat()`. Gemini takes a **JSON Schema** via
`responseJsonSchema`. Rather than hand-maintain a second copy of the shape — which would drift —
it's derived from the same zod schemas:

```js
function toGeminiSchema(schema) {
  const json = z.toJSONSchema(schema, { target: "draft-7" });
  delete json.$schema;   // Gemini rejects unknown top-level keys
  return json;
}
```

zod v4 ships `z.toJSONSchema()` natively, so no extra dependency. One source of truth is preserved:
the same zod object validates the browser form, validates the API payload, *and* constrains the
model's output.

**Then the response is validated with zod anyway:**

```js
function parseStructured(response, schema) {
  const text = response?.text;
  if (!text) return null;
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
```

Belt and braces. The schema *constrains generation*; zod *verifies the result*. If the model ever
deviates, the run degrades to human review rather than pushing an unroutable value into the n8n
Switch node. Constraint and validation are different things and it's worth doing both.

### 3.3 Failure handling, translated

Claude's typed error classes became status-code branching on Gemini's single `ApiError`:

```js
function toReason(err) {
  if (err instanceof ApiError) {
    if (err.status === 429) return "rate_limited";
    if (err.status === 401 || err.status === 403) return "auth";
    if (err.status >= 500) return "upstream";
    return `api_${err.status}`;
  }
  if (err?.name === "AbortError") return "timeout";
  return "unknown";
}
```

Gemini also signals problems through `finishReason` rather than a `stop_reason` field, so that
needed its own guard:

```js
function checkFinish(response) {
  const reason = response?.candidates?.[0]?.finishReason;
  if (!reason || reason === "STOP") return;
  if (reason === "MAX_TOKENS") throw new AiUnavailable("truncated");
  if (reason === "SAFETY" || reason === "PROHIBITED_CONTENT") throw new AiUnavailable("refusal");
  throw new AiUnavailable(`finish_${String(reason).toLowerCase()}`);
}
```

Without this, a response truncated at the token limit would return partial JSON, fail to parse, and
be reported as "unparsable" — a misleading diagnosis. Distinguishing *cut short* from *malformed*
matters when you're reading logs at 2am.

### 3.4 Token accounting has a trap

Gemini's `promptTokenCount` **includes** cached tokens, and thinking tokens are billed as output.
Naively reading the fields double-counts:

```js
input_tokens:  Math.max(0, (m.promptTokenCount ?? 0) - (m.cachedContentTokenCount ?? 0)),
output_tokens: (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0),
```

Worth getting right — the whole point of showing cost in `/ops` is that the number is trustworthy.

---

## 4. The anti-bot layer — and why this is the right design

### The principle

> Reject the cheapest way possible, as early as possible, and never tell the attacker which check
> caught them.

Every defence runs **before** Firestore is touched or the model is called, so a bot costs CPU cycles
and nothing else.

### The four layers

```
POST /api/triage
  │
  ├─ 1. Origin check ────────► 403          (no DB, no spend)
  ├─ 2. Honeypot ───────────► fake 200      (no DB, no spend)
  ├─ 3. Burst detection ────► may trip breaker
  ├─ 4. Breaker / lockdown ─► canned mode   (no spend)
  │
  └─ existing quota: 3-per-visitor · daily · lifetime
```

#### 1. Origin check

A browser sends `Origin` on fetch POSTs. A copied `curl` command usually doesn't, or sends the wrong
host.

This is **not** real security — `Origin` is trivially forged by anything that bothers to try. It's a
free filter that removes the laziest traffic. It's deliberately permissive: a request with *no*
Origin and *no* Referer is allowed through, because that's what n8n's server-to-server PATCH calls
look like. Breaking your own integration to block a bot that can forge a header anyway would be a
bad trade.

#### 2. Honeypot

A hidden field a human can never fill:

```jsx
<div className="absolute left-[-9999px] …" aria-hidden="true">
  <label htmlFor="company_website">Company website — leave this blank</label>
  <input id="company_website" name="company_website" tabIndex={-1} autoComplete="off" … />
</div>
```

Off-screen, `aria-hidden` (screen readers skip it), `tabIndex={-1}` (keyboard users can't reach it),
`autoComplete="off"` (password managers won't fill it). A bot that walks the DOM and fills every
input walks straight into it.

The response when tripped is the interesting part:

```js
if (isHoneypotTripped(body)) {
  console.warn("Honeypot tripped — dropping request.");
  return NextResponse.json({ ok: true, id: null, live: false }, { status: 200 });
}
```

**A fake success, not an error.** A 403 tells the operator their bot was detected and they should
change something. A 200 tells them everything is fine while nothing happens. Silent failure is the
correct response to detected abuse.

#### 3. Circuit breaker

The actual "lockdown". If more than `DEMO_BURST_THRESHOLD` submissions arrive within
`DEMO_BURST_WINDOW_MINUTES`, the demo switches itself to canned results for
`DEMO_BREAKER_COOLDOWN_MINUTES`, posts a Slack alert, and then **heals itself** — no cron job, no
manual reset:

```js
if (Date.now() >= until) {
  return { tripped: false, until: null, reason: null };   // expired
}
```

Three design points worth being able to defend:

**It lives in Firestore, not in memory.** On Vercel each request may hit a different serverless
instance. An in-process counter would reset constantly and never detect anything. This is the single
most common mistake in home-rolled rate limiting, and it fails silently — the code looks correct and
simply never fires.

**It counts every attempt, including already-capped ones.** Burst recording happens *before* the
quota check:

```js
await recordAndDetectBurst(db);
const lockdownReason = await checkLockdown(db);
```

If it only counted successful runs, a bot that had exhausted its per-visitor quota would hammer the
endpoint forever while the detector saw nothing.

**It fails safe.** If the breaker state can't be read, we don't know whether we're under attack — so
we assume we are:

```js
console.warn("Breaker read failed, assuming tripped:", …);
return { tripped: true, until: null, reason: "unreadable" };
```

Being wrong costs canned results. Being wrong the other way costs an unprotected endpoint.

#### 4. Manual switch

`DEMO_LOCKDOWN=true` — one env var, forces canned mode for everyone, immediately. For when something
is happening that the automatic rules didn't anticipate.

### What was deliberately *not* built

**Cloudflare Turnstile** would be stronger than all of the above and is nearly frictionless. It was
skipped because it needs a third-party signup, and the layers above are enough at this risk level.
It's the obvious next addition if the demo ever gets real attention — and the honest answer in an
interview is "I'd add Turnstile if this were handling anything that mattered."

**IP-based hard blocking** was skipped too. IPs are shared (offices, mobile carriers, universities)
and rotate cheaply. Blocking one punishes innocent visitors while barely inconveniencing an
attacker. The existing hashed-IP *counter* is a better use of the same signal.

---

## 5. Testing

### Origin and honeypot

| Test | Expected | Result |
|---|---|---|
| Honeypot filled | Fake 200, no run created | `{"ok":true,"id":null,"live":false}` ✅ |
| `Origin: https://evil.example.com` | 403 | `403` ✅ |
| No Origin at all (n8n) | Allowed | `200` ✅ |
| `Origin: http://localhost:3000` | Normal run | `200`, intent `new_lead` ✅ |

### Circuit breaker

Threshold temporarily lowered to 5, cooldown to 2 minutes, then six requests fired:

```
req 1 -> live=false notice=Live AI is switched off…
req 2 -> live=false notice=Live AI is switched off…
req 3 -> live=false notice=The demo saw an unusual burst of traffic…   ← tripped
req 4 -> live=false notice=The demo saw an unusual burst of traffic…
req 5 -> live=false notice=The demo saw an unusual burst of traffic…
req 6 -> live=false notice=The demo saw an unusual burst of traffic…
```

Server log:

```
Circuit breaker TRIPPED: 6 requests in 10m (threshold 5).
  Canned mode until 2026-07-23T02:57:57.515Z.
```

It tripped at request **3**, not 5 — because the earlier origin/honeypot tests were already in the
same 10-minute window. That's correct behaviour, and a useful reminder that the window is wall-clock,
not per-test.

Polling for self-healing then exposed a real bug — see [problem 5](#problem-5--the-breaker-could-never-reopen).
After the fix, with threshold 5 / window 1m / cooldown 1m and a request every 15 seconds throughout:

```
phase 1: burst of 6 to trip it
trips logged: 1 (should be exactly 1)          ← was 12 before the fix

phase 2: continuous traffic every 15s
12:01:20 -> The demo saw an unusual burst of traff
12:01:36 -> The demo saw an unusual burst of traff
12:01:51 -> The demo saw an unusual burst of traff
12:02:06 -> The demo saw an unusual burst of traff
12:02:22 -> Live AI is switched off for this deplo
>>> SELF-HEALED under continuous traffic
total trips: 1
```

### Schema conversion

The zod → JSON Schema output was inspected directly before trusting it:

```
has $schema (must be false): false
top-level type: object
intent enum: new_lead|support|billing|spam
confidence constraints: {"min":0,"max":1}
nested contact type: object -> name,email,company
```

Enums preserved, nested objects intact, constraints carried over, no stray `$schema`.

---

## 6. Troubleshooting log

### Problem 1 — Conflicting pricing from third-party sources

**Symptom.** Search results gave two different prices for the same model: $0.25/$1.50 and
$0.125/$0.75.

**Diagnosis.** Third-party pricing aggregators lag, and often list preview or promotional variants
alongside GA ones without distinguishing them.

**Fix.** Fetched Google's own pricing page. Used $0.25/$1.50, the GA standard-tier rate.

**Lesson.** For anything that ends up in a cost estimate a client might rely on, go to the vendor's
own documentation. An aggregator being six weeks stale is normal.

### Problem 2 — The build lock, again

**Symptom.** Identical to problem 4 in the first build log:

```
uncaughtException [Error: EPERM: operation not permitted, open '…\.next\trace']
```

**Diagnosis.** The dev server from the previous session was still running and holding `.next/`.

**Fix.** The documented procedure from last time, applied directly:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*harbor-supply-co*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Then `rm -rf .next` and rebuild.

**Lesson.** This is the value of writing the first build log — a problem that cost real debugging
time the first time cost about thirty seconds the second time.

### Problem 3 — `NODE_PATH` doesn't work for ES modules

**Symptom.** A scratch script to inspect the generated JSON Schema failed:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from …\scratchpad\schema-check.mjs
```

…despite `NODE_PATH` pointing at the project's `node_modules`.

**Diagnosis.** `NODE_PATH` is a **CommonJS-only** mechanism. Node's ES module resolver ignores it
entirely and walks up from the importing file's own directory. A `.mjs` sitting in a scratch folder
outside the project therefore can't see the project's dependencies no matter what you set.

**Fix.** Ran the script from inside the project directory instead, and deleted it afterwards.

**Lesson.** ESM and CJS resolve modules by genuinely different rules. When an import fails only under
ESM, check whether the mechanism you're relying on is CJS-era before assuming a config error.

### Problem 4 — Verifying Firestore state needed a different approach

**Symptom.** A script written to read the breaker document directly from Firestore failed on import.

**Diagnosis.** The project has no `"type": "module"` in `package.json`, so `.js` files are parsed as
CommonJS — but `lib/firebaseAdmin.js` is written in ESM syntax. It works inside Next (which compiles
it) and fails under bare Node.

**Fix.** Didn't fight it. Verified through the running application instead — polling the real API
endpoint and watching the notice change. That tests the actual code path a visitor hits, which is
better evidence than reading the database directly.

**Lesson.** When a test harness becomes harder than the thing it's testing, test through the real
interface instead. Reading the DB would have proved the document exists; polling the endpoint proves
the *behaviour* works.

### Problem 5 — The breaker could never reopen

**Symptom.** After tripping the breaker, a poll loop hit the endpoint every 15 seconds waiting for
the 2-minute cooldown to expire. It never did:

```
11:57:27 -> The demo saw an unusual burst of traffic
11:57:42 -> The demo saw an unusual burst of traffic
…
11:59:15 -> The demo saw an unusual burst of traffic     ← well past the 2-minute cooldown
```

**Diagnosis.** The server log told the story immediately:

```bash
grep -c "Circuit breaker TRIPPED" /tmp/hsc-dev.log
# 12

Circuit breaker TRIPPED: 15 requests in 10m … until 2026-07-23T03:00:59.916Z
Circuit breaker TRIPPED: 16 requests in 10m … until 2026-07-23T03:01:15.404Z
```

Twelve trips, each with a **later** expiry than the last. `recordAndDetectBurst()` incremented the
window counter on every request, and once that counter was above the threshold, *every subsequent
request* re-tripped the breaker and pushed `until` forward by a fresh cooldown.

The effect: the cooldown restarted continuously, so the breaker would only reopen after traffic
stopped completely for the entire cooldown period. On a public demo, a slow trickle of genuine
visitors would keep it locked shut **indefinitely** — precisely the opposite of self-healing, and it
would have looked like the demo was permanently broken.

Worth noting *why* this passed the first test: the initial burst test only checked that the breaker
*trips*. It did, correctly. The bug lived entirely in the recovery path, which only a
wait-and-observe test could reach.

**Fix.** Only trip on the way up. If the breaker is already open, leave its expiry alone:

```js
// Only trip on the way *up*. Once the breaker is open, leave its expiry alone.
const existing = await getBreakerState(db);
if (existing.tripped) return false;
```

**Re-tested** with a request every 15 seconds throughout: exactly **1** trip instead of 12, and the
breaker reopened on schedule while traffic was still arriving.

**Lesson.** A self-healing mechanism needs a test that actually waits for it to heal. "Does it
trigger?" and "does it recover?" are two different tests, and the second is the one people skip —
it's slower, it's boring, and the failure it catches is invisible until you're in production
wondering why the thing never came back.

---

## 7. How to explain the security work

### The one-liner

> It's a paid API endpoint on a public URL, which is effectively an open relay unless you defend it.
> So there are four layers before anything costs money, and the demo can shut its own door.

### If they ask *"couldn't a bot just get past that?"*

Answer honestly — it's a much better answer than pretending otherwise:

> Yes, a determined one could. The origin check and the honeypot only stop unsophisticated traffic —
> anything that forges a header and skips hidden fields gets through both. That's why they're not the
> last line. The circuit breaker doesn't care *how* the requests arrive; it just notices too many
> arriving too fast and shuts off the expensive path. And behind that the hard caps mean the absolute
> worst case is bounded at about a pound fifty. I picked layers that fail in different ways rather
> than one clever one.

### The detail that shows real deployment experience

> The breaker state lives in the database, not in memory. On serverless, every request can land on a
> different instance, so an in-process counter would reset constantly and never fire. That's the
> usual way home-rolled rate limiting fails, and it fails silently — the code looks completely
> correct and just never triggers.

### And on the honeypot response

> When the honeypot catches something, it returns a normal success response and quietly does nothing.
> If you return a 403, you've told them their bot was detected and they'll adjust. A fake 200 means
> they carry on thinking it works.

---

## 8. Outstanding

| Item | Status |
|---|---|
| `GEMINI_API_KEY` in `.env.local` | **Blocking live AI** — paste your Tier 3 key |
| Flip `DEMO_AI_ENABLED=true` | After the key is in |
| Restore burst threshold to 15 / cooldown 120 | Currently 5 / 2 from testing |
| One live run per intent | Confirms real classification + cost tracking |
| n8n workflows imported + credentials | Unchanged from the first build log |
| Google Sheet with `CRM` + `Tickets` tabs | Unchanged |
| Screenshots + screen recording | Unchanged |
| Deploy to Vercel | Set `QUOTA_SALT` to a long random string there |

### Verified working

- `npm run build` and `npm run lint` clean after the provider swap
- zod → JSON Schema conversion produces valid, enum-preserving output
- Honeypot returns fake success and creates no run
- Origin check: wrong origin 403, absent origin allowed, correct origin passes
- Circuit breaker trips on burst, logs, and self-heals after cooldown
- Per-visitor cap now 3
- Quota, idempotency, confidence gate, and approval gate all still pass from the first build log
