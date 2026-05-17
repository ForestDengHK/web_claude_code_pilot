import net from 'node:net';
import path from 'node:path';
import * as pty from 'node-pty';
import { findClaudeBinary } from '../platform';

const MCP_SERVER_PATH = path.join(process.cwd(), 'scripts', 'channels-mcp-server.mjs');

export interface ChannelSession {
  codepilotSessionId: string;
  claudeSessionId: string;   // the --session-id we assigned; also the .jsonl filename
  channelPort: number;       // channel MCP server HTTP port
  cwd: string;
  proc: pty.IPty;
  state: 'starting' | 'ready' | 'exited';
  lastUsedAt: number;
  // Config baked in at spawn time. permission-mode and the system prompt are
  // CLI flags, so a change requires respawning the process (see ensureSession).
  spawnedMode?: string;
  spawnedSystemPrompt?: string;
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
}

/** Pure, testable: construct the claude CLI argv. */
export function buildSpawnArgs(input: SpawnArgsInput): string[] {
  const args = [
    '--session-id', input.claudeSessionId,
    '--mcp-config', input.mcpConfigJson,
    '--dangerously-load-development-channels', 'server:codepilot',
    '--allowedTools', 'mcp__codepilot__reply',
  ];
  if (input.model) args.push('--model', input.model);
  if (input.mode && VALID_PERMISSION_MODES.has(input.mode)) {
    args.push('--permission-mode', input.mode);
  }
  if (input.systemPrompt) args.push('--append-system-prompt', input.systemPrompt);
  if (input.resume) args.push('--resume', input.claudeSessionId);
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
}

/** Return a ready ChannelSession, spawning the claude process if needed. */
export async function ensureSession(input: EnsureInput): Promise<ChannelSession> {
  const reg = registry();
  const existing = reg.get(input.codepilotSessionId);
  if (existing && existing.state !== 'exited') {
    // permission-mode and the system prompt are baked in at spawn time. If the
    // user changed either, the running process can't honor it — kill it and
    // fall through to respawn (with --resume, so the transcript continues).
    const configChanged =
      existing.spawnedMode !== input.mode ||
      existing.spawnedSystemPrompt !== input.systemPrompt;
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
  const mcpConfigJson = JSON.stringify({
    mcpServers: { codepilot: { command: 'node', args: [MCP_SERVER_PATH] } },
  });
  const args = buildSpawnArgs({
    claudeSessionId: input.claudeSessionId, mcpConfigJson,
    model: input.model, resume: input.resume,
    mode: input.mode, systemPrompt: input.systemPrompt,
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
  if (s && s.state !== 'exited') { try { s.proc.kill(); } catch { /* noop */ } }
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
