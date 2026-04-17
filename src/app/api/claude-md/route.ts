/**
 * GET /api/claude-md?scope=user
 * GET /api/claude-md?scope=project&cwd=/abs/path
 *   → { exists, content, path, mtimeMs? }
 *
 * PUT /api/claude-md   body: { scope, cwd?, content }
 *   → { ok: true, path } | { error, code }
 *
 * Thin wrapper around `src/lib/claude-md-fs.ts`. All path/size validation
 * lives there; this file is only responsible for the HTTP transport.
 */

import { NextRequest } from 'next/server';
import {
  readClaudeMd,
  writeClaudeMd,
  type ClaudeMdScope,
} from '@/lib/claude-md-fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isScope(v: unknown): v is ClaudeMdScope {
  return v === 'user' || v === 'project';
}

export async function GET(request: NextRequest) {
  const scope = request.nextUrl.searchParams.get('scope');
  const cwd = request.nextUrl.searchParams.get('cwd') ?? undefined;

  if (!isScope(scope)) {
    return Response.json(
      { error: 'scope must be "user" or "project"' },
      { status: 400 },
    );
  }

  try {
    const result = readClaudeMd(scope, cwd);
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'read failed' },
      { status: 400 },
    );
  }
}

export async function PUT(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { scope, cwd, content } = (body ?? {}) as {
    scope?: unknown;
    cwd?: unknown;
    content?: unknown;
  };

  if (!isScope(scope)) {
    return Response.json(
      { error: 'scope must be "user" or "project"' },
      { status: 400 },
    );
  }
  if (cwd !== undefined && typeof cwd !== 'string') {
    return Response.json(
      { error: 'cwd must be a string when provided' },
      { status: 400 },
    );
  }
  if (typeof content !== 'string') {
    return Response.json(
      { error: 'content must be a string' },
      { status: 400 },
    );
  }

  const result = writeClaudeMd(scope, content, cwd);
  if (result.ok) {
    return Response.json({ ok: true, path: result.path });
  }
  return Response.json(
    { error: result.reason },
    { status: result.code },
  );
}
