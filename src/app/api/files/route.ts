import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { scanDirectory, isPathSafe, isRootPath } from '@/lib/files';
import type { FileTreeResponse, ErrorResponse } from '@/types';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const dir = searchParams.get('dir');
  const depth = parseInt(searchParams.get('depth') || '3', 10);

  if (!dir) {
    return NextResponse.json<ErrorResponse>(
      { error: 'Missing dir parameter' },
      { status: 400 }
    );
  }

  const resolvedDir = path.resolve(dir);
  const homeDir = os.homedir();

  // Use baseDir (the session's working directory) as the trust boundary.
  // baseDir is the project root the user explicitly chose — it may be on
  // a different drive than the home directory on Windows (e.g., D:\projects).
  // We only reject root paths (/, C:\) as baseDir to prevent full-disk scans.
  // If no baseDir is provided, fall back to the user's home directory.
  const baseDir = searchParams.get('baseDir');
  if (baseDir) {
    const resolvedBase = path.resolve(baseDir);
    // Prevent using a filesystem root as baseDir (e.g., /, C:\)
    if (isRootPath(resolvedBase)) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Cannot use filesystem root as base directory' },
        { status: 403 }
      );
    }
    if (!isPathSafe(resolvedBase, resolvedDir)) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Directory is outside the project scope' },
        { status: 403 }
      );
    }
  } else {
    // Fallback: without a baseDir, restrict to the user's home directory
    // to prevent scanning arbitrary system directories like /etc
    if (!isPathSafe(homeDir, resolvedDir)) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Directory is outside the allowed scope' },
        { status: 403 }
      );
    }
  }

  try {
    const tree = await scanDirectory(resolvedDir, Math.min(depth, 5));
    return NextResponse.json<FileTreeResponse>({ tree, root: resolvedDir });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to scan directory' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const filePath = searchParams.get('path');
  const baseDir = searchParams.get('baseDir');

  if (!filePath) {
    return NextResponse.json<ErrorResponse>(
      { error: 'Missing path parameter' },
      { status: 400 }
    );
  }

  if (!baseDir) {
    return NextResponse.json<ErrorResponse>(
      { error: 'Missing baseDir parameter' },
      { status: 400 }
    );
  }

  const resolvedPath = path.resolve(filePath);
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

  // Prevent deleting the project root itself
  if (resolvedPath === resolvedBase) {
    return NextResponse.json<ErrorResponse>(
      { error: 'Cannot delete the project root directory' },
      { status: 403 }
    );
  }

  try {
    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      await fs.rm(resolvedPath, { recursive: true });
    } else {
      await fs.unlink(resolvedPath);
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to delete file' },
      { status: 500 }
    );
  }
}
