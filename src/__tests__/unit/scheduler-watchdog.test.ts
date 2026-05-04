import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWithWallClock } from '../../lib/scheduler/watchdog';

describe('runWithWallClock', () => {
  it('returns the inner result when it finishes in time', async () => {
    const r = await runWithWallClock(2, async () => 'done');
    assert.deepEqual(r, { kind: 'finished', value: 'done' });
  });

  it('aborts when the inner exceeds the deadline', async () => {
    const r = await runWithWallClock(0.05, async (signal) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5000);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
      });
      return 'done';
    });
    assert.equal(r.kind, 'timed_out');
  });

  it('forwards a thrown error', async () => {
    const r = await runWithWallClock(2, async () => { throw new Error('boom'); });
    assert.equal(r.kind, 'errored');
    if (r.kind === 'errored') assert.equal(r.error.message, 'boom');
  });
});
