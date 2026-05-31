import { test } from 'node:test';
import assert from 'node:assert';

/* eslint-disable @typescript-eslint/no-require-imports */
const { resolveFinalReplyText } = require('../../lib/channels/reply-dedup') as typeof import('../../lib/channels/reply-dedup');

// Regression for the recurring T1 truncation bug. Captured shape: the model
// streams short narration as natural text and puts the real, detailed answer
// ONLY in the reply tool. The OLD boolean logic returned '' here (because text
// had streamed), dropping the answer — UI showed only the narration. The answer
// must now be delivered.
test('working-notes streamed + answer only in reply → reply is delivered (the truncation bug)', () => {
  const streamed = [
    'Both backends report the levels correctly — production returns the full set.',
    'The dropdown maps all options with no filtering.',
    'I have everything I need. Let me load the reply tool to respond on the channel.',
  ].join('\n');
  const reply = '两件事分别说。\n\n## 1. Workflow\n这个我们确实没有，但不是 bug，是架构缺口。（完整详答）';
  assert.equal(resolveFinalReplyText(streamed, reply), reply);
});

// The case the old boolean existed to handle: the model typed its answer as
// natural text, then restated the same text verbatim into reply. Showing both
// duplicates the answer, so reply is suppressed.
test('answer typed as text then restated verbatim in reply → reply suppressed (no duplicate)', () => {
  const answer = 'The effort levels are low, medium, high, xhigh, and max.';
  assert.equal(resolveFinalReplyText(answer, answer), '');
});

test('restatement differing only in whitespace → still suppressed', () => {
  const streamed = 'The answer is 42.';
  const reply = '  The   answer\n is 42. ';
  assert.equal(resolveFinalReplyText(streamed, reply), '');
});

test('answer embedded among narration, restated verbatim in reply → suppressed', () => {
  const streamed = 'Let me check.\nThe final answer is 42 because of X and Y.\nDone.';
  const reply = 'The final answer is 42 because of X and Y.';
  assert.equal(resolveFinalReplyText(streamed, reply), '');
});

// The model used ONLY the reply tool and streamed no natural text. reply is the
// sole copy of the answer and must be delivered.
test('model used ONLY reply (no natural text) → reply is delivered', () => {
  assert.equal(resolveFinalReplyText('', 'the only copy of the answer'), 'the only copy of the answer');
});

test('empty reply → nothing to deliver (streamed text already shown)', () => {
  assert.equal(resolveFinalReplyText('some streamed text', ''), '');
});
