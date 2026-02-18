// CodePilot standalone server entry point
// Loads user shell environment (for API keys, PATH, etc.) then starts Next.js
// Usage: node .next/standalone/codepilot-server.js

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

/**
 * Load environment variables from the user's login shell.
 * This picks up ANTHROPIC_API_KEY, PATH (for finding `claude` binary), etc.
 * Uses execFileSync (no shell metacharacter expansion) to avoid injection risks.
 */
function loadUserShellEnv() {
  if (process.platform === 'win32') {
    console.log('[codepilot] Skipping shell env loading on Windows');
    return {};
  }

  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const result = execFileSync(shell, ['-ilc', 'env'], {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const env = {};
    for (const line of result.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        env[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }

    console.log(
      `[codepilot] Loaded ${Object.keys(env).length} env vars from user shell (${shell})`
    );
    return env;
  } catch (err) {
    console.warn(
      '[codepilot] Failed to load user shell env:',
      err.message || err
    );
    return {};
  }
}

// --- Load shell environment ---
const shellEnv = loadUserShellEnv();
Object.assign(process.env, shellEnv);

// --- Set defaults (after shell env so user overrides take precedence) ---
process.env.HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
process.env.PORT = process.env.PORT || '3000';
process.env.CLAUDE_GUI_DATA_DIR =
  process.env.CLAUDE_GUI_DATA_DIR || path.join(os.homedir(), '.codepilot');

console.log(
  `[codepilot] Starting server on ${process.env.HOSTNAME}:${process.env.PORT}`
);
console.log(`[codepilot] Data directory: ${process.env.CLAUDE_GUI_DATA_DIR}`);

// --- Start the Next.js standalone server ---
require('./server.js');
