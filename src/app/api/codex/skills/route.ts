/**
 * GET /api/codex/skills — List Codex skills via app-server JSON-RPC.
 *
 * Spawns a temporary Codex process, sends `skills/list`, and returns the
 * skills metadata. Results are cached for 5 minutes to avoid repeated spawns.
 *
 * This endpoint is Codex-only. Claude skills use the separate `/api/skills` endpoint.
 */

import { NextRequest } from 'next/server';
import { CodexProcessManager } from '@/lib/codex-process-manager';
import { formatJsonRpcRequest, getLastRequestId } from '@/lib/codex-jsonrpc';
import type { JsonRpcMessage } from '@/lib/codex-jsonrpc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CodexSkillEntry {
  name: string;
  description: string;
  path: string;
  scope: 'user' | 'repo' | 'system' | 'admin';
  enabled: boolean;
  shortDescription?: string;
  displayName?: string;
  brandColor?: string;
  iconSmall?: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cachedSkills: CodexSkillEntry[] | null = null;
let cachedAt = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const TEMP_SESSION_ID = '__codex_skills__';

// In-flight mutex: prevents concurrent requests from racing over the same
// Codex process (first request would kill it while second is still waiting).
let inflightFetch: Promise<CodexSkillEntry[]> | null = null;

// ---------------------------------------------------------------------------
// Internal fetch logic (separated for mutex wrapping)
// ---------------------------------------------------------------------------

async function doFetchSkills(cwd?: string): Promise<CodexSkillEntry[]> {
  const codexProcess = await CodexProcessManager.getOrCreate(TEMP_SESSION_ID);

  try {
    const skills = await new Promise<CodexSkillEntry[]>((resolve, reject) => {
      const params: Record<string, unknown> = {};
      if (cwd) params.cwds = [cwd];

      const req = formatJsonRpcRequest('skills/list', params);
      const requestId = getLastRequestId();

      const timeout = setTimeout(() => {
        codexProcess.offMessage(handler);
        reject(new Error('skills/list timed out after 15s'));
      }, 15_000);

      const handler = (msg: JsonRpcMessage) => {
        if (msg.type === 'response' && msg.id === requestId) {
          clearTimeout(timeout);
          codexProcess.offMessage(handler);

          if (msg.error) {
            reject(new Error(`skills/list failed: ${msg.error.message}`));
            return;
          }

          // Response: { data: [{ cwd, skills: [...], errors: [...] }] }
          const result = msg.result as {
            data?: Array<{
              cwd: string;
              skills: Array<{
                name: string;
                description: string;
                path: string;
                scope: string;
                enabled: boolean;
                shortDescription?: string;
                interface?: {
                  displayName?: string;
                  shortDescription?: string;
                  brandColor?: string;
                  iconSmall?: string;
                };
              }>;
              errors: Array<{ message: string; path: string }>;
            }>;
          } | undefined;

          const entries: CodexSkillEntry[] = [];
          for (const group of result?.data || []) {
            for (const s of group.skills) {
              if (!s.enabled) continue;
              entries.push({
                name: s.name,
                description: s.interface?.shortDescription || s.shortDescription || s.description || '',
                path: s.path,
                scope: s.scope as CodexSkillEntry['scope'],
                enabled: s.enabled,
                displayName: s.interface?.displayName,
                brandColor: s.interface?.brandColor,
                iconSmall: s.interface?.iconSmall,
              });
            }
          }

          resolve(entries);
        }
      };

      codexProcess.onMessage(handler);
      codexProcess.send(req);
    });

    cachedSkills = skills;
    cachedAt = Date.now();
    return skills;
  } finally {
    await CodexProcessManager.kill(TEMP_SESSION_ID);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const cwd = request.nextUrl.searchParams.get('cwd') || undefined;

  // Return cached skills if fresh
  if (cachedSkills && Date.now() - cachedAt < CACHE_TTL) {
    return Response.json({ skills: cachedSkills });
  }

  try {
    // Mutex: if a fetch is already in-flight, reuse it instead of spawning
    // a second Codex process that would race against the first.
    if (!inflightFetch) {
      inflightFetch = doFetchSkills(cwd).finally(() => { inflightFetch = null; });
    }
    const skills = await inflightFetch;
    return Response.json({ skills });
  } catch (error) {
    console.error('[/api/codex/skills] Failed to fetch skills:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch skills', skills: [] },
      { status: 500 },
    );
  }
}
