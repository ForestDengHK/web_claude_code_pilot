/**
 * PATCH /api/codex/skills/[name] — Enable/disable a Codex skill.
 *
 * Spawns a temporary Codex process, sends `skills/config/write`, and returns
 * the effective enabled state. Invalidates the list-route cache on success
 * so the next GET reflects the change.
 */

import { NextRequest } from 'next/server';
import { CodexProcessManager } from '@/lib/codex-process-manager';
import { formatJsonRpcRequest, getLastRequestId } from '@/lib/codex-jsonrpc';
import type { JsonRpcMessage } from '@/lib/codex-jsonrpc';
import { invalidateSkillsCache } from '@/lib/codex-skills-cache';
import { readSkill, writeSkill, deleteSkill } from '@/lib/codex-skill-fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// In-flight mutex: prevents concurrent PATCHes from racing over the same
// Codex process.
let inflightWrite: Promise<{ effectiveEnabled: boolean }> | null = null;

async function doWriteSkillConfig(
  name: string,
  enabled: boolean,
): Promise<{ effectiveEnabled: boolean }> {
  // Per-request UUID so we never share a Codex process with another in-flight
  // call (e.g. a skills-list GET or a model/list). inflightWrite covers
  // same-handler concurrency; UUID covers the cross-handler case.
  const tempSessionId = `__codex_skills_config__:${crypto.randomUUID()}`;
  const codexProcess = await CodexProcessManager.getOrCreate(tempSessionId);

  try {
    return await new Promise<{ effectiveEnabled: boolean }>((resolve, reject) => {
      const req = formatJsonRpcRequest('skills/config/write', { name, enabled });
      const requestId = getLastRequestId();

      const timeout = setTimeout(() => {
        codexProcess.offMessage(handler);
        reject(new Error('skills/config/write timed out after 15s'));
      }, 15_000);

      const handler = (msg: JsonRpcMessage) => {
        if (msg.type === 'response' && msg.id === requestId) {
          clearTimeout(timeout);
          codexProcess.offMessage(handler);

          if (msg.error) {
            reject(new Error(`skills/config/write failed: ${msg.error.message}`));
            return;
          }

          const result = msg.result as { effectiveEnabled?: boolean } | undefined;
          if (typeof result?.effectiveEnabled !== 'boolean') {
            reject(new Error('skills/config/write returned no effectiveEnabled'));
            return;
          }

          resolve({ effectiveEnabled: result.effectiveEnabled });
        }
      };

      codexProcess.onMessage(handler);
      codexProcess.send(req);
    });
  } finally {
    await CodexProcessManager.kill(tempSessionId);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name: rawName } = await params;
  if (!rawName) {
    return Response.json({ error: 'Missing skill name' }, { status: 400 });
  }
  const name = decodeURIComponent(rawName);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== 'boolean') {
    return Response.json(
      { error: '`enabled` must be a boolean' },
      { status: 400 },
    );
  }

  try {
    if (!inflightWrite) {
      inflightWrite = doWriteSkillConfig(name, enabled).finally(() => {
        inflightWrite = null;
      });
    }
    const result = await inflightWrite;
    invalidateSkillsCache();
    return Response.json({ effectiveEnabled: result.effectiveEnabled });
  } catch (error) {
    console.error('[/api/codex/skills/:name] Failed to write config:', error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Failed to write skill config',
      },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// GET: full skill details with content and symlink info
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name: raw } = await params;
  if (!raw) {
    return Response.json({ error: 'Missing skill name' }, { status: 400 });
  }
  const name = decodeURIComponent(raw);
  const skill = readSkill(name);
  if (!skill) {
    return Response.json({ error: 'Skill not found' }, { status: 404 });
  }
  return Response.json({ skill });
}

// ---------------------------------------------------------------------------
// PUT: overwrite SKILL.md
// ---------------------------------------------------------------------------

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name: raw } = await params;
  if (!raw) {
    return Response.json({ error: 'Missing skill name' }, { status: 400 });
  }
  const name = decodeURIComponent(raw);

  let body: { content?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.content !== 'string') {
    return Response.json({ error: 'content must be a string' }, { status: 400 });
  }

  const result = writeSkill(name, body.content);
  if (!result.ok) {
    return Response.json({ error: result.reason }, { status: result.code });
  }
  invalidateSkillsCache();
  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// DELETE: unlink (symlink) or rm -rf (real dir)
// ---------------------------------------------------------------------------

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name: raw } = await params;
  if (!raw) {
    return Response.json({ error: 'Missing skill name' }, { status: 400 });
  }
  const name = decodeURIComponent(raw);

  const result = deleteSkill(name);
  if (!result.ok) {
    return Response.json({ error: result.reason }, { status: result.code });
  }
  invalidateSkillsCache();
  return Response.json({ ok: true, kind: result.kind });
}
