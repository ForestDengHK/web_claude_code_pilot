/**
 * Telegram-specific utility functions for the bridge adapter.
 */

const TELEGRAM_API = 'https://api.telegram.org';

export interface TelegramSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  httpStatus?: number;
  retryAfter?: number;
}

export interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id?: number; [key: string]: unknown };
  description?: string;
  parameters?: { retry_after?: number; [key: string]: unknown };
}

/**
 * Call the Telegram Bot API via POST.
 */
export async function callTelegramApi(
  botToken: string,
  method: string,
  params: Record<string, unknown>,
): Promise<TelegramSendResult> {
  const url = `${TELEGRAM_API}/bot${botToken}/${method}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const httpStatus = res.status;

  let body: TelegramApiResponse;
  try {
    body = (await res.json()) as TelegramApiResponse;
  } catch {
    return { ok: false, error: 'Invalid JSON response from Telegram', httpStatus };
  }

  if (body.ok && body.result) {
    return {
      ok: true,
      messageId: body.result.message_id != null ? String(body.result.message_id) : undefined,
      httpStatus,
    };
  }

  return {
    ok: false,
    error: body.description ?? 'Unknown Telegram API error',
    httpStatus,
    retryAfter: body.parameters?.retry_after,
  };
}

/**
 * Send (or edit) a draft message for streaming preview.
 * Truncates text to 4096 chars (Telegram limit).
 */
export async function sendMessageDraft(
  botToken: string,
  chatId: string,
  text: string,
  draftId: number,
): Promise<TelegramSendResult> {
  const truncated = text.length > 4096 ? text.slice(0, 4093) + '...' : text;

  if (draftId === 0) {
    // First draft — send a new message
    return callTelegramApi(botToken, 'sendMessage', {
      chat_id: chatId,
      text: truncated,
      parse_mode: 'HTML',
    });
  }

  // Subsequent drafts — edit existing message
  return callTelegramApi(botToken, 'editMessageText', {
    chat_id: chatId,
    message_id: draftId,
    text: truncated,
    parse_mode: 'HTML',
  });
}

/**
 * Escape special HTML characters for Telegram HTML parse mode.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Split a long message into chunks that respect the max length,
 * preferring to split at line boundaries.
 */
export function splitMessage(text: string, maxLength: number = 4096): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a newline to split at within the limit
    const slice = remaining.slice(0, maxLength);
    const lastNewline = slice.lastIndexOf('\n');

    let splitAt: number;
    if (lastNewline > 0) {
      splitAt = lastNewline + 1; // include the newline in the current chunk
    } else {
      // No newline found — hard split at maxLength
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

/**
 * Format a session header line for Telegram messages (HTML mode).
 */
export function formatSessionHeader(
  opts?: { title?: string; workDir?: string },
): string {
  if (!opts) return '';

  const parts: string[] = [];

  if (opts.title) {
    parts.push(`<b>${escapeHtml(opts.title)}</b>`);
  }

  if (opts.workDir) {
    parts.push(`<code>${escapeHtml(opts.workDir)}</code>`);
  }

  return parts.join('\n');
}
