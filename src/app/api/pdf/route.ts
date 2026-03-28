import { NextRequest, NextResponse } from 'next/server';
import { generatePdf } from '@/lib/pdf-generator';

export async function POST(request: NextRequest) {
  // Guard: reject oversized requests
  const contentLength = parseInt(request.headers.get('content-length') || '0');
  if (contentLength > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'Request too large' }, { status: 413 });
  }

  let body: { markdown?: string; title?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { markdown, title } = body;
  if (!markdown || typeof markdown !== 'string') {
    return NextResponse.json({ error: 'Missing required field: markdown' }, { status: 400 });
  }

  const filename = title || 'download';
  // ASCII-only fallback (same strategy as export route)
  const asciiFilename = filename.replace(/[^a-zA-Z0-9\-_]/g, '') || 'download';
  // RFC 5987 encoding for UTF-8 support
  const utf8Filename = encodeURIComponent(filename);

  try {
    const pdfBuffer = await generatePdf(markdown);

    return new Response(pdfBuffer.buffer as ArrayBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${asciiFilename}.pdf"; filename*=UTF-8''${utf8Filename}.pdf`,
        'Content-Length': String(pdfBuffer.length),
      },
    });
  } catch (error) {
    console.error('[PDF Generation Error]', error);
    return NextResponse.json(
      { error: 'Failed to generate PDF' },
      { status: 500 },
    );
  }
}
