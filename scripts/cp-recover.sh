#!/bin/bash
# CodePilot one-shot recovery.
#
# Restart the self-hosted stack from a phone over (Tailscale) SSH when the
# server is down or wedged. `launchctl kickstart -k` kills any running/hung
# instance and starts a fresh one, so this handles BOTH a crashed process and a
# hung-but-alive one (which KeepAlive can't catch on its own). Idempotent — safe
# to run anytime.
#
# One-tap setup:
#   mkdir -p ~/bin && ln -sf "$(pwd)/scripts/cp-recover.sh" ~/bin/cp-restart
#   # ensure ~/bin is on PATH (in ~/.zshrc), then from the phone just run:
#   ssh <your-tailnet-host> cp-restart
#
# On the phone, wire `ssh <host> cp-restart` to a home-screen button:
#   - Android: Termux + Termux:Widget (put the ssh line in ~/.shortcuts/), or a
#     Termius / JuiceSSH snippet.
#   - iOS: Shortcuts app -> "Run script over SSH" -> add to Home Screen.

set -uo pipefail

UID_NUM="$(id -u)"

# Restart order: app first, then the pieces that front it for remote access.
SERVICES=(
  com.codepilot.production    # Next.js app (PORT 4001)
  com.codepilot.terminal-ws  # PTY backend for the in-app terminal
  com.codepilot.caddy        # HTTPS reverse proxy
  com.codepilot.tunnel       # SSH tunnel for remote access
)

echo "== CodePilot recovery =="
for svc in "${SERVICES[@]}"; do
  printf '-> restarting %-28s ' "$svc"
  if launchctl kickstart -k "gui/${UID_NUM}/${svc}" 2>/dev/null; then
    echo ok
  else
    echo "FAILED (not loaded? bootstrap it: launchctl bootstrap gui/${UID_NUM} ~/Library/LaunchAgents/${svc}.plist)"
  fi
done

printf '\n== health check (waiting for the app on :4001) ==\n'
for i in $(seq 1 15); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:4001/ || true)"
  case "$code" in
    200|302|307|308)
      echo "OK - production is up (HTTP $code) after $((i * 2))s"
      exit 0
      ;;
  esac
  sleep 2
done

echo "WARN - production still not responding on :4001"
echo "       check ~/.codepilot/production.error.log"
exit 1
