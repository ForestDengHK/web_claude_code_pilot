/**
 * Resolves — and self-heals — the `codex` executable used to spawn
 * `codex app-server`.
 *
 * Background: on macOS the *installed* codex binary's inode can fall into a
 * launch-validation state where every spawn hangs in dyld before `main()`
 * (see the project memory note `codex-models-dyld-hang`). The binary content
 * is fine — an identical fresh-inode copy launches normally. So when codex
 * appears hung, we copy the real binary to a CodePilot-managed path (fresh
 * inode), verify it launches, and spawn from that copy thereafter. If the copy
 * itself can't be made to launch, we kick off a `brew reinstall` in the
 * background as a last resort.
 *
 * `getCodexExecutable()` is the single source of truth for "which codex binary
 * do we spawn"; `codex-process-manager` calls it instead of hardcoding 'codex'.
 */

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// globalThis-backed state (survives Next.js dev module reloads)
// ---------------------------------------------------------------------------

interface BinaryState {
  /** A verified fresh-inode copy to spawn from, or null to use PATH `codex`. */
  healedPath: string | null;
  /** Timestamp of the last repair attempt (cooldown gate). */
  lastRepairAt: number;
}

const globalKey = '__codexBinaryState__' as const;

function state(): BinaryState {
  const g = globalThis as Record<string, unknown>;
  if (!g[globalKey]) {
    g[globalKey] = { healedPath: null, lastRepairAt: 0 } satisfies BinaryState;
  }
  return g[globalKey] as BinaryState;
}

/** Don't re-attempt repair more than once per minute (copy is ~189 MB). */
const REPAIR_COOLDOWN_MS = 60_000;

function dataDir(): string {
  return process.env.CLAUDE_GUI_DATA_DIR || path.join(os.homedir(), '.codepilot');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The codex executable to spawn. Returns a healed fresh-inode copy once one has
 * been created and verified; otherwise the plain `codex` on PATH.
 */
export function getCodexExecutable(existsSync: (p: string) => boolean = fs.existsSync): string {
  const s = state();
  if (s.healedPath && existsSync(s.healedPath)) return s.healedPath;
  return 'codex';
}

export interface RepairResult {
  repaired: boolean;
  method?: 'copy' | 'reinstall';
  error?: string;
}

/** Injectable side-effects so the policy (cooldown/branching) is unit-testable. */
export interface RepairDeps {
  now: () => number;
  /** Real, symlink-resolved path of `codex` on PATH, or null if not found. */
  resolveRealCodex: () => string | null;
  /** Copy `real` to a fresh-inode managed path and return that path (throws on failure). */
  freshCopy: (real: string) => string;
  /** Launch `<bin> --version` and resolve true if it runs promptly. */
  verifyLaunch: (bin: string) => Promise<boolean>;
  /** Kick off a background `brew reinstall --cask codex`. */
  startReinstall: () => void;
}

/**
 * Attempt to heal a hung codex binary. Primary path: fresh-inode copy + verify.
 * Fallback: background brew reinstall. Rate-limited by REPAIR_COOLDOWN_MS.
 */
export async function repairCodexBinary(deps: Partial<RepairDeps> = {}): Promise<RepairResult> {
  const d: RepairDeps = {
    now: Date.now,
    resolveRealCodex: defaultResolveRealCodex,
    freshCopy: defaultFreshCopy,
    verifyLaunch: defaultVerifyLaunch,
    startReinstall: defaultStartReinstall,
    ...deps,
  };

  const s = state();
  if (d.now() - s.lastRepairAt < REPAIR_COOLDOWN_MS) {
    return { repaired: false, error: 'cooldown' };
  }
  s.lastRepairAt = d.now();

  const real = d.resolveRealCodex();
  if (!real) return { repaired: false, error: 'codex not found on PATH' };

  // Primary: fresh-inode copy.
  try {
    const copy = d.freshCopy(real);
    if (await d.verifyLaunch(copy)) {
      s.healedPath = copy;
      return { repaired: true, method: 'copy' };
    }
  } catch {
    // fall through to reinstall
  }

  // Fallback: the copy couldn't be made healthy — reinstall in the background
  // and revert to PATH so the next attempt picks up the fresh install.
  s.healedPath = null;
  try {
    d.startReinstall();
    return { repaired: false, method: 'reinstall', error: 'reinstall started in background' };
  } catch (e) {
    return { repaired: false, error: e instanceof Error ? e.message : 'repair failed' };
  }
}

/** Test-only: reset healed path + cooldown. */
export function __resetCodexBinaryState(): void {
  const s = state();
  s.healedPath = null;
  s.lastRepairAt = 0;
}

// ---------------------------------------------------------------------------
// Default side-effect implementations
// ---------------------------------------------------------------------------

function defaultResolveRealCodex(): string | null {
  try {
    const which = execFileSync('which', ['codex'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (!which) return null;
    return fs.realpathSync(which);
  } catch {
    return null;
  }
}

function defaultFreshCopy(real: string): string {
  const destDir = path.join(dataDir(), 'codex-bin');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'codex');
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.copyFileSync(real, tmp); // fresh inode
  try {
    execFileSync('xattr', ['-c', tmp], { stdio: 'ignore' }); // strip quarantine/provenance
  } catch {
    // xattr is best-effort; not fatal
  }
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest); // atomic swap into place
  return dest;
}

function defaultVerifyLaunch(bin: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, proc?: ReturnType<typeof spawn>) => {
      if (settled) return;
      settled = true;
      try {
        proc?.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve(ok);
    };
    try {
      const proc = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      proc.stdout?.on('data', (chunk) => {
        out += chunk;
      });
      const timer = setTimeout(() => finish(false, proc), timeoutMs);
      proc.on('exit', () => {
        clearTimeout(timer);
        finish(out.trim().length > 0);
      });
      proc.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
    } catch {
      finish(false);
    }
  });
}

function defaultStartReinstall(): void {
  const child = spawn('brew', ['reinstall', '--cask', 'codex'], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' },
  });
  child.unref();
}
