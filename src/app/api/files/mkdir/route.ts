import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { isPathSafe, isRootPath } from '@/lib/files';
import type { ErrorResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { INVALID_NAME_PATTERN } from '@/lib/config';

export async function POST(request: NextRequest) {
  try {
    const { parentDir, name, baseDir } = await request.json();

    if (!parentDir || typeof parentDir !== 'string' || !name || typeof name !== 'string') {
      return NextResponse.json<ErrorResponse>(
        { error: 'Missing parentDir or name parameter' },
        { status: 400 }
      );
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Folder name cannot be empty' },
        { status: 400 }
      );
    }

    if (trimmedName === '.' || trimmedName === '..') {
      return NextResponse.json<ErrorResponse>(
        { error: 'Folder name cannot be . or ..' },
        { status: 400 }
      );
    }

    if (INVALID_NAME_PATTERN.test(trimmedName)) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Folder name contains invalid characters' },
        { status: 400 }
      );
    }

    const resolvedParent = path.resolve(parentDir);
    const homeDir = os.homedir();

    // Security: same pattern as write/route.ts
    if (baseDir) {
      const resolvedBase = path.resolve(baseDir);
      if (isRootPath(resolvedBase)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'Cannot use filesystem root as base directory' },
          { status: 403 }
        );
      }
      if (!isPathSafe(resolvedBase, resolvedParent)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'Directory is outside the project scope' },
          { status: 403 }
        );
      }
    } else {
      if (!isPathSafe(homeDir, resolvedParent)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'Directory is outside the allowed scope' },
          { status: 403 }
        );
      }
    }

    const newDirPath = path.join(resolvedParent, trimmedName);

    // Check if already exists
    try {
      await fs.stat(newDirPath);
      // If stat succeeds, something exists at this path
      return NextResponse.json<ErrorResponse>(
        { error: 'A file or folder with this name already exists' },
        { status: 409 }
      );
    } catch {
      // Does not exist — good, proceed
    }

    await fs.mkdir(newDirPath);

    return NextResponse.json({ success: true, path: newDirPath });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to create folder' },
      { status: 500 }
    );
  }
}
