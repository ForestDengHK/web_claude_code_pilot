import { NextRequest } from 'next/server';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import archiver from 'archiver';
import { isPathSafe, collectArchiveEntries } from '@/lib/files';
import { getSession } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Convert a Node.js Readable stream into a Web ReadableStream<Uint8Array> with
 * backpressure. Mirrors the helper in `../raw/route.ts`: pause/resume keeps the
 * archiver from buffering the whole zip in memory while the client downloads.
 */
function nodeStreamToWeb(nodeReadable: import('stream').Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeReadable.pause();
      nodeReadable.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          nodeReadable.pause();
        }
      });
      nodeReadable.on('end', () => controller.close());
      nodeReadable.on('error', (err) => controller.error(err));
    },
    pull() {
      nodeReadable.resume();
    },
    cancel() {
      // Client aborted (closed tab / cancelled download): stop archiving so we
      // don't keep reading files for a download nobody is receiving.
      nodeReadable.destroy();
    },
  });
}

/**
 * Stream a directory as a downloadable zip archive.
 *
 * Heavy/noise dirs (node_modules, .git, .next, …) are excluded via
 * collectArchiveEntries — see `@/lib/files`. The zip is produced on the fly
 * (no temp file, no full-archive memory buffering) so large folders stay safe.
 *
 * Security: same scope as `../raw/route.ts` — only paths within the user's home
 * directory, the system temp dirs, an optional `baseDir`, or the session's
 * working directory are allowed.
 */
export async function GET(request: NextRequest) {
  const dirPath = request.nextUrl.searchParams.get('path');

  if (!dirPath) {
    return new Response(JSON.stringify({ error: 'path parameter is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const homeDir = os.homedir();
  const baseDir = request.nextUrl.searchParams.get('baseDir');
  const sessionId = request.nextUrl.searchParams.get('session_id');
  const allowedRoots: string[] = [homeDir, '/tmp', '/private/tmp', os.tmpdir()];
  if (baseDir) allowedRoots.push(path.resolve(baseDir));
  let sessionWorkingDir: string | undefined;
  if (sessionId) {
    const session = getSession(sessionId);
    if (session?.working_directory) {
      sessionWorkingDir = path.resolve(session.working_directory);
      allowedRoots.push(sessionWorkingDir);
    }
  }

  // Expand a leading `~`, then resolve (relative paths fall back to the session
  // working dir when available, otherwise process cwd) — matches the raw route.
  const expanded = dirPath === '~'
    ? homeDir
    : dirPath.startsWith('~/')
      ? path.join(homeDir, dirPath.slice(2))
      : dirPath;
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : sessionWorkingDir
      ? path.resolve(sessionWorkingDir, expanded)
      : path.resolve(expanded);

  const isAllowed = allowedRoots.some((root) => isPathSafe(root, resolved));
  if (!isAllowed) {
    return new Response(JSON.stringify({ error: 'Folder is outside the allowed scope' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    return new Response(JSON.stringify({ error: 'Folder not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!stat.isDirectory()) {
    return new Response(JSON.stringify({ error: 'Not a directory' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const folderName = path.basename(resolved) || 'download';
  const entries = await collectArchiveEntries(resolved);

  const archive = archiver('zip', { zlib: { level: 6 } });
  // ENOENT warnings happen when a file vanishes mid-walk; log others but keep going.
  archive.on('warning', (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[files/archive] archiver warning:', err);
    }
  });

  const webStream = nodeStreamToWeb(archive);

  // Append + finalize concurrently with the client consuming the stream. Errors
  // surface to the client via the stream's 'error' handler (controller.error).
  void (async () => {
    try {
      for (const { absPath, name } of entries) {
        archive.file(absPath, { name });
      }
      await archive.finalize();
    } catch (err) {
      archive.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  // RFC 5987: ASCII fallback + UTF-8 encoded name so non-ASCII (e.g. Chinese)
  // folder names download with a correct filename.
  const asciiName = folderName.replace(/[^\x20-\x7e]/g, '_') || 'download';
  const disposition =
    `attachment; filename="${asciiName}.zip"; ` +
    `filename*=UTF-8''${encodeURIComponent(folderName)}.zip`;

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': disposition,
      'Cache-Control': 'no-store',
    },
  });
}
