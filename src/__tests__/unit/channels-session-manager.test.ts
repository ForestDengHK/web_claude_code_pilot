import { test } from 'node:test';
import assert from 'node:assert';

// Use require to avoid top-level await issues with CJS output (matches channels-db.test.ts style)
/* eslint-disable @typescript-eslint/no-require-imports */
const { buildSpawnArgs, buildSpawnEnv, allocatePort } = require('../../lib/channels/session-manager') as typeof import('../../lib/channels/session-manager');

test('buildSpawnArgs includes channels + mcp-config + pre-approved reply tool', () => {
  const args = buildSpawnArgs({
    claudeSessionId: 'U-1', mcpConfigJson: '{"mcpServers":{}}',
    model: 'opus', resume: false,
  });
  assert.ok(args.includes('--session-id'));
  assert.ok(args.includes('U-1'));
  assert.ok(args.includes('--mcp-config'));
  assert.ok(args.includes('--dangerously-load-development-channels'));
  assert.ok(args.includes('server:codepilot'));
  assert.ok(args.includes('--allowedTools'));
  assert.ok(args.includes('mcp__codepilot__reply'));
  assert.ok(!args.includes('--resume'));
});

test('buildSpawnArgs disallows the interactive AskUserQuestion tool', () => {
  // T1 (the PTY-run CLI) has no UI to answer AskUserQuestion, so the model
  // calling it would hang the turn forever. We disable it; the model falls
  // back to the `reply` tool (plain text) instead. T2 (SDK) keeps the tool —
  // it intercepts it via canUseTool and renders an input_request UI.
  const args = buildSpawnArgs({
    claudeSessionId: 'U-AUQ', mcpConfigJson: '{}', resume: false,
  });
  const d = args.indexOf('--disallowedTools');
  assert.ok(d >= 0 && args[d + 1] === 'AskUserQuestion',
    '--disallowedTools AskUserQuestion must be present');
  // The reply-tool wiring must remain intact.
  const a = args.indexOf('--allowedTools');
  assert.ok(a >= 0 && args[a + 1] === 'mcp__codepilot__reply');
});

test('buildSpawnArgs adds --resume when resuming', () => {
  const args = buildSpawnArgs({
    claudeSessionId: 'U-2', mcpConfigJson: '{}', resume: true,
  });
  const i = args.indexOf('--resume');
  assert.ok(i >= 0 && args[i + 1] === 'U-2');
});

test('buildSpawnArgs omits --session-id when resuming (claude rejects both)', () => {
  // `claude` errors out — "--session-id can only be used with --continue or
  // --resume if --fork-session is also specified" — and exits 1, so a resumed
  // channel session never starts.
  const args = buildSpawnArgs({
    claudeSessionId: 'U-2', mcpConfigJson: '{}', resume: true,
  });
  assert.ok(!args.includes('--session-id'),
    '--session-id must be omitted when --resume is present');
});

test('buildSpawnArgs adds --permission-mode for a valid mode and --append-system-prompt', () => {
  const args = buildSpawnArgs({
    claudeSessionId: 'U-3', mcpConfigJson: '{}',
    mode: 'plan', systemPrompt: 'be terse',
  });
  const m = args.indexOf('--permission-mode');
  assert.ok(m >= 0 && args[m + 1] === 'plan');
  const sp = args.indexOf('--append-system-prompt');
  assert.ok(sp >= 0 && args[sp + 1] === 'be terse');
});

test('buildSpawnArgs ignores an invalid permission mode', () => {
  const args = buildSpawnArgs({
    claudeSessionId: 'U-4', mcpConfigJson: '{}', mode: 'bogus-mode',
  });
  assert.ok(!args.includes('--permission-mode'));
});

test('buildSpawnArgs adds --effort for a valid effort level', () => {
  const args = buildSpawnArgs({
    claudeSessionId: 'U-5', mcpConfigJson: '{}', effort: 'xhigh',
  });
  const i = args.indexOf('--effort');
  assert.ok(i >= 0 && args[i + 1] === 'xhigh');
});

test('buildSpawnArgs drops a malformed effort value', () => {
  // Malformed values (digits, symbols, oversize) are rejected by sanitizeEffortLevel
  // so the CLI falls back to the model's default effort instead of erroring.
  const args = buildSpawnArgs({
    claudeSessionId: 'U-6', mcpConfigJson: '{}', effort: 'high!!',
  });
  assert.ok(!args.includes('--effort'));
});

test('buildSpawnArgs adds --settings {"fastMode":true} when fastMode is on', () => {
  const args = buildSpawnArgs({
    claudeSessionId: 'U-F1', mcpConfigJson: '{}', fastMode: true,
  });
  const i = args.indexOf('--settings');
  assert.ok(i >= 0 && args[i + 1] === '{"fastMode":true}');
});

test('buildSpawnArgs omits --settings when fastMode is off', () => {
  const args = buildSpawnArgs({
    claudeSessionId: 'U-F2', mcpConfigJson: '{}', fastMode: false,
  });
  assert.ok(!args.includes('--settings'));
});

test('buildSpawnArgs adds --dangerously-skip-permissions when skipPermissions is true', () => {
  const args = buildSpawnArgs({
    claudeSessionId: 'U-7', mcpConfigJson: '{}', skipPermissions: true,
  });
  assert.ok(args.includes('--dangerously-skip-permissions'));
});

test('buildSpawnArgs omits --dangerously-skip-permissions when off', () => {
  const args = buildSpawnArgs({
    claudeSessionId: 'U-8', mcpConfigJson: '{}', skipPermissions: false,
  });
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('buildSpawnArgs emits one --plugin-dir per pluginPaths entry', () => {
  const args = buildSpawnArgs({
    claudeSessionId: 'U-9', mcpConfigJson: '{}',
    pluginPaths: ['/path/one', '/path/two'],
  });
  // Pair up flag with the path that immediately follows it.
  const paired: Array<[string, string]> = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--plugin-dir') paired.push([args[i], args[i + 1]]);
  }
  assert.deepStrictEqual(paired, [
    ['--plugin-dir', '/path/one'],
    ['--plugin-dir', '/path/two'],
  ]);
});

test('buildSpawnArgs omits --plugin-dir when pluginPaths is empty', () => {
  const args = buildSpawnArgs({
    claudeSessionId: 'U-10', mcpConfigJson: '{}', pluginPaths: [],
  });
  assert.ok(!args.includes('--plugin-dir'));
});

test('buildSpawnEnv always sets the CODEPILOT_* runtime vars', () => {
  const env = buildSpawnEnv({}, { sessionId: 'S-1', channelPort: 5123, internalUrl: 'http://127.0.0.1:4000' });
  assert.strictEqual(env.CODEPILOT_SESSION_ID, 'S-1');
  assert.strictEqual(env.CODEPILOT_CHANNEL_PORT, '5123');
  assert.strictEqual(env.CODEPILOT_INTERNAL_URL, 'http://127.0.0.1:4000');
});

test('buildSpawnEnv mirrors CLAUDE_CODE_OAUTH_TOKEN into ANTHROPIC_AUTH_TOKEN (interactive auth fix)', () => {
  // The crux of the 401 fix: the interactive PTY ignores CLAUDE_CODE_OAUTH_TOKEN
  // and would otherwise fall to the (stale) Keychain login session. Mirroring it
  // into ANTHROPIC_AUTH_TOKEN forces the bearer path, bypassing the Keychain.
  const env = buildSpawnEnv(
    { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-xyz' },
    { sessionId: 'S-2', channelPort: 1, internalUrl: 'u' },
  );
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'oauth-xyz');
});

test('buildSpawnEnv injects an active provider base_url + auth token', () => {
  const provider = {
    id: 'p9', name: 'OR', provider_type: 'openrouter', base_url: 'https://openrouter.ai/api',
    api_key: 'sk-or-9', is_active: 1, sort_order: 0, extra_env: '{}', notes: '',
    created_at: '', updated_at: '',
  };
  const env = buildSpawnEnv(
    { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-xyz' },
    { sessionId: 'S-P', channelPort: 1, internalUrl: 'u' },
    provider as any,
  );
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'sk-or-9');
});

test('buildSpawnEnv without a provider keeps the OAuth mirror (back-compat)', () => {
  const env = buildSpawnEnv(
    { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-xyz' },
    { sessionId: 'S-Q', channelPort: 1, internalUrl: 'u' },
  );
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'oauth-xyz');
});

test('buildSpawnEnv does NOT override an existing ANTHROPIC_AUTH_TOKEN', () => {
  const env = buildSpawnEnv(
    { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-xyz', ANTHROPIC_AUTH_TOKEN: 'user-set' },
    { sessionId: 'S-3', channelPort: 1, internalUrl: 'u' },
  );
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'user-set');
});

test('buildSpawnEnv leaves an explicit ANTHROPIC_API_KEY path untouched', () => {
  const env = buildSpawnEnv(
    { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-xyz', ANTHROPIC_API_KEY: 'sk-ant-real' },
    { sessionId: 'S-4', channelPort: 1, internalUrl: 'u' },
  );
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-ant-real');
});

test('buildSpawnEnv sets no auth token when CLAUDE_CODE_OAUTH_TOKEN is absent', () => {
  const env = buildSpawnEnv({}, { sessionId: 'S-5', channelPort: 1, internalUrl: 'u' });
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('allocatePort returns a usable TCP port', async () => {
  const p = await allocatePort();
  assert.ok(p > 1024 && p < 65536);
});
