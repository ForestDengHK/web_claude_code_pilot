import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { isPathSafe, isRootPath } from '@/lib/files';
import type { ErrorResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const targetDir = formData.get('targetDir') as string | null;
    const baseDir = formData.get('baseDir') as string | null;

    if (!targetDir || typeof targetDir !== 'string') {
      return NextResponse.json<ErrorResponse>(
        { error: 'Missing targetDir parameter' },
        { status: 400 }
      );
    }

    const resolvedTarget = path.resolve(targetDir);
    const homeDir = os.homedir();

    // Security: same pattern as other file endpoints
    if (baseDir) {
      const resolvedBase = path.resolve(baseDir);
      if (isRootPath(resolvedBase)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'Cannot use filesystem root as base directory' },
          { status: 403 }
        );
      }
      if (!isPathSafe(resolvedBase, resolvedTarget)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'Directory is outside the project scope' },
          { status: 403 }
        );
      }
    } else {
      if (!isPathSafe(homeDir, resolvedTarget)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'Directory is outside the allowed scope' },
          { status: 403 }
        );
      }
    }

    // Validate targetDir exists and is a directory
    let stat;
    try {
      stat = await fs.stat(resolvedTarget);
    } catch {
      return NextResponse.json<ErrorResponse>(
        { error: 'Target directory does not exist' },
        { status: 404 }
      );
    }
    if (!stat.isDirectory()) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Target path is not a directory' },
        { status: 400 }
      );
    }

    // Collect all File entries from the form data
    const files: File[] = [];
    for (const [, value] of formData.entries()) {
      if (value instanceof File) {
        files.push(value);
      }
    }

    if (files.length === 0) {
      return NextResponse.json<ErrorResponse>(
        { error: 'No files provided' },
        { status: 400 }
      );
    }

    // Write each file
    const { MAX_UPLOAD_FILE_SIZE: MAX_FILE_SIZE } = await import('@/lib/config');
    const results: { name: string; path: string; size: number; overwritten: boolean }[] = [];
    for (const file of files) {
      // Security: use basename to strip any path traversal from file.name
      // (e.g., "../../etc/passwd" → "passwd")
      const safeName = path.basename(file.name);
      if (!safeName) continue;

      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json<ErrorResponse>(
          { error: `File "${safeName}" exceeds the 100 MB size limit` },
          { status: 400 }
        );
      }

      const filePath = path.join(resolvedTarget, safeName);

      // Check if file already exists
      let overwritten = false;
      try {
        await fs.stat(filePath);
        overwritten = true;
      } catch {
        // Does not exist — fine
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(filePath, buffer);

      results.push({
        name: safeName,
        path: filePath,
        size: buffer.length,
        overwritten,
      });
    }

    return NextResponse.json({ success: true, files: results });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to upload files' },
      { status: 500 }
    );
  }
}
