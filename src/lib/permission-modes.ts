import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

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
