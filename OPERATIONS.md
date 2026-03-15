# Web Claude Code Pilot — Operations Guide

## Architecture

Web Claude Code Pilot runs in **two independent modes** on the same machine:

| Mode | Port | Command | Service | Purpose |
|------|------|---------|---------|---------|
| **Dev** | 4000 | `next dev --turbopack` | `com.codepilot.web` | Local development, HMR |
| **Production** | 4001 | `node .next/standalone/server.js` | `com.codepilot.production` | Remote access via `ccpilot.swifttools.eu` |

Both modes are managed by macOS launchd and auto-start on login. They share the same codebase and database (`~/.codepilot/codepilot.db`) but maintain separate `.next` caches.

---

## Dev Mode (Port 4000)

Runs `next dev --turbopack`. Code changes are picked up automatically via HMR — no build step needed.

### Restart

```bash
lsof -ti :4000 | xargs kill -9; launchctl kickstart -k gui/$(id -u)/com.codepilot.web
```

> **Always kill port 4000 first** before restarting. Never touch other ports.

### Stop / Start

```bash
# Stop
launchctl bootout gui/$(id -u)/com.codepilot.web

# Start
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codepilot.web.plist
```

### When to Restart

**No restart needed** (HMR handles it):
- Editing files under `src/`

**Restart required:**
- Changed `package.json`, `next.config.ts`, or `.env`
- Installed or removed dependencies (`npm install`)

**Plist changed** — must unload/reload (plain `kickstart` uses the cached version):

```bash
launchctl bootout gui/$(id -u)/com.codepilot.web
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codepilot.web.plist
```

### View Logs

```bash
tail -f ~/.codepilot/service.log
tail -f ~/.codepilot/service.error.log
```

---

## Production Mode (Port 4001)

Runs `node .next/standalone/server.js`. Accessible remotely via `ccpilot.swifttools.eu` (SSH tunnel + Caddy + HTTPS). See `docs/remote-access-setup.md` for the full remote access architecture.

### Rebuild & Deploy

After code changes, **you must rebuild** for remote to see updates (HMR doesn't apply):

```bash
./scripts/rebuild-production.sh
```

This script:
1. Copies source to `/tmp/codepilot-build/` (avoids corrupting dev server's `.next` cache)
2. Runs `next build` in the temp directory
3. Deploys standalone output to `.next/standalone/`
4. Kills the old process and waits for launchd to restart with the new binary

> **Never run `next build` directly in the project directory** — it will overwrite dev server's `.next` cache and break HMR.

### Restart (without rebuilding)

```bash
lsof -ti :4001 | xargs kill -9
# launchd KeepAlive will auto-restart
```

### View Logs

```bash
tail -f ~/.codepilot/production.log
tail -f ~/.codepilot/production.error.log
```

---

## Clearing the `.next` Cache

The `.next/` directory is safe to delete — `next dev` recreates it on-demand:

```bash
rm -rf .next
```

When to clear:

- Stale compilation artifacts causing weird behavior
- After switching between dev mode and production build
- HMR not picking up changes after dependency updates

After clearing, just restart the dev service. First page load will be slow (cold compilation).

---

## Access

| From | URL | Secure Context |
|------|-----|----------------|
| Local machine | `http://localhost:4000` | ✅ (localhost exempt) |
| Phone via Tailscale (HTTP) | `http://100.78.243.128:4000` | ❌ |
| Phone via Tailscale (HTTPS) | `https://partys-mac-mini.tail7bb93b.ts.net` | ✅ |
| Remote (internet) | `https://ccpilot.swifttools.eu` | ✅ (port 4001 via SSH tunnel) |

HTTPS access enables browser APIs that require secure context: Notification, Clipboard, PWA install, Service Worker.

---

## HTTPS (Caddy Reverse Proxy — Local/Tailscale)

Caddy handles TLS termination, forwarding `https://partys-mac-mini.tail7bb93b.ts.net` → `http://localhost:4000`. The dev server itself runs unchanged on HTTP.

### How it works

```
Phone → HTTPS:443 (Caddy, TLS) → HTTP:4000 (Web Claude Code Pilot dev)
Phone → HTTP:4000 (direct, still works)
```

### Service Management

```bash
# Check status
launchctl list | grep caddy

# Restart
launchctl kickstart -k gui/$(id -u)/com.codepilot.caddy

# View logs
tail -f ~/.codepilot/caddy.log
```

### TLS Certificate

Certificate is issued by Tailscale (Let's Encrypt), valid ~90 days, **auto-renewed weekly** by `com.codepilot.cert-renew` launchd job.

```bash
# Check cert expiry
openssl x509 -in ~/.codepilot/certs/tailscale.crt -noout -dates

# Manual renewal (if needed)
~/.codepilot/renew-cert.sh

# Check renewal log
cat ~/.codepilot/cert-renew.log
```

### Troubleshooting

**HTTPS not working but HTTP works?** → Caddy might have stopped:
```bash
launchctl kickstart -k gui/$(id -u)/com.codepilot.caddy
```

**Certificate expired?** → Run manual renewal:
```bash
~/.codepilot/renew-cert.sh
```

**Tailscale macOS sandbox note:** The Tailscale macOS App runs in a sandbox, so `tailscale cert` can only write to its container directory. The renewal script works around this by outputting to stdout (`--cert-file -`) and redirecting to `~/.codepilot/certs/`.

---

## Check Status

```bash
# All services
launchctl list | grep codepilot

# Specific service
launchctl print gui/$(id -u)/com.codepilot.web
launchctl print gui/$(id -u)/com.codepilot.production
```

---

## Key Files

| File | Purpose |
|------|---------|
| **Dev mode** | |
| `~/Library/LaunchAgents/com.codepilot.web.plist` | Dev service config (port 4000) |
| `~/.codepilot/service.log` | Dev runtime log |
| `~/.codepilot/service.error.log` | Dev error log |
| **Production mode** | |
| `~/Library/LaunchAgents/com.codepilot.production.plist` | Production service config (port 4001) |
| `scripts/rebuild-production.sh` | Build & deploy script |
| `~/.codepilot/production.log` | Production runtime log |
| `~/.codepilot/production.error.log` | Production error log |
| **Shared** | |
| `~/.codepilot/codepilot.db` | Database (chat sessions, settings) |
| **HTTPS (Tailscale)** | |
| `~/Library/LaunchAgents/com.codepilot.caddy.plist` | Caddy reverse proxy service |
| `~/.codepilot/Caddyfile` | Caddy config (HTTPS → port 4000) |
| `~/.codepilot/certs/tailscale.{crt,key}` | TLS certificate & key |
| `~/.codepilot/renew-cert.sh` | Certificate auto-renewal script |
| `~/Library/LaunchAgents/com.codepilot.cert-renew.plist` | Weekly cert renewal job |
| **Remote access (SSH tunnel)** | |
| `~/Library/LaunchAgents/com.codepilot.tunnel.plist` | SSH reverse tunnel to Azure |
| `~/.codepilot/tunnel.log` | Tunnel log |
