# CodePilot (Web Claude Code Pilot) — AGENTS.md

Concise, high-signal instructions for AI-assisted development in this repo.

## Tech Stack
- Next.js App Router (standalone output), React, TypeScript
- UI: Radix UI + shadcn/ui; styling: Tailwind CSS v4; animation: Motion
- AI: `@anthropic-ai/claude-agent-sdk` (Claude Code CLI on `PATH` is expected)
- DB: SQLite via `better-sqlite3`
- Streaming: Server-Sent Events (SSE)
- Tests: Playwright (`src/__tests__/e2e`), TS/Node tests via `tsx`

## Project Structure
- `src/app/`: App Router routes + API routes (chat, settings, extensions/plugins, bridge)
- `src/components/`: feature UI by domain (chat/layout/project/settings/skills/bridge/plugins)
- `src/lib/`: core logic (db, claude client, bridge, permissions, helpers)
- `src/hooks/`, `src/types/`: shared hooks/contracts
- `src/__tests__/`: e2e + unit + targeted/smoke scripts
- `docs/`: architecture notes (notably bridge); `scripts/`: build helpers; `public/`: assets
- `.worktrees/`: local git worktrees (do not lint/build against generated artifacts here)

## Key Architecture Decisions
- Standalone server build: `next.config.mjs` sets `output: 'standalone'` and externalizes `better-sqlite3`.
- Versioning: `NEXT_PUBLIC_APP_VERSION` is injected from `package.json` at build time.
- Data directory: defaults to `~/.codepilot/` (DB at `~/.codepilot/codepilot.db`), override with `CLAUDE_GUI_DATA_DIR`.
- Claude integration is mediated via `src/lib/claude-client.ts`; prefer adding behavior there over sprinkling SDK calls.
- Bridge subsystem lives under `src/lib/bridge/**` and has its own adapters + markdown handling.

## Commands (local)
- Dev server: `npm run dev` (default binds `0.0.0.0:3000`)
- Lint: `npm run lint`
- Typecheck (recommended): `npx tsc -p tsconfig.json --noEmit`
- Build (standalone): `npm run build` then `npm run start` or `node .next/standalone/codepilot-server.js`
- E2E: `npx playwright test`
- Unit test (single): `npx tsx --test src/__tests__/unit/<name>.test.ts`
- Smoke scripts: `node --import tsx src/__tests__/smoke-test.ts` (preferred over `npx tsx` in restricted sandboxes)

## Env / Config
- Required for real usage: Claude Code CLI installed + authenticated (`claude login`).
- Common env vars: `ANTHROPIC_API_KEY`, `CLAUDE_GUI_DATA_DIR`, `HOSTNAME`, `PORT`.
- Local overrides: `.env.local`.

## Coding Conventions
- TypeScript, React, 2-space indentation; keep components small and domain-scoped.
- Prefer colocating feature UI under `src/components/<area>/`.
- Hooks: `useX` naming; components: `PascalCase` filenames.
- Follow existing patterns for streaming + persistence (DB-backed stream recovery).

## Gotchas / Footguns
- `next.config.mjs` sets `typescript.ignoreBuildErrors: true`; do not rely on `next build` alone for type safety—run `npx tsc`.
- `next/font/google` fetches fonts at build time; offline/network-restricted environments can fail builds.
- Lint/build output under `.next/**` and worktrees under `.worktrees/**` should be treated as generated; avoid expanding tooling scope to those paths.
  - If `npm run lint` appears to lint generated files, scope it (e.g. `npx eslint src`) or add appropriate ignores in `eslint.config.mjs`.

## Ops (macOS service)
- See `OPERATIONS.md` for launchd + Caddy setup, restart commands, and when to clear `.next`.
