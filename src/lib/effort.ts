import type { Options } from '@anthropic-ai/claude-agent-sdk';

/**
 * Sanity-check an effort level string before forwarding it to the Claude
 * Agent SDK.
 *
 * Design: the set of valid effort levels is owned by the SDK / Claude Code
 * CLI at runtime (reported via `query().supportedModels()` →
 * `supportedEffortLevels`) and is the single source of truth consumed by the
 * UI. Server-side we deliberately do NOT keep a literal whitelist — that
 * caused `xhigh` (Opus 4.7) to be silently dropped when the SDK added it,
 * and would drop any future level the same way.
 *
 * We only guard against obviously malformed input (non-strings, absurd
 * lengths, suspicious characters). Anything that looks like a plausible
 * identifier is trusted and passed through; an unknown value is rejected by
 * the SDK itself with a clear error, which is far better than silently
 * falling back to the CLI default.
 *
 * Returns a properly typed `EffortLevel` when acceptable, else `undefined`.
 */
export function sanitizeEffortLevel(
  effort: unknown,
): Options['effort'] | undefined {
  if (typeof effort !== 'string') return undefined;
  const trimmed = effort.trim();
  if (!trimmed) return undefined;
  // All known levels fit `/^[a-z]{1,16}$/`: low, medium, high, xhigh, max.
  // Future additions (e.g. `ultra`, `deep`) will also match without changes.
  if (!/^[a-z]{1,16}$/.test(trimmed)) return undefined;
  return trimmed as Options['effort'];
}
