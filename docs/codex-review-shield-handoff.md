# Codex Review + Shield Workstream Handoff

Last updated: 2026-04-06
Repo: `CodePilot`
Branch: `main`

## Goal

Improve the Codex-specific workflow in the web app without polluting the Claude path.

This workstream focused on two practical areas:

1. Make the existing shield toggle actually map to Codex backend approval semantics.
2. Build a Codex-only review workflow that is useful in the web UI, including structured findings and file navigation.

## What Has Been Completed

### 1. Codex shield semantics are now real backend behavior

The existing shield UI was kept unchanged, but Codex requests now actually consume `skip_permissions` on the backend path.

Completed:
- Pass `skip_permissions` from session state into the Codex chat request.
- Read Codex configured approval policy when available.
- Map shield on to `approvalPolicy: 'never'`.
- Fix the one-way reset problem: if a thread had previously been forced to `never`, turning shield off now restores prompting via `on-request` when needed.

Key files:
- `src/app/api/codex/chat/route.ts`
- `src/lib/codex-client.ts`

### 2. Codex-only review API and UI were added

Completed:
- New route: `POST /api/codex/review`
- New dialog: `CodexReviewDialog`
- Review results now include structured findings, not just markdown text.
- Findings are clickable and can open the existing file preview panel.
- File preview supports jumping to and highlighting a target line.

Key files:
- `src/app/api/codex/review/route.ts`
- `src/components/chat/CodexReviewDialog.tsx`
- `src/lib/codex-client.ts`
- `src/hooks/usePanel.ts`
- `src/components/layout/AppShell.tsx`
- `src/components/layout/RightPanel.tsx`
- `src/components/layout/DocPreview.tsx`
- `src/types/index.ts`

### 3. Review execution no longer blocks the main Codex chat process

Completed:
- Review runs on a separate Codex worker process derived from the main session id.
- Review no longer appends hidden context into the main chat thread.
- Review timeout was increased from 180s to 10m.
- Review handles interruption / replacement / empty-output cases more explicitly.
- Compatibility with older Codex CLIs that only emit `thread/started` notifications was restored.

Key files:
- `src/lib/codex-client.ts`
- `src/lib/codex-review-registry.ts`

### 4. Review deduping exists on the server

Completed:
- Same-session duplicate review requests are deduped server-side.
- If two requests hit `/api/codex/review` concurrently for the same `sessionId`, they reuse the same in-flight promise instead of starting two review runs.

Key files:
- `src/lib/codex-review-registry.ts`
- `src/app/api/codex/review/route.ts`

### 5. Review UI behavior improved

Completed:
- Mobile review entry moved out of the crowded control row.
- Desktop keeps the compact icon entry.
- The dialog shows elapsed time while running.
- Closing the dialog no longer drops the latest review result.
- Reopening the dialog shows the cached latest result.
- A manual `Run New Review` action was added.
- A review timestamp is shown so users can tell whether they are looking at an older run.

Key files:
- `src/components/chat/MessageInput.tsx`
- `src/components/chat/CodexReviewDialog.tsx`

### 6. Review dialog visual layout was improved

Completed:
- Wider desktop dialog.
- Two-column layout only on larger screens.
- Single-column layout retained on mobile / smaller screens.
- Left column cards no longer depend on horizontal truncation to be readable.
- Right side is now explicitly a detail panel plus summary area.
- Typography hierarchy improved for title / path / body / summary.

Key file:
- `src/components/chat/CodexReviewDialog.tsx`

## Current Known Behavior / Constraints

### Good / intentional behavior

- Concurrent review clicks on the same `sessionId` usually do **not** create two backend review runs.
- Desktop and mobile can both open the same review dialog independently.
- Review results are cached per browser tab for the current session.
- Large desktop review workspace is now easier to read.
- Mobile remains single-column by design.

### Important current limitation

The review running state and the last completed review are **not yet shared across browsers/devices**.

What this means:
- If mobile starts a review and desktop opens the same session, desktop may not automatically show the spinner unless it initiated the request itself.
- If one browser already has a completed review cached locally, the other browser does not know about that result yet.
- If browser A completed a review earlier and browser B later presses review, browser B may start a new review because the cached result is only local UI state, not server-backed session state.

This is the main next architectural gap.

## Best Next Steps

Recommended order:

### Next 1. Move review state from local UI cache to backend session-level state

This is the highest-value next change.

Desired outcome:
- backend stores `running / completed / failed`
- backend stores latest review result + reviewedAt timestamp
- all browsers for the same session read the same review state
- mobile and desktop both show the same spinner / last result / re-run controls

Likely implementation shape:
- add a small Codex review session state store on the server
- expose `GET /api/codex/review?session_id=...` or equivalent status route
- make dialog initialize from backend state instead of local-only `Map`

### Next 2. Add stale detection

After a review completes, if the working tree changes, show something like:
- `Workspace changed since last review`

This will make multi-round review much easier to understand.

### Next 3. Mobile-specific review UX refinement

Current mobile choice is intentionally single-column.

Still worth doing:
- tabs for `Finding` vs `Summary`
- or summary collapsed by default on small screens

### Next 4. Optional design polish

Potential polish items:
- split selected finding path into `filename + directory`
- better visual severity encoding for `P1/P2/P3`
- stronger distinction between selected-finding detail and summary area

## Validation Already Performed

Completed validations during this workstream:
- shield toggle behavior checked on Codex path
- server-side deduping confirmed for concurrent review requests
- review can run while main Codex chat still responds on the same session id path
- targeted lint checks run on touched files
- targeted type checks run for touched areas
- browser checks run for mobile review button placement and general review UI behavior

Caveat:
- full cross-browser synchronized review state was **not** implemented yet, so multi-device UX is still partially local-state-driven

## Files Touched In This Workstream

Core behavior:
- `src/lib/codex-client.ts`
- `src/app/api/codex/chat/route.ts`
- `src/app/api/codex/review/route.ts`
- `src/lib/codex-review-registry.ts`
- `src/types/index.ts`

Review UI:
- `src/components/chat/MessageInput.tsx`
- `src/components/chat/CodexReviewDialog.tsx`

File preview integration:
- `src/hooks/usePanel.ts`
- `src/components/layout/AppShell.tsx`
- `src/components/layout/RightPanel.tsx`
- `src/components/layout/DocPreview.tsx`

## Commit Scope Intention

This handoff is intended to represent the Codex review / shield workstream only.

If the git worktree contains unrelated dependency version bumps or other unrelated changes, do not assume they are required for this feature unless separately reviewed.

## Restart Prompt For A Future Session

Use this exact framing in a new session:

> Continue the Codex review + shield workstream from `docs/codex-review-shield-handoff.md`.
> First read that file, then inspect the current implementation in:
> - `src/lib/codex-client.ts`
> - `src/app/api/codex/review/route.ts`
> - `src/components/chat/CodexReviewDialog.tsx`
> - `src/components/chat/MessageInput.tsx`
> Focus next on backend-shared review state across browsers/devices.

