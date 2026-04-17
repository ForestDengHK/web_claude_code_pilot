import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectSymlink } from '../codex-skill-fs';

// ---------------------------------------------------------------------------
// These tests guard against the real production incident of 2026-04-17:
//
//   ~/.codex/skills/pdf        → ~/.claude/skills/pdf       (symlink #1)
//   ~/.claude/skills/pdf       → ~/.agents/skills/pdf       (symlink #2)
//   ~/.agents/skills/pdf/      (real dir with SKILL.md)
//
// A single-hop `fs.realpathSync` on ~/.codex/skills/pdf returns
// ~/.agents/skills/pdf — *skipping* the ~/.claude/skills/ hop — so a naive
// `target.startsWith(claudeRoot)` check returns false and the writer
// happily overwrites the file Claude thinks it owns.
//
// detectSymlink MUST walk the chain hop-by-hop and flip `claudeOwned` if
// ANY hop lands under ~/.claude/skills/.
// ---------------------------------------------------------------------------

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-fs-test-'));
}

describe('detectSymlink', () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = makeTempRoot();
    origHome = process.env.HOME;
    process.env.HOME = tmp;
    // Layout inside fake HOME:
    //   tmp/.codex/skills/
    //   tmp/.claude/skills/
    //   tmp/.agents/skills/
    fs.mkdirSync(path.join(tmp, '.codex', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.agents', 'skills'), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns undefined for a real directory', () => {
    const dir = path.join(tmp, '.codex', 'skills', 'real-one');
    fs.mkdirSync(dir);
    const sym = detectSymlink(dir);
    assert.equal(sym, undefined);
  });

  it('detects a direct claude-owned symlink', () => {
    const target = path.join(tmp, '.claude', 'skills', 'foo');
    fs.mkdirSync(target);
    const link = path.join(tmp, '.codex', 'skills', 'foo');
    fs.symlinkSync(target, link);

    const sym = detectSymlink(link);
    assert.ok(sym, 'detectSymlink should return info for a symlink');
    assert.equal(sym!.claudeOwned, true, 'direct claude symlink must be claudeOwned');
  });

  it('detects claude-ownership through a TWO-HOP chain (pdf incident)', () => {
    //   codex/skills/foo  → claude/skills/foo  → agents/skills/foo
    const realDir = path.join(tmp, '.agents', 'skills', 'foo');
    fs.mkdirSync(realDir);
    const claudeLink = path.join(tmp, '.claude', 'skills', 'foo');
    fs.symlinkSync(realDir, claudeLink);
    const codexLink = path.join(tmp, '.codex', 'skills', 'foo');
    fs.symlinkSync(claudeLink, codexLink);

    const sym = detectSymlink(codexLink);
    assert.ok(sym, 'detectSymlink should return info');
    assert.equal(
      sym!.claudeOwned,
      true,
      'chain walker MUST set claudeOwned when ANY hop goes through ~/.claude/skills/',
    );
  });

  it('does NOT flag non-claude chains as claudeOwned', () => {
    //   codex/skills/foo  → agents/skills/foo  (no claude hop)
    const realDir = path.join(tmp, '.agents', 'skills', 'foo');
    fs.mkdirSync(realDir);
    const codexLink = path.join(tmp, '.codex', 'skills', 'foo');
    fs.symlinkSync(realDir, codexLink);

    const sym = detectSymlink(codexLink);
    assert.ok(sym, 'detectSymlink should return info');
    assert.equal(sym!.claudeOwned, false, 'non-claude chain must NOT be claudeOwned');
  });

  it('handles a relative symlink target that resolves through claude', () => {
    // codex/skills/rel → ../../.claude/skills/rel → agents/skills/rel
    const realDir = path.join(tmp, '.agents', 'skills', 'rel');
    fs.mkdirSync(realDir);
    const claudeLink = path.join(tmp, '.claude', 'skills', 'rel');
    fs.symlinkSync(realDir, claudeLink);
    const codexLink = path.join(tmp, '.codex', 'skills', 'rel');
    // Relative symlink pointing at the claude copy
    fs.symlinkSync('../../.claude/skills/rel', codexLink);

    const sym = detectSymlink(codexLink);
    assert.ok(sym);
    assert.equal(
      sym!.claudeOwned,
      true,
      'relative-path chain walker must still catch the claude hop',
    );
  });

  it('does not infinite-loop on circular symlinks', () => {
    const a = path.join(tmp, '.codex', 'skills', 'a');
    const b = path.join(tmp, '.codex', 'skills', 'b');
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    // Must return some result (not throw, not hang). claudeOwned may be
    // false — the point is that the walker terminates.
    const sym = detectSymlink(a);
    // No assertion on claudeOwned since neither hop goes through claude;
    // the key assertion is that the call returned at all.
    assert.ok(sym !== undefined || sym === undefined); // tautology — we just want no throw/hang
  });
});
