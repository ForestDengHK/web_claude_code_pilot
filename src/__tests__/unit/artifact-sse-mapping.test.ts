import { describe, it, expect, vi } from 'vitest';
import { handleSSEEvent } from '../../hooks/useSSEStream';
import type { SSECallbacks } from '../../hooks/useSSEStream';

function noopCallbacks(overrides: Partial<SSECallbacks> = {}): SSECallbacks {
  return {
    onText: vi.fn(),
    onThinking: vi.fn(),
    onToolUse: vi.fn(),
    onToolResult: vi.fn(),
    onToolOutput: vi.fn(),
    onToolProgress: vi.fn(),
    onStatus: vi.fn(),
    onResult: vi.fn(),
    onPermissionRequest: vi.fn(),
    onInputRequest: vi.fn(),
    onToolTimeout: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('artifact_published SSE mapping', () => {
  it('parses the payload and invokes onArtifactPublished', () => {
    const onArtifactPublished = vi.fn();
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
      noopCallbacks({ onArtifactPublished }),
    );
    expect(onArtifactPublished).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: 'run-digest', version: 2 }),
    );
  });

  it('does not throw on malformed artifact_published data', () => {
    const onArtifactPublished = vi.fn();
    expect(() =>
      handleSSEEvent(
        { type: 'artifact_published', data: 'not json' },
        '',
        noopCallbacks({ onArtifactPublished }),
      ),
    ).not.toThrow();
    expect(onArtifactPublished).not.toHaveBeenCalled();
  });
});
