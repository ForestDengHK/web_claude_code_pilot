/**
 * Bridge Manager — lifecycle orchestrator for the IM bridge system.
 *
 * Responsibilities:
 * - Start/stop adapters based on settings
 * - Run poll loops (one per adapter)
 * - Dispatch inbound messages (commands, callbacks, conversation)
 * - Wire conversation engine callbacks to delivery layer
 *
 * Uses globalThis singleton to survive HMR in dev mode.
 */

import type {
  ChannelAddress,
  InboundMessage,
  BridgeStatus,
  AdapterStatus,
} from './types';
import type { BaseChannelAdapter } from './channel-adapter';
import { createAdapter, getRegisteredTypes } from './channel-adapter';
import { resolve, bindSession, updateSession, listSessions, removeSession } from './channel-router';
import { processMessage } from './conversation-engine';
import type { ConversationCallbacks } from './conversation-engine';
import { deliver } from './delivery-layer';
import {
  forwardPermissionRequest,
  handlePermissionCallback,
  parsePermissionCallback,
} from './permission-broker';
import { insertAuditLog, getAuditMessageIds, clearAuditLogs, clearOutboundRefs } from './bridge-db';
import {
  validateWorkingDirectory,
  sanitizeInput,
  isDangerousInput,
  validateMode,
} from './security/validators';
import { getSetting, clearSessionMessages, deleteSession as deleteCodepilotSession, getAllSessions, getFavoriteDirectories, getRecentDirectories } from '../../lib/db';
import crypto from 'crypto';

// ==========================================
// GlobalThis singleton state
// ==========================================

const GLOBAL_KEY = '__bridge_manager__';

interface BridgeManagerState {
  running: boolean;
  startedAt: string | null;
  adapters: Map<string, BaseChannelAdapter>;
  pollAbortControllers: Map<string, AbortController>;
  adapterErrors: Map<string, string | null>;
  adapterLastMessage: Map<string, string | null>;
}

function getState(): BridgeManagerState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      running: false,
      startedAt: null,
      adapters: new Map(),
      pollAbortControllers: new Map(),
      adapterErrors: new Map(),
      adapterLastMessage: new Map(),
    };
  }
  return g[GLOBAL_KEY] as BridgeManagerState;
}

// ==========================================
// Public API
// ==========================================

/**
 * Start the bridge — load adapters, validate config, start poll loops.
 */
export async function startBridge(): Promise<void> {
  const state = getState();
  if (state.running) return;

  state.running = true;

  try {
    // Side-effect import to trigger adapter self-registration
    await import('./adapters');

    const registeredTypes = getRegisteredTypes();

    for (const channelType of registeredTypes) {
      // Check if this channel type is enabled in settings
      const enabledKey = `bridge_${channelType}_enabled`;
      const enabled = getSetting(enabledKey);
      if (enabled !== 'true') continue;

      const adapter = createAdapter(channelType);
      if (!adapter) {
        console.warn(`[bridge-manager] No adapter factory for ${channelType}`);
        continue;
      }

      // Validate configuration
      const configError = adapter.validateConfig();
      if (configError) {
        console.warn(`[bridge-manager] ${channelType} config invalid: ${configError}`);
        state.adapterErrors.set(channelType, configError);
        continue;
      }

      try {
        await adapter.start();
        state.adapters.set(channelType, adapter);
        state.adapterErrors.set(channelType, null);

        // Start poll loop
        const abortController = new AbortController();
        state.pollAbortControllers.set(channelType, abortController);
        // Fire and forget — loop runs in background
        runAdapterLoop(adapter, abortController.signal).catch((err) => {
          console.error(`[bridge-manager] ${channelType} loop crashed:`, err);
          state.adapterErrors.set(channelType, String(err));
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Failed to start ${channelType}: ${msg}`);
        state.adapterErrors.set(channelType, msg);
      }
    }

    state.startedAt = new Date().toISOString();
  } catch (err) {
    state.running = false;
    throw err;
  }
}

/**
 * Stop the bridge — abort all poll loops and stop all adapters.
 */
export async function stopBridge(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  // Abort all poll loops
  for (const [, controller] of state.pollAbortControllers) {
    controller.abort();
  }
  state.pollAbortControllers.clear();

  // Stop all adapters
  for (const [channelType, adapter] of state.adapters) {
    try {
      await adapter.stop();
    } catch (err) {
      console.error(`[bridge-manager] Error stopping ${channelType}:`, err);
    }
  }
  state.adapters.clear();

  state.running = false;
  state.startedAt = null;
}

/**
 * Get bridge status with per-adapter details.
 */
export function getBridgeStatus(): BridgeStatus {
  const state = getState();

  const adapters: AdapterStatus[] = [];
  for (const [channelType, adapter] of state.adapters) {
    adapters.push({
      channelType,
      running: adapter.isRunning(),
      connectedAt: state.startedAt,
      lastMessageAt: state.adapterLastMessage.get(channelType) ?? null,
      error: state.adapterErrors.get(channelType) ?? null,
    });
  }

  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters,
  };
}

// ==========================================
// Poll loop
// ==========================================

/**
 * Run the poll loop for a single adapter.
 * Exported for testing.
 */
export async function runAdapterLoop(
  adapter: BaseChannelAdapter,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const message = await adapter.consumeOne();
      if (message) {
        if (adapter.processMediaAttachments) {
          await adapter.processMediaAttachments(message);
        }
        const state = getState();
        state.adapterLastMessage.set(adapter.channelType, new Date().toISOString());
        await dispatchMessage(adapter, message);
      } else {
        // No message — short sleep to avoid busy loop
        await sleep(300, signal);
      }
    } catch (err) {
      if (signal.aborted) break;
      console.error(`[bridge-manager] ${adapter.channelType} poll error:`, err);
      // Sleep before retry to avoid tight error loop
      await sleep(2000, signal);
    }
  }
}

// ==========================================
// Message dispatch
// ==========================================

/**
 * Dispatch an inbound message to the appropriate handler.
 * Exported (prefixed) for testing.
 */
export async function dispatchMessage(
  adapter: BaseChannelAdapter,
  message: InboundMessage,
): Promise<void> {
  // Acknowledge the update if adapter supports it
  if (adapter.acknowledgeUpdate && message.updateId !== undefined) {
    adapter.acknowledgeUpdate(message.updateId);
  }

  // Check authorization
  if (!adapter.isAuthorized(message.address.userId ?? '', message.address.chatId)) {
    console.warn(`[bridge-manager] Unauthorized message from ${message.address.chatId}`);
    return;
  }

  // Callback query (inline button press) — check for permission callback
  if (message.callbackData) {
    const parsed = parsePermissionCallback(message.callbackData);
    if (parsed) {
      await handlePermissionCallback(
        adapter,
        message.callbackData,
        message.messageId,
      );
      return;
    }
    // Command callback (e.g. directory selection)
    if (message.callbackData.startsWith('cmd:')) {
      await handleCommandCallback(adapter, message);
      return;
    }
    // Unknown callback — ignore
    return;
  }

  // Command (starts with /)
  const trimmedText = message.text.trim();
  if (trimmedText.startsWith('/')) {
    await handleCommand(adapter, message);
    return;
  }

  // Regular message — route to conversation
  await routeToConversation(adapter, message);
}

// ==========================================
// Command callback handling (inline button presses)
// ==========================================

async function handleCommandCallback(
  adapter: BaseChannelAdapter,
  message: InboundMessage,
): Promise<void> {
  const data = message.callbackData!;
  const { address } = message;

  // Answer the callback to remove loading spinner
  if (adapter.answerCallback) {
    await adapter.answerCallback(message.messageId);
  }

  // Format: cmd:<command>:<payload>
  const parts = data.split(':');
  const command = parts[1];
  const payload = parts.slice(2).join(':');

  switch (command) {
    case 'cwd':
      await cmdCwd(adapter, address, payload);
      break;
    case 'new':
      await cmdNew(adapter, address, payload);
      break;
    case 'bind':
      await cmdBind(adapter, address, payload);
      break;
    case 'mode':
      await cmdMode(adapter, address, payload);
      break;
    default:
      break;
  }
}

// ==========================================
// Command handling
// ==========================================

/**
 * Handle a slash command from an IM message.
 * Exported for testing.
 */
export async function handleCommand(
  adapter: BaseChannelAdapter,
  message: InboundMessage,
): Promise<void> {
  const text = message.text.trim();
  // Parse: "/command arg1 arg2 ..."
  const spaceIdx = text.indexOf(' ');
  const command = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  const { address } = message;

  switch (command) {
    case '/new':
      await cmdNew(adapter, address, args);
      break;
    case '/bind':
      await cmdBind(adapter, address, args);
      break;
    case '/cwd':
      await cmdCwd(adapter, address, args);
      break;
    case '/mode':
      await cmdMode(adapter, address, args);
      break;
    case '/status':
      await cmdStatus(adapter, address);
      break;
    case '/sessions':
      await cmdSessions(adapter, address);
      break;
    case '/stop':
      await cmdStop(adapter, address);
      break;
    case '/clear':
      await cmdClear(adapter, address);
      break;
    case '/unbind':
      await cmdUnbind(adapter, address);
      break;
    case '/delete':
      await cmdDelete(adapter, address);
      break;
    case '/help':
      await cmdHelp(adapter, address);
      break;
    default:
      await sendText(adapter, address, `Unknown command: ${command}\nType /help for available commands.`);
      break;
  }
}

// ── Command implementations ─────────────────────────

async function cmdNew(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  args: string,
): Promise<void> {
  const defaultWorkDir = getSetting('bridge_default_work_dir') || '/tmp';
  const defaultModel = getSetting('bridge_default_model') || '';

  // No args — show directory picker
  if (!args.trim()) {
    const buttons = buildDirectoryButtons('new');
    if (buttons.length > 0) {
      // Add default dir as first option if not already there
      await deliver(adapter, {
        address,
        text: `Select a project directory:`,
        parseMode: 'plain',
        inlineButtons: buttons,
      });
      return;
    }
  }

  let workDir = args.trim() || defaultWorkDir;

  // Validate working directory
  const normalized = validateWorkingDirectory(workDir);
  if (!normalized) {
    await sendText(adapter, address, `Invalid working directory: ${workDir}`);
    return;
  }
  workDir = normalized;

  const sessionId = crypto.randomUUID();
  try {
    const binding = bindSession(address, sessionId, {
      workingDirectory: workDir,
      model: defaultModel,
    });
    await sendText(
      adapter,
      address,
      `New session created.\nSession: ${binding.codepilotSessionId}\nDirectory: ${binding.workingDirectory}\nMode: ${binding.mode}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendText(adapter, address, `Failed to create session: ${msg}`);
  }
}

async function cmdBind(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  args: string,
): Promise<void> {
  const sessionId = args.trim();
  if (!sessionId) {
    // Show available sessions as a list with buttons
    const allSessions = getAllSessions().slice(0, 8);
    if (allSessions.length > 0) {
      const lines = ['<b>Select a session:</b>'];
      const buttons = allSessions.map((s, i) => {
        const num = i + 1;
        const title = s.title || '(untitled)';
        const parts = s.working_directory.split('/').filter(Boolean);
        const dirLabel = parts.length > 1 ? parts.slice(-2).join('/') : (s.working_directory || '—');
        const mode = s.mode || 'code';
        const date = s.updated_at?.slice(0, 10) || '';

        lines.push('');
        lines.push(`<b>${num}.</b> ${title}`);
        lines.push(`   📁 ${dirLabel} · ${mode} · ${date}`);

        return [{ text: `${num}. ${title}`, callbackData: `cmd:bind:${s.id}` }];
      });
      await deliver(adapter, {
        address,
        text: lines.join('\n'),
        parseMode: 'HTML',
        inlineButtons: buttons,
      });
    } else {
      await sendText(adapter, address, 'No sessions found. Use /new to create one.');
    }
    return;
  }

  try {
    const binding = bindSession(address, sessionId);
    await sendText(
      adapter,
      address,
      `Bound to session: ${binding.codepilotSessionId}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendText(adapter, address, `Failed to bind: ${msg}`);
  }
}

async function cmdCwd(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  args: string,
): Promise<void> {
  const binding = resolve(address);
  if (!binding) {
    await sendText(adapter, address, 'No active session. Use /new to create one.');
    return;
  }

  const newPath = args.trim();
  if (!newPath) {
    // Show current dir + directory picker
    const buttons = buildDirectoryButtons('cwd');
    if (buttons.length > 0) {
      await deliver(adapter, {
        address,
        text: `Current: ${binding.workingDirectory}\n\nSelect a directory:`,
        parseMode: 'plain',
        inlineButtons: buttons,
      });
    } else {
      await sendText(adapter, address, `Current directory: ${binding.workingDirectory}`);
    }
    return;
  }

  const normalized = validateWorkingDirectory(newPath);
  if (!normalized) {
    await sendText(adapter, address, `Invalid path: ${newPath}`);
    return;
  }

  try {
    updateSession(binding.id, { workingDirectory: normalized });
    await sendText(adapter, address, `Working directory updated: ${normalized}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendText(adapter, address, `Failed: ${msg}`);
  }
}

async function cmdMode(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  args: string,
): Promise<void> {
  const binding = resolve(address);
  if (!binding) {
    await sendText(adapter, address, 'No active session. Use /new to create one.');
    return;
  }

  const mode = args.trim().toLowerCase();
  if (!mode) {
    // Show mode picker with current mode highlighted
    const modes = ['code', 'plan', 'ask'];
    const buttons = modes.map((m) => [{
      text: m === binding.mode ? `✓ ${m}` : m,
      callbackData: `cmd:mode:${m}`,
    }]);
    await deliver(adapter, {
      address,
      text: `Current mode: ${binding.mode}\n\nSelect a mode:`,
      parseMode: 'plain',
      inlineButtons: [buttons.map((b) => b[0])], // single row
    });
    return;
  }

  if (!validateMode(mode)) {
    await sendText(adapter, address, `Invalid mode: ${mode}\nValid modes: code, plan, ask`);
    return;
  }

  try {
    updateSession(binding.id, { mode });
    await sendText(adapter, address, `Mode updated: ${mode}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendText(adapter, address, `Failed: ${msg}`);
  }
}

async function cmdStatus(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
): Promise<void> {
  const binding = resolve(address);
  if (!binding) {
    await sendText(adapter, address, 'No active session. Use /new to create one.');
    return;
  }

  const lines = [
    'Session Status:',
    `  Session: ${binding.codepilotSessionId}`,
    `  Directory: ${binding.workingDirectory}`,
    `  Model: ${binding.model || '(default)'}`,
    `  Mode: ${binding.mode}`,
    `  Active: ${binding.active ? 'yes' : 'no'}`,
  ];

  await sendText(adapter, address, lines.join('\n'));
}

async function cmdSessions(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
): Promise<void> {
  const bindings = listSessions(adapter.channelType);
  const boundSessionIds = new Set(bindings.map((b) => b.codepilotSessionId));

  const lines: string[] = [];

  // Show bound sessions
  if (bindings.length > 0) {
    lines.push('<b>Bound Sessions:</b>');
    for (const s of bindings) {
      const status = s.active ? '🟢' : '⚪';
      lines.push('');
      lines.push(`${status} <code>${s.codepilotSessionId}</code>`);
      lines.push(`   ${s.workingDirectory} · ${s.mode}`);
    }
  }

  // Show recent unbound CodePilot sessions (up to 5)
  const allSessions = getAllSessions();
  const unbound = allSessions
    .filter((s) => !boundSessionIds.has(s.id))
    .slice(0, 10);

  if (unbound.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('<b>Recent CodePilot Sessions:</b>');
    for (const s of unbound) {
      lines.push('');
      lines.push(`📎 <code>${s.id}</code>`);
      const parts = [s.title || '(untitled)', s.working_directory || ''].filter(Boolean);
      lines.push(`   ${parts.join(' · ')}`);
    }
    lines.push('');
    lines.push('Use /bind &lt;id&gt; to connect');
  }

  if (lines.length === 0) {
    await sendText(adapter, address, 'No sessions found. Use /new to create one.');
    return;
  }

  await deliver(adapter, {
    address,
    text: lines.join('\n'),
    parseMode: 'HTML',
  });
}

async function cmdStop(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
): Promise<void> {
  const binding = resolve(address);
  if (!binding) {
    await sendText(adapter, address, 'No active session. Use /new to create one.');
    return;
  }

  try {
    updateSession(binding.id, { active: false });
    await sendText(adapter, address, 'Session deactivated.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendText(adapter, address, `Failed: ${msg}`);
  }
}

async function cmdClear(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
): Promise<void> {
  const binding = resolve(address);
  if (!binding) {
    await sendText(adapter, address, 'No active session. Use /new to create one.');
    return;
  }

  try {
    // Delete messages from the chat window (Telegram side)
    if (adapter.deleteMessages) {
      const messageIds = getAuditMessageIds(adapter.channelType, address.chatId);
      // Filter out non-numeric IDs (e.g. bridge-generated IDs)
      const platformIds = messageIds.filter((id) => /^\d+$/.test(id));
      if (platformIds.length > 0) {
        await adapter.deleteMessages(address.chatId, platformIds);
      }
    }

    // Clear CodePilot conversation history
    clearSessionMessages(binding.codepilotSessionId);

    // Clear bridge tracking data for this chat
    clearAuditLogs(adapter.channelType, address.chatId);
    clearOutboundRefs(adapter.channelType, address.chatId);

    await sendText(adapter, address, 'Chat cleared.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendText(adapter, address, `Failed to clear: ${msg}`);
  }
}

async function cmdUnbind(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
): Promise<void> {
  const binding = resolve(address);
  if (!binding) {
    await sendText(adapter, address, 'No active session. Nothing to unbind.');
    return;
  }

  try {
    updateSession(binding.id, { active: false });
    await sendText(adapter, address, `Unbound from session ${binding.codepilotSessionId}\nUse /sessions to see it, /bind to reconnect.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendText(adapter, address, `Failed to unbind: ${msg}`);
  }
}

async function cmdDelete(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
): Promise<void> {
  const binding = resolve(address);
  if (!binding) {
    await sendText(adapter, address, 'No active session. Nothing to delete.');
    return;
  }

  try {
    removeSession(binding.id);
    deleteCodepilotSession(binding.codepilotSessionId);
    await sendText(adapter, address, `Session deleted: ${binding.codepilotSessionId}\nRemoved from both Telegram and CodePilot.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendText(adapter, address, `Failed to delete: ${msg}`);
  }
}

async function cmdHelp(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
): Promise<void> {
  const helpText = [
    'Available commands:',
    '  /new [path]    — Create a new session',
    '  /bind <id>     — Bind to an existing session',
    '  /cwd [path]    — Show or change working directory',
    '  /mode <mode>   — Switch mode (code, plan, ask)',
    '  /status        — Show current session status',
    '  /sessions      — List all sessions',
    '  /clear         — Clear conversation history',
    '  /unbind        — Disconnect from session (keeps it)',
    '  /delete        — Delete session entirely',
    '  /stop          — Deactivate current session',
    '  /help          — Show this help message',
  ].join('\n');

  await sendText(adapter, address, helpText);
}

// ==========================================
// Conversation routing
// ==========================================

/**
 * Route a regular (non-command) message to the conversation engine.
 * Exported for testing.
 */
export async function routeToConversation(
  adapter: BaseChannelAdapter,
  message: InboundMessage,
): Promise<void> {
  const { address, text, attachments } = message;

  // Sanitize input
  const { text: sanitized, truncated } = sanitizeInput(text);
  if (truncated) {
    await sendText(adapter, address, '(Message was truncated to 32K characters)');
  }

  // Check for dangerous input
  const danger = isDangerousInput(sanitized);
  if (danger.dangerous) {
    insertAuditLog({
      channelType: address.channelType,
      chatId: address.chatId,
      direction: 'inbound',
      messageId: message.messageId,
      summary: `BLOCKED: ${danger.reason}`,
    });
    await sendText(adapter, address, `Message blocked: potentially dangerous input detected (${danger.reason}).`);
    return;
  }

  // Resolve binding
  let binding = resolve(address);

  if (!binding) {
    // No binding — prompt user to create one
    await sendText(
      adapter,
      address,
      'No active session. Use /new to create one first, or /bind <id> to bind to an existing session.',
    );
    return;
  }

  if (!binding.active) {
    await sendText(adapter, address, 'Session is inactive. Use /new to create a new one.');
    return;
  }

  // Notify adapter that message processing has started
  adapter.onMessageStart?.(address.chatId);

  // Build conversation callbacks
  const callbacks: ConversationCallbacks = {
    onResponse: async (responseText: string) => {
      adapter.onMessageEnd?.(address.chatId);
      await adapter.deliverResponse(address, responseText, deliver, {
        sessionId: binding!.codepilotSessionId,
      });
    },

    onPermissionRequest: async (params) => {
      await forwardPermissionRequest(adapter, address, params);
    },

    onPartialText: (partialText: string) => {
      // Streaming preview — adapter may support sendPreview
      if (adapter.sendPreview) {
        // Fire and forget — preview is best-effort
        adapter.sendPreview(address.chatId, partialText, 0).catch(() => {});
      }
    },

    onError: async (error: Error) => {
      adapter.onMessageEnd?.(address.chatId);
      await sendText(adapter, address, `Error: ${error.message}`);
    },

    onSessionInit: (sdkSessionId: string) => {
      // Update the binding's SDK session ID for session resumption
      try {
        updateSession(binding!.id, { sdkSessionId });
      } catch (err) {
        console.error('[bridge-manager] Failed to update SDK session ID:', err);
      }
    },
  };

  try {
    await processMessage(binding, sanitized, callbacks, {
      attachments,
      mode: binding.mode,
    });
  } catch (err) {
    adapter.onMessageEnd?.(address.chatId);
    const msg = err instanceof Error ? err.message : String(err);
    await sendText(adapter, address, `Error processing message: ${msg}`);
  }
}

// ==========================================
// Helpers
// ==========================================

/**
 * Send a plain text message via the delivery layer.
 */
/**
 * Build inline keyboard rows with directory options for /cwd or /new.
 */
function buildDirectoryButtons(command: 'cwd' | 'new'): { text: string; callbackData: string }[][] {
  const favorites = getFavoriteDirectories();
  const recent = getRecentDirectories(10);

  // Dedupe: favorites first, then recent that aren't in favorites
  const favPaths = new Set(favorites.map((f) => f.path));
  const dirs: { label: string; path: string }[] = [];

  for (const f of favorites) {
    dirs.push({ label: `⭐ ${f.name || f.path}`, path: f.path });
  }
  for (const r of recent) {
    if (!favPaths.has(r)) {
      // Show last 2 path components as label
      const parts = r.split('/').filter(Boolean);
      const label = parts.length > 1 ? parts.slice(-2).join('/') : r;
      dirs.push({ label, path: r });
    }
  }

  // Telegram: max 64 bytes per callback_data, 1 button per row for readability
  return dirs.slice(0, 8).map((d) => [
    { text: d.label, callbackData: `cmd:${command}:${d.path}` },
  ]);
}

async function sendText(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  text: string,
): Promise<void> {
  await deliver(adapter, { address, text, parseMode: 'plain' });
}

/**
 * Abortable sleep.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// ==========================================
// Exported internals for testing (prefixed with _)
// ==========================================

export {
  handleCommand as _handleCommand,
  dispatchMessage as _dispatchMessage,
  routeToConversation as _routeToConversation,
  sendText as _sendText,
  getState as _getState,
};
