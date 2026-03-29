import { CodexProcessManager } from '@/lib/codex-process-manager';
import { formatJsonRpcRequest, getLastRequestId } from '@/lib/codex-jsonrpc';
import type { JsonRpcMessage } from '@/lib/codex-jsonrpc';
import { normalizeCodexUsageResponse } from '@/lib/codex-usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TEMP_SESSION_ID = '__codex_usage__';

let inflightFetch: Promise<unknown> | null = null;

async function sendJsonRpcRequest(
  method: string,
  codexProcess: Awaited<ReturnType<typeof CodexProcessManager.getOrCreate>>,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = formatJsonRpcRequest(method, {});
    const requestId = getLastRequestId();

    const timeout = setTimeout(() => {
      codexProcess.offMessage(handler);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (msg: JsonRpcMessage) => {
      if (msg.type !== 'response' || msg.id !== requestId) return;

      clearTimeout(timeout);
      codexProcess.offMessage(handler);

      if (msg.error) {
        reject(new Error(`${method} failed: ${msg.error.message}`));
        return;
      }

      resolve((msg.result || {}) as Record<string, unknown>);
    };

    codexProcess.onMessage(handler);
    codexProcess.send(request);
  });
}

async function doFetchUsage() {
  const codexProcess = await CodexProcessManager.getOrCreate(TEMP_SESSION_ID);

  try {
    const [accountResult, rateLimitResult] = await Promise.allSettled([
      sendJsonRpcRequest('account/read', codexProcess),
      sendJsonRpcRequest('account/rateLimits/read', codexProcess),
    ]);

    const payload: Record<string, unknown> = {};

    if (accountResult.status === 'fulfilled') {
      Object.assign(payload, accountResult.value);
    } else {
      payload.account = null;
      payload.requiresOpenaiAuth = false;
      payload.accountError = accountResult.reason instanceof Error
        ? accountResult.reason.message
        : 'account/read failed';
    }

    if (rateLimitResult.status === 'fulfilled') {
      Object.assign(payload, rateLimitResult.value);
    } else {
      payload.rateLimits = null;
      payload.rateLimitsByLimitId = null;
      payload.rateLimitError = rateLimitResult.reason instanceof Error
        ? rateLimitResult.reason.message
        : 'account/rateLimits/read failed';
    }

    return normalizeCodexUsageResponse(payload);
  } finally {
    await CodexProcessManager.kill(TEMP_SESSION_ID);
  }
}

export async function GET() {
  try {
    if (!inflightFetch) {
      inflightFetch = doFetchUsage().finally(() => { inflightFetch = null; });
    }

    const usage = await inflightFetch;
    return Response.json(usage);
  } catch (error) {
    console.error('[/api/codex/usage] Failed to fetch usage:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch usage' },
      { status: 500 },
    );
  }
}
