/**
 * Unit tests for detectLeakedToolCall — the "session degraded" guard.
 *
 * Run with: npx tsx --test src/__tests__/unit/context-health-leak-detector.test.ts
 *
 * Background: when a session's context saturates, the model can emit a tool
 * call as plain *text* (the antml `<invoke name="…">` markup) instead of a
 * structured tool_use block. The harness can't execute it, the turn ends, and
 * the work silently stalls. We detect that text so the UI can warn the user to
 * start a fresh session. The detector must NOT fire on real tool_use blocks
 * (whose command inputs legitimately contain shell text).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLeakedToolCall } from '@/lib/context-health';

const leakedInvoke =
  '<invoke name="Bash">\n<parameter name="command">cd /tmp && ls</parameter>\n</invoke>';

describe('detectLeakedToolCall', () => {
  it('flags a plaintext turn that ends with a leaked tool call', () => {
    const content = `明白,我现在一口气把 PR 提交完,不再中途停。\n\n${leakedInvoke}`;
    assert.equal(detectLeakedToolCall(content), true);
  });

  it('flags a JSON-array turn whose final text block leaked a tool call', () => {
    const content = JSON.stringify([
      { type: 'text', text: 'ruff check 全过。还剩 2 个文件要重排。直接修：' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo a' } },
      { type: 'tool_result', tool_use_id: 't1', content: 'a' },
      { type: 'text', text: `继续\n\n${leakedInvoke}` },
    ]);
    assert.equal(detectLeakedToolCall(content), true);
  });

  it('does NOT flag a healthy turn with real tool_use blocks', () => {
    const content = JSON.stringify([
      { type: 'text', text: 'Running the gates now.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ruff check .' } },
      { type: 'tool_result', tool_use_id: 't1', content: 'All checks passed!' },
      { type: 'text', text: 'All gates pass.' },
    ]);
    assert.equal(detectLeakedToolCall(content), false);
  });

  it('does NOT scan tool_use inputs — a command that echoes <invoke> is fine', () => {
    const content = JSON.stringify([
      { type: 'text', text: 'Demonstrating the syntax in a heredoc.' },
      {
        type: 'tool_use',
        id: 't1',
        name: 'Bash',
        input: { command: `echo '${leakedInvoke}' > example.txt` },
      },
      { type: 'tool_result', tool_use_id: 't1', content: '' },
    ]);
    assert.equal(detectLeakedToolCall(content), false);
  });

  it('does NOT flag ordinary prose that merely says the word invoke', () => {
    assert.equal(
      detectLeakedToolCall('I will invoke the Bash tool to run the tests.'),
      false,
    );
  });

  it('does NOT flag a lone <invoke> opener without parameter/closing markup', () => {
    // Defensive: a stray "<invoke name=" inside prose shouldn't trip the alarm.
    assert.equal(detectLeakedToolCall('We discussed <invoke name= earlier.'), false);
  });

  it('handles empty / malformed input without throwing', () => {
    assert.equal(detectLeakedToolCall(''), false);
    assert.equal(detectLeakedToolCall(null), false);
    assert.equal(detectLeakedToolCall(undefined), false);
    assert.equal(detectLeakedToolCall('[not valid json'), false);
  });
});
