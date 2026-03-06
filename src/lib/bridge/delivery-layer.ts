import type { BaseChannelAdapter } from './channel-adapter';
import type { ChannelAddress, OutboundMessage, SendResult } from './types';
import { checkDedup, insertDedup, insertAuditLog, insertOutboundRef } from './bridge-db';
import { ChatRateLimiter } from './security/rate-limiter';

// Singleton rate limiter for delivery
const rateLimiter = new ChatRateLimiter();

/**
 * Core delivery function — sends a message via the adapter with:
 * 1. Deduplication (skip if dedupKey already seen)
 * 2. Rate limiting (per-chat sliding window)
 * 3. Retry with exponential backoff (on retryAfter or 5xx)
 * 4. Audit logging
 * 5. Outbound ref tracking
 */
export async function deliver(
  adapter: BaseChannelAdapter,
  message: OutboundMessage,
  opts?: { sessionId?: string; dedupKey?: string; maxRetries?: number },
): Promise<SendResult> {
  // 1. Dedup check
  if (opts?.dedupKey && checkDedup(opts.dedupKey)) {
    return { ok: true };
  }

  // 2. Rate limit
  const chatId = message.address.chatId;
  await rateLimiter.acquire(chatId);

  // 3. Send with retry
  const maxRetries = opts?.maxRetries ?? 3;
  let lastResult: SendResult = { ok: false, error: 'No attempt made' };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = await adapter.send(message);

    if (lastResult.ok) {
      break;
    }

    if (lastResult.retryAfter && attempt < maxRetries) {
      await sleep(lastResult.retryAfter * 1000);
    } else if (lastResult.httpStatus && lastResult.httpStatus >= 500 && attempt < maxRetries) {
      await sleep(1000 * Math.pow(2, attempt));
    } else {
      break; // 4xx or exhausted retries
    }
  }

  // 4. Record dedup
  if (opts?.dedupKey && lastResult.ok) {
    insertDedup(opts.dedupKey, 24 * 60 * 60 * 1000); // 24h TTL
  }

  // 5. Audit log
  insertAuditLog({
    channelType: adapter.channelType,
    chatId,
    direction: 'outbound',
    messageId: lastResult.messageId ?? '',
    summary: lastResult.ok
      ? `Delivered (${message.text.length} chars)`
      : `Failed: ${lastResult.error}`,
  });

  // 6. Outbound ref tracking
  if (lastResult.ok && lastResult.messageId && opts?.sessionId) {
    insertOutboundRef({
      channelType: adapter.channelType,
      chatId,
      codepilotSessionId: opts.sessionId,
      platformMessageId: lastResult.messageId,
      purpose: 'response',
    });
  }

  return lastResult;
}

/**
 * Deliver multiple chunks sequentially with the same dedup prefix.
 */
export async function deliverChunks(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  chunks: string[],
  opts?: { sessionId?: string; parseMode?: OutboundMessage['parseMode'] },
): Promise<SendResult> {
  let lastResult: SendResult = { ok: true };

  for (let i = 0; i < chunks.length; i++) {
    lastResult = await deliver(adapter, {
      address,
      text: chunks[i],
      parseMode: opts?.parseMode,
    }, {
      sessionId: opts?.sessionId,
    });

    if (!lastResult.ok) break;
  }

  return lastResult;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Export for testing
export { rateLimiter as _rateLimiter };
