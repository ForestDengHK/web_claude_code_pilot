import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerPendingCodexApproval,
  resolvePendingCodexApproval,
  getPendingCodexApprovalForSession,
} from '../codex-approval-registry';

function makeInfo(overrides?: Record<string, unknown>) {
  return {
    type: 'command' as const,
    callId: 'call-1',
    turnId: 'turn-1',
    command: ['ls', '-la'],
    reason: 'list files',
    ...overrides,
  };
}

afterEach(() => {
  // Clean up globalThis maps between tests
  delete (globalThis as Record<string, unknown>)['__codexPendingApprovals__'];
  delete (globalThis as Record<string, unknown>)['__codexSessionApprovals__'];
});

// ---------------------------------------------------------------------------
// registerPendingCodexApproval + resolvePendingCodexApproval
// ---------------------------------------------------------------------------

describe('registerPendingCodexApproval', () => {
  it('resolves with the correct decision when resolved', async () => {
    const info = makeInfo();
    const promise = registerPendingCodexApproval('ap-1', 'sess-1', info);

    const found = resolvePendingCodexApproval('ap-1', 'accept');
    assert.equal(found, true);

    const decision = await promise;
    assert.equal(decision, 'accept');
  });

  it('returns false when resolving a non-existent approval', () => {
    const result = resolvePendingCodexApproval('non-existent', 'decline');
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// getPendingCodexApprovalForSession
// ---------------------------------------------------------------------------

describe('getPendingCodexApprovalForSession', () => {
  it('looks up pending approval by session ID', () => {
    const info = makeInfo({ callId: 'call-2' });
    registerPendingCodexApproval('ap-2', 'sess-2', info);

    const found = getPendingCodexApprovalForSession('sess-2');
    assert.ok(found !== null);
    assert.equal(found!.callId, 'call-2');
  });

  it('returns null for unknown session ID', () => {
    const result = getPendingCodexApprovalForSession('unknown-session');
    assert.equal(result, null);
  });

  it('returns null after approval is resolved (cleaned up)', () => {
    const info = makeInfo();
    registerPendingCodexApproval('ap-3', 'sess-3', info);

    resolvePendingCodexApproval('ap-3', 'decline');

    const found = getPendingCodexApprovalForSession('sess-3');
    assert.equal(found, null);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal auto-cancel
// ---------------------------------------------------------------------------

describe('AbortSignal', () => {
  it('auto-cancels when abort signal fires', async () => {
    const controller = new AbortController();
    const info = makeInfo();
    const promise = registerPendingCodexApproval('ap-4', 'sess-4', info, controller.signal);

    controller.abort();

    const decision = await promise;
    assert.equal(decision, 'cancel');

    // Should also clean up session map
    const found = getPendingCodexApprovalForSession('sess-4');
    assert.equal(found, null);
  });
});
