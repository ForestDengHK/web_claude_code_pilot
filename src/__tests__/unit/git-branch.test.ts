/**
 * Unit tests for git branch detection helpers.
 *
 * Run with: npx tsx --test src/__tests__/unit/git-branch.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { getGitBranch } from '../../lib/files';

describe('getGitBranch', () => {
  it('returns the current branch for a git repository', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codepilot-git-branch-'));
    execFileSync('git', ['init', '-b', 'feature/test-branch'], { cwd: repoDir });

    const branch = await getGitBranch(repoDir);
    assert.equal(branch, 'feature/test-branch');
  });

  it('returns null for a non-git directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codepilot-non-git-'));
    const branch = await getGitBranch(dir);
    assert.equal(branch, null);
  });
});
