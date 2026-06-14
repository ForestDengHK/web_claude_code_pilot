import { test } from 'node:test';
import assert from 'node:assert';

/* eslint-disable @typescript-eslint/no-require-imports */
const { turnHasDeliverableAnswer } = require('../../lib/channels-client') as typeof import('../../lib/channels-client');

// When a watchdog force-kills a turn (timeout / stall), the turn-end DETECTOR
// failed — but the model may already have produced a real answer (it called
// `reply`, or streamed a natural-language answer). In that case the turn should
// be FINISHED with that answer, not failed with "channel turn timed out".

test('a delivered reply is preserved even with no streamed text', () => {
  assert.equal(turnHasDeliverableAnswer({ sawReply: true, streamedText: '' }), true);
});

test('streamed natural-language text counts as a deliverable answer', () => {
  assert.equal(turnHasDeliverableAnswer({ sawReply: false, streamedText: 'here is the answer' }), true);
});

test('a turn that produced nothing has no answer to preserve (genuine wedge → fail)', () => {
  assert.equal(turnHasDeliverableAnswer({ sawReply: false, streamedText: '' }), false);
});

test('whitespace-only streamed text is not a deliverable answer', () => {
  assert.equal(turnHasDeliverableAnswer({ sawReply: false, streamedText: '  \n\t ' }), false);
});
