#!/usr/bin/env node

// Post-build script for Next.js standalone mode:
// 1. Copies codepilot-server.js into .next/standalone/
// 2. Symlinks .next/static into .next/standalone/.next/static (CSS/JS bundles)
// 3. Symlinks public into .next/standalone/public (static assets)

import { copyFileSync, existsSync, mkdirSync, symlinkSync, rmSync, lstatSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildSync } from 'esbuild';

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
  // Ensure the parent .next/ dir exists inside standalone (Turbopack may not create it)
  mkdirSync(join(standaloneDir, '.next'), { recursive: true });
  forceSymlink(staticSrc, staticDest, '.next/static -> .next/standalone/.next/static');
}

// 3. Symlink public -> .next/standalone/public
const publicSrc = join(projectRoot, 'public');
const publicDest = join(standaloneDir, 'public');
if (existsSync(publicSrc)) {
  forceSymlink(publicSrc, publicDest, 'public -> .next/standalone/public');
}

// 4. Bundle terminal-ws-server.ts → .next/standalone/terminal-ws-server.js
// Native modules (node-pty, better-sqlite3) are marked external — loaded from
// .next/standalone/node_modules/ at runtime via the symlinks created in step 5.
const wsServerSrc = join(projectRoot, 'scripts', 'terminal-ws-server.ts');
const wsServerDest = join(standaloneDir, 'terminal-ws-server.js');

if (existsSync(wsServerSrc)) {
  buildSync({
    entryPoints: [wsServerSrc],
    outfile: wsServerDest,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // External: native addons and ESM-only packages that can't be bundled
    external: ['node-pty', 'ws', 'better-sqlite3', 'nanoid'],
  });
  console.log('[prepare-server] Bundled terminal-ws-server.ts -> .next/standalone/terminal-ws-server.js');
} else {
  console.warn('[prepare-server] terminal-ws-server.ts not found — skipping terminal bundle');
}

// 5. Symlink WS server's runtime deps into standalone/node_modules/
// (Next.js standalone only traces modules imported by Next.js code, not the WS server)
// Include better-sqlite3: it's in serverExternalPackages so Next.js traces it,
// but we symlink it explicitly to ensure it's present for the WS server bundle too.
const wsRuntimeDeps = ['node-pty', 'ws', 'nanoid', 'better-sqlite3'];
for (const dep of wsRuntimeDeps) {
  const depSrc = join(projectRoot, 'node_modules', dep);
  const depDest = join(standaloneDir, 'node_modules', dep);
  if (existsSync(depSrc)) {
    forceSymlink(depSrc, depDest, `node_modules/${dep}`);
  } else {
    console.warn(`[prepare-server] ${dep} not found in node_modules — run npm install`);
  }
}
