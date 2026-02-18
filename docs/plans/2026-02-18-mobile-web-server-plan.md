# Mobile Web Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform CodePilot from an Electron desktop app into a standalone Next.js web server accessible from a phone browser over Tailscale.

**Architecture:** Strip Electron, run Next.js standalone server on `0.0.0.0:3000`. Add mobile-responsive layout with bottom tab bar. Add per-session permission toggle and folder favorites. All existing API routes, SQLite DB, and SDK integration stay unchanged.

**Tech Stack:** Next.js 16 (standalone), React 19, Tailwind CSS 4, better-sqlite3, Claude Agent SDK

**Design doc:** `docs/plans/2026-02-18-mobile-web-server-design.md`

---

## Task 1: Remove Electron — Clean Out Desktop Shell

**Files:**
- Remove: `electron/main.ts`, `electron/preload.ts`
- Remove: `electron-builder.yml`
- Remove: `scripts/after-pack.js`, `scripts/build-electron.mjs`
- Remove: `src/components/layout/InstallWizard.tsx`
- Remove: `src/components/layout/UpdateDialog.tsx`
- Modify: `package.json`
- Modify: `tsconfig.json` (if it references electron/)

**Step 1: Remove Electron directories and files**

```bash
rm -rf electron/
rm -f electron-builder.yml
rm -f scripts/after-pack.js scripts/build-electron.mjs
rm -f src/components/layout/InstallWizard.tsx
rm -f src/components/layout/UpdateDialog.tsx
```

**Step 2: Clean package.json — remove Electron deps and scripts**

In `package.json`:
- Remove from `devDependencies`: `electron`, `electron-builder`, `concurrently`, `wait-on`, `esbuild` (if only used for electron build)
- Remove scripts: `electron:dev`, `electron:build`, `electron:pack`, `electron:pack:mac`, `electron:pack:win`, `electron:pack:linux`
- Remove `"main": "dist-electron/main.js"` field
- Change `"dev"` to: `"HOSTNAME=0.0.0.0 next dev --turbopack"`
- Add `"server"` script: `"node .next/standalone/codepilot-server.js"`

**Step 3: Remove UpdateDialog imports from AppShell**

In `src/components/layout/AppShell.tsx`:
- Remove `import { UpdateDialog } from "./UpdateDialog"`
- Remove `import { UpdateContext, type UpdateInfo } from "@/hooks/useUpdate"`
- Remove all update-related state (`updateInfo`, `checking`, `showDialog`, `checkForUpdates`, `dismissUpdate`)
- Remove `<UpdateContext.Provider>` wrapper
- Remove `<UpdateDialog />`
- Remove `hasUpdate` prop from `<NavRail>`

**Step 4: Remove Electron title bar drag region from AppShell**

In `src/components/layout/AppShell.tsx`:
- Remove the 44px title bar div:
  ```tsx
  <div className="h-11 w-full shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
  ```

**Step 5: Clean NavRail — remove hasUpdate prop**

In `src/components/layout/NavRail.tsx`:
- Remove `hasUpdate` from `NavRailProps` interface
- Remove the update indicator dot (`{item.href === "/settings" && hasUpdate && ...}`)

**Step 6: Remove /api/app/updates route if it exists**

```bash
rm -rf src/app/api/app/
```

**Step 7: Remove useUpdate hook if it exists**

```bash
rm -f src/hooks/useUpdate.ts src/hooks/useUpdate.tsx
```

**Step 8: Run build to verify nothing is broken**

```bash
npm run build
```

Expected: Build succeeds with no import errors.

**Step 9: Commit**

```bash
git add -A && git commit -m "refactor: remove Electron shell and desktop-only features"
```

---

## Task 2: Create Standalone Server Entry Point

**Files:**
- Create: `server.ts`
- Create: `scripts/prepare-server.mjs`
- Modify: `package.json` (add server script)

**Step 1: Create server.ts**

Create `server.ts` at project root — this loads shell env and starts the Next.js standalone server. Uses `execFileSync` (not `exec`) for safe subprocess invocation:

```typescript
const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

function loadUserShellEnv() {
  if (process.platform === 'win32') return {};
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const result = execFileSync(shell, ['-ilc', 'env'], {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const env = {};
    for (const line of result.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        env[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    console.log(`[server] Loaded ${Object.keys(env).length} env vars from user shell`);
    return env;
  } catch (err) {
    console.warn('[server] Failed to load user shell env:', err.message || err);
    return {};
  }
}

const shellEnv = loadUserShellEnv();
Object.assign(process.env, shellEnv);

process.env.HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
process.env.PORT = process.env.PORT || '3000';
process.env.CLAUDE_GUI_DATA_DIR = process.env.CLAUDE_GUI_DATA_DIR
  || path.join(os.homedir(), '.codepilot');

require('./server.js');
```

**Step 2: Create scripts/prepare-server.mjs**

```javascript
import fs from 'fs';
import path from 'path';

const src = path.resolve('server.ts');
const dest = path.resolve('.next/standalone/codepilot-server.js');

const content = fs.readFileSync(src, 'utf-8');
fs.writeFileSync(dest, content);
console.log('[prepare-server] Copied server entry point to .next/standalone/');
```

**Step 3: Update package.json scripts**

```json
{
  "build": "next build && node scripts/prepare-server.mjs",
  "server": "node .next/standalone/codepilot-server.js",
  "start": "npm run server"
}
```

**Step 4: Test the standalone server**

```bash
npm run build
npm run server
```

Expected: Server starts on `0.0.0.0:3000`, accessible from browser.

**Step 5: Commit**

```bash
git add server.ts scripts/prepare-server.mjs package.json
git commit -m "feat: add standalone server entry point with shell env loading"
```

---

## Task 3: Add Viewport Meta Tag and Remove Electron Assumptions

**Files:**
- Modify: `src/app/layout.tsx`

**Step 1: Add viewport meta tag**

In `src/app/layout.tsx`, add Next.js viewport export:

```typescript
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};
```

**Step 2: Update metadata description**

Change `description` from `"A desktop GUI for Claude Code"` to `"A web GUI for Claude Code"`.

**Step 3: Verify on mobile viewport**

```bash
npm run dev
```

Open browser DevTools, toggle device toolbar, check iPhone SE (375px). Page should render at device width.

**Step 4: Commit**

```bash
git add src/app/layout.tsx
git commit -m "feat: add mobile viewport meta tag"
```

---

## Task 4: Create Mobile Bottom Navigation Bar

**Files:**
- Create: `src/components/layout/BottomNav.tsx`
- Modify: `src/components/layout/AppShell.tsx`
- Modify: `src/components/layout/NavRail.tsx`

**Step 1: Create BottomNav component**

Create `src/components/layout/BottomNav.tsx` — a fixed bottom tab bar visible only on mobile (`md:hidden`). Contains same nav items as NavRail (Chats, Extensions, Settings) plus theme toggle. Uses existing HugeiconsIcon components and cn() utility. Min 44px touch targets.

**Step 2: Hide NavRail on mobile**

In `src/components/layout/NavRail.tsx`, change outer `<aside>` className:
- Add `hidden md:flex` prefix (hidden below 768px, visible above)

**Step 3: Add BottomNav to AppShell and bottom padding**

In `src/components/layout/AppShell.tsx`:
- Import and render `<BottomNav>` as sibling of main flex container
- Add `pb-14 md:pb-0` to main content area for mobile bottom spacing

**Step 4: Verify mobile layout**

At 375px: bottom nav visible, left NavRail hidden. At 768px+: NavRail visible, bottom nav hidden.

**Step 5: Commit**

```bash
git add src/components/layout/BottomNav.tsx src/components/layout/NavRail.tsx src/components/layout/AppShell.tsx
git commit -m "feat: add mobile bottom navigation bar"
```

---

## Task 5: Make ChatListPanel a Mobile Overlay

**Files:**
- Modify: `src/components/layout/ChatListPanel.tsx`
- Modify: `src/components/layout/AppShell.tsx`

**Step 1: Read current ChatListPanel implementation**

Read `src/components/layout/ChatListPanel.tsx` to understand current structure.

**Step 2: Add mobile overlay mode**

Wrap ChatListPanel so on mobile (`< md`), it renders as `fixed inset-0 z-50 bg-background` with a close button and backdrop overlay. On desktop, keep current side panel behavior but use `md:` breakpoint.

**Step 3: Update AppShell to pass close handler**

Pass `onClose={() => setChatListOpen(false)}` to ChatListPanel.

**Step 4: Test mobile overlay**

At 375px: tap Chats → full-screen session list. Tap session → navigates and closes.

**Step 5: Commit**

```bash
git add src/components/layout/ChatListPanel.tsx src/components/layout/AppShell.tsx
git commit -m "feat: make chat list panel a full-screen overlay on mobile"
```

---

## Task 6: Make RightPanel and DocPreview Mobile Overlays

**Files:**
- Modify: `src/components/layout/RightPanel.tsx`
- Modify: `src/components/layout/DocPreview.tsx`
- Modify: `src/components/layout/AppShell.tsx`

**Step 1: Read current implementations**

Read `src/components/layout/RightPanel.tsx` and `DocPreview.tsx`.

**Step 2: RightPanel — mobile overlay**

On mobile: `fixed inset-0 z-50` overlay with close button. On desktop: current side panel with `md:` breakpoint.

**Step 3: DocPreview — mobile overlay**

Same pattern: full-screen overlay on mobile, side panel on desktop.

**Step 4: Hide ResizeHandle on mobile**

In AppShell, add `hidden md:block` to all `<ResizeHandle>` components.

**Step 5: Test at multiple viewports**

375px: panels as full-screen overlays. 768px+: panels as side panels.

**Step 6: Commit**

```bash
git add src/components/layout/RightPanel.tsx src/components/layout/DocPreview.tsx src/components/layout/AppShell.tsx
git commit -m "feat: make right panel and doc preview mobile overlays"
```

---

## Task 7: Mobile-Optimize MessageInput

**Files:**
- Modify: `src/components/chat/MessageInput.tsx`
- Modify: `src/app/globals.css`

**Step 1: Increase touch targets**

Add `min-h-[44px] min-w-[44px]` to PromptInputButton instances on mobile viewport.

**Step 2: Mobile-friendly popovers**

Mode/model selector popover menus: use `w-full` on mobile, existing width on `md:`.

**Step 3: Dynamic viewport height for keyboard**

In `globals.css`, add:
```css
@supports (height: 100dvh) {
  .h-screen { height: 100dvh; }
}
```

**Step 4: Test on mobile viewport**

Verify input stays visible when typing, buttons are easy to tap.

**Step 5: Commit**

```bash
git add src/components/chat/MessageInput.tsx src/app/globals.css
git commit -m "feat: optimize message input for mobile touch targets"
```

---

## Task 8: Per-Session Permission Toggle

**Files:**
- Modify: `src/lib/db.ts` — migration + helpers
- Modify: `src/types/index.ts` — update ChatSession type
- Modify: `src/app/api/chat/sessions/[id]/route.ts` — PATCH support
- Modify: `src/app/api/chat/route.ts` — read session setting
- Modify: `src/lib/claude-client.ts` — accept per-session option
- Modify: `src/components/chat/MessageInput.tsx` — toggle UI

**Step 1: Add migration in db.ts migrateDb()**

```typescript
if (!colNames.includes('skip_permissions')) {
  db.exec("ALTER TABLE chat_sessions ADD COLUMN skip_permissions INTEGER NOT NULL DEFAULT 0");
}
```

Add helper: `updateSessionSkipPermissions(id, skip: boolean)`.

**Step 2: Update ChatSession type**

Add `skip_permissions?: number` to ChatSession in `src/types/index.ts`.

**Step 3: Update PATCH /api/chat/sessions/[id]**

Accept `skip_permissions` in request body, call `updateSessionSkipPermissions`.

**Step 4: Update POST /api/chat**

Read `session.skip_permissions` and pass `skipPermissions: session.skip_permissions === 1` to `streamClaude`.

**Step 5: Update claude-client.ts**

Add `skipPermissions?: boolean` to `ClaudeStreamOptions`. Use it:
```typescript
const skipPermissions = options.skipPermissions ?? (getSetting('dangerously_skip_permissions') === 'true');
```

**Step 6: Add toggle UI in MessageInput toolbar**

Shield/lock icon button. Orange pulsing dot when active. Calls `PATCH /api/chat/sessions/{id}` on toggle.

**Step 7: Test**

Toggle ON → no permission prompts. Toggle OFF → prompts appear.

**Step 8: Commit**

```bash
git add src/lib/db.ts src/types/index.ts src/app/api/chat/ src/lib/claude-client.ts src/components/chat/MessageInput.tsx
git commit -m "feat: add per-session permission toggle"
```

---

## Task 9: Folder Favorites API

**Files:**
- Modify: `src/lib/db.ts` — add favorites helpers
- Create: `src/app/api/favorites/route.ts`

**Step 1: Add favorites helpers to db.ts**

```typescript
export function getFavoriteDirectories(): Array<{ path: string; name: string }> { ... }
export function addFavoriteDirectory(dirPath: string, name: string): void { ... }
export function removeFavoriteDirectory(dirPath: string): void { ... }
export function getRecentDirectories(limit = 5): string[] { ... }
```

Uses `settings` table with key `favorite_directories` (JSON array).

**Step 2: Create favorites API route**

`src/app/api/favorites/route.ts`: GET returns favorites + recent, POST adds, DELETE removes.

**Step 3: Test API**

```bash
curl http://localhost:3000/api/favorites
```

**Step 4: Commit**

```bash
git add src/app/api/favorites/route.ts src/lib/db.ts
git commit -m "feat: add favorites and recent directories API"
```

---

## Task 10: Folder Selection UI with Favorites and Recent

**Files:**
- Modify: `src/app/chat/page.tsx`
- Modify: `src/components/chat/FolderPicker.tsx`

**Step 1: Read current new chat page**

Read `src/app/chat/page.tsx` to understand current folder selection flow.

**Step 2: Add favorites/recent section**

On new chat page, fetch `GET /api/favorites` on mount. Show Favorites section (starred dirs, one-tap), Recent section (last 5), and Browse button for full picker.

**Step 3: Add star button**

Star icon on each directory row: filled = favorite (tap to remove), empty = not favorite (tap to add).

**Step 4: Mobile layout**

Full-width with min 48px row height for touch.

**Step 5: Verify flow**

New chat → favorites + recent visible → tap to select → chat starts.

**Step 6: Commit**

```bash
git add src/app/chat/page.tsx src/components/chat/FolderPicker.tsx
git commit -m "feat: add favorites and recent directories to folder selection"
```

---

## Task 11: Update E2E Tests for New Layout

**Files:**
- Modify: `src/__tests__/helpers.ts`
- Modify: `src/__tests__/e2e/layout.spec.ts`

**Step 1: Update test helpers**

Add `bottomNav()` locator. Update `sidebar()` and `sidebarToggle()` for new structure.

**Step 2: Update mobile responsive tests**

Test bottom nav visible at 375px, NavRail hidden, chat list as overlay, navigation via bottom tabs.

**Step 3: Run tests**

```bash
npx playwright test src/__tests__/e2e/layout.spec.ts
```

**Step 4: Commit**

```bash
git add src/__tests__/
git commit -m "test: update e2e tests for mobile-responsive layout"
```

---

## Task 12: Dev and Production Startup Verification

**Step 1: Test dev mode**

```bash
npm run dev
```

Verify: accessible on `localhost:3000` and via Tailscale IP from phone.

**Step 2: Test production build**

```bash
npm run build && npm run server
```

Verify: server on `0.0.0.0:3000`, mobile layout, session creation, streaming, permission toggle.

**Step 3: Final fixes commit if needed**

---

## Execution Order

| Task | Description | Dependencies |
|------|-------------|--------------|
| 1 | Remove Electron | None |
| 2 | Standalone server | Task 1 |
| 3 | Viewport meta | Task 1 |
| 4 | Bottom nav bar | Task 3 |
| 5 | ChatListPanel overlay | Task 4 |
| 6 | RightPanel/DocPreview overlay | Task 4 |
| 7 | MessageInput mobile | Task 4 |
| 8 | Permission toggle | Task 1 |
| 9 | Favorites API | Task 1 |
| 10 | Folder selection UI | Task 9 |
| 11 | Update E2E tests | Tasks 4-7 |
| 12 | Full verification | All |

Tasks 3-7 (UI) and 8-10 (features) can be parallelized after Tasks 1+2.
