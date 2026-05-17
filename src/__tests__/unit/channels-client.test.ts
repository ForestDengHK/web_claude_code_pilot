import { test } from 'node:test';
import assert from 'node:assert';

/* eslint-disable @typescript-eslint/no-require-imports */
const { assembleStream } = require('../../lib/channels-client') as typeof import('../../lib/channels-client');

async function collect(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let out = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; out += value; }
  return out;
}

test('assembleStream emits emitted events then done on finish', async () => {
  const stream = assembleStream({
    onStart: (emit, finish) => {
      emit({ type: 'text', data: 'hi' });
      emit({ type: 'tool_use', data: '{"name":"Bash"}' });
      finish('done text');
    },
  });
  const joined = await collect(stream);
  assert.match(joined, /"type":"text"/);
  assert.match(joined, /"type":"tool_use"/);
  assert.match(joined, /"type":"done"/);
});

test('assembleStream surfaces finish() text as a text event', async () => {
  // The reply-tool answer arrives via finish(); it must reach the client as a
  // text event, otherwise the model's answer is silently dropped.
  const stream = assembleStream({ onStart: (_emit, finish) => finish('the final answer') });
  const joined = await collect(stream);
  assert.match(joined, /"type":"text"/);
  assert.match(joined, /the final answer/);
});

test('assembleStream emits a result event carrying finish() usage', async () => {
  const stream = assembleStream({
    onStart: (_emit, finish) => finish('answer', { output_tokens: 42, model: 'claude-sonnet-4-6' }),
  });
  const joined = await collect(stream);
  const resultLine = joined.split('\n').find((l) => l.includes('"type":"result"'));
  assert.ok(resultLine, 'expected a result event');
  const usage = JSON.parse(JSON.parse(resultLine.slice(6)).data).usage;
  assert.equal(usage.output_tokens, 42);
  assert.equal(usage.model, 'claude-sonnet-4-6');
});

test('assembleStream omits the result event when finish() has no usage', async () => {
  const stream = assembleStream({ onStart: (_emit, finish) => finish('answer') });
  const joined = await collect(stream);
  assert.doesNotMatch(joined, /"type":"result"/);
});

test('assembleStream emits error on fail', async () => {
  const stream = assembleStream({ onStart: (_emit, _finish, fail) => fail('boom') });
  const joined = await collect(stream);
  assert.match(joined, /"type":"error"/);
  assert.match(joined, /boom/);
});
