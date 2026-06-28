import { test } from 'node:test';
import assert from 'node:assert';
/* eslint-disable @typescript-eslint/no-require-imports */
const { applyProviderEnv } = require('../../lib/provider-env') as typeof import('../../lib/provider-env');

const base = () => ({ ANTHROPIC_API_KEY: 'stale', ANTHROPIC_BASE_URL: 'https://old', PATH: '/usr/bin' } as Record<string, string>);
const prov = (over: Partial<import('../../types').ApiProvider> = {}) => ({
  id: 'p1', name: 'OpenRouter', provider_type: 'openrouter', base_url: 'https://openrouter.ai/api',
  api_key: 'sk-or-123', is_active: 0, sort_order: 0, extra_env: '{}', notes: '',
  created_at: '', updated_at: '', ...over,
} as import('../../types').ApiProvider);

test('applyProviderEnv injects base_url + both token vars and clears stale ANTHROPIC_*', () => {
  const env = applyProviderEnv(base(), prov());
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'sk-or-123');
  assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-or-123');
  assert.strictEqual(env.PATH, '/usr/bin'); // non-ANTHROPIC vars preserved
});

test('applyProviderEnv extra_env empty-string deletes a var; other keys set', () => {
  const env = applyProviderEnv(base(), prov({ extra_env: '{"ANTHROPIC_API_KEY":"","CLAUDE_CODE_USE_BEDROCK":"1"}' }));
  assert.strictEqual(env.ANTHROPIC_API_KEY, undefined);
  assert.strictEqual(env.CLAUDE_CODE_USE_BEDROCK, '1');
});

test('applyProviderEnv is a no-op for null provider or missing api_key', () => {
  assert.strictEqual(applyProviderEnv(base(), null).ANTHROPIC_BASE_URL, 'https://old');
  assert.strictEqual(applyProviderEnv(base(), prov({ api_key: '' })).ANTHROPIC_BASE_URL, 'https://old');
});

test('applyProviderEnv tolerates malformed extra_env', () => {
  const env = applyProviderEnv(base(), prov({ extra_env: 'not json' }));
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'sk-or-123');
});
