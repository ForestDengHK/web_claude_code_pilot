import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { AskForApproval } from '@/types/codex/AskForApproval';

/**
 * Permission modes exposed in the chat UI as stable "working modes".
 *
 * These use the SDK's native names on purpose (`acceptEdits`, `plan`, `auto`)
 * instead of CodePilot-specific aliases like `'code'`. Rationale:
 *   - Keeps our vocabulary aligned with Claude Code docs / release notes.
 *   - Removes a translation layer that previously silently dropped any new
 *     SDK mode (the same failure mode that caused `xhigh` effort to be
 *     swallowed until `effort.ts` was rewritten).
 *   - `satisfies` lets TypeScript verify we only list real SDK modes, so if
 *     the SDK ever renames/removes one, the build breaks here instead of
 *     failing silently at runtime.
 *
 * We deliberately exclude:
 *   - `'bypassPermissions'` — reachable via the dedicated shield toggle
 *     (`skip_permissions`), which is orthogonal to the working mode. Keeping
 *     it out of the dropdown preserves the "danger indicator" UX.
 *   - `'default'` — would prompt on dangerous ops, but the web UI has no
 *     interactive permission prompt, so selecting it would just stall.
 *   - `'dontAsk'` — denies anything not pre-approved, and we don't surface
 *     a pre-approval UI, so it would be unusable.
 */
export const CLAUDE_UI_PERMISSION_MODES = [
  'plan',
  'acceptEdits',
  'auto',
] as const satisfies readonly PermissionMode[];

export type ClaudeUiPermissionMode =
  (typeof CLAUDE_UI_PERMISSION_MODES)[number];

/** Default mode for a new chat session. */
export const DEFAULT_CLAUDE_UI_MODE: ClaudeUiPermissionMode = 'acceptEdits';

/**
 * Normalize a persisted / user-supplied mode value to a current-vocabulary
 * mode. Handles:
 *   - Legacy values from older DBs: `'code'` → `'acceptEdits'`,
 *     `'ask'` → `'acceptEdits'` (the bridge-only `'ask'` never had a real
 *     mapping in the main chat path, so we fall back to the default).
 *   - `undefined` / unknown strings → `DEFAULT_CLAUDE_UI_MODE`.
 *   - Current valid values are returned unchanged.
 *
 * The output is guaranteed to be a valid `ClaudeUiPermissionMode`, safe to
 * pass to the SDK as `permissionMode`.
 */
export function normalizeClaudeMode(
  raw: string | null | undefined,
): ClaudeUiPermissionMode {
  if (raw === 'code') return 'acceptEdits';
  if (raw === 'ask') return DEFAULT_CLAUDE_UI_MODE;
  if (
    raw === 'plan' ||
    raw === 'acceptEdits' ||
    raw === 'auto'
  ) {
    return raw;
  }
  return DEFAULT_CLAUDE_UI_MODE;
}

/** Human-readable label for UI rendering. */
export function claudeModeLabel(mode: ClaudeUiPermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'Plan';
    case 'acceptEdits':
      return 'Accept Edits';
    case 'auto':
      return 'Auto';
  }
}

/** Short description for tooltips / dropdown captions. */
export function claudeModeDescription(mode: ClaudeUiPermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'Plan first, no tool execution';
    case 'acceptEdits':
      return 'Read, write files & run commands';
    case 'auto':
      return 'Model classifier approves safe tools automatically';
  }
}

// ---------------------------------------------------------------------------
// Codex working modes — mirror Claude's design on the Codex side.
// ---------------------------------------------------------------------------

/**
 * Codex-side "working modes" — subset of `AskForApproval` exposed in the UI.
 *
 * Same split philosophy as the Claude modes:
 *   - `never` is excluded — the shield toggle owns that danger override
 *     (combined with `sandbox=danger-full-access`).
 *   - The remaining three are legitimate "how often should Codex interrupt
 *     me" settings and correspond 1:1 to the Codex CLI's `approval_policy`.
 *
 * `satisfies` locks the list to real SDK values so a rename/removal in
 * `AskForApproval` will fail the build here instead of silently at runtime.
 */
export const CODEX_UI_PERMISSION_MODES = [
  'untrusted',
  'on-failure',
  'on-request',
] as const satisfies readonly AskForApproval[];

export type CodexUiPermissionMode =
  (typeof CODEX_UI_PERMISSION_MODES)[number];

/**
 * Default Codex mode for a new chat session or when switching backend from
 * Claude to Codex. `on-failure` mirrors Claude's `acceptEdits` spirit:
 * "do work, ask only when something goes wrong."
 */
export const DEFAULT_CODEX_UI_MODE: CodexUiPermissionMode = 'on-failure';

/**
 * Normalize a persisted / user-supplied mode value to a valid Codex mode.
 * Unknown values (including Claude-side modes like `'acceptEdits'` left over
 * from a backend switch) fall back to `DEFAULT_CODEX_UI_MODE`.
 *
 * We deliberately do NOT attempt semantic cross-mapping (Claude `plan` →
 * Codex `untrusted`, etc.). Hard-coded translation tables rot whenever
 * either SDK changes its vocabulary — the user can re-select after
 * switching backends.
 */
export function normalizeCodexMode(
  raw: string | null | undefined,
): CodexUiPermissionMode {
  if (
    raw === 'untrusted' ||
    raw === 'on-failure' ||
    raw === 'on-request'
  ) {
    return raw;
  }
  return DEFAULT_CODEX_UI_MODE;
}

/** Human-readable label for UI rendering. */
export function codexModeLabel(mode: CodexUiPermissionMode): string {
  switch (mode) {
    case 'untrusted':
      return 'Ask';
    case 'on-failure':
      return 'On Failure';
    case 'on-request':
      return 'On Request';
  }
}

/**
 * Backend-aware normalizer. Use this at any UI boundary where the backend
 * is known — avoids calling the wrong normalizer after a backend switch.
 */
export function normalizeModeForBackend(
  raw: string | null | undefined,
  backend: 'claude' | 'codex' | 'channels',
): string {
  return backend === 'codex'
    ? normalizeCodexMode(raw)
    : normalizeClaudeMode(raw);
}
