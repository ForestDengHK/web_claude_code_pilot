import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCodexExecutable,
  repairCodexBinary,
  __resetCodexBinaryState,
  type RepairDeps,
} from '../../lib/codex-binary';

/** Build a deps object with safe defaults; override per test. */
function deps(over: Partial<RepairDeps> = {}): Partial<RepairDeps> {
  return {
    now: () => 1_000_000,
    resolveRealCodex: () => '/real/codex',
    freshCopy: () => '/healed/codex',
    verifyLaunch: async () => true,
    startReinstall: () => {},
    ...over,
  };
}

describe('getCodexExecutable', () => {
  beforeEach(() => __resetCodexBinaryState());

  it('defaults to PATH `codex` when nothing is healed', () => {
    assert.equal(getCodexExecutable(() => false), 'codex');
  });

  it('returns the healed copy after a successful repair', async () => {
    await repairCodexBinary(deps());
    assert.equal(getCodexExecutable(() => true), '/healed/codex');
  });

  it('falls back to PATH `codex` if the healed copy no longer exists', async () => {
    await repairCodexBinary(deps());
    assert.equal(getCodexExecutable(() => false), 'codex');
  });
});

describe('repairCodexBinary', () => {
  beforeEach(() => __resetCodexBinaryState());

  it('heals via fresh-inode copy when the copy verifies', async () => {
    let copied = '';
    const res = await repairCodexBinary(
      deps({ freshCopy: (real) => { copied = real; return '/healed/codex'; } }),
    );
    assert.deepEqual(res, { repaired: true, method: 'copy' });
    assert.equal(copied, '/real/codex');
  });

  it('falls back to background reinstall when the copy does not launch', async () => {
    let reinstalled = false;
    const res = await repairCodexBinary(
      deps({ verifyLaunch: async () => false, startReinstall: () => { reinstalled = true; } }),
    );
    assert.equal(res.repaired, false);
    assert.equal(res.method, 'reinstall');
    assert.equal(reinstalled, true);
    // healed path must not point at the bad copy
    assert.equal(getCodexExecutable(() => true), 'codex');
  });

  it('falls back to reinstall when the copy throws', async () => {
    let reinstalled = false;
    const res = await repairCodexBinary(
      deps({
        freshCopy: () => { throw new Error('ENOSPC'); },
        startReinstall: () => { reinstalled = true; },
      }),
    );
    assert.equal(res.method, 'reinstall');
    assert.equal(reinstalled, true);
  });

  it('returns an error and does nothing when codex is not found', async () => {
    let copied = false;
    const res = await repairCodexBinary(
      deps({ resolveRealCodex: () => null, freshCopy: () => { copied = true; return 'x'; } }),
    );
    assert.equal(res.repaired, false);
    assert.equal(res.error, 'codex not found on PATH');
    assert.equal(copied, false);
  });

  it('is rate-limited: a second attempt within the cooldown is skipped', async () => {
    let copies = 0;
    const mkCopy = () => { copies += 1; return '/healed/codex'; };
    let t = 5_000_000;
    const clock = () => t;

    await repairCodexBinary(deps({ now: clock, freshCopy: mkCopy }));
    // 30s later — still inside the 60s cooldown
    t += 30_000;
    const second = await repairCodexBinary(deps({ now: clock, freshCopy: mkCopy }));

    assert.equal(second.repaired, false);
    assert.equal(second.error, 'cooldown');
    assert.equal(copies, 1);
  });

  it('allows another attempt after the cooldown elapses', async () => {
    let copies = 0;
    const mkCopy = () => { copies += 1; return '/healed/codex'; };
    let t = 5_000_000;
    const clock = () => t;

    await repairCodexBinary(deps({ now: clock, freshCopy: mkCopy, verifyLaunch: async () => false }));
    t += 61_000; // past cooldown
    await repairCodexBinary(deps({ now: clock, freshCopy: mkCopy }));

    assert.equal(copies, 2);
  });
});
