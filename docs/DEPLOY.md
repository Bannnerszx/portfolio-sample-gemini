# Deploy — VM + Cloudflare Quick Tunnel + push-to-deploy

This is the production counterpart to [RUNBOOK.md](RUNBOOK.md) (which covers running locally).

**The shape:** the app runs in Docker on a Linux VM. A `cloudflared` container opens an outbound
tunnel to Cloudflare and hands back a public `https://….trycloudflare.com` URL — no inbound ports,
no TLS certificate to manage. A GitHub Action SSHes into the VM on every push to `main`, pulls,
rebuilds, and restarts. That's the Firebase-App-Hosting feel: push, wait, refresh.

```
git push origin main
   └─► GitHub Actions ─ssh─► VM
                              ├─ git reset --hard origin/main
                              ├─ write .env from the ENV_FILE_B64 secret
                              └─ docker compose up -d --build app   ← cloudflared untouched
                                          │
                    browser ──► Cloudflare ──tunnel──► app:3000
```

---

## ⚠️ The one thing to know about Quick Tunnels

**The URL is issued per `cloudflared` process and changes every time that container restarts.**
There is no way to pin it without a domain on your Cloudflare account.

Consequences, and how this repo handles them:

- Deploys **do not** restart the tunnel — the workflow runs `docker compose up -d --build app`, naming
  the service, so `cloudflared` keeps running and the URL holds. Never `docker compose down` unless
  you mean to rotate it.
- After a VM reboot (or any tunnel restart) run `bash scripts/tunnel-url.sh` to get the new URL, then
  **re-paste it into the n8n callback node**, or the approve round trip breaks silently.
- If you want a URL that never changes, the upgrade is a **Named Tunnel** on a domain you own in
  Cloudflare. Same `cloudflared` image, a token instead of `--url`.

---

## One-time VM setup

### 1. Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # log out and back in for this to take effect
docker compose version            # confirm the compose plugin is there
```

### 2. Clone

```bash
git clone https://github.com/Bannnerszx/portfolio-sample-gemini.git ~/harbor-supply-co
cd ~/harbor-supply-co
```

The deploy workflow hardcodes `~/harbor-supply-co` — keep that path, or edit
[.github/workflows/deploy.yml](../.github/workflows/deploy.yml) to match.

If the repo is private, add a read-only **deploy key** on the VM (`ssh-keygen -t ed25519`, paste the
`.pub` into GitHub → repo → Settings → Deploy keys) and clone over SSH instead.

### 3. `.env`

Note the filename: **`.env`**, not `.env.local`. Compose only interpolates `${...}` from a file named
exactly `.env`, and the build args for the public Firebase values depend on that.

```bash
cp .env.example .env
nano .env
```

Fill in everything from [.env.example](../.env.example). The two that are deploy-specific:

```ini
N8N_WEBHOOK_URL=https://shortcuts-everyday-korean-amd.trycloudflare.com/webhook/inbox-triage
N8N_APPROVE_WEBHOOK_URL=https://shortcuts-everyday-korean-amd.trycloudflare.com/webhook/approve-send
```

Also set a real `QUOTA_SALT` (any long random string) — the default makes visitor IP hashes
guessable. Leave `DEMO_AI_ENABLED=false` until you've confirmed the deploy works; the whole demo runs
on canned results at zero cost.

### 4. First run

```bash
docker compose up -d --build
bash scripts/tunnel-url.sh          # → https://something-random.trycloudflare.com
```

Open that URL. If it loads, you're deployed.

### 5. Point n8n at it

In n8n, open `workflow.json`'s callback node (the `PATCH /api/triage` HTTP Request) and set its base
URL to the tunnel URL from step 4. Same for the approve flow in `workflow-send.json`. Do this again
whenever the tunnel URL rotates.

### 6. GitHub secrets

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `VM_HOST` | the VM's public IP or hostname |
| `VM_USER` | the SSH user that owns `~/harbor-supply-co` |
| `VM_SSH_KEY` | the **private** key whose public half is in the VM's `~/.ssh/authorized_keys` |
| `ENV_FILE_B64` | `base64 -w0 .env` — run it on the VM, paste the single line it prints |

`ENV_FILE_B64` is base64 because `FIREBASE_ADMIN_PRIVATE_KEY` is one line full of literal `\n`
sequences that a plain `echo` into a file will happily corrupt.

**Re-generate `ENV_FILE_B64` whenever you change `.env`** — the workflow overwrites the VM's `.env`
from that secret on every deploy, so the secret is the source of truth, not the file on disk.

---

## Day to day

```bash
docker compose logs -f app          # app logs
docker compose logs -f cloudflared  # tunnel logs
bash scripts/tunnel-url.sh          # current public URL
docker compose up -d --build app    # manual redeploy (leaves the tunnel alone)
docker compose restart app          # pick up an .env change without rebuilding
```

Changing an `NEXT_PUBLIC_FIREBASE_*` value needs a **rebuild**, not a restart — those are compiled
into the client bundle. Everything else (Gemini key, quota caps, `DEMO_LOCKDOWN`, n8n URLs) is read at
runtime, so `restart` is enough.

---

## Troubleshooting

**Page loads but the live list is dead / "not configured".**
The `NEXT_PUBLIC_FIREBASE_*` build args didn't reach the build. Confirm they're set in `.env` (not
just `.env.local`), then `docker compose build --no-cache app && docker compose up -d app`.

**Form submits return 403.**
The origin check in [lib/lockdown.js](../lib/lockdown.js) compares the request's `Origin` host against
the `Host` header; if cloudflared rewrites `Host`, they stop matching. Fix without touching code —
add the current tunnel host to `.env` and restart:

```ini
DEMO_ALLOWED_ORIGINS=https://your-current-tunnel.trycloudflare.com
```

n8n's server-to-server `PATCH` sends no `Origin` at all and is always allowed, so this only ever
affects browser traffic.

**Action fails on `docker: permission denied`.**
The SSH user isn't in the `docker` group, or was added without re-logging in. `sudo usermod -aG docker
$USER`, then reconnect.

**Deploy succeeded but the site is unreachable.**
The tunnel probably restarted. `bash scripts/tunnel-url.sh` for the new URL, and update n8n.

**Firestore auth errors after a deploy.**
`FIREBASE_ADMIN_PRIVATE_KEY` got mangled in `ENV_FILE_B64`. Re-run `base64 -w0 .env` on the VM
against a known-good `.env` and replace the secret.
