# Runbook — running this locally

Everything you need to start, stop, and check this project. Written for the future you who hasn't
touched it in three months.

---

## TL;DR

```bash
cd "c:/Users/marcv/OneDrive/Desktop/UPLOAD TO GITHUB/N8n/harbor-supply-co"
npm run dev
```

Open <http://localhost:3000>. That's it — the app runs on canned results at zero cost.

Everything below is for when you want more than that.

---

## Level 1 — Just the app (no AI, no n8n)

**Zero cost. Nothing can spend money. Good for UI work and for showing someone the flow.**

```bash
cd "c:/Users/marcv/OneDrive/Desktop/UPLOAD TO GITHUB/N8n/harbor-supply-co"
npm run dev
```

| URL | What it is |
|---|---|
| <http://localhost:3000> | The demo — submit an email |
| <http://localhost:3000/ops> | Live run list |
| <http://localhost:3000/ops/[id]> | Approve / edit / reject one run |

**Try this first:** load the **"Ambiguous"** sample and submit it. Confidence lands at 0.41, the run
goes to `needs_review`, and **no reply is drafted**. That's the confidence gate — the single most
impressive thing to show someone.

Stop it with `Ctrl+C`.

> Requires `.env.local` to exist with your Firebase values (it already does). Without Firestore the
> API returns a clear 503 instead of pretending to work.

---

## Level 2 — With live AI

**Costs about $0.003 per run. Capped at 3 runs per visitor, 50/day, 500 lifetime (~$1.50 total).**

1. Get a key at <https://aistudio.google.com/apikey>
2. Edit `.env.local`:
   ```ini
   GEMINI_API_KEY=your-key-here
   DEMO_AI_ENABLED=true
   ```
3. Restart the dev server (**env changes need a restart** — Next does not hot-reload `.env.local`)

Confirm it's live:

```bash
curl -s http://localhost:3000/api/quota
# {"live":true,"remaining":3,"limit":3,…}
```

`"live": false` means it fell back. Check why in the terminal — the server logs the reason
(`auth`, `rate_limited`, `unparsable`, …) while the browser only sees a friendly notice.

To go back to zero-cost: set `DEMO_AI_ENABLED=false` and restart.

---

## Level 3 — Full loop with n8n

**Start Docker Desktop first**, wait for the whale icon to settle, then:

```bash
docker start n8n          # the container already exists
```

Open <http://localhost:5678>.

**One-time setup** (not done yet — see the checklist at the bottom):

1. Import all three files from `n8n/` — Workflows → ⋯ → Import from File
2. Set credentials on the Google Sheets and Gmail SMTP nodes (credentials never travel with an
   export)
3. Replace `REPLACE_WITH_YOUR_GOOGLE_SHEET_ID` and the Slack webhook URLs
4. Settings → Error Workflow → *Harbor Supply Co. — Error Handler* on the other two workflows
5. Activate both the triage and send workflows
6. Copy the webhook URLs into `.env.local` and restart the dev server

> **The app must be on port 3000** for this level. The workflows call back to
> `http://host.docker.internal:3000/api/triage`. If Next starts on 3001 because something else took
> 3000, the return leg breaks — see troubleshooting below.

---

## Stopping everything

```bash
# 1. The dev server
Ctrl+C in its terminal
```

If `Ctrl+C` didn't work, or you closed the terminal, **this is the reliable way on Windows**
(`pkill -f "next dev"` silently does nothing here — the real process is `node.exe` running
`start-server.js`):

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*harbor-supply-co*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

```bash
# 2. n8n
docker stop n8n

# 3. Confirm nothing is listening
curl -s -o /dev/null -w "%{http_code}\n" --max-time 3 http://localhost:3000/   # 000 = closed
curl -s -o /dev/null -w "%{http_code}\n" --max-time 3 http://localhost:5678/   # 000 = closed
```

Docker Desktop itself can stay open — it costs nothing with no containers running.

---

## Troubleshooting

### `EPERM: operation not permitted, open '…\.next\trace'`

A dev server is still running and holding the build directory. Kill it with the PowerShell command
above, then:

```bash
rm -rf .next && npm run build
```

### It started on port 3001 instead of 3000

Something else has 3000. Find out what:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000 |
  ForEach-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)").CommandLine }
```

Usually another project's dev server. Either stop that one, or accept 3001 — but remember the n8n
workflows point at 3000.

### `"live": false` when you expected live AI

In order of likelihood:

1. `DEMO_AI_ENABLED` isn't `true`
2. `GEMINI_API_KEY` is empty
3. You didn't restart after editing `.env.local`
4. You've used your 3 runs — check `/api/quota`
5. The circuit breaker tripped — the notice will say "unusual burst of traffic"

The terminal always logs the real reason. The browser deliberately doesn't.

### The demo says "unusual burst of traffic"

The circuit breaker tripped (more than 15 submissions in 10 minutes). It **self-heals after 2
hours**. To clear it immediately, delete the `quota/breaker` document in the Firestore console.

### Everything returns canned results and you don't know why

```bash
curl -s http://localhost:3000/api/quota
```

The `reason` field tells you: `disabled`, `visitor`, `daily`, `lifetime`, `breaker`, `lockdown`, or
`unconfigured`.

### Panic — something is hammering the demo

```ini
DEMO_LOCKDOWN=true
```

Restart (or redeploy). Everyone gets canned results instantly, zero spend.

---

## Useful commands

```bash
npm run dev        # dev server, hot reload
npm run build      # production build — also runs lint and type checks
npm run lint       # lint only
docker start n8n   # start n8n
docker stop n8n    # stop n8n
docker ps -a       # what containers exist and their state
```

Check quota / live status at any time:

```bash
curl -s http://localhost:3000/api/quota
```

---

## Reset knobs (all in `.env.local`)

| Variable | Default | What it does |
|---|---|---|
| `DEMO_AI_ENABLED` | `false` | Master switch. `false` = zero cost, always |
| `DEMO_RUNS_PER_VISITOR` | `3` | Live runs before a visitor gets canned results |
| `DEMO_RUNS_PER_DAY` | `50` | Global daily cap (UTC midnight reset) |
| `DEMO_RUNS_TOTAL` | `500` | Lifetime ceiling — ~$1.50 of spend |
| `DEMO_LOCKDOWN` | `false` | Panic switch |
| `DEMO_BURST_THRESHOLD` | `15` | Submissions per window before the breaker trips |
| `DEMO_BURST_WINDOW_MINUTES` | `10` | Burst window length |
| `DEMO_BREAKER_COOLDOWN_MINUTES` | `120` | How long the breaker stays open |
| `OWNER_DEMO_KEY` | *(empty)* | Set it, then visit `/ops?key=<value>` to bypass your own cap for screen recordings |

**Every one of these needs a dev-server restart to take effect.**

To wipe your own quota during testing: delete the `quota/ip-*` and `quota/visitor-*` documents in the
Firestore console. Delete `quota/global-total` to reset the lifetime counter.

---

## Still to do before this is portfolio-ready

- [ ] Paste `GEMINI_API_KEY`, set `DEMO_AI_ENABLED=true`, run one live email of each intent
- [ ] Import the three n8n workflows and set their credentials
- [ ] Create the Google Sheet with `CRM` and `Tickets` tabs (headers in the README)
- [ ] Capture the six screenshots listed in the README
- [ ] Record 60–90 seconds of one email → Slack → approve → sent
- [ ] Push to GitHub and deploy to Vercel (set `QUOTA_SALT` to a long random string there)

⚠️ **Never paste a real key into `.env.example`** — that file is committed on purpose. Keys go in
`.env.local`, which is gitignored.
