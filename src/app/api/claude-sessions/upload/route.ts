import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import {
  encodeProjectPath,
  getClaudeProjectsDir,
} from '@/lib/claude-session-parser';
import { importClaudeSessionById } from '@/lib/claude-session-import';
import { MAX_SESSION_FILE_SIZE } from '@/lib/config';

interface UploadMetaEntry {
  sessionId: string;
  originalCwd: string;
  /** Empty string means "keep originalCwd". */
  targetCwd: string;
}

interface UploadResultEntry {
  sessionId: string;
  status: 'imported' | 'already-exists' | 'invalid' | 'too-large' | 'no-cwd' | 'write-failed' | 'parse-failed' | 'empty';
  /** Reason / detail for non-imported entries. */
  detail?: string;
  /** Set when status === 'imported'. */
  codepilotSessionId?: string;
  /** Set when status === 'already-exists' and the duplicate is already imported in CodePilot. */
  existingCodepilotSessionId?: string;
  /** The cwd we resolved to (target if remapped, else original). */
  resolvedCwd?: string;
}

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const metaRaw = formData.get('metadata');
    if (typeof metaRaw !== 'string') {
      return Response.json({ error: 'metadata field is required' }, { status: 400 });
    }

    let metadata: UploadMetaEntry[];
    try {
      metadata = JSON.parse(metaRaw);
    } catch {
      return Response.json({ error: 'metadata is not valid JSON' }, { status: 400 });
    }
    if (!Array.isArray(metadata) || metadata.length === 0) {
      return Response.json({ error: 'metadata must be a non-empty array' }, { status: 400 });
    }

    const files = formData.getAll('files');
    if (files.length !== metadata.length) {
      return Response.json(
        { error: `files.length (${files.length}) does not match metadata.length (${metadata.length})` },
        { status: 400 },
      );
    }

    const projectsDir = getClaudeProjectsDir();
    const existingSessionIds = collectExistingSessionIds(projectsDir);

    const results: UploadResultEntry[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const meta = metadata[i];
      results.push(await handleOneUpload(file, meta, projectsDir, existingSessionIds));
    }

    return Response.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[POST /api/claude-sessions/upload] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}

async function handleOneUpload(
  file: FormDataEntryValue,
  meta: UploadMetaEntry,
  projectsDir: string,
  existingSessionIds: Set<string>,
): Promise<UploadResultEntry> {
  if (!meta || typeof meta.sessionId !== 'string' || !SESSION_ID_PATTERN.test(meta.sessionId)) {
    return { sessionId: meta?.sessionId ?? '?', status: 'invalid', detail: 'invalid sessionId' };
  }

  if (typeof file === 'string' || !(file instanceof File)) {
    return { sessionId: meta.sessionId, status: 'invalid', detail: 'expected File entry' };
  }

  if (existingSessionIds.has(meta.sessionId)) {
    // The file already exists on disk. It may or may not be imported into CodePilot
    // already — surface the CodePilot session id when we can find it.
    const existing = await findExistingCodepilotSession(meta.sessionId);
    return {
      sessionId: meta.sessionId,
      status: 'already-exists',
      detail: 'a session with this id already exists on the server',
      ...(existing ? { existingCodepilotSessionId: existing } : {}),
    };
  }

  if (file.size > MAX_SESSION_FILE_SIZE) {
    return { sessionId: meta.sessionId, status: 'too-large', detail: `${file.size} bytes` };
  }

  const targetCwd = (meta.targetCwd || meta.originalCwd || '').trim();
  if (!targetCwd) {
    return { sessionId: meta.sessionId, status: 'no-cwd' };
  }
  // Only accept absolute paths so the encoded directory cannot escape projectsDir.
  // Unix: starts with '/'.   Windows: starts with a drive letter + ':' + slash.
  const isAbsolute = targetCwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(targetCwd);
  if (!isAbsolute) {
    return { sessionId: meta.sessionId, status: 'invalid', detail: 'cwd must be absolute' };
  }

  let content: string;
  try {
    content = await file.text();
  } catch (e) {
    return { sessionId: meta.sessionId, status: 'parse-failed', detail: (e as Error).message };
  }

  if (meta.originalCwd && meta.originalCwd !== targetCwd) {
    content = remapCwdInJsonl(content, meta.originalCwd, targetCwd);
  }

  const encodedDir = encodeProjectPath(targetCwd);
  const targetDir = path.join(projectsDir, encodedDir);
  const targetFile = path.join(targetDir, `${meta.sessionId}.jsonl`);

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetFile, content, 'utf-8');
    existingSessionIds.add(meta.sessionId);
  } catch (e) {
    return { sessionId: meta.sessionId, status: 'write-failed', detail: (e as Error).message };
  }

  // Auto-import into CodePilot now that the file is on disk in the right place.
  const importResult = importClaudeSessionById(meta.sessionId);
  if (!importResult.ok) {
    if (importResult.reason === 'already-imported') {
      return {
        sessionId: meta.sessionId,
        status: 'already-exists',
        detail: 'already imported into CodePilot',
        existingCodepilotSessionId: importResult.existingCodepilotSessionId,
        resolvedCwd: targetCwd,
      };
    }
    if (importResult.reason === 'empty') {
      return { sessionId: meta.sessionId, status: 'empty', resolvedCwd: targetCwd };
    }
    return { sessionId: meta.sessionId, status: 'parse-failed', detail: importResult.reason, resolvedCwd: targetCwd };
  }

  return {
    sessionId: meta.sessionId,
    status: 'imported',
    codepilotSessionId: importResult.codepilotSessionId,
    resolvedCwd: targetCwd,
  };
}

function collectExistingSessionIds(projectsDir: string): Set<string> {
  const ids = new Set<string>();
  if (!fs.existsSync(projectsDir)) return ids;
  try {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      try {
        const fnames = fs.readdirSync(path.join(projectsDir, dir.name));
        for (const fname of fnames) {
          if (fname.endsWith('.jsonl')) {
            ids.add(fname.replace(/\.jsonl$/, ''));
          }
        }
      } catch {
        // skip unreadable subdir
      }
    }
  } catch {
    // skip unreadable projectsDir
  }
  return ids;
}

async function findExistingCodepilotSession(sdkSessionId: string): Promise<string | null> {
  const { getAllSessions } = await import('@/lib/db');
  const found = getAllSessions().find(s => s.sdk_session_id === sdkSessionId);
  return found?.id ?? null;
}

/**
 * Rewrite the `cwd` field in every JSONL entry from `from` to `to`, leaving
 * other fields and unparseable lines untouched.
 */
function remapCwdInJsonl(content: string, from: string, to: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.cwd === from) {
        entry.cwd = to;
        out.push(JSON.stringify(entry));
        continue;
      }
    } catch {
      // fall through — keep original line
    }
    out.push(line);
  }
  return out.join('\n');
}
