/**
 * Unit tests for git status parsing and tree annotation.
 *
 * Run with: npx tsx src/__tests__/unit/git-status.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseGitStatusOutput, annotateTreeWithGitStatus } from '../../lib/files';
import type { FileTreeNode } from '../../types';

describe('parseGitStatusOutput', () => {
  it('should parse modified files', () => {
    const output = ' M src/lib/files.ts\n';
    const result = parseGitStatusOutput(output, '/project');
    assert.equal(result.get('/project/src/lib/files.ts'), 'M');
  });

  it('should parse untracked files', () => {
    const output = '?? src/new-file.ts\n';
    const result = parseGitStatusOutput(output, '/project');
    assert.equal(result.get('/project/src/new-file.ts'), '?');
  });

  it('should parse staged (added) files', () => {
    const output = 'A  src/added.ts\n';
    const result = parseGitStatusOutput(output, '/project');
    assert.equal(result.get('/project/src/added.ts'), 'A');
  });

  it('should parse mixed statuses', () => {
    const output = [
      ' M src/lib/files.ts',
      '?? src/brand-new.ts',
      'A  src/staged.ts',
      'MM src/both.ts',
    ].join('\n');
    const result = parseGitStatusOutput(output, '/project');
    assert.equal(result.size, 4);
    assert.equal(result.get('/project/src/lib/files.ts'), 'M');
    assert.equal(result.get('/project/src/brand-new.ts'), '?');
    assert.equal(result.get('/project/src/staged.ts'), 'A');
    assert.equal(result.get('/project/src/both.ts'), 'M');
  });

  it('should return empty map for empty output', () => {
    const result = parseGitStatusOutput('', '/project');
    assert.equal(result.size, 0);
  });

  it('should skip deleted files', () => {
    const output = ' D src/removed.ts\n';
    const result = parseGitStatusOutput(output, '/project');
    assert.equal(result.size, 0);
  });

  it('should handle renamed files (show new path as modified)', () => {
    const output = 'R  old.ts -> new.ts\n';
    const result = parseGitStatusOutput(output, '/project');
    assert.equal(result.get('/project/new.ts'), 'M');
  });
});

describe('annotateTreeWithGitStatus', () => {
  it('should annotate files with git status', () => {
    const tree: FileTreeNode[] = [
      { name: 'modified.ts', path: '/project/modified.ts', type: 'file' },
      { name: 'clean.ts', path: '/project/clean.ts', type: 'file' },
    ];
    const statusMap = new Map([
      ['/project/modified.ts', 'M'],
    ]);
    annotateTreeWithGitStatus(tree, statusMap);
    assert.equal(tree[0].gitStatus, 'M');
    assert.equal(tree[1].gitStatus, undefined);
  });

  it('should propagate status to parent directories', () => {
    const tree: FileTreeNode[] = [
      {
        name: 'src',
        path: '/project/src',
        type: 'directory',
        children: [
          {
            name: 'components',
            path: '/project/src/components',
            type: 'directory',
            children: [
              { name: 'App.tsx', path: '/project/src/components/App.tsx', type: 'file' },
            ],
          },
        ],
      },
      { name: 'README.md', path: '/project/README.md', type: 'file' },
    ];
    const statusMap = new Map([
      ['/project/src/components/App.tsx', '?'],
    ]);
    annotateTreeWithGitStatus(tree, statusMap);

    assert.equal(tree[0].children![0].children![0].gitStatus, '?');
    assert.equal(tree[0].gitStatus, 'M');
    assert.equal(tree[0].children![0].gitStatus, 'M');
    assert.equal(tree[1].gitStatus, undefined);
  });

  it('should handle empty status map', () => {
    const tree: FileTreeNode[] = [
      { name: 'clean.ts', path: '/project/clean.ts', type: 'file' },
    ];
    annotateTreeWithGitStatus(tree, new Map());
    assert.equal(tree[0].gitStatus, undefined);
  });
});
