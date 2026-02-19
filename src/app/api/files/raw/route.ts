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
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/**
 * Serve raw file content from the user's home directory.
 * Security: only allows reading files within the user's home directory.
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

  try {
    await fs.access(resolved);
  } catch {
    return new Response(JSON.stringify({ error: 'File not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    return new Response(JSON.stringify({ error: 'Not a file' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let buffer = await fs.readFile(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const baseMime = MIME_TYPES[ext] || 'application/octet-stream';
  const isText = baseMime.startsWith('text/');
  const contentType = isText ? `${baseMime}; charset=utf-8` : baseMime;
  const isDownload = request.nextUrl.searchParams.get('download') === '1';
  const disposition = isDownload ? 'attachment' : 'inline';

  // Prepend UTF-8 BOM for text file downloads so mobile text editors
  // can detect the encoding correctly (without BOM, Chinese/Japanese/etc. become garbled)
  if (isText && isDownload && buffer.length > 0 && !(buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF)) {
    buffer = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), buffer]);
  }

  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `${disposition}; filename="${path.basename(resolved)}"`,
    },
  });
}
