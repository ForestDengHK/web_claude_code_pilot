/**
 * Unit tests for Telegram bridge utility functions.
 * Tests only pure functions (no network calls).
 *
 * Run: npx tsx src/__tests__/unit/bridge-telegram-utils.test.ts
 */

import assert from 'node:assert/strict';
import {
  escapeHtml,
  splitMessage,
  formatSessionHeader,
} from '../../lib/bridge/adapters/telegram-utils';
import {
  selectOptimalPhoto,
  inferMimeType,
  isSupportedImageMime,
} from '../../lib/bridge/adapters/telegram-media';
import type { TelegramPhotoSize } from '../../lib/bridge/adapters/telegram-media';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${err instanceof Error ? err.message : err}`);
  }
}

// ===========================================================
// escapeHtml
// ===========================================================
console.log('\nescapeHtml');

test('escapes ampersand', () => {
  assert.equal(escapeHtml('A & B'), 'A &amp; B');
});

test('escapes less-than', () => {
  assert.equal(escapeHtml('a < b'), 'a &lt; b');
});

test('escapes greater-than', () => {
  assert.equal(escapeHtml('a > b'), 'a &gt; b');
});

test('escapes combined HTML', () => {
  assert.equal(escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
});

test('leaves plain text unchanged', () => {
  assert.equal(escapeHtml('hello world'), 'hello world');
});

// ===========================================================
// splitMessage
// ===========================================================
console.log('\nsplitMessage');

test('short text returns single chunk', () => {
  const result = splitMessage('hello', 100);
  assert.deepEqual(result, ['hello']);
});

test('text over limit splits at newlines', () => {
  const text = 'line1\nline2\nline3\nline4';
  const result = splitMessage(text, 12);
  assert.ok(result.length > 1, `Expected multiple chunks, got ${result.length}`);
  for (const chunk of result) {
    assert.ok(chunk.length <= 12, `Chunk "${chunk}" exceeds limit 12 (length: ${chunk.length})`);
  }
  // Joined chunks should equal original text
  assert.equal(result.join(''), text);
});

test('respects maxLength', () => {
  const text = 'a'.repeat(100);
  const result = splitMessage(text, 30);
  for (const chunk of result) {
    assert.ok(chunk.length <= 30);
  }
  assert.equal(result.join(''), text);
});

test('handles text with no newlines', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz';
  const result = splitMessage(text, 10);
  assert.ok(result.length > 1);
  for (const chunk of result) {
    assert.ok(chunk.length <= 10);
  }
  assert.equal(result.join(''), text);
});

test('exact length returns single chunk', () => {
  const text = 'abc';
  assert.deepEqual(splitMessage(text, 3), ['abc']);
});

// ===========================================================
// formatSessionHeader
// ===========================================================
console.log('\nformatSessionHeader');

test('with title only', () => {
  const result = formatSessionHeader({ title: 'My Session' });
  assert.equal(result, '<b>My Session</b>');
});

test('with workDir only', () => {
  const result = formatSessionHeader({ workDir: '/home/user/project' });
  assert.equal(result, '<code>/home/user/project</code>');
});

test('with both title and workDir', () => {
  const result = formatSessionHeader({ title: 'Test', workDir: '/tmp' });
  assert.equal(result, '<b>Test</b>\n<code>/tmp</code>');
});

test('with no opts returns empty', () => {
  assert.equal(formatSessionHeader(), '');
});

test('with empty opts returns empty', () => {
  assert.equal(formatSessionHeader({}), '');
});

test('escapes HTML in title', () => {
  const result = formatSessionHeader({ title: '<script>' });
  assert.equal(result, '<b>&lt;script&gt;</b>');
});

// ===========================================================
// selectOptimalPhoto
// ===========================================================
console.log('\nselectOptimalPhoto');

test('picks smallest photo with long edge >= 1568', () => {
  const photos: TelegramPhotoSize[] = [
    { file_id: 'a', file_unique_id: 'a', width: 320, height: 240 },
    { file_id: 'b', file_unique_id: 'b', width: 1600, height: 1200 },
    { file_id: 'c', file_unique_id: 'c', width: 2400, height: 1800 },
  ];
  const result = selectOptimalPhoto(photos);
  assert.equal(result?.file_id, 'b');
});

test('picks largest if none qualify', () => {
  const photos: TelegramPhotoSize[] = [
    { file_id: 'a', file_unique_id: 'a', width: 320, height: 240 },
    { file_id: 'b', file_unique_id: 'b', width: 800, height: 600 },
    { file_id: 'c', file_unique_id: 'c', width: 1024, height: 768 },
  ];
  const result = selectOptimalPhoto(photos);
  assert.equal(result?.file_id, 'c');
});

test('returns null for empty array', () => {
  assert.equal(selectOptimalPhoto([]), null);
});

test('single photo is returned', () => {
  const photos: TelegramPhotoSize[] = [
    { file_id: 'x', file_unique_id: 'x', width: 500, height: 500 },
  ];
  assert.equal(selectOptimalPhoto(photos)?.file_id, 'x');
});

test('exactly 1568 long edge qualifies', () => {
  const photos: TelegramPhotoSize[] = [
    { file_id: 'a', file_unique_id: 'a', width: 800, height: 600 },
    { file_id: 'b', file_unique_id: 'b', width: 1568, height: 1000 },
  ];
  assert.equal(selectOptimalPhoto(photos)?.file_id, 'b');
});

// ===========================================================
// inferMimeType
// ===========================================================
console.log('\ninferMimeType');

test('.jpg -> image/jpeg', () => {
  assert.equal(inferMimeType('photo.jpg'), 'image/jpeg');
});

test('.jpeg -> image/jpeg', () => {
  assert.equal(inferMimeType('photo.jpeg'), 'image/jpeg');
});

test('.png -> image/png', () => {
  assert.equal(inferMimeType('img.png'), 'image/png');
});

test('.gif -> image/gif', () => {
  assert.equal(inferMimeType('anim.gif'), 'image/gif');
});

test('.txt -> null', () => {
  assert.equal(inferMimeType('readme.txt'), null);
});

test('no extension -> null', () => {
  assert.equal(inferMimeType('Makefile'), null);
});

test('.JPG (uppercase) -> image/jpeg', () => {
  assert.equal(inferMimeType('PHOTO.JPG'), 'image/jpeg');
});

// ===========================================================
// isSupportedImageMime
// ===========================================================
console.log('\nisSupportedImageMime');

test('image/jpeg is supported', () => {
  assert.equal(isSupportedImageMime('image/jpeg'), true);
});

test('image/png is supported', () => {
  assert.equal(isSupportedImageMime('image/png'), true);
});

test('image/gif is supported', () => {
  assert.equal(isSupportedImageMime('image/gif'), true);
});

test('image/webp is supported', () => {
  assert.equal(isSupportedImageMime('image/webp'), true);
});

test('application/pdf is not supported', () => {
  assert.equal(isSupportedImageMime('application/pdf'), false);
});

test('text/plain is not supported', () => {
  assert.equal(isSupportedImageMime('text/plain'), false);
});

// ===========================================================
// Summary
// ===========================================================
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
