/**
 * Unit tests for cross-platform compatibility fixes.
 *
 * Run with: npx tsx --test src/__tests__/unit/cross-platform.test.ts
 *
 * Tests verify that:
 * 1. Git clone route uses os.homedir() for DEFAULT_BASE_DIR (no hardcoded paths)
 * 2. push-notifications uses os.homedir() for VAPID keys path
 * 3. decodeProjectPath handles both Unix and Windows encoded paths
 * 4. Versions API uses platform-aware update commands
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';

// ==========================================
// 1. Git Clone Route — DEFAULT_BASE_DIR
// ==========================================

describe('git clone route — DEFAULT_BASE_DIR', () => {
  it('should not contain hardcoded /Users/party paths', () => {
    const routePath = path.resolve(__dirname, '../../app/api/git/clone/route.ts');
    const content = fs.readFileSync(routePath, 'utf-8');
    assert.ok(
      !content.includes("'/Users/party"),
      'route.ts should not contain hardcoded /Users/party path',
    );
    assert.ok(
      !content.includes('"/Users/party'),
      'route.ts should not contain hardcoded /Users/party path (double quotes)',
    );
  });

  it('should use os.homedir() for DEFAULT_BASE_DIR', () => {
    const routePath = path.resolve(__dirname, '../../app/api/git/clone/route.ts');
    const content = fs.readFileSync(routePath, 'utf-8');
    assert.ok(
      content.includes('os.homedir()'),
      'route.ts should use os.homedir() for the default base directory',
    );
  });
});

// ==========================================
// 2. Push Notifications — VAPID keys path
// ==========================================

describe('push-notifications — VAPID keys path', () => {
  it('should use os.homedir() instead of process.env.HOME fallback', () => {
    const filePath = path.resolve(__dirname, '../../lib/push-notifications.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    assert.ok(
      content.includes('os.homedir()'),
      'push-notifications.ts should use os.homedir()',
    );
    assert.ok(
      !content.includes("|| '~'"),
      'push-notifications.ts should not fall back to literal tilde string',
    );
  });
});

// ==========================================
// 3. decodeProjectPath — Windows + Unix
// ==========================================

describe('decodeProjectPath — cross-platform', () => {
  let parser: typeof import('../../lib/claude-session-parser');

  // Dynamic import to handle path aliases
  const parserPath = path.resolve(__dirname, '../../lib/claude-session-parser.ts');

  it('should decode Unix paths (leading dash)', async () => {
    parser = await import(parserPath);
    assert.equal(parser.decodeProjectPath('-home-user-project'), '/home/user/project');
    assert.equal(parser.decodeProjectPath('-root-clawd'), '/root/clawd');
  });

  it('should decode Windows paths (drive letter prefix)', async () => {
    parser = parser || await import(parserPath);
    // C:\Users\foo\projects\app
    assert.equal(
      parser.decodeProjectPath('C-Users-foo-projects-app'),
      'C:\\Users\\foo\\projects\\app',
    );
  });

  it('should normalize Windows drive letter to uppercase', async () => {
    parser = parser || await import(parserPath);
    assert.equal(
      parser.decodeProjectPath('c-users-test'),
      'C:\\users\\test',
    );
    assert.equal(
      parser.decodeProjectPath('d-work-repo'),
      'D:\\work\\repo',
    );
  });

  it('should return as-is for non-path encoded names', async () => {
    parser = parser || await import(parserPath);
    assert.equal(parser.decodeProjectPath('some-dir'), 'some-dir');
    assert.equal(parser.decodeProjectPath('myproject'), 'myproject');
  });

  it('should handle single-segment Unix path', async () => {
    parser = parser || await import(parserPath);
    assert.equal(parser.decodeProjectPath('-root'), '/root');
  });

  it('should handle Windows path with single directory', async () => {
    parser = parser || await import(parserPath);
    assert.equal(parser.decodeProjectPath('C-project'), 'C:\\project');
  });
});

// ==========================================
// 4. Versions API — platform-aware commands
// ==========================================

describe('versions route — platform-aware Codex update', () => {
  it('should not hardcode brew as the only Codex update method', () => {
    const routePath = path.resolve(__dirname, '../../app/api/versions/route.ts');
    const content = fs.readFileSync(routePath, 'utf-8');
    // Should have platform detection
    assert.ok(
      content.includes('isMac') || content.includes("process.platform"),
      'versions route should check platform for Codex CLI update method',
    );
    // Should have npm fallback for non-macOS
    assert.ok(
      content.includes('@openai/codex'),
      'versions route should have npm fallback for Codex CLI on non-macOS',
    );
  });

  it('should skip brew cask check on non-macOS', () => {
    const routePath = path.resolve(__dirname, '../../app/api/versions/route.ts');
    const content = fs.readFileSync(routePath, 'utf-8');
    assert.ok(
      content.includes('if (!isMac) return null'),
      'getLatestBrewCaskVersion should early-return null on non-macOS',
    );
  });
});

// ==========================================
// 5. FolderPicker — no hardcoded paths
// ==========================================

describe('FolderPicker — no hardcoded developer paths', () => {
  it('should not contain hardcoded /Users/party paths', () => {
    const filePath = path.resolve(__dirname, '../../components/chat/FolderPicker.tsx');
    const content = fs.readFileSync(filePath, 'utf-8');
    assert.ok(
      !content.includes('/Users/party'),
      'FolderPicker.tsx should not contain hardcoded /Users/party path',
    );
  });
});

// ==========================================
// 6. GeneralSection — no hardcoded paths
// ==========================================

describe('GeneralSection — no hardcoded developer paths', () => {
  it('should not contain hardcoded /Users/party paths', () => {
    const filePath = path.resolve(__dirname, '../../components/settings/GeneralSection.tsx');
    const content = fs.readFileSync(filePath, 'utf-8');
    assert.ok(
      !content.includes('/Users/party'),
      'GeneralSection.tsx should not contain hardcoded /Users/party path',
    );
  });
});

// ==========================================
// 7. package.json — cross-env dev script
// ==========================================

describe('package.json — cross-platform dev script', () => {
  it('should use cross-env for the dev script', () => {
    const pkgPath = path.resolve(__dirname, '../../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    assert.ok(
      pkg.scripts.dev.startsWith('cross-env '),
      'dev script should use cross-env for Windows compatibility',
    );
  });

  it('should have cross-env in devDependencies', () => {
    const pkgPath = path.resolve(__dirname, '../../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    assert.ok(
      pkg.devDependencies?.['cross-env'],
      'cross-env should be listed in devDependencies',
    );
  });
});
