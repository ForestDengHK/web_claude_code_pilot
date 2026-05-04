import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeNextFire } from '../../lib/scheduler/scheduler-manager';

describe('computeNextFire', () => {
  it('computes next cron fire after a reference time', () => {
    const ref = new Date('2026-01-01T08:30:00Z');
    const next = computeNextFire(
      { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
      ref,
    );
    assert.equal(next?.toISOString(), '2026-01-01T09:00:00.000Z');
  });

  it('returns null for once trigger in the past', () => {
    const next = computeNextFire(
      { kind: 'once', runAt: Date.now() - 60000, timezone: 'UTC' },
      new Date(),
    );
    assert.equal(next, null);
  });

  it('returns runAt date for once trigger in the future', () => {
    const future = Date.now() + 60000;
    const next = computeNextFire(
      { kind: 'once', runAt: future, timezone: 'UTC' },
      new Date(),
    );
    assert.equal(next?.getTime(), future);
  });

  it('computes interval next-fire', () => {
    const ref = new Date('2026-01-01T00:00:00Z');
    const next = computeNextFire(
      { kind: 'interval', everyMs: 60000, timezone: 'UTC' },
      ref,
    );
    assert.equal(next?.toISOString(), '2026-01-01T00:01:00.000Z');
  });
});
