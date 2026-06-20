import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleSSEEvent } from '../../hooks/useSSEStream';
import type { SSECallbacks } from '../../hooks/useSSEStream';

function spy<T extends unknown[] = unknown[]>() {
  const calls: T[] = [];
  const fn = (...args: T) => {
    calls.push(args);
  };
  return { fn, calls };
}

function noopCallbacks(overrides: Partial<SSECallbacks> = {}): SSECallbacks {
  return {
    onText: () => {},
    onThinking: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onToolOutput: () => {},
    onToolProgress: () => {},
    onStatus: () => {},
    onResult: () => {},
    onPermissionRequest: () => {},
    onInputRequest: () => {},
    onToolTimeout: () => {},
    onError: () => {},
    ...overrides,
  };
}

describe('artifact_published SSE mapping', () => {
  it('parses the payload and invokes onArtifactPublished', () => {
    const onArtifactPublished = spy<[Parameters<NonNullable<SSECallbacks['onArtifactPublished']>>[0]]>();
    handleSSEEvent(
      {
        type: 'artifact_published',
        data: JSON.stringify({
          artifactId: 'run-digest',
          version: 2,
          internalUrl: '/api/artifacts/run-digest?version=2',
          title: 'Run Digest',
          favicon: '📊',
        }),
      },
      '',
      noopCallbacks({ onArtifactPublished: onArtifactPublished.fn }),
    );
    assert.equal(onArtifactPublished.calls.length, 1);
    assert.equal(onArtifactPublished.calls[0][0].artifactId, 'run-digest');
    assert.equal(onArtifactPublished.calls[0][0].version, 2);
  });

  it('does not throw on malformed artifact_published data', () => {
    const onArtifactPublished = spy<[Parameters<NonNullable<SSECallbacks['onArtifactPublished']>>[0]]>();
    assert.doesNotThrow(() =>
      handleSSEEvent(
        { type: 'artifact_published', data: 'not json' },
        '',
        noopCallbacks({ onArtifactPublished: onArtifactPublished.fn }),
      ),
    );
    assert.equal(onArtifactPublished.calls.length, 0);
  });
});
