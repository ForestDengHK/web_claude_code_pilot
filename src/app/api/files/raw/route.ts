import { NextRequest } from 'next/server';
import { createReadStream } from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { isPathSafe } from '@/lib/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.xml': 'text/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.jsx': 'application/javascript',
  '.py': 'text/x-python',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.rb': 'text/x-ruby',
  '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.sql': 'text/x-sql',
  '.swift': 'text/x-swift',
  '.kt': 'text/x-kotlin',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.hpp': 'text/x-c++',
  '.cs': 'text/x-csharp',
  '.php': 'text/x-php',
  '.dart': 'text/x-dart',
  '.lua': 'text/x-lua',
  '.zig': 'text/x-zig',
  '.vue': 'text/x-vue',
  '.svelte': 'text/x-svelte',
  '.graphql': 'text/x-graphql',
  '.gql': 'text/x-graphql',
  '.prisma': 'text/x-prisma',
  '.dockerfile': 'text/x-dockerfile',
  '.scss': 'text/x-scss',
  '.less': 'text/x-less',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/**
 * Convert a Node.js Readable stream into a Web ReadableStream<Uint8Array>.
 * Handles cleanup: cancel() destroys the underlying file stream to release the fd.
 */
function nodeStreamToWeb(nodeReadable: import('stream').Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeReadable.pause();
      nodeReadable.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
        // Backpressure: pause the Node stream when the web stream's buffer is full.
        // This prevents unbounded memory growth during rapid video seeking.
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

/**
 * Parse a single-range "Range: bytes=START-END" header.
 * Returns null if absent or malformed. Multi-range is intentionally unsupported
 * (browsers never send multi-range for media).
 */
function parseRange(header: string | null): { start: number; end: number | undefined } | null {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : undefined;
  return { start, end };
}

/**
 * Serve raw file content with HTTP Range support for streaming media.
 *
 * - All responses include `Accept-Ranges: bytes` to signal range capability
 * - Range requests (e.g. video seek) return 206 Partial Content
 * - Files are streamed via fs.createReadStream (no full-file memory buffering)
 * - Exception: text file downloads still use full buffer for BOM prepending
 *
 * Security: only allows reading files within the user's home directory
 * or an explicitly provided baseDir.
 */
export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get('path');

  if (!filePath) {
    return new Response(JSON.stringify({ error: 'path parameter is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const resolved = path.resolve(filePath);
  const homeDir = os.homedir();

  // Scope restriction: only allow files within the user's home directory
  // or within an explicitly provided baseDir (the session's working directory)
  const baseDir = request.nextUrl.searchParams.get('baseDir');
  const allowedRoot = baseDir ? path.resolve(baseDir) : homeDir;
  if (!isPathSafe(allowedRoot, resolved)) {
    return new Response(JSON.stringify({ error: 'File is outside the allowed scope' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await fsp.access(resolved);
  } catch {
    return new Response(JSON.stringify({ error: 'File not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) {
    return new Response(JSON.stringify({ error: 'Not a file' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const fileSize = stat.size;
  const ext = path.extname(resolved).toLowerCase();
  const baseMime = MIME_TYPES[ext] || 'application/octet-stream';
  const isText = baseMime.startsWith('text/');
  const contentType = isText ? `${baseMime}; charset=utf-8` : baseMime;
  const isDownload = request.nextUrl.searchParams.get('download') === '1';
  const disposition = isDownload ? 'attachment' : 'inline';
  const dispositionHeader = `${disposition}; filename="${path.basename(resolved)}"`;

  // ── Text file download: full buffer for BOM prepending (unchanged behavior) ──
  if (isText && isDownload) {
    let buffer = await fsp.readFile(resolved);
    // Prepend UTF-8 BOM for text file downloads so mobile text editors
    // can detect the encoding correctly (without BOM, Chinese/Japanese/etc. become garbled)
    if (buffer.length > 0 && !(buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF)) {
      buffer = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), buffer]);
    }
    return new Response(buffer, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': dispositionHeader,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(buffer.length),
      },
    });
  }

  // ── Range request: 206 Partial Content (enables video/audio seeking) ──
  const rangeHeader = request.headers.get('range');
  const parsed = parseRange(rangeHeader);

  if (parsed !== null) {
    const rangeStart = parsed.start;
    const rangeEnd = parsed.end !== undefined
      ? Math.min(parsed.end, fileSize - 1)
      : fileSize - 1;

    // Unsatisfiable range
    if (rangeStart >= fileSize || rangeStart > rangeEnd) {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${fileSize}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    const chunkSize = rangeEnd - rangeStart + 1;
    const nodeStream = createReadStream(resolved, { start: rangeStart, end: rangeEnd });
    const webStream = nodeStreamToWeb(nodeStream);

    return new Response(webStream, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': dispositionHeader,
        'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${fileSize}`,
        'Content-Length': String(chunkSize),
        'Accept-Ranges': 'bytes',
      },
    });
  }

  // ── Normal request: stream full file (no memory buffering) ──
  const nodeStream = createReadStream(resolved);
  const webStream = nodeStreamToWeb(nodeStream);

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': dispositionHeader,
      'Content-Length': String(fileSize),
      'Accept-Ranges': 'bytes',
    },
  });
}
