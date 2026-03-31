import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, AccountInfo } from '@anthropic-ai/claude-agent-sdk';
import { getActiveProvider, getSetting } from '@/lib/db';
import { findClaudeBinary, findGitBash, getExpandedPath } from '@/lib/platform';
import { getCachedRateLimits } from '@/lib/rate-limit-cache';
import os from 'os';
import path from 'path';
import fs from 'fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sanitize env values for child_process.spawn
 */
function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      // eslint-disable-next-line no-control-regex
      clean[key] = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    }
  }
  return clean;
}

/**
 * Resolve .js script from Windows .cmd wrapper
 */
function resolveScriptFromCmd(cmdPath: string): string | undefined {
  try {
    const content = fs.readFileSync(cmdPath, 'utf-8');
    const cmdDir = path.dirname(cmdPath);
    const patterns = [
      /"%~dp0\\([^"]*claude[^"]*\.js)"/i,
      /%~dp0\\(\S*claude\S*\.js)/i,
      /"%dp0%\\([^"]*claude[^"]*\.js)"/i,
    ];
    for (const re of patterns) {
      const m = content.match(re);
      if (m) {
        const resolved = path.normalize(path.join(cmdDir, m[1]));
        if (fs.existsSync(resolved)) return resolved;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

// Cache account info briefly to avoid spawning CLI processes on repeated calls
let cachedInfo: { account: AccountInfo; fetchedAt: number } | null = null;
import { USAGE_CACHE_TTL as CACHE_TTL } from '@/lib/config';

let inflightFetch: Promise<AccountInfo> | null = null;

async function fetchAccountInfo(): Promise<AccountInfo> {
  // Build env (mirrors models/route.ts logic)
  const sdkEnv: Record<string, string> = { ...process.env as Record<string, string> };
  delete sdkEnv.CLAUDECODE;
  delete sdkEnv.CLAUDE_CODE_ENTRYPOINT;
  if (!sdkEnv.HOME) sdkEnv.HOME = os.homedir();
  if (!sdkEnv.USERPROFILE) sdkEnv.USERPROFILE = os.homedir();
  sdkEnv.PATH = getExpandedPath();

  if (process.platform === 'win32' && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    const gitBashPath = findGitBash();
    if (gitBashPath) sdkEnv.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;
  }

  const activeProvider = getActiveProvider();
  if (activeProvider && activeProvider.api_key) {
    for (const key of Object.keys(sdkEnv)) {
      if (key.startsWith('ANTHROPIC_')) delete sdkEnv[key];
    }
    sdkEnv.ANTHROPIC_AUTH_TOKEN = activeProvider.api_key;
    sdkEnv.ANTHROPIC_API_KEY = activeProvider.api_key;
    if (activeProvider.base_url) sdkEnv.ANTHROPIC_BASE_URL = activeProvider.base_url;
    try {
      const extraEnv = JSON.parse(activeProvider.extra_env || '{}');
      for (const [key, value] of Object.entries(extraEnv)) {
        if (typeof value === 'string') {
          if (value === '') delete sdkEnv[key];
          else sdkEnv[key] = value;
        }
      }
    } catch { /* ignore */ }
  } else {
    const appToken = getSetting('anthropic_auth_token');
    const appBaseUrl = getSetting('anthropic_base_url');
    if (appToken) sdkEnv.ANTHROPIC_AUTH_TOKEN = appToken;
    if (appBaseUrl) sdkEnv.ANTHROPIC_BASE_URL = appBaseUrl;
  }

  const options: Options = {
    cwd: os.homedir(),
    permissionMode: 'default',
    env: sanitizeEnv(sdkEnv),
  };

  const claudePath = findClaudeBinary();
  if (claudePath) {
    const ext = path.extname(claudePath).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      const scriptPath = resolveScriptFromCmd(claudePath);
      if (scriptPath) options.pathToClaudeCodeExecutable = scriptPath;
    } else {
      options.pathToClaudeCodeExecutable = claudePath;
    }
  }

  // Create a query that never sends a message — just initializes for the query API
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function* idlePrompt(): AsyncGenerator<never> {
    await new Promise<never>(() => {});
  }

  const q = query({ prompt: idlePrompt(), options });

  try {
    const info = await q.accountInfo();
    return info;
  } finally {
    q.close();
  }
}

export async function GET() {
  try {
    let account: AccountInfo | null = null;

    // Return cached account info if fresh
    if (cachedInfo && Date.now() - cachedInfo.fetchedAt < CACHE_TTL) {
      account = cachedInfo.account;
    } else {
      // Deduplicate concurrent requests
      if (!inflightFetch) {
        inflightFetch = fetchAccountInfo().finally(() => { inflightFetch = null; });
      }

      account = await inflightFetch;
      cachedInfo = { account, fetchedAt: Date.now() };
    }

    // Include server-cached rate limits (from streaming events)
    const rateLimits = getCachedRateLimits();

    return Response.json({ account, rateLimits });
  } catch (error) {
    console.error('[/api/claude-usage] Failed to fetch account info:', error);
    // Still return rate limits even if account info fails
    const rateLimits = getCachedRateLimits();
    return Response.json(
      { account: null, rateLimits, error: error instanceof Error ? error.message : 'Failed to fetch account info' },
      { status: 500 },
    );
  }
}
