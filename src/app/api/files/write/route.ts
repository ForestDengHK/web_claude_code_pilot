import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { isPathSafe, isRootPath } from '@/lib/files';
import type { ErrorResponse } from '@/types';

export async function POST(request: NextRequest) {
  try {
    const { path: filePath, content, baseDir } = await request.json();

    if (!filePath || content === undefined) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Missing path or content' },
        { status: 400 }
      );
    }

    const resolvedPath = path.resolve(filePath);
    const homeDir = os.homedir();

    // Path validation — same logic as preview endpoint
    if (baseDir) {
      const resolvedBase = path.resolve(baseDir);
      if (isRootPath(resolvedBase)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'Cannot use filesystem root as base directory' },
          { status: 403 }
        );
      }
      if (!isPathSafe(resolvedBase, resolvedPath)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'File is outside the project scope' },
          { status: 403 }
        );
      }
    } else {
      if (!isPathSafe(homeDir, resolvedPath)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'File is outside the allowed scope' },
          { status: 403 }
        );
      }
    }

    // Verify file exists (don't create new files)
    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        return NextResponse.json<ErrorResponse>(
          { error: 'Not a file' },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json<ErrorResponse>(
        { error: 'File not found' },
        { status: 404 }
      );
    }

    await fs.writeFile(resolvedPath, content, 'utf-8');

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to write file' },
      { status: 500 }
    );
  }
}
