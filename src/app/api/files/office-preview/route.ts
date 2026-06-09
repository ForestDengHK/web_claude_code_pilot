import { NextRequest } from 'next/server';
import { createReadStream } from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile as execFileCb } from 'child_process';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { promisify } from 'util';
import { isPathSafe, isRootPath } from '@/lib/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFileCb);

const OFFICE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
]);

const SOFFICE_CANDIDATES = [
  process.env.LIBREOFFICE_PATH,
  'soffice',
  'libreoffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/opt/homebrew/bin/soffice',
  '/usr/local/bin/soffice',
].filter(Boolean) as string[];

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
      nodeReadable.destroy();
    },
  });
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function commandExists(command: string): Promise<boolean> {
  if (command.includes(path.sep)) {
    try {
      await fsp.access(command);
      return true;
    } catch {
      return false;
    }
  }

  try {
    await execFileAsync('which', [command], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function findSoffice(): Promise<string | null> {
  for (const candidate of SOFFICE_CANDIDATES) {
    if (await commandExists(candidate)) return candidate;
  }
  return null;
}

async function resolveAuthorizedPath(request: NextRequest, filePath: string): Promise<string | Response> {
  const homeDir = os.homedir();
  const baseDir = request.nextUrl.searchParams.get('baseDir');
  const expanded = filePath === '~'
    ? homeDir
    : filePath.startsWith('~/')
      ? path.join(homeDir, filePath.slice(2))
      : filePath;
  const resolved = path.resolve(expanded);

  if (baseDir) {
    const resolvedBase = path.resolve(baseDir);
    if (isRootPath(resolvedBase)) {
      return jsonError('Cannot use filesystem root as base directory', 403);
    }
    if (!isPathSafe(resolvedBase, resolved)) {
      return jsonError('File is outside the project scope', 403);
    }
  } else if (!isPathSafe(homeDir, resolved)) {
    return jsonError('File is outside the allowed scope', 403);
  }

  return resolved;
}

function computeCacheKey(resolvedPath: string, stat: { size: number; mtimeMs: number }): string {
  return createHash('sha256')
    .update(`${resolvedPath}\0${stat.size}\0${stat.mtimeMs}`)
    .digest('hex');
}

async function convertOfficeToPdf(resolvedPath: string, stat: { size: number; mtimeMs: number }) {
  const soffice = await findSoffice();
  if (!soffice) {
    throw new Error('LibreOffice is required for Office previews. Install LibreOffice or set LIBREOFFICE_PATH to the soffice executable.');
  }

  const cacheKey = computeCacheKey(resolvedPath, stat);
  const cacheDir = path.join(os.tmpdir(), 'codepilot-office-preview', cacheKey);
  await fsp.mkdir(cacheDir, { recursive: true });

  const expectedPdf = path.join(cacheDir, `${path.basename(resolvedPath, path.extname(resolvedPath))}.pdf`);
  try {
    await fsp.access(expectedPdf);
    return expectedPdf;
  } catch {
    // Convert below.
  }

  const profileDir = path.join(cacheDir, 'lo-profile');
  await fsp.mkdir(profileDir, { recursive: true });

  await execFileAsync(
    soffice,
    [
      '--headless',
      '--nologo',
      '--nofirststartwizard',
      '--nodefault',
      '--nolockcheck',
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--convert-to',
      'pdf',
      '--outdir',
      cacheDir,
      resolvedPath,
    ],
    { timeout: 120000, maxBuffer: 1024 * 1024 * 4 },
  );

  try {
    await fsp.access(expectedPdf);
    return expectedPdf;
  } catch {
    const entries = await fsp.readdir(cacheDir);
    const pdf = entries.find((entry) => entry.toLowerCase().endsWith('.pdf'));
    if (pdf) return path.join(cacheDir, pdf);
    throw new Error('LibreOffice did not produce a PDF preview for this file.');
  }
}

export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get('path');
  if (!filePath) {
    return jsonError('path parameter is required', 400);
  }

  const resolvedOrResponse = await resolveAuthorizedPath(request, filePath);
  if (resolvedOrResponse instanceof Response) return resolvedOrResponse;
  const resolved = resolvedOrResponse;

  const ext = path.extname(resolved).toLowerCase();
  if (!OFFICE_EXTENSIONS.has(ext)) {
    return jsonError('Unsupported Office preview file type', 415);
  }

  let sourceStat;
  try {
    sourceStat = await fsp.stat(resolved);
  } catch {
    return jsonError('File not found', 404);
  }
  if (!sourceStat.isFile()) {
    return jsonError('Not a file', 400);
  }

  // The preview URL is identical no matter what the source file contains, so a
  // plain max-age would let the browser keep serving a stale PDF after the user
  // edits the document. Tie an ETag to size+mtime (the same identity the disk
  // cache uses) and require revalidation: an unchanged file returns 304, while
  // an edited one re-converts.
  const etag = `"${computeCacheKey(resolved, sourceStat)}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': 'private, no-cache' },
    });
  }

  try {
    const pdfPath = await convertOfficeToPdf(resolved, sourceStat);
    const pdfStat = await fsp.stat(pdfPath);
    const nodeStream = createReadStream(pdfPath);
    const safePdfName = `${path.basename(resolved, ext)}.pdf`.replace(/["\r\n]/g, '_');
    return new Response(nodeStreamToWeb(nodeStream), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${safePdfName}"`,
        'Content-Length': String(pdfStat.size),
        'Cache-Control': 'private, no-cache',
        ETag: etag,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create Office preview';
    const status = message.includes('LibreOffice is required') ? 501 : 500;
    return jsonError(message, status);
  }
}
