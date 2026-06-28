import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  spawnedModel?: string;
  spawnedEffort?: string;
  spawnedFastMode?: boolean;
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
   * When true, enable fast mode via `--settings '{"fastMode":true}'`. The CLI
   * has no `--fast` launch flag (only the interactive `/fast` toggle), but
   * `fastMode` is a first-class settings key, and `--settings` loads
   * *additional* settings (merges over user/project sources, never clobbers
   * them). Omitted when off so the CLI uses its default. Mirrors the T2 SDK's
   * `queryOptions.settings.fastMode`.
   */
  fastMode?: boolean;
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
    '--disallowedTools', 'AskUserQuestion',
  );
  if (input.model) args.push('--model', input.model);
  if (input.mode && VALID_PERMISSION_MODES.has(input.mode)) {
    args.push('--permission-mode', input.mode);
  }
  if (input.systemPrompt) args.push('--append-system-prompt', input.systemPrompt);
  const sanitizedEffort = sanitizeEffortLevel(input.effort);
  if (sanitizedEffort) args.push('--effort', sanitizedEffort);
  if (input.fastMode) args.push('--settings', JSON.stringify({ fastMode: true }));
  if (input.skipPermissions) args.push('--dangerously-skip-permissions');
  if (input.pluginPaths && input.pluginPaths.length > 0) {
    for (const p of input.pluginPaths) args.push('--plugin-dir', p);
  }
  return args;
}

/**
 * Pure, testable: build the env for the channels PTY.
 *
 * Auth note — the fix for the recurring "⚠️ Please run /login · API Error: 401".
 * The channels CLI runs *interactively* (a long-lived PTY). Interactive Claude
 * Code resolves auth in this order: ANTHROPIC_AUTH_TOKEN > the macOS Keychain
 * login session > CLAUDE_CODE_OAUTH_TOKEN. Headless (the T2 SDK / `claude -p`)
 * is the opposite — it honors CLAUDE_CODE_OAUTH_TOKEN directly, which is why T2
 * never 401s. So forwarding only CLAUDE_CODE_OAUTH_TOKEN (via `...process.env`)
 * leaves the interactive PTY pinned to the Keychain login session, whose
 * short-lived (~8h) access token goes stale on a long-lived process — and once
 * that token has no refresh token it can never re-mint, so every send 401s.
 *
 * We mirror the subscription token into ANTHROPIC_AUTH_TOKEN so the long-lived
 * OAuth token is used directly as the bearer and the Keychain is never
 * consulted: same Max-subscription billing, no 8h staleness, no refresh race.
 * Only for the subscription-token path — if the user already configured an
 * explicit ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN we leave their choice alone.
 */
export function buildSpawnEnv(
  base: NodeJS.ProcessEnv,
  runtime: { sessionId: string; channelPort: number; internalUrl: string },
): Record<string, string> {
  const env: Record<string, string> = {
    ...base,
    CODEPILOT_SESSION_ID: runtime.sessionId,
    CODEPILOT_CHANNEL_PORT: String(runtime.channelPort),
    CODEPILOT_INTERNAL_URL: runtime.internalUrl,
  } as Record<string, string>;
  if (base.CLAUDE_CODE_OAUTH_TOKEN && !base.ANTHROPIC_AUTH_TOKEN && !base.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_AUTH_TOKEN = base.CLAUDE_CODE_OAUTH_TOKEN;
  }
  return env;
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
  fastMode?: boolean;
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
  const wantedFastMode = !!input.fastMode;
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
      existing.spawnedModel !== input.model ||
      existing.spawnedEffort !== wantedEffort ||
      existing.spawnedFastMode !== wantedFastMode ||
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
    fastMode: input.fastMode,
    skipPermissions: input.skipPermissions,
    pluginPaths: input.pluginPaths,
  });
  const proc = pty.spawn(claudeBin, args, {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: input.cwd,
    env: buildSpawnEnv(process.env, {
      sessionId: input.codepilotSessionId,
      channelPort,
      internalUrl: input.internalUrl,
    }),
  });
  // Drain PTY output. We read state from the on-disk transcript, not from
  // the PTY (the CLI's interactive UI — spinner, status bar, ANSI escapes —
  // is not useful here). Without a listener, node-pty's libuv reader still
  // allocates Buffers for every chunk that arrives from the CLI's stdout/
  // stderr; over long-lived sessions this generates real GC pressure. A
  // no-op sink lets V8 collect each chunk as soon as the callback returns.
  proc.onData(() => { /* drain — see comment above */ });

  const session: ChannelSession = {
    codepilotSessionId: input.codepilotSessionId,
    claudeSessionId: input.claudeSessionId,
    channelPort, cwd: input.cwd, proc,
    state: 'starting', lastUsedAt: Date.now(),
    spawnedMode: input.mode,
    spawnedSystemPrompt: input.systemPrompt,
    spawnedModel: input.model,
    spawnedEffort: wantedEffort,
    spawnedFastMode: wantedFastMode,
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

/**
 * Kill stray `claude --channels` PTYs left over from a PREVIOUS server instance.
 *
 * reapIdle only knows sessions in THIS process's registry. When the server
 * restarts — `launchctl kickstart`, a rebuild, an HMR full reload, or a crash —
 * the old next-server process can survive (reparented to PID 1) and keep its
 * channel-PTY children alive forever; the new instance's registry never sees
 * them, so they leak across restarts (observed: 6-day-old orphans). At boot the
 * registry is empty, so ANY live process whose argv carries THIS project's MCP
 * server path is necessarily such a leftover and is safe to SIGKILL — the
 * conversation is on disk and resumes via `--resume` on the next message.
 *
 * Scoped to MCP_SERVER_PATH, an absolute path that embeds this project's cwd, so
 * a parallel CodePilot running from a different checkout — e.g. a git worktree
 * on another port — is never touched. Never kills a registered session's PID or
 * our own PID (defensive; the registry is empty at boot but this keeps the
 * function safe to call at any time).
 *
 * Returns the number of processes killed.
 */
export function reapOrphanChannelProcs(): number {
  const protectedPids = new Set<number>([process.pid]);
  for (const s of registry().values()) {
    if (s.proc?.pid) protectedPids.add(s.proc.pid);
  }
  let pids: number[];
  try {
    // pgrep -f matches the full command line. MCP_SERVER_PATH appears both in
    // the channel PTY's --mcp-config argv and in the MCP server child's script
    // path; at boot both belong to a dead instance, so killing both is correct
    // and complete. pgrep exits non-zero (throws) when nothing matches.
    const out = execFileSync('pgrep', ['-f', MCP_SERVER_PATH], { encoding: 'utf8' });
    pids = out.split('\n').map((l) => parseInt(l.trim(), 10)).filter(Number.isInteger);
  } catch {
    return 0; // no matches (or pgrep unavailable) — nothing to reap
  }
  let killed = 0;
  for (const pid of pids) {
    if (protectedPids.has(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* already gone */ }
  }
  if (killed > 0) {
    console.log(`[channels] reaped ${killed} orphaned channel process(es) from a previous instance`);
  }
  return killed;
}

export { MCP_SERVER_PATH };
