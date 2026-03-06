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
import { resolve, bindSession, updateSession, listSessions } from './channel-router';
import { processMessage } from './conversation-engine';
import type { ConversationCallbacks } from './conversation-engine';
import { deliver } from './delivery-layer';
import {
  forwardPermissionRequest,
  handlePermissionCallback,
  parsePermissionCallback,
} from './permission-broker';
import { insertAuditLog } from './bridge-db';
import {
  validateWorkingDirectory,
  sanitizeInput,
  isDangerousInput,
  validateMode,
} from './security/validators';
import { getSetting } from '../../lib/db';
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
    // Non-permission callback — ignore for now
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
      `New session created.\nSession: ${binding.codepilotSessionId.slice(0, 8)}...\nDirectory: ${binding.workingDirectory}\nMode: ${binding.mode}`,
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
    await sendText(adapter, address, 'Usage: /bind <session-id>');
    return;
  }

  try {
    const binding = bindSession(address, sessionId);
    await sendText(
      adapter,
      address,
      `Bound to session: ${binding.codepilotSessionId.slice(0, 8)}...`,
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
    await sendText(adapter, address, `Current directory: ${binding.workingDirectory}`);
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
    await sendText(adapter, address, `Current mode: ${binding.mode}`);
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
    `  Session: ${binding.codepilotSessionId.slice(0, 8)}...`,
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
  const sessions = listSessions(adapter.channelType);
  if (sessions.length === 0) {
    await sendText(adapter, address, 'No sessions found.');
    return;
  }

  const lines = ['Sessions:'];
  for (const s of sessions) {
    const shortId = s.codepilotSessionId.slice(0, 8);
    const status = s.active ? 'active' : 'inactive';
    lines.push(`  ${shortId}... [${status}] ${s.workingDirectory} (${s.mode})`);
  }

  await sendText(adapter, address, lines.join('\n'));
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
