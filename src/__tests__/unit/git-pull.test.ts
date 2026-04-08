/**
 * Unit tests for git pull output parsing helpers.
 * Run with: npx tsx src/__tests__/unit/git-pull.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitPullOutput, classifyGitPullError } from '../../lib/git-pull';

describe('parseGitPullOutput', () => {
  it('returns up-to-date for "Already up to date."', () => {
    assert.equal(parseGitPullOutput('Already up to date.\n'), 'up-to-date');
  });

  it('returns up-to-date for "Already up to date." with leading whitespace', () => {
    assert.equal(parseGitPullOutput('  Already up to date.  '), 'up-to-date');
  });

  it('returns pulled for a normal pull output', () => {
    const output = 'From github.com/user/repo\n   abc1234..def5678  main -> origin/main\nUpdating abc1234..def5678\nFast-forward\n';
    assert.equal(parseGitPullOutput(output), 'pulled');
  });

  it('returns pulled for empty stdout (e.g. on timeout)', () => {
    assert.equal(parseGitPullOutput(''), 'pulled');
  });
});

describe('classifyGitPullError', () => {
  it('returns human-readable message for fast-forward failure', () => {
    const stderr = 'fatal: Not possible to fast-forward, aborting.';
    assert.equal(classifyGitPullError(stderr), 'Branch has diverged — manual merge required');
  });

  it('strips "fatal: " prefix from other errors', () => {
    const stderr = 'fatal: Could not read from remote repository.';
    assert.equal(classifyGitPullError(stderr), 'Could not read from remote repository.');
  });

  it('strips "error: " prefix', () => {
    const stderr = 'error: Your local changes would be overwritten by merge.';
    assert.equal(classifyGitPullError(stderr), 'Your local changes would be overwritten by merge.');
  });

  it('returns first non-empty line for multi-line stderr', () => {
    const stderr = '\nfatal: Authentication failed\nMore details here';
    assert.equal(classifyGitPullError(stderr), 'Authentication failed');
  });

  it('returns fallback for empty stderr', () => {
    assert.equal(classifyGitPullError(''), 'Pull failed');
  });
});
