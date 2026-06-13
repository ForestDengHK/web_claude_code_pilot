import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { ErrorResponse } from '@/types';

async function getWindowsDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const drives: string[] = [];
  for (let i = 65; i <= 90; i++) {
    const drive = String.fromCharCode(i) + ':\\';
    try {
      await fs.access(drive);
      drives.push(drive);
    } catch {
      // drive not available
    }
  }
  return drives;
}

// Image extensions surfaced when `?images=1` is passed (matches /api/files/raw)
const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp', '.ico',
]);

// List only directories for folder browsing (no safety restriction since user is choosing where to work).
// With `?images=1`, also returns image files in the directory (for the image picker).
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const rawDir = searchParams.get('dir') || os.homedir();
  const wantImages = searchParams.get('images') === '1';

  // Expand a leading `~` so users can paste `~/Desktop/…` paths directly.
  const expanded = rawDir === '~'
    ? os.homedir()
    : rawDir.startsWith('~/')
      ? path.join(os.homedir(), rawDir.slice(2))
      : rawDir;
  const resolvedDir = path.resolve(expanded);

  try {
    await fs.access(resolvedDir);
  } catch {
    return NextResponse.json<ErrorResponse>(
      { error: 'Directory does not exist' },
      { status: 404 }
    );
  }

  try {
    const entries = await fs.readdir(resolvedDir, { withFileTypes: true });
    const directories = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        path: path.join(resolvedDir, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const files = wantImages
      ? entries
          .filter((e) => e.isFile() && !e.name.startsWith('.') && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
          .map((e) => ({
            name: e.name,
            path: path.join(resolvedDir, e.name),
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];

    const drives = await getWindowsDrives();

    return NextResponse.json({
      current: resolvedDir,
      parent: path.dirname(resolvedDir) !== resolvedDir ? path.dirname(resolvedDir) : null,
      directories,
      files,
      drives,
    });
  } catch (err) {
    // macOS protects Desktop/Documents/Downloads — readdir fails with EPERM/EACCES
    // unless the app has Full Disk Access. Make that actionable instead of cryptic.
    const code = (err as NodeJS.ErrnoException)?.code;
    const denied = code === 'EPERM' || code === 'EACCES';
    return NextResponse.json<ErrorResponse>(
      {
        error: denied
          ? "Permission denied — macOS protects this folder. Grant the app Full Disk Access, or paste the full path to a subfolder (e.g. ~/Desktop/your-folder) and press Enter."
          : 'Cannot read directory',
      },
      { status: denied ? 403 : 500 }
    );
  }
}
