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

test('allocatePort returns a usable TCP port', async () => {
  const p = await allocatePort();
  assert.ok(p > 1024 && p < 65536);
});
