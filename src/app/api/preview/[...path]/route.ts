import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { isPathSafe } from '@/lib/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.xml': 'text/xml',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
};

/**
 * Serve files for HTML preview with relative path resolution.
 *
 * URL pattern: /api/preview/<absolute-filesystem-path>
 * Example:     /api/preview/Users/party/projects/test-page/index.html
 *
 * When the browser resolves relative resources (CSS, JS, images) from the
 * iframe, they naturally resolve against this path — e.g. "style.css" becomes
 * /api/preview/Users/party/projects/test-page/style.css
 *
 * Security: files must be within the user's home directory.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const segments = (await params).path;
  if (!segments || segments.length === 0) {
    return new Response('Not found', { status: 404 });
  }

  // Reconstruct the absolute path from URL segments.
  // The leading "/" was stripped by Next.js routing, so prepend it back.
  const filePath = path.resolve('/' + segments.map(decodeURIComponent).join('/'));

  // Security: only serve files within the user's home directory
  const homeDir = os.homedir();
  if (!isPathSafe(homeDir, filePath)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return new Response('Not a file', { status: 400 });
    }

    const buffer = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const baseMime = MIME_TYPES[ext] || 'application/octet-stream';
    const isText = baseMime.startsWith('text/');
    const contentType = isText ? `${baseMime}; charset=utf-8` : baseMime;

    return new Response(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
