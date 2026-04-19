import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'child_process';

import { CodexProcessManager, type CodexProcess } from '../../lib/codex-process-manager';

const PROCESS_MAP_KEY = '__codexProcesses__' as const;

function getProcessMap(): Map<string, CodexProcess> {
  if (!(globalThis as Record<string, unknown>)[PROCESS_MAP_KEY]) {
    (globalThis as Record<string, unknown>)[PROCESS_MAP_KEY] = new Map<string, CodexProcess>();
  }

  return (globalThis as Record<string, unknown>)[PROCESS_MAP_KEY] as Map<string, CodexProcess>;
}

function createFakeCodexProcess(overrides: Partial<CodexProcess> = {}) {
  const sent: string[] = [];

  const entry: CodexProcess = {
    proc: { exitCode: null, signalCode: null } as ChildProcess,
    send(message: string) {
      sent.push(message);
    },
    onMessage() {},
    offMessage() {},
    onExit() {},
    offExit() {},
    threadId: 'thread-1',
    currentTurnId: 'turn-1',
    interruptRequested: false,
    initialized: true,
    ...overrides,
  };

  return { entry, sent };
}

afterEach(() => {
  getProcessMap().clear();
});

describe('CodexProcessManager.interrupt', () => {
  it('sends turn/interrupt with both threadId and turnId', () => {
    const { entry, sent } = createFakeCodexProcess();
    getProcessMap().set('session-1', entry);

    const stopped = CodexProcessManager.interrupt('session-1');

    assert.equal(stopped, true);
    assert.equal(sent.length, 1);

    const request = JSON.parse(sent[0].trim()) as {
      method: string;
      params: { threadId: string; turnId: string };
    };

    assert.equal(request.method, 'turn/interrupt');
    assert.deepEqual(request.params, {
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    assert.equal(entry.interruptRequested, false);
  });

  it('queues the interrupt until the active turn id is known', () => {
    const { entry, sent } = createFakeCodexProcess({ currentTurnId: null });
    getProcessMap().set('session-2', entry);

    const stopped = CodexProcessManager.interrupt('session-2');

    assert.equal(stopped, true);
    assert.equal(sent.length, 0);
    assert.equal(entry.interruptRequested, true);

    entry.currentTurnId = 'turn-2';
    CodexProcessManager.flushPendingInterrupt(entry);
    CodexProcessManager.flushPendingInterrupt(entry);

    assert.equal(sent.length, 1);

    const request = JSON.parse(sent[0].trim()) as {
      params: { threadId: string; turnId: string };
    };

    assert.deepEqual(request.params, {
      threadId: 'thread-1',
      turnId: 'turn-2',
    });
    assert.equal(entry.interruptRequested, false);
  });

  it('returns false when no live Codex process exists', () => {
    assert.equal(CodexProcessManager.interrupt('missing-session'), false);
  });
});
