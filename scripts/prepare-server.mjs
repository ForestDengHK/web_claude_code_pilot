#!/usr/bin/env node

// Post-build script: copies codepilot-server.js into .next/standalone/
// so that `node .next/standalone/codepilot-server.js` can wrap and start
// the Next.js generated server.js with user shell environment loaded.

import { copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const src = join(projectRoot, 'codepilot-server.js');
const dest = join(projectRoot, '.next', 'standalone', 'codepilot-server.js');

if (!existsSync(src)) {
  console.error('[prepare-server] codepilot-server.js not found at:', src);
  process.exit(1);
}

if (!existsSync(join(projectRoot, '.next', 'standalone'))) {
  console.error(
    '[prepare-server] .next/standalone/ does not exist. Run `next build` first.'
  );
  process.exit(1);
}

copyFileSync(src, dest);
console.log('[prepare-server] Copied codepilot-server.js -> .next/standalone/');
