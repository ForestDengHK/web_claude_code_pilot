# CodePilot: Standalone Web Server + Mobile UI

**Date:** 2026-02-18
**Status:** Approved

## Problem

CodePilot is an Electron desktop app. The user connects to their Mac Mini remotely from their phone via Tailscale + Termius (SSH terminal). The terminal experience is poor for operating Claude Code on a phone. CodePilot needs to become a standalone web server accessible from a phone browser over Tailscale.

## Decisions

- **Replace Electron entirely** — pure web app, no desktop shell
- **No authentication** — Tailscale provides network-level security
- **Per-session permission toggle** — skip-permissions configurable per session, default from global setting
- **Folder picker + favorites** — starred directories + recent + filesystem browser
- **Mobile-first responsive** — bottom tab bar, full-screen overlays for panels

---

## Section 1: Standalone Server (Drop Electron)

### Remove

- `electron/` directory (main.ts, preload.ts)
- `electron-builder.yml`
- Electron deps: `electron`, `electron-builder`, `concurrently`, `wait-on`
- Electron scripts: `electron:dev`, `electron:build`, `electron:pack`, `electron:pack:*`
- Install wizard: `InstallWizard.tsx`, install IPC handlers
- Update checker: `UpdateDialog.tsx`, `/api/app/updates` route
- ABI check logic (only relevant for Electron's Node ABI)
- 44px Electron title bar drag region in `AppShell.tsx`

### Add

- `server.ts` — standalone entry point:
  - Loads user shell env via login shell (reuse logic from `electron/main.ts:loadUserShellEnv`)
  - Sets `HOSTNAME=0.0.0.0` for network access
  - Sets `PORT` from env (default 3000)
  - Merges shell env into `process.env` before starting Next.js server
  - Starts the Next.js standalone `server.js`
- `npm run server` script in package.json
- Config via env vars: `PORT`, `HOSTNAME`

### Keep Unchanged

- All API routes (28 routes)
- SQLite database at `~/.codepilot/`
- `claude-client.ts` (SDK integration)
- `platform.ts` (already works without Electron)
- Session management, message streaming, permission registry

---

## Section 2: Mobile-Responsive Layout

### Breakpoint Strategy

- `md:` (768px) — mobile/desktop split
- Below 768px → mobile layout
- Above 768px → current desktop layout (minus Electron chrome)

### Mobile Layout

```
+--------------------------------------+
|          Main Content                |
|       (full width chat)              |
|                                      |
+--------------------------------------+
| [Chats] [Files] [Settings] [Theme]  |  <- Bottom tab bar
+--------------------------------------+
```

### Component Changes

| Component | Desktop (>= 768px) | Mobile (< 768px) |
|-----------|--------------------|--------------------|
| NavRail | Left sidebar 56px | Hidden → becomes bottom tab bar |
| Bottom tab bar | Hidden | Fixed bottom, 56px height |
| ChatListPanel | Side panel, resizable | Full-screen overlay, slide-in |
| RightPanel | Side panel, resizable | Full-screen overlay via tab |
| DocPreview | Side panel | Full-screen overlay |
| ResizeHandle | Mouse drag | Hidden |
| Title bar region | Removed (was Electron-only) | Removed |
| MessageInput | As-is | Larger tap targets (44px min), full-width toolbar |

### CSS Approach

- Add `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">` to layout.tsx
- NavRail: `hidden md:flex` (desktop only)
- New `BottomNav` component: `fixed bottom-0 md:hidden` (mobile only)
- Panels: `fixed inset-0 z-50` overlays on mobile
- Mode/model selectors: horizontal scroll row on mobile
- Existing Tailwind v4 setup supports all needed responsive utilities

---

## Section 3: Per-Session Permission Toggle

### Database

Add column to sessions table:
```sql
ALTER TABLE sessions ADD COLUMN skip_permissions INTEGER DEFAULT 0;
```

### UI

- Toggle icon (shield/lock) in MessageInput toolbar, alongside Mode and Model selectors
- Orange pulsing indicator when active (reuse existing pattern from NavRail)
- On mobile: part of the horizontal toolbar row

### Behavior

- New sessions: default from global `dangerously_skip_permissions` setting
- Toggle changes session-level setting via `PATCH /api/chat/sessions/{id}`
- `claude-client.ts` reads session's `skip_permissions` instead of (or in addition to) global setting
- When ON: `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`
- When OFF: uses mode-based permission (code→acceptEdits, plan→plan, ask→default)

---

## Section 4: Folder Picker + Favorites

### Storage

New key in SQLite `settings` table:
- Key: `favorite_directories`
- Value: JSON array of `{ path: string, name: string }` objects

### API

- `GET /api/favorites` — returns favorite directories list
- `POST /api/favorites` — add a favorite `{ path, name }`
- `DELETE /api/favorites` — remove a favorite `{ path }`

### UI Flow (Mobile)

New chat → full-screen folder selection:

1. **Favorites** section — star-pinned directories, one-tap to select
2. **Recent** section — last 5 used working directories (derived from sessions)
3. **Browse** button — opens filesystem browser (existing FolderPicker logic adapted for mobile full-screen)
4. Star icon on each directory to add/remove from favorites

### UI Flow (Desktop)

Same sections shown in the existing new-chat page layout, not as an overlay.

---

## Section 5: Startup & Deployment

### Scripts

```json
{
  "dev": "HOSTNAME=0.0.0.0 next dev",
  "build": "next build",
  "server": "node server.js"
}
```

### Production Flow

```bash
npm run build     # Build Next.js standalone
npm run server    # Start on 0.0.0.0:3000
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOSTNAME` | `0.0.0.0` | Bind address |

### Optional: launchd Auto-Start

Provide a sample plist in `docs/launchd/com.codepilot.server.plist` for macOS auto-start on boot. Documentation only — user configures manually.

---

## Files to Modify/Create

### New Files
- `server.ts` — standalone server entry point
- `src/components/layout/BottomNav.tsx` — mobile bottom tab bar
- `src/app/api/favorites/route.ts` — favorites CRUD
- `docs/launchd/com.codepilot.server.plist` — sample launchd config

### Major Modifications
- `src/app/layout.tsx` — add viewport meta, remove Electron assumptions
- `src/components/layout/AppShell.tsx` — responsive layout, remove title bar, add BottomNav
- `src/components/layout/NavRail.tsx` — hide on mobile (`hidden md:flex`)
- `src/components/layout/ChatListPanel.tsx` — mobile overlay mode
- `src/components/layout/RightPanel.tsx` — mobile overlay mode
- `src/components/layout/DocPreview.tsx` — mobile overlay mode
- `src/components/chat/MessageInput.tsx` — permission toggle, touch targets
- `src/lib/db.ts` — add `skip_permissions` column, favorites helpers
- `src/lib/claude-client.ts` — read per-session skip_permissions
- `package.json` — remove Electron deps/scripts, add `server` script
- `next.config.ts` — no changes needed (already standalone)

### Remove
- `electron/` directory
- `electron-builder.yml`
- `src/components/layout/InstallWizard.tsx`
- `src/components/layout/UpdateDialog.tsx`
- `scripts/after-pack.js` (Electron build script)
- `scripts/build-electron.mjs` (Electron build script)
