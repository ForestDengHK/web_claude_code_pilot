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
    const result = execFileSync(shell, ['-lc', 'env -0'], {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const env = {};
    for (const entry of result.split('\0')) {
      const idx = entry.indexOf('=');
      if (idx > 0) {
        env[entry.slice(0, idx)] = entry.slice(idx + 1);
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

// Exclude HOSTNAME — macOS sets this to the machine name (e.g. "Macs-Mac-Mini.local"),
// which would prevent the server from binding to 0.0.0.0
delete shellEnv.HOSTNAME;

// Only set vars not already present, so CLI overrides (PORT=8080 node ...) take precedence
for (const [key, value] of Object.entries(shellEnv)) {
  if (!(key in process.env)) {
    process.env[key] = value;
  }
}

// --- Set defaults ---
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
