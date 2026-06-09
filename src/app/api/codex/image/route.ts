import { NextRequest } from 'next/server';
import { getSession } from '@/lib/db';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getCodePilotDataDir } from '@/lib/data-dir';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
};

/**
 * Serve an image file from disk. Used by the chat UI to render Codex
 * `imageView` thread items (e.g. gpt-image-2 generations).
 *
 * Security: the requested path must resolve to a location under the
 * session's working_directory. This prevents arbitrary file reads when
 * the app is exposed over a network (Tailscale, etc.).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  const rawPath = url.searchParams.get('path');

  if (!sessionId || !rawPath) {
    return new Response('session_id and path are required', { status: 400 });
  }

  const session = getSession(sessionId);
  if (!session) {
    return new Response('Session not found', { status: 404 });
  }
  if (!session.working_directory) {
    return new Response('Session has no working directory', { status: 400 });
  }

  const resolvedPath = path.resolve(rawPath);
  // Whitelist: session's working directory, plus Codex's default
  // generated-images locations (used by the built-in image_gen tool), plus
  // CodePilot's persisted image cache for chat history previews.
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const codePilotImageCache = path.join(getCodePilotDataDir(), 'codex-images');
  const allowedRoots = [
    path.resolve(session.working_directory),
    path.resolve(codexHome),
    path.resolve(codePilotImageCache),
  ];
  const isUnderAllowed = allowedRoots.some((root) =>
    resolvedPath === root || resolvedPath.startsWith(root + path.sep),
  );
  if (!isUnderAllowed) {
    return new Response('Path is outside allowed roots', { status: 403 });
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return new Response('Unsupported file type', { status: 415 });
  }

  let data: Buffer;
  try {
    data = await fs.readFile(resolvedPath);
  } catch {
    return new Response('Image not found', { status: 404 });
  }

  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
