import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readClaudeMd,
  writeClaudeMd,
  resolveClaudeMdPath,
  userClaudeMdPath,
  MAX_CLAUDE_MD_BYTES,
} from '../claude-md-fs';

// ---------------------------------------------------------------------------
// Isolate HOME and working dirs inside a tmpdir per test. We never touch the
// real ~/.claude/CLAUDE.md.
// ---------------------------------------------------------------------------

function makeTempRoot(prefix = 'claude-md-fs-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('claude-md-fs: path resolution', () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = makeTempRoot();
    origHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('user scope resolves to ~/.claude/CLAUDE.md under HOME', () => {
    assert.equal(
      userClaudeMdPath(),
      path.join(tmp, '.claude', 'CLAUDE.md'),
    );
    assert.equal(
      resolveClaudeMdPath('user'),
      path.join(tmp, '.claude', 'CLAUDE.md'),
    );
  });

  it('project scope resolves to {cwd}/CLAUDE.md for an existing dir', () => {
    const projDir = path.join(tmp, 'my-project');
    fs.mkdirSync(projDir);
    assert.equal(
      resolveClaudeMdPath('project', projDir),
      path.join(projDir, 'CLAUDE.md'),
    );
  });

  it('project scope without cwd throws', () => {
    assert.throws(
      () => resolveClaudeMdPath('project'),
      /project scope requires cwd/,
    );
  });

  it('project scope with non-absolute cwd throws', () => {
    assert.throws(
      () => resolveClaudeMdPath('project', 'relative/path'),
      /cwd must be an absolute path/,
    );
  });

  it('project scope with missing dir throws', () => {
    const missing = path.join(tmp, 'does-not-exist');
    assert.throws(
      () => resolveClaudeMdPath('project', missing),
      /cwd does not exist/,
    );
  });

  it('project scope with file (not dir) cwd throws', () => {
    const filePath = path.join(tmp, 'afile');
    fs.writeFileSync(filePath, 'not a dir');
    assert.throws(
      () => resolveClaudeMdPath('project', filePath),
      /cwd is not a directory/,
    );
  });

  it('unknown scope throws', () => {
    // Cast through unknown because TS would otherwise reject the bad input.
    assert.throws(
      () => resolveClaudeMdPath('admin' as unknown as 'user'),
      /unknown scope: admin/,
    );
  });
});

describe('claude-md-fs: read', () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = makeTempRoot();
    origHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns exists:false with empty content when user file missing', () => {
    const result = readClaudeMd('user');
    assert.equal(result.exists, false);
    assert.equal(result.content, '');
    assert.equal(result.path, path.join(tmp, '.claude', 'CLAUDE.md'));
    assert.equal(result.mtimeMs, undefined);
  });

  it('returns content + mtime when user file exists', () => {
    const claudeDir = path.join(tmp, '.claude');
    fs.mkdirSync(claudeDir);
    fs.writeFileSync(
      path.join(claudeDir, 'CLAUDE.md'),
      '# Hello\n\nuser prefs here',
      'utf-8',
    );
    const result = readClaudeMd('user');
    assert.equal(result.exists, true);
    assert.equal(result.content, '# Hello\n\nuser prefs here');
    assert.ok(typeof result.mtimeMs === 'number' && result.mtimeMs > 0);
  });

  it('returns exists:false with empty content when project file missing', () => {
    const projDir = path.join(tmp, 'myproj');
    fs.mkdirSync(projDir);
    const result = readClaudeMd('project', projDir);
    assert.equal(result.exists, false);
    assert.equal(result.content, '');
    assert.equal(result.path, path.join(projDir, 'CLAUDE.md'));
  });

  it('returns content for project file when present', () => {
    const projDir = path.join(tmp, 'myproj');
    fs.mkdirSync(projDir);
    fs.writeFileSync(
      path.join(projDir, 'CLAUDE.md'),
      'project-level notes',
      'utf-8',
    );
    const result = readClaudeMd('project', projDir);
    assert.equal(result.exists, true);
    assert.equal(result.content, 'project-level notes');
  });
});

describe('claude-md-fs: write', () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = makeTempRoot();
    origHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates ~/.claude/CLAUDE.md when parent dir missing', () => {
    // .claude does not exist yet
    assert.equal(fs.existsSync(path.join(tmp, '.claude')), false);
    const result = writeClaudeMd('user', 'first write');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.path, path.join(tmp, '.claude', 'CLAUDE.md'));
    }
    const onDisk = fs.readFileSync(
      path.join(tmp, '.claude', 'CLAUDE.md'),
      'utf-8',
    );
    assert.equal(onDisk, 'first write');
  });

  it('overwrites existing user CLAUDE.md', () => {
    const claudeDir = path.join(tmp, '.claude');
    fs.mkdirSync(claudeDir);
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'old', 'utf-8');
    const result = writeClaudeMd('user', 'new contents');
    assert.equal(result.ok, true);
    assert.equal(
      fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf-8'),
      'new contents',
    );
  });

  it('writes to {cwd}/CLAUDE.md for project scope', () => {
    const projDir = path.join(tmp, 'my-proj');
    fs.mkdirSync(projDir);
    const result = writeClaudeMd('project', 'hello project', projDir);
    assert.equal(result.ok, true);
    assert.equal(
      fs.readFileSync(path.join(projDir, 'CLAUDE.md'), 'utf-8'),
      'hello project',
    );
  });

  it('rejects non-string content', () => {
    // Simulate bad callers: force a non-string through the type system.
    const result = writeClaudeMd('user', 123 as unknown as string);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 400);
      assert.match(result.reason, /must be a string/);
    }
  });

  it('rejects content exceeding MAX_CLAUDE_MD_BYTES', () => {
    const oversize = 'a'.repeat(MAX_CLAUDE_MD_BYTES + 1);
    const result = writeClaudeMd('user', oversize);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 413);
      assert.match(result.reason, /content too large/);
    }
    // And: no file was created on disk.
    assert.equal(
      fs.existsSync(path.join(tmp, '.claude', 'CLAUDE.md')),
      false,
    );
  });

  it('rejects project scope when cwd is missing', () => {
    const result = writeClaudeMd(
      'project',
      'x',
      path.join(tmp, 'no-such-dir'),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 400);
      assert.match(result.reason, /cwd does not exist/);
    }
  });

  it('rejects project scope without cwd', () => {
    const result = writeClaudeMd('project', 'x');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 400);
      assert.match(result.reason, /project scope requires cwd/);
    }
  });
});
