#!/usr/bin/env node

// Post-build script for Next.js standalone mode:
// 1. Copies codepilot-server.js into .next/standalone/
// 2. Symlinks .next/static into .next/standalone/.next/static (CSS/JS bundles)
// 3. Symlinks public into .next/standalone/public (static assets)

import { copyFileSync, existsSync, symlinkSync, rmSync, lstatSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const standaloneDir = join(projectRoot, '.next', 'standalone');

if (!existsSync(standaloneDir)) {
  console.error(
    '[prepare-server] .next/standalone/ does not exist. Run `next build` first.'
  );
  process.exit(1);
}

// Helper: remove existing file/symlink/dir at path, then create symlink
function forceSymlink(target, linkPath, label) {
  try {
    const stat = lstatSync(linkPath);
    // Remove whatever is there (symlink, file, or directory)
    rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // Doesn't exist, that's fine
  }
  symlinkSync(target, linkPath, 'dir');
  console.log(`[prepare-server] Symlinked ${label}`);
}

// 1. Copy codepilot-server.js
const serverSrc = join(projectRoot, 'codepilot-server.js');
const serverDest = join(standaloneDir, 'codepilot-server.js');
if (!existsSync(serverSrc)) {
  console.error('[prepare-server] codepilot-server.js not found at:', serverSrc);
  process.exit(1);
}
copyFileSync(serverSrc, serverDest);
console.log('[prepare-server] Copied codepilot-server.js -> .next/standalone/');

// 2. Symlink .next/static -> .next/standalone/.next/static
const staticSrc = join(projectRoot, '.next', 'static');
const staticDest = join(standaloneDir, '.next', 'static');
if (existsSync(staticSrc)) {
  forceSymlink(staticSrc, staticDest, '.next/static -> .next/standalone/.next/static');
}

// 3. Symlink public -> .next/standalone/public
const publicSrc = join(projectRoot, 'public');
const publicDest = join(standaloneDir, 'public');
if (existsSync(publicSrc)) {
  forceSymlink(publicSrc, publicDest, 'public -> .next/standalone/public');
}
