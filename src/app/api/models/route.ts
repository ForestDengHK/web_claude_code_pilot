import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { getActiveProvider, getSetting } from '@/lib/db';
import { findClaudeBinary, findGitBash, getExpandedPath } from '@/lib/platform';
import os from 'os';
import path from 'path';
import fs from 'fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CachedModel {
  value: string;
  displayName: string;
  description: string;
}

// Cache models to avoid spawning a CLI process on every request
let cachedModels: CachedModel[] | null = null;
let cachedAt = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

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

export async function GET() {
  // Return cached models if fresh
  if (cachedModels && Date.now() - cachedAt < CACHE_TTL) {
    return Response.json({ models: cachedModels });
  }

  try {
    // Build env for CLI subprocess (mirrors claude-client.ts logic)
    const sdkEnv: Record<string, string> = { ...process.env as Record<string, string> };
    // Unset CLAUDECODE so the subprocess doesn't think it's nested inside a Claude Code session
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

    // Find claude binary
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

    // Create a query that never sends a user message — just initializes
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async function* idlePrompt(): AsyncGenerator<never> {
      await new Promise<never>(() => {});
    }

    const q = query({ prompt: idlePrompt(), options });

    try {
      // supportedModels() waits for init and returns the model list
      const models = await q.supportedModels();
      cachedModels = models.map((m) => ({
        value: m.value,
        displayName: m.displayName,
        description: m.description,
      }));
      cachedAt = Date.now();
      return Response.json({ models: cachedModels });
    } finally {
      q.close();
    }
  } catch (error) {
    console.error('[/api/models] Failed to fetch models:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch models', models: [] },
      { status: 500 },
    );
  }
}
