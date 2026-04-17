import { execFileSync } from 'node:child_process';

type Probe = () => string;

const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { value: boolean; at: number } | null = null;

const defaultProbe: Probe = () =>
  execFileSync('which', ['codex'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();

/**
 * Returns true when the `codex` binary is on PATH. Cached for 5 minutes
 * per-process to avoid repeated shell-outs. `probe` is injectable for
 * tests; production callers should omit it.
 */
export function isCodexAvailable(probe: Probe = defaultProbe): boolean {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  let value: boolean;
  try {
    const out = probe();
    value = typeof out === 'string' && out.trim().length > 0;
  } catch {
    value = false;
  }
  cached = { value, at: Date.now() };
  return value;
}

/** Test-only helper. Do not call from production code. */
export function __resetCodexAvailabilityCache(): void {
  cached = null;
}
