# CodePilot Operations Guide

## Architecture

- CodePilot runs in `next dev` mode on port **4000**
- Managed by macOS launchd service (`com.codepilot.web`), auto-starts on login
- Code changes are picked up automatically via hot reload — no build step needed

## Service Management

### Restart

```bash
lsof -ti :4000 | xargs kill -9; launchctl kickstart -k gui/$(id -u)/com.codepilot.web
```

### Stop

```bash
launchctl bootout gui/$(id -u)/com.codepilot.web
```

### Start

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codepilot.web.plist
```

### Check Status

```bash
launchctl list | grep codepilot
```

### View Logs

```bash
# Runtime log
tail -f ~/.codepilot/service.log

# Error log
tail -f ~/.codepilot/service.error.log
```

## When to Restart

**No restart needed** — just refresh the browser:

- Editing files under `src/`

**Restart required:**

- Changed `package.json`, `next.config.ts`, or `.env`
- Installed or removed dependencies (`npm install`)

**Plist changed** — must unload/reload (plain `kickstart` uses the cached version):

```bash
launchctl bootout gui/$(id -u)/com.codepilot.web
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codepilot.web.plist
```

## Clearing the `.next` Cache

The `.next/` directory is safe to delete — `next dev` recreates it on-demand:

```bash
rm -rf .next
```

When to clear:

- Stale compilation artifacts causing weird behavior
- After switching between dev mode and production build
- HMR not picking up changes after dependency updates

After clearing, just restart the service. First page load will be slow (cold compilation).

## Access

| From | URL |
|------|-----|
| Local machine | `http://localhost:4000` |
| Phone via Tailscale | `http://<tailscale-ip>:4000` |

## Key Files

| File | Purpose |
|------|---------|
| `~/Library/LaunchAgents/com.codepilot.web.plist` | Service config |
| `~/.codepilot/codepilot.db` | Database (chat sessions, settings) |
| `~/.codepilot/service.log` | Runtime log |
| `~/.codepilot/service.error.log` | Error log |

## Production Build (Release Only)

Production builds are only needed for creating release tags — not for daily use:

```bash
npm run build
PORT=4000 node .next/standalone/codepilot-server.js
```

**Do not mix dev and production.** If you ran `npm run build` previously, clear the cache before going back to dev mode:

```bash
rm -rf .next
# then restart the service
```

Mixing the two leaves stale `.next/standalone/` artifacts that can confuse launchctl and tools that inspect the `.next/` directory.
