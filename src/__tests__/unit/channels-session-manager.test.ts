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

test('allocatePort returns a usable TCP port', async () => {
  const p = await allocatePort();
  assert.ok(p > 1024 && p < 65536);
});
