import net from 'node:net';
import path from 'node:path';
import * as pty from 'node-pty';
import { findClaudeBinary } from '../platform';
import { sanitizeEffortLevel } from '../effort';

const MCP_SERVER_PATH = path.join(process.cwd(), 'scripts', 'channels-mcp-server.mjs');

export interface ChannelSession {
  codepilotSessionId: string;
  claudeSessionId: string;   // the --session-id we assigned; also the .jsonl filename
  channelPort: number;       // channel MCP server HTTP port
  cwd: string;
  proc: pty.IPty;
  state: 'starting' | 'ready' | 'exited';
  lastUsedAt: number;
  // Config baked in at spawn time. All of these are CLI flags or part of the
  // --mcp-config payload, so a change requires respawning the process (see
  // ensureSession).
  spawnedMode?: string;
  spawnedSystemPrompt?: string;
  spawnedEffort?: string;
  spawnedSkipPermissions?: boolean;
  spawnedPluginPathsKey?: string;  // serialized so we can equality-compare cheaply
  spawnedMcpConfigKey?: string;
}

/** Valid values for `claude --permission-mode`. */
const VALID_PERMISSION_MODES = new Set([
  'acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan',
]);

const KEY = '__codepilot_channel_sessions__';
function registry(): Map<string, ChannelSession> {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY] as Map<string, ChannelSession>;
}

export async function allocatePort(): Promise<number> {
  // TOCTOU: we bind to :0, read the assigned port, close the server, then hand
  // the port to a child process. There is an inherent race window where another
  // process could claim the port before the child binds it. Acceptable here.
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export interface SpawnArgsInput {
  claudeSessionId: string;
  mcpConfigJson: string;
  model?: string;
  resume?: boolean;
  /** Permission mode; ignored unless it is a valid `--permission-mode` value. */
  mode?: string;
  /** Extra system prompt appended to the default one. */
  systemPrompt?: string;
  /**
   * Reasoning effort level (low / medium / high / xhigh / max). Validated by
   * `sanitizeEffortLevel`; invalid values are dropped so the CLI uses its
   * model default instead of erroring out.
   */
  effort?: string;
  /**
   * When true, append `--dangerously-skip-permissions`. Mirrors the T2 SDK's
   * `bypassPermissions` mode toggled by the UI's shield button.
   */
  skipPermissions?: boolean;
  /**
   * Absolute paths to enabled Claude Code plugins, one `--plugin-dir` per
   * entry. Caller is responsible for symlink correction (use
   * `loadEnabledPluginPaths` from `claude-config-loader`).
   */
  pluginPaths?: string[];
}

/** Pure, testable: construct the claude CLI argv. */
export function buildSpawnArgs(input: SpawnArgsInput): string[] {
  // `--session-id` starts a new session; `--resume` continues an existing one.
  // claude rejects both together ("--session-id can only be used with
  // --continue or --resume if --fork-session is also specified") and exits 1,
  // so pick exactly one. --resume keeps writing to the same transcript file.
  const args = input.resume
    ? ['--resume', input.claudeSessionId]
    : ['--session-id', input.claudeSessionId];
  args.push(
    '--mcp-config', input.mcpConfigJson,
    '--dangerously-load-development-channels', 'server:codepilot',
    '--allowedTools', 'mcp__codepilot__reply',
  );
  if (input.model) args.push('--model', input.model);
  if (input.mode && VALID_PERMISSION_MODES.has(input.mode)) {
    args.push('--permission-mode', input.mode);
  }
  if (input.systemPrompt) args.push('--append-system-prompt', input.systemPrompt);
  const sanitizedEffort = sanitizeEffortLevel(input.effort);
  if (sanitizedEffort) args.push('--effort', sanitizedEffort);
  if (input.skipPermissions) args.push('--dangerously-skip-permissions');
  if (input.pluginPaths && input.pluginPaths.length > 0) {
    for (const p of input.pluginPaths) args.push('--plugin-dir', p);
  }
  return args;
}

/** Auto-confirm the dev-channels prompt by sending Enter a few times after boot. */
function autoConfirm(proc: pty.IPty): void {
  for (const delayMs of [6000, 11000, 15000]) {
    setTimeout(() => { try { proc.write('\r'); } catch { /* exited */ } }, delayMs);
  }
}

export interface EnsureInput {
  codepilotSessionId: string;
  claudeSessionId: string;
  cwd: string;
  model?: string;
  resume: boolean;
  internalUrl: string;   // e.g. http://127.0.0.1:4000
  mode?: string;
  systemPrompt?: string;
  effort?: string;
  skipPermissions?: boolean;
  /**
   * Extra MCP servers to expose to Claude Code in addition to the built-in
   * `codepilot` reply MCP. Caller should pre-merge user / project sources via
   * `loadMergedMcpServers`.
   */
  extraMcpServers?: Record<string, unknown>;
  /** Absolute plugin directories to load via repeated `--plugin-dir` flags. */
  pluginPaths?: string[];
}

/** Return a ready ChannelSession, spawning the claude process if needed. */
export async function ensureSession(input: EnsureInput): Promise<ChannelSession> {
  const reg = registry();
  const existing = reg.get(input.codepilotSessionId);
  // Compare against the same sanitized value the spawned process actually saw,
  // so e.g. " high " and "bogus" don't trigger spurious respawns.
  const wantedEffort = sanitizeEffortLevel(input.effort);
  const wantedSkipPermissions = !!input.skipPermissions;
  // Cheap deep-equality via JSON.stringify — pluginPaths is a string[] in a
  // stable order and extraMcpServers is a small object, so stringify is fine
  // and avoids pulling in a deep-equal dep.
  const wantedPluginPathsKey = JSON.stringify(input.pluginPaths ?? []);
  const wantedMcpConfigKey = JSON.stringify(input.extraMcpServers ?? {});
  if (existing && existing.state !== 'exited') {
    // Everything compared here is baked in at spawn time; if any of it
    // changed the running process can't honor it — kill it and fall through
    // to respawn (with --resume, so the transcript continues).
    const configChanged =
      existing.spawnedMode !== input.mode ||
      existing.spawnedSystemPrompt !== input.systemPrompt ||
      existing.spawnedEffort !== wantedEffort ||
      existing.spawnedSkipPermissions !== wantedSkipPermissions ||
      existing.spawnedPluginPathsKey !== wantedPluginPathsKey ||
      existing.spawnedMcpConfigKey !== wantedMcpConfigKey;
    if (!configChanged) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    try { existing.proc.kill(); } catch { /* noop */ }
    reg.delete(input.codepilotSessionId);
  }

  const claudeBin = findClaudeBinary();
  if (!claudeBin) throw new Error('claude binary not found; cannot start channel session');

  const channelPort = await allocatePort();
  // Merge the built-in codepilot reply MCP with whatever extra servers the
  // caller asked for (user/project mcpServers loaded via the shared loader).
  // User-provided keys win on collision: an extra server overrides our
  // built-in only if the user named theirs `codepilot`, which is rare and
  // their explicit choice.
  const mergedMcpServers = {
    codepilot: { command: 'node', args: [MCP_SERVER_PATH] },
    ...(input.extraMcpServers ?? {}),
  };
  const mcpConfigJson = JSON.stringify({ mcpServers: mergedMcpServers });
  const args = buildSpawnArgs({
    claudeSessionId: input.claudeSessionId, mcpConfigJson,
    model: input.model, resume: input.resume,
    mode: input.mode, systemPrompt: input.systemPrompt,
    effort: input.effort,
    skipPermissions: input.skipPermissions,
    pluginPaths: input.pluginPaths,
  });
  const proc = pty.spawn(claudeBin, args, {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: input.cwd,
    env: {
      ...process.env,
      CODEPILOT_SESSION_ID: input.codepilotSessionId,
      CODEPILOT_CHANNEL_PORT: String(channelPort),
      CODEPILOT_INTERNAL_URL: input.internalUrl,
    } as Record<string, string>,
  });

  const session: ChannelSession = {
    codepilotSessionId: input.codepilotSessionId,
    claudeSessionId: input.claudeSessionId,
    channelPort, cwd: input.cwd, proc,
    state: 'starting', lastUsedAt: Date.now(),
    spawnedMode: input.mode,
    spawnedSystemPrompt: input.systemPrompt,
    spawnedEffort: wantedEffort,
    spawnedSkipPermissions: wantedSkipPermissions,
    spawnedPluginPathsKey: wantedPluginPathsKey,
    spawnedMcpConfigKey: wantedMcpConfigKey,
  };
  reg.set(input.codepilotSessionId, session);
  proc.onExit(({ exitCode, signal }) => {
    session.state = 'exited';
    console.log(`[channels:${input.codepilotSessionId}] process exited (code=${exitCode}, signal=${signal})`);
  });
  autoConfirm(proc);

  try {
    await waitForPort(channelPort, 30_000);
  } catch (err) {
    // waitForPort timed out: the spawned process is orphaned and the registry
    // entry is stuck in 'starting'. Kill the process and remove the entry so a
    // subsequent ensureSession() call gets a fresh start instead of a dead one.
    try { proc.kill(); } catch { /* noop */ }
    reg.delete(input.codepilotSessionId);
    throw err;
  }
  session.state = 'ready';
  return session;
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => { s.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`channel server port ${port} not reachable in ${timeoutMs}ms`);
}

export function getSession(codepilotSessionId: string): ChannelSession | undefined {
  return registry().get(codepilotSessionId);
}

export function killSession(codepilotSessionId: string): void {
  const s = registry().get(codepilotSessionId);
  // SIGKILL, not the default term signal: killSession is used to reap a
  // wedged/stalled process, which may ignore a catchable signal.
  if (s && s.state !== 'exited') { try { s.proc.kill('SIGKILL'); } catch { /* noop */ } }
  registry().delete(codepilotSessionId);
}

/** Reap sessions idle longer than maxIdleMs. Call from a periodic sweep. */
export function reapIdle(maxIdleMs = 30 * 60_000): void {
  const now = Date.now();
  for (const [id, s] of registry()) {
    if (s.state === 'exited' || now - s.lastUsedAt > maxIdleMs) killSession(id);
  }
}

export { MCP_SERVER_PATH };
