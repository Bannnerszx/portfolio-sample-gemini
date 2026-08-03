# Gemini egress proxy

The demo VM is hosted in a country Google blocks for
`generativelanguage.googleapis.com`. Requests failed with HTTP 400
`FAILED_PRECONDITION` — *"User location is not supported for the API use"* —
which [`toReason()`](../lib/gemini.js) maps to `api_400`, so `/api/triage`
degraded to fixtures on every run and showed the "Live AI is unavailable"
notice. Local dev worked because the laptop is in a supported region.

This Worker forwards requests to Google from Cloudflare's network. It's the
smallest fix that leaves the app, the auth model, and the pricing constants
untouched.

> **Caveat — this only helps if Cloudflare egresses from a *supported* region.**
> Workers run in the data center closest to the caller. When the caller is a VM
> in a blocked region (e.g. Hong Kong), the Worker can run in that same colo and
> its outbound `fetch()` to Google egresses from a nearby IP — so Google may
> still geolocate the request to the blocked region and return `api_400`. Verify
> before trusting it (see [Verify](#verify)). If it still 400s, the Worker is the
> wrong tool: point `GEMINI_BASE_URL` at a reverse proxy hosted in a supported
> region instead. Nothing in the app changes — only the two env values below.

## Deploy

```bash
cd cloudflare
npx wrangler login
npx wrangler secret put PROXY_TOKEN     # paste a long random string
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL, e.g.
`https://harbor-gemini-proxy.<subdomain>.workers.dev`.

## Wire it up

Add both values to the `ENV_CONTENT` GitHub secret (the deployed `.env` is
built from it — nothing in the repo feeds it):

```
GEMINI_BASE_URL=https://harbor-gemini-proxy.<subdomain>.workers.dev
GEMINI_PROXY_TOKEN=<the same string you gave wrangler secret put>
```

Leave both **unset in `.env.local`** so local dev keeps calling Google
directly — [`httpOptions()`](../lib/gemini.js) returns `undefined` when
`GEMINI_BASE_URL` is empty, and the SDK falls back to its own default endpoint.
That keeps the proxy out of the dev path entirely.

Then push to `main` to redeploy.

## Verify

**Test the proxy path directly from the VM** — this reproduces the real egress
region (running it from a laptop in a supported region would not):

```bash
curl -sS -D - -o /dev/null \
  -H "x-proxy-token: $GEMINI_PROXY_TOKEN" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  "https://harbor-gemini-proxy.<subdomain>.workers.dev/v1beta/models/gemini-3.1-flash-lite:generateContent" \
  -d '{"contents":[{"parts":[{"text":"ping"}]}]}'
```

- **200** — the proxy works; live AI should now run.
- **400 `FAILED_PRECONDITION` / "User location is not supported"** — Cloudflare
  egressed from the blocked region (the `cf-ray:` header's trailing colo code,
  e.g. `HKG`, confirms where the Worker ran). The Worker can't fix this; use a
  supported-region reverse proxy instead — see the caveat above.
- **403** — `GEMINI_PROXY_TOKEN` doesn't match the Worker's `PROXY_TOKEN`.

Then confirm end to end:

```bash
docker compose exec app printenv GEMINI_BASE_URL
docker compose logs app --tail=50 | grep "Gemini unavailable"
```

The grep should print nothing on a successful run.

## Notes

- The Worker never sees or stores the Gemini API key beyond passing the
  `x-goog-api-key` header straight through; it holds no credentials of its own.
- Free-tier Workers allow 100k requests/day — orders of magnitude above what
  the demo's spend caps (`DEMO_RUNS_TOTAL=500` lifetime) can generate.
- If you ever move the VM to a supported region, delete `GEMINI_BASE_URL` from
  `ENV_CONTENT` and the app reverts to calling Google directly. No code change.
