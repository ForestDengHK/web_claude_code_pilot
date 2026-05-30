import { CodexProcessManager } from '@/lib/codex-process-manager';
import { formatJsonRpcRequest, getLastRequestId } from '@/lib/codex-jsonrpc';
import type { JsonRpcMessage } from '@/lib/codex-jsonrpc';
import { repairCodexBinary } from '@/lib/codex-binary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ReasoningEffortOption {
  value: string;
  label: string;
}

interface CachedModel {
  value: string;
  displayName: string;
  description: string;
  reasoningEfforts?: ReasoningEffortOption[];
  defaultEffort?: string;
}

// Cache models to avoid spawning a Codex process on every request
let cachedModels: CachedModel[] | null = null;
let cachedAt = 0;
import { MODELS_CACHE_TTL as CACHE_TTL } from '@/lib/config';

/**
 * Spawn a throwaway Codex process and ask it for the model list. Throws if the
 * handshake or model/list times out (the symptom of a hung codex binary).
 */
async function fetchModelsFromCodex(): Promise<CachedModel[]> {
  // Per-request UUID so concurrent requests don't share a temp Codex process
  // (shared ID caused `model/list timed out after 15s` when one request's
  // kill() tore down the proc before a peer's response arrived).
  const tempSessionId = `__codex_models__:${crypto.randomUUID()}`;

  const codexProcess = await CodexProcessManager.getOrCreate(tempSessionId);
  try {
    return await new Promise<CachedModel[]>((resolve, reject) => {
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

          // Codex model/list returns { data: [...] } not { models: [...] }
          const result = msg.result as {
            data?: Array<{
              id?: string;
              displayName?: string;
              description?: string;
              supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>;
              defaultReasoningEffort?: string;
            }>;
          } | undefined;
          const modelList = result?.data || [];

          resolve(
            modelList.map((m) => {
              const efforts = m.supportedReasoningEfforts;
              const hasEfforts = efforts && efforts.length > 1;
              return {
                value: m.id || '',
                displayName: m.displayName || m.id || '',
                description: m.description || '',
                // Only include reasoning efforts if the model has more than one option
                ...(hasEfforts ? {
                  reasoningEfforts: efforts.map((e) => ({
                    value: e.reasoningEffort,
                    label: e.description || e.reasoningEffort,
                  })),
                  defaultEffort: m.defaultReasoningEffort || efforts[0].reasoningEffort,
                } : {}),
              };
            }),
          );
        }
      };

      codexProcess.onMessage(handler);
      codexProcess.send(request);
    });
  } finally {
    // Kill the temporary process after getting models
    await CodexProcessManager.kill(tempSessionId);
  }
}

export async function GET() {
  // Return cached models if fresh
  if (cachedModels && Date.now() - cachedAt < CACHE_TTL) {
    return Response.json({ models: cachedModels });
  }

  try {
    let models: CachedModel[];
    try {
      models = await fetchModelsFromCodex();
    } catch (firstError) {
      // A timeout here usually means the installed codex binary's inode is hung
      // in dyld (see codex-binary.ts). Try to self-heal with a fresh-inode copy,
      // then retry once before giving up.
      console.warn('[/api/codex/models] codex query failed, attempting repair:', firstError);
      const repair = await repairCodexBinary();
      if (!repair.repaired) throw firstError;
      console.warn(`[/api/codex/models] codex repaired via ${repair.method}; retrying`);
      models = await fetchModelsFromCodex();
    }

    cachedModels = models;
    cachedAt = Date.now();
    return Response.json({ models: cachedModels });
  } catch (error) {
    console.error('[/api/codex/models] Failed to fetch models:', error);
    // Don't blank the UI on a transient failure: serve the last known list if
    // we have one. Only return an empty list when we've never succeeded.
    if (cachedModels) {
      return Response.json({ models: cachedModels, stale: true });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch models', models: [] },
      { status: 500 },
    );
  }
}
