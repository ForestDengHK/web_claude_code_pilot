/**
 * Unit tests for bridge markdown pipeline: IR, BaseIRRenderer, TelegramRenderer, chunking.
 *
 * Run: npx tsx src/__tests__/unit/bridge-markdown.test.ts
 */

import assert from 'node:assert/strict';
import { markdownToIR } from '../../lib/bridge/markdown/ir';
import type { IRNode } from '../../lib/bridge/markdown/ir';
import { BaseIRRenderer } from '../../lib/bridge/markdown/render';
import { TelegramRenderer, markdownToTelegramChunks } from '../../lib/bridge/markdown/telegram';

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
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ===== markdownToIR =====

console.log('\nmarkdownToIR:');

test('plain text produces text node inside paragraph', () => {
  const nodes = markdownToIR('Hello world');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, 'paragraph');
  assert.equal(nodes[0].children![0].type, 'text');
  assert.equal(nodes[0].children![0].content, 'Hello world');
});

test('bold text', () => {
  const nodes = markdownToIR('**bold**');
  const p = nodes[0];
  assert.equal(p.type, 'paragraph');
  assert.equal(p.children![0].type, 'bold');
  assert.equal(p.children![0].children![0].content, 'bold');
});

test('italic text', () => {
  const nodes = markdownToIR('*italic*');
  const p = nodes[0];
  assert.equal(p.children![0].type, 'italic');
  assert.equal(p.children![0].children![0].content, 'italic');
});

test('inline code', () => {
  const nodes = markdownToIR('use `code` here');
  const p = nodes[0];
  const codeNode = p.children!.find((n) => n.type === 'code');
  assert.ok(codeNode);
  assert.equal(codeNode!.content, 'code');
});

test('code block with language', () => {
  const nodes = markdownToIR('```typescript\nconst x = 1;\n```');
  const cb = nodes.find((n) => n.type === 'code_block');
  assert.ok(cb);
  assert.equal(cb!.language, 'typescript');
  assert.ok(cb!.content!.includes('const x = 1;'));
});

test('code block without language', () => {
  const nodes = markdownToIR('```\nplain code\n```');
  const cb = nodes.find((n) => n.type === 'code_block');
  assert.ok(cb);
  assert.equal(cb!.language, undefined);
});

test('link', () => {
  const nodes = markdownToIR('[click](https://example.com)');
  const p = nodes[0];
  const link = p.children!.find((n) => n.type === 'link');
  assert.ok(link);
  assert.equal(link!.url, 'https://example.com');
  assert.equal(link!.children![0].content, 'click');
});

test('heading levels', () => {
  for (let level = 1; level <= 3; level++) {
    const hashes = '#'.repeat(level);
    const nodes = markdownToIR(`${hashes} Title`);
    const h = nodes.find((n) => n.type === 'heading');
    assert.ok(h, `heading level ${level} not found`);
    assert.equal(h!.level, level);
  }
});

test('unordered list', () => {
  const nodes = markdownToIR('- item1\n- item2');
  const items = nodes.filter((n) => n.type === 'list_item');
  assert.equal(items.length, 2);
  assert.equal(items[0].ordered, false);
});

test('ordered list', () => {
  const nodes = markdownToIR('1. first\n2. second');
  const items = nodes.filter((n) => n.type === 'list_item');
  assert.equal(items.length, 2);
  assert.equal(items[0].ordered, true);
});

test('blockquote', () => {
  const nodes = markdownToIR('> quoted text');
  const bq = nodes.find((n) => n.type === 'blockquote');
  assert.ok(bq);
  // Blockquote contains a paragraph with the text
  const p = bq!.children!.find((n) => n.type === 'paragraph');
  assert.ok(p);
});

test('horizontal rule', () => {
  const nodes = markdownToIR('---');
  const hr = nodes.find((n) => n.type === 'horizontal_rule');
  assert.ok(hr);
});

test('nested bold inside link', () => {
  const nodes = markdownToIR('[**bold link**](https://example.com)');
  const p = nodes[0];
  const link = p.children!.find((n) => n.type === 'link');
  assert.ok(link);
  const bold = link!.children!.find((n) => n.type === 'bold');
  assert.ok(bold);
});

// ===== TelegramRenderer =====

console.log('\nTelegramRenderer:');

const tg = new TelegramRenderer();

test('text escapes HTML', () => {
  assert.equal(tg.text('<b>test</b>'), '&lt;b&gt;test&lt;/b&gt;');
});

test('bold wraps in <b>', () => {
  assert.equal(tg.bold('hello'), '<b>hello</b>');
});

test('italic wraps in <i>', () => {
  assert.equal(tg.italic('hello'), '<i>hello</i>');
});

test('strikethrough wraps in <s>', () => {
  assert.equal(tg.strikethrough('hello'), '<s>hello</s>');
});

test('code wraps in <code> and escapes', () => {
  assert.equal(tg.code('a<b>'), '<code>a&lt;b&gt;</code>');
});

test('codeBlock with language', () => {
  const result = tg.codeBlock('x = 1', 'python');
  assert.ok(result.includes('class="language-python"'));
  assert.ok(result.includes('x = 1'));
});

test('codeBlock without language', () => {
  const result = tg.codeBlock('x = 1');
  assert.ok(!result.includes('class='));
  assert.ok(result.includes('<pre><code>'));
});

test('link renders <a> tag', () => {
  const result = tg.link('click', 'https://example.com');
  assert.equal(result, '<a href="https://example.com">click</a>');
});

test('heading renders bold', () => {
  const result = tg.heading('Title', 2);
  assert.ok(result.includes('<b>Title</b>'));
});

test('renders full IR tree to HTML', () => {
  const nodes: IRNode[] = [
    {
      type: 'paragraph',
      children: [
        { type: 'text', content: 'Hello ' },
        { type: 'bold', children: [{ type: 'text', content: 'world' }] },
      ],
    },
  ];
  const html = tg.renderNodes(nodes);
  assert.equal(html, 'Hello <b>world</b>\n\n');
});

// ===== BaseIRRenderer (plain text) =====

console.log('\nBaseIRRenderer:');

const plain = new BaseIRRenderer();

test('strips bold formatting', () => {
  const nodes: IRNode[] = [
    { type: 'bold', children: [{ type: 'text', content: 'hello' }] },
  ];
  assert.equal(plain.renderNodes(nodes), 'hello');
});

test('strips italic formatting', () => {
  const nodes: IRNode[] = [
    { type: 'italic', children: [{ type: 'text', content: 'hi' }] },
  ];
  assert.equal(plain.renderNodes(nodes), 'hi');
});

test('link shows url in parens', () => {
  const nodes: IRNode[] = [
    { type: 'link', url: 'https://example.com', children: [{ type: 'text', content: 'click' }] },
  ];
  assert.equal(plain.renderNodes(nodes), 'click (https://example.com)');
});

test('code block outputs content with newline', () => {
  assert.equal(plain.codeBlock('x = 1', 'py'), 'x = 1\n');
});

test('paragraph outputs content with double newline', () => {
  assert.equal(plain.paragraph('hello'), 'hello\n\n');
});

// ===== markdownToTelegramChunks =====

console.log('\nmarkdownToTelegramChunks:');

test('short text produces 1 chunk', () => {
  const chunks = markdownToTelegramChunks('Hello world');
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].includes('Hello world'));
});

test('code blocks preserved in output', () => {
  const chunks = markdownToTelegramChunks('```python\nprint("hi")\n```');
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].includes('<pre><code'));
  assert.ok(chunks[0].includes('print'));
});

test('nested formatting works', () => {
  const chunks = markdownToTelegramChunks('**bold *and italic***');
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].includes('<b>'));
  assert.ok(chunks[0].includes('<i>'));
});

test('long text splits into multiple chunks', () => {
  // Create markdown that exceeds 100 chars when rendered
  const maxLen = 100;
  const paragraphs = Array.from({ length: 20 }, (_, i) => `Paragraph number ${i}: ${'x'.repeat(30)}`);
  const md = paragraphs.join('\n\n');
  const chunks = markdownToTelegramChunks(md, maxLen);
  assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= maxLen, `Chunk exceeds maxLength: ${chunk.length} > ${maxLen}`);
  }
});

test('single huge node gets hard-split', () => {
  // One very long paragraph
  const longText = 'A'.repeat(300);
  const chunks = markdownToTelegramChunks(longText, 100);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
  }
});

test('empty input returns single empty chunk', () => {
  const chunks = markdownToTelegramChunks('');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], '');
});

// ===== Summary =====

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
if (failed > 0) process.exit(1);
