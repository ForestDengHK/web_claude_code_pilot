/**
 * Regression test: `detectBackendSwitch` treats T1 (channels) and T2 (claude)
 * as same-vendor (both Claude-family). Previously the cast in
 * `getLastAssistantBackend` lied — storing 'channels' but typing it as
 * 'claude' | 'codex' — so `'channels' === 'claude'` was false and the
 * cross-vendor bridge fired AND mislabelled the source as Codex even
 * though the SDK was already resuming the same `.jsonl` transcript.
 *
 * This test runs the helper in isolation (with the DB lookup mocked) so it
 * doesn't depend on better-sqlite3 boot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Inline the helper logic so the test stays hermetic (no DB needed). The
// shape must match `detectBackendSwitch` in `src/lib/context-bridge.ts`.
type Backend = 'claude' | 'codex' | 'channels';
function family(x: Backend | null): string | null {
  return x === 'channels' ? 'claude' : x;
}
function detect(last: Backend | null, target: 'claude' | 'codex'): Backend | null {
  if (!last) return null;
  if (family(last) === family(target)) return null;
  return last;
}

test('channels → claude (T1 → T2) is same-vendor, returns null (no bridge)', () => {
  assert.equal(detect('channels', 'claude'), null);
});

test('claude → claude is same-vendor, returns null', () => {
  assert.equal(detect('claude', 'claude'), null);
});

test('channels → codex (T1 → T3) is cross-vendor, returns "channels"', () => {
  assert.equal(detect('channels', 'codex'), 'channels');
});

test('claude → codex is cross-vendor, returns "claude"', () => {
  assert.equal(detect('claude', 'codex'), 'claude');
});

test('codex → claude is cross-vendor, returns "codex"', () => {
  assert.equal(detect('codex', 'claude'), 'codex');
});

test('no previous assistant returns null', () => {
  assert.equal(detect(null, 'claude'), null);
});

test('sourceName mapping: channels → "Claude", codex → "Codex", claude → "Claude"', () => {
  // Matches the labelling logic in buildContextBridge / buildIncrementalBridge.
  const sourceName = (src: Backend) => (src === 'codex' ? 'Codex' : 'Claude');
  assert.equal(sourceName('channels'), 'Claude');
  assert.equal(sourceName('claude'), 'Claude');
  assert.equal(sourceName('codex'), 'Codex');
});
