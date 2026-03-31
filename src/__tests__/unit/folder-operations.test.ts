/**
 * Unit tests for folder operations (mkdir + upload) security.
 *
 * Run with: npx tsx src/__tests__/unit/folder-operations.test.ts
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';

import { isPathSafe, isRootPath } from '../../lib/files';

// Regex duplicated from mkdir/route.ts — tests validate its behavior
const INVALID_NAME_PATTERN = /[/\\:*?"<>|\0]|\.\./;

describe('Folder name validation', () => {
  it('should allow simple alphanumeric names', () => {
    assert.equal(INVALID_NAME_PATTERN.test('my-folder'), false);
    assert.equal(INVALID_NAME_PATTERN.test('src'), false);
    assert.equal(INVALID_NAME_PATTERN.test('components_v2'), false);
  });

  it('should allow dot-prefixed names (hidden folders)', () => {
    assert.equal(INVALID_NAME_PATTERN.test('.hidden'), false);
    assert.equal(INVALID_NAME_PATTERN.test('.config'), false);
    assert.equal(INVALID_NAME_PATTERN.test('.github'), false);
  });

  it('should reject names with path separators', () => {
    assert.equal(INVALID_NAME_PATTERN.test('foo/bar'), true);
    assert.equal(INVALID_NAME_PATTERN.test('foo\\bar'), true);
  });

  it('should reject names containing .. substring', () => {
    assert.equal(INVALID_NAME_PATTERN.test('..'), true);
    assert.equal(INVALID_NAME_PATTERN.test('...'), true);
    assert.equal(INVALID_NAME_PATTERN.test('foo..bar'), true);
  });

  it('should reject names with special characters', () => {
    assert.equal(INVALID_NAME_PATTERN.test('file:name'), true);
    assert.equal(INVALID_NAME_PATTERN.test('file*name'), true);
    assert.equal(INVALID_NAME_PATTERN.test('file?name'), true);
    assert.equal(INVALID_NAME_PATTERN.test('file"name'), true);
    assert.equal(INVALID_NAME_PATTERN.test('file<name'), true);
    assert.equal(INVALID_NAME_PATTERN.test('file>name'), true);
    assert.equal(INVALID_NAME_PATTERN.test('file|name'), true);
  });

  it('should allow names with spaces and dashes', () => {
    assert.equal(INVALID_NAME_PATTERN.test('my folder'), false);
    assert.equal(INVALID_NAME_PATTERN.test('my-folder'), false);
    assert.equal(INVALID_NAME_PATTERN.test('My Folder (2)'), false);
  });
});

describe('Mkdir path safety', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-mkdir-test-'));
  const projectDir = path.join(tmpDir, 'myproject');

  fs.mkdirSync(projectDir, { recursive: true });

  it('should allow creating folders inside the project', () => {
    const newDir = path.join(projectDir, 'newfolder');
    assert.equal(isPathSafe(projectDir, newDir), true);
  });

  it('should allow creating nested folders inside the project', () => {
    const newDir = path.join(projectDir, 'src', 'components');
    assert.equal(isPathSafe(projectDir, newDir), true);
  });

  it('should block creating folders outside the project', () => {
    const outsideDir = path.join(tmpDir, 'outside');
    assert.equal(isPathSafe(projectDir, outsideDir), false);
  });

  it('should block creating folders via path traversal', () => {
    const traversal = path.resolve(projectDir, '..', 'evil');
    assert.equal(isPathSafe(projectDir, traversal), false);
  });

  it('should reject filesystem root as baseDir', () => {
    assert.equal(isRootPath('/'), true);
    if (process.platform === 'win32') {
      assert.equal(isRootPath('C:\\'), true);
    }
    assert.equal(isRootPath(projectDir), false);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
