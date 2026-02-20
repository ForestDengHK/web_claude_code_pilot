import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

/**
 * Serve files from .codepilot-uploads/ directories.
 * Only allows reading from paths that contain '.codepilot-uploads/' to prevent directory traversal.
 */
export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get('path');

  if (!filePath) {
    return new Response(JSON.stringify({ error: 'path parameter is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Security: only allow files within a .codepilot-uploads/ directory.
  // Verify using path segment check on the resolved path (not substring).
  const resolved = path.resolve(filePath);
  const segments = resolved.split(path.sep);
  if (!segments.includes('.codepilot-uploads')) {
    return new Response(JSON.stringify({ error: 'Access denied' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await fs.access(resolved);
  } catch {
    return new Response(JSON.stringify({ error: 'File not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const buffer = await fs.readFile(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const baseMime = MIME_TYPES[ext] || 'application/octet-stream';
  const contentType = baseMime.startsWith('text/') ? `${baseMime}; charset=utf-8` : baseMime;

  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
