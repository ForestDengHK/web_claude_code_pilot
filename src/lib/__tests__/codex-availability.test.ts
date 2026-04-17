import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isCodexAvailable, __resetCodexAvailabilityCache } from '../codex-availability';

describe('isCodexAvailable', () => {
  beforeEach(() => {
    __resetCodexAvailabilityCache();
  });

  it('returns true when the probe command resolves', () => {
    const probe = () => '/fake/path/codex\n';
    assert.equal(isCodexAvailable(probe), true);
  });

  it('returns false when the probe command throws', () => {
    const probe = () => { throw new Error('not found'); };
    assert.equal(isCodexAvailable(probe), false);
  });

  it('caches the result across calls within the TTL', () => {
    let calls = 0;
    const probe = () => { calls += 1; return '/x'; };
    isCodexAvailable(probe);
    isCodexAvailable(probe);
    isCodexAvailable(probe);
    assert.equal(calls, 1);
  });

  it('re-probes after the cache is reset', () => {
    let calls = 0;
    const probe = () => { calls += 1; return '/x'; };
    isCodexAvailable(probe);
    __resetCodexAvailabilityCache();
    isCodexAvailable(probe);
    assert.equal(calls, 2);
  });
});
