import { test } from 'node:test';
import assert from 'node:assert';

// Use require to avoid top-level await issues with CJS output (matches channels-db.test.ts style)
/* eslint-disable @typescript-eslint/no-require-imports */
const { buildSpawnArgs, allocatePort } = require('../../lib/channels/session-manager') as typeof import('../../lib/channels/session-manager');

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

test('allocatePort returns a usable TCP port', async () => {
  const p = await allocatePort();
  assert.ok(p > 1024 && p < 65536);
});
