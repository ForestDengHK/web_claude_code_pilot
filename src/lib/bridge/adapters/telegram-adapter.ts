/**
 * Telegram channel adapter — long polling, message dispatch, and rendering.
 *
 * Self-registers via registerAdapterFactory at module load time.
 */

import type {
  ChannelAddress, InboundMessage, OutboundMessage, SendResult, StreamConfig,
} from '../types';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter';
import type { DeliverFn } from '../channel-adapter';
import { callTelegramApi, escapeHtml, splitMessage } from './telegram-utils';
import { downloadPhoto, downloadDocumentImage, isImageEnabled } from './telegram-media';
import type { TelegramPhotoSize, TelegramDocument } from './telegram-media';
import { getChannelOffset, setChannelOffset, checkDedup, insertDedup } from '../bridge-db';
import { sanitizeInput, isDangerousInput } from '../security/validators';
import { getSetting } from '../../db';

// ── Telegram update types (subset we care about) ───────────────

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

// ── Adapter ─────────────────────────────────────────────────────

export class TelegramAdapter extends BaseChannelAdapter {
  readonly channelType = 'telegram' as const;

  private running = false;

  // ── Platform limits ─────────────────────────────────────────

  get messageLimit(): number {
    return 4096;
  }

  get streamDefaults(): StreamConfig {
    return { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 };
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    this.running = true;
    // Register bot commands with Telegram for / menu hints
    const token = getSetting('telegram_bot_token');
    if (token) {
      callTelegramApi(token, 'setMyCommands', {
        commands: [
          { command: 'new', description: 'Start new session (optional: /new /path/to/project)' },
          { command: 'bind', description: 'Bind to existing session by ID' },
          { command: 'cwd', description: 'Change working directory' },
          { command: 'mode', description: 'Set mode: code, plan, or ask' },
          { command: 'status', description: 'Show current session info' },
          { command: 'sessions', description: 'List all bound sessions' },
          { command: 'clear', description: 'Clear conversation history' },
          { command: 'unbind', description: 'Disconnect from session (keeps it)' },
          { command: 'delete', description: 'Delete session entirely' },
          { command: 'stop', description: 'Deactivate current session' },
          { command: 'help', description: 'Show all available commands' },
        ],
      }).catch(() => { /* best-effort */ });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Config validation ───────────────────────────────────────

  validateConfig(): string | null {
    const token = getSetting('telegram_bot_token');
    if (!token || token.trim() === '') {
      return 'Missing telegram_bot_token setting';
    }
    return null;
  }

  // ── Auth ────────────────────────────────────────────────────

  isAuthorized(userId: string, _chatId: string): boolean {
    const allowedRaw = getSetting('telegram_bridge_allowed_users');
    if (!allowedRaw || allowedRaw.trim() === '') {
      // No whitelist configured — deny all
      return false;
    }
    const allowed = allowedRaw.split(',').map((s) => s.trim()).filter(Boolean);
    return allowed.includes(userId);
  }

  // ── Poll one update ─────────────────────────────────────────

  async consumeOne(): Promise<InboundMessage | null> {
    const token = getSetting('telegram_bot_token');
    if (!token) return null;

    const offsetKey = `telegram:poll`;
    const currentOffset = getChannelOffset(offsetKey);
    const offsetNum = parseInt(currentOffset, 10) || 0;

    return this.pollOne(token, offsetNum);
  }

  private async pollOne(botToken: string, offset: number): Promise<InboundMessage | null> {
    const url = `https://api.telegram.org/bot${botToken}/getUpdates`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset,
          limit: 1,
          timeout: 30,
          allowed_updates: ['message', 'callback_query'],
        }),
      });
    } catch (err) {
      console.warn('[telegram-adapter] pollOne fetch failed:', err);
      return null;
    }

    let body: { ok: boolean; result?: TelegramUpdate[] };
    try {
      body = await res.json() as { ok: boolean; result?: TelegramUpdate[] };
    } catch (err) {
      console.warn('[telegram-adapter] pollOne JSON parse failed:', err);
      return null;
    }

    if (!body.ok || !body.result || body.result.length === 0) {
      return null;
    }

    const update = body.result[0];
    const updateId = update.update_id;

    // Dedup check
    const dedupKey = `telegram:update:${updateId}`;
    if (checkDedup(dedupKey)) {
      // Already processed — advance offset and skip
      setChannelOffset('telegram:poll', String(updateId + 1));
      return null;
    }

    // Process the update
    const message = this.parseUpdate(update);

    // Advance offset and record dedup
    setChannelOffset('telegram:poll', String(updateId + 1));
    insertDedup(dedupKey);

    if (!message) return null;

    message.updateId = updateId;
    return message;
  }

  private parseUpdate(update: TelegramUpdate): InboundMessage | null {
    // Callback query
    if (update.callback_query) {
      return this.parseCallbackQuery(update.callback_query, update.update_id);
    }

    // Regular message
    if (update.message) {
      return this.parseMessage(update.message, update.update_id);
    }

    return null;
  }

  private parseCallbackQuery(cbq: TelegramCallbackQuery, _updateId: number): InboundMessage | null {
    const chatId = cbq.message?.chat.id;
    if (!chatId) return null;

    const userId = String(cbq.from.id);
    const displayName = [cbq.from.first_name, cbq.from.last_name].filter(Boolean).join(' ');

    return {
      messageId: cbq.id,
      address: {
        channelType: 'telegram',
        chatId: String(chatId),
        userId,
        displayName,
      },
      text: cbq.data ?? '',
      timestamp: cbq.message?.date ?? Math.floor(Date.now() / 1000),
      callbackData: cbq.data,
      callbackMessageId: cbq.message ? String(cbq.message.message_id) : undefined,
      raw: cbq,
    };
  }

  private parseMessage(msg: TelegramMessage, _updateId: number): InboundMessage | null {
    const chatId = String(msg.chat.id);
    const userId = msg.from ? String(msg.from.id) : undefined;
    const displayName = msg.from
      ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ')
      : undefined;

    const address: ChannelAddress = {
      channelType: 'telegram',
      chatId,
      userId,
      displayName,
    };

    // Text or caption
    const rawText = msg.text ?? msg.caption ?? '';
    const { text } = sanitizeInput(rawText);

    const inbound: InboundMessage = {
      messageId: String(msg.message_id),
      address,
      text,
      timestamp: msg.date,
      raw: msg,
    };

    // Photo and document attachments are handled asynchronously
    // by the bridge manager after consumeOne returns — we store
    // the raw message for it. For the synchronous path, we note
    // that attachments will be populated by processMediaAttachments().

    return inbound;
  }

  /**
   * Download and attach media from a raw Telegram message.
   * Called by the bridge manager after consumeOne() returns.
   */
  async processMediaAttachments(message: InboundMessage): Promise<void> {
    const token = getSetting('telegram_bot_token');
    if (!token || !isImageEnabled()) return;

    const raw = message.raw as TelegramMessage | undefined;
    if (!raw) return;

    if (raw.photo && raw.photo.length > 0) {
      const result = await downloadPhoto(token, raw.photo, message.messageId);
      if (result.attachment) {
        message.attachments = message.attachments ?? [];
        message.attachments.push(result.attachment);
      }
    }

    if (raw.document) {
      const result = await downloadDocumentImage(token, raw.document, message.messageId);
      if (result.attachment) {
        message.attachments = message.attachments ?? [];
        message.attachments.push(result.attachment);
      }
    }
  }

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    const token = getSetting('telegram_bot_token');
    if (!token) {
      return { ok: false, error: 'Missing telegram_bot_token' };
    }

    const params: Record<string, unknown> = {
      chat_id: message.address.chatId,
      text: message.text,
    };

    if (message.parseMode && message.parseMode !== 'plain') {
      params.parse_mode = message.parseMode;
    }

    if (message.replyToMessageId) {
      params.reply_to_message_id = parseInt(message.replyToMessageId, 10);
    }

    if (message.inlineButtons && message.inlineButtons.length > 0) {
      params.reply_markup = {
        inline_keyboard: message.inlineButtons.map((row) =>
          row.map((btn) => ({
            text: btn.text,
            callback_data: btn.callbackData,
          })),
        ),
      };
    }

    const result = await callTelegramApi(token, 'sendMessage', params);

    return {
      ok: result.ok,
      messageId: result.messageId,
      error: result.error,
      httpStatus: result.httpStatus,
      retryAfter: result.retryAfter,
    };
  }

  // ── Deliver response (OCP pattern) ──────────────────────────

  async deliverResponse(
    address: ChannelAddress,
    markdownText: string,
    deliverFn: DeliverFn,
    opts?: { sessionId?: string },
  ): Promise<SendResult> {
    // For now: escape HTML and split into chunks.
    // The full markdown-to-HTML pipeline comes in Task 8.
    const escaped = escapeHtml(markdownText);
    const chunks = splitMessage(escaped, this.messageLimit);

    let lastResult: SendResult = { ok: true };

    for (const chunk of chunks) {
      lastResult = await deliverFn(this, {
        address,
        text: chunk,
        parseMode: 'HTML',
      }, opts);

      if (!lastResult.ok) {
        return lastResult;
      }
    }

    return lastResult;
  }

  // ── Callback query ──────────────────────────────────────────

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    const token = getSetting('telegram_bot_token');
    if (!token) return;

    const params: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    };
    if (text) {
      params.text = text;
    }

    await callTelegramApi(token, 'answerCallbackQuery', params);
  }

  // ── Delete messages from chat ─────────────────────────────

  async deleteMessages(chatId: string, messageIds: string[]): Promise<number> {
    const token = getSetting('telegram_bot_token');
    if (!token || messageIds.length === 0) return 0;

    let deleted = 0;
    // Telegram deleteMessage works one at a time
    for (const msgId of messageIds) {
      const numId = parseInt(msgId, 10);
      if (isNaN(numId)) continue;
      try {
        const result = await callTelegramApi(token, 'deleteMessage', {
          chat_id: chatId,
          message_id: numId,
        });
        if (result.ok) deleted++;
      } catch {
        // Message may already be deleted or older than 48h — skip
      }
    }
    return deleted;
  }
}

// ── Self-registration ───────────────────────────────────────────

registerAdapterFactory('telegram', () => new TelegramAdapter());
