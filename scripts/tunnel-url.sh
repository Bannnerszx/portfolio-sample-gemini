#!/usr/bin/env bash
# Print the current Cloudflare Quick Tunnel URL.
#
# The hostname is issued when the cloudflared process starts and is only ever
# announced in its log, so this greps it back out. It changes every time the
# cloudflared container restarts — re-run this and update n8n when it does.
set -euo pipefail

cd "$(dirname "$0")/.."

url="$(docker compose logs cloudflared 2>/dev/null \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' \
  | tail -1)"

if [ -z "$url" ]; then
  echo "No tunnel URL found. Is the container up? Try: docker compose logs cloudflared" >&2
  exit 1
fi

echo "$url"
