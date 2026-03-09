import { CodexProcessManager } from '@/lib/codex-process-manager';
import { formatJsonRpcRequest, getLastRequestId } from '@/lib/codex-jsonrpc';
import type { JsonRpcMessage } from '@/lib/codex-jsonrpc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CachedModel {
  value: string;
  displayName: string;
  description: string;
}

// Cache models to avoid spawning a Codex process on every request
let cachedModels: CachedModel[] | null = null;
let cachedAt = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

const TEMP_SESSION_ID = '__codex_models__';

export async function GET() {
  // Return cached models if fresh
  if (cachedModels && Date.now() - cachedAt < CACHE_TTL) {
    return Response.json({ models: cachedModels });
  }

  try {
    // Spawn a temporary Codex process to query models
    const codexProcess = await CodexProcessManager.getOrCreate(TEMP_SESSION_ID);

    try {
      const models = await new Promise<CachedModel[]>((resolve, reject) => {
        const request = formatJsonRpcRequest('model/list', {});
        const requestId = getLastRequestId();

        const timeout = setTimeout(() => {
          codexProcess.offMessage(handler);
          reject(new Error('model/list timed out after 15s'));
        }, 15_000);

        const handler = (msg: JsonRpcMessage) => {
          if (msg.type === 'response' && msg.id === requestId) {
            clearTimeout(timeout);
            codexProcess.offMessage(handler);

            if (msg.error) {
              reject(new Error(`model/list failed: ${msg.error.message}`));
              return;
            }

            const result = msg.result as { models?: Array<{ id?: string; name?: string; description?: string }> } | undefined;
            const modelList = result?.models || [];

            resolve(
              modelList.map((m) => ({
                value: m.id || m.name || '',
                displayName: m.name || m.id || '',
                description: m.description || '',
              })),
            );
          }
        };

        codexProcess.onMessage(handler);
        codexProcess.send(request);
      });

      cachedModels = models;
      cachedAt = Date.now();
      return Response.json({ models: cachedModels });
    } finally {
      // Kill the temporary process after getting models
      await CodexProcessManager.kill(TEMP_SESSION_ID);
    }
  } catch (error) {
    console.error('[/api/codex/models] Failed to fetch models:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch models', models: [] },
      { status: 500 },
    );
  }
}
