/**
 * Unit tests for the folder-download archive walker (collectArchiveEntries).
 *
 * Run with: npx tsx --test src/__tests__/unit/folder-download.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';

import { collectArchiveEntries } from '../../lib/files';

describe('collectArchiveEntries', () => {
  let tmpDir: string;
  let projectDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-archive-test-'));
    projectDir = path.join(tmpDir, 'myproject');

    // Files that SHOULD be included
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(projectDir, '.env'), 'SECRET=1'); // dotfile, but a real file -> included
    fs.writeFileSync(path.join(projectDir, 'src', 'b.ts'), 'export const b = 1;');

    // Dirs that SHOULD be excluded (IGNORED_DIRS)
    fs.mkdirSync(path.join(projectDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'pkg', 'index.js'), 'x');
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.git', 'config'), 'x');
    fs.mkdirSync(path.join(projectDir, '.next'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.next', 'build'), 'x');

    // Empty dir -> contributes no entries
    fs.mkdirSync(path.join(projectDir, 'empty'), { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes nested files with posix names rooted at the folder basename', async () => {
    const names = (await collectArchiveEntries(projectDir)).map((e) => e.name).sort();
    assert.deepEqual(names, [
      'myproject/.env',
      'myproject/a.txt',
      'myproject/src/b.ts',
    ]);
  });

  it('excludes node_modules, .git, and .next', async () => {
    const names = (await collectArchiveEntries(projectDir)).map((e) => e.name);
    assert.ok(!names.some((n) => n.includes('node_modules')), 'node_modules should be excluded');
    assert.ok(!names.some((n) => n.includes('.git/')), '.git should be excluded');
    assert.ok(!names.some((n) => n.includes('.next')), '.next should be excluded');
  });

  it('omits empty directories (only files carry entries)', async () => {
    const names = (await collectArchiveEntries(projectDir)).map((e) => e.name);
    assert.ok(!names.some((n) => n.includes('empty')), 'empty dir should produce no entries');
  });

  it('returns absolute source paths that exist on disk', async () => {
    const entries = await collectArchiveEntries(projectDir);
    for (const { absPath } of entries) {
      assert.ok(path.isAbsolute(absPath), `${absPath} should be absolute`);
      assert.ok(fs.existsSync(absPath), `${absPath} should exist`);
    }
  });
});
