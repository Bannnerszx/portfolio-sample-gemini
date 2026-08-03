# Gemini egress proxy

The demo VM is hosted in a country Google blocks for
`generativelanguage.googleapis.com`. Requests failed with HTTP 400
`FAILED_PRECONDITION` — *"User location is not supported for the API use"* —
which [`toReason()`](../lib/gemini.js) maps to `api_400`, so `/api/triage`
degraded to fixtures on every run and showed the "Live AI is unavailable"
notice. Local dev worked because the laptop is in a supported region.

This Worker forwards requests to Google from Cloudflare's network, which is not
blocked. It's the smallest fix that leaves the app, the auth model, and the
pricing constants untouched.

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

From the VM, after the deploy:

```bash
docker compose exec app printenv GEMINI_BASE_URL
docker compose logs app --tail=50 | grep "Gemini unavailable"
```

The second command should print nothing on a successful run. A `403` reason
means `GEMINI_PROXY_TOKEN` doesn't match the Worker's `PROXY_TOKEN`.

## Notes

- The Worker never sees or stores the Gemini API key beyond passing the
  `x-goog-api-key` header straight through; it holds no credentials of its own.
- Free-tier Workers allow 100k requests/day — orders of magnitude above what
  the demo's spend caps (`DEMO_RUNS_TOTAL=500` lifetime) can generate.
- If you ever move the VM to a supported region, delete `GEMINI_BASE_URL` from
  `ENV_CONTENT` and the app reverts to calling Google directly. No code change.
