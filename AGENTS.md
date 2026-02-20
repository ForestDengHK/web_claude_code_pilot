# Repository Guidelines

## Project Structure & Module Organization
- `src/app/`: Next.js App Router pages and API routes (chat, settings, extensions).
- `src/components/`: UI building blocks and feature components grouped by domain.
- `src/lib/`: Core logic (database, Claude client, file helpers, permissions).
- `src/hooks/` and `src/types/`: shared hooks and TypeScript contracts.
- `src/__tests__/`: Playwright e2e specs plus Node test/tsx unit and script tests.
- `public/`: static assets; `scripts/`: build helpers; `docs/`: design notes/plans.

## Build, Test, and Development Commands
- `npm run dev`: starts the Next.js dev server on `http://localhost:3000`.
- `npm run build`: builds the standalone app and prepares server assets.
- `npm run start`: runs the production server (`.next/standalone`).
- `npm run lint`: runs ESLint (required before PRs).
- `npx playwright test`: runs e2e tests in `src/__tests__/e2e` (auto-starts dev server).
- `npx tsx --test src/__tests__/unit/<name>.test.ts`: runs a unit test file.
- `npx tsx src/__tests__/smoke-test.ts`: runs scripted smoke/functional checks.

## Coding Style & Naming Conventions
- TypeScript + React (Next.js App Router). Indentation is 2 spaces.
- Components use `PascalCase` filenames; hooks use `useX` naming.
- Follow ESLint (`eslint.config.mjs`) and existing module boundaries in `src/`.
- Prefer small, focused components; colocate feature UI under `src/components/<area>/`.

## Testing Guidelines
- E2E: Playwright specs in `src/__tests__/e2e/*.spec.ts`.
- Unit: Node test runner via `tsx` in `src/__tests__/unit/*.test.ts`.
- Scripted tests: `src/__tests__/*-test.ts` (smoke/functional/targeted).
- No explicit coverage thresholds; keep tests close to the behavior you change.

## Commit & Pull Request Guidelines
- Commit messages follow a conventional style (`feat:`, `fix:`).
- PRs: keep scope focused, describe changes and rationale, and list test commands run.
- Include screenshots/gifs for UI changes when practical.
- Run `npm run lint` before opening a PR.

## Configuration & Data Notes
- The standalone server loads shell env for keys like `ANTHROPIC_API_KEY`.
- Local data lives in `~/.codepilot/codepilot.db` (override with `CLAUDE_GUI_DATA_DIR`).
- `HOSTNAME` and `PORT` control server binding (default `0.0.0.0:3000`).
