import { test } from 'node:test';
import assert from 'node:assert';

/* eslint-disable @typescript-eslint/no-require-imports */
const { streamChannels } = require('../../lib/channels-client') as typeof import('../../lib/channels-client');
import type { ChannelsStreamOptions } from '../../lib/channels-client';
import type { SSEEvent } from '../../types';

/** Build a ReadableStream that emits each event as its own SSE chunk, like assembleStream. */
function fakeTurn(events: SSEEvent[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const e of events) controller.enqueue(`data: ${JSON.stringify(e)}\n\n`);
      controller.close();
    },
  });
}

/** Drain the wrapper stream into a flat list of parsed SSEEvents. */
async function collect(stream: ReadableStream<string>): Promise<SSEEvent[]> {
  const reader = stream.getReader();
  const out: SSEEvent[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of value.split('\n')) {
      if (line.startsWith('data: ')) out.push(JSON.parse(line.slice(6)));
    }
  }
  return out;
}

const baseOpts = { sessionId: 's1', prompt: 'hi', workingDirectory: '/tmp', internalUrl: 'http://x' } as unknown as ChannelsStreamOptions;

/** No-op warmup so unit tests never spawn a real `claude -p`. */
const noWarmup = async () => {};

test('auth_error on first attempt → swallowed, session_reset emitted, retry succeeds', async () => {
  const scripts = [
    [{ type: 'auth_error', data: 'Please run /login · API Error: 401' }, { type: 'done', data: '' }],
    [{ type: 'text', data: 'recovered answer' }, { type: 'done', data: '' }],
  ] as SSEEvent[][];
  let calls = 0;
  const events = await collect(streamChannels(baseOpts, () => fakeTurn(scripts[calls++]), noWarmup));

  assert.equal(calls, 2, 'turn runner called twice (original + retry)');
  assert.ok(!events.some((e) => e.type === 'auth_error'), 'auth_error must never reach the client');
  assert.ok(events.some((e) => e.type === 'session_reset'), 'session_reset signals the collector to discard the failed attempt');
  assert.ok(events.some((e) => e.type === 'text' && e.data === 'recovered answer'), 'retry answer forwarded');
});

test('auth_error → warmup re-mints the token BETWEEN the failed turn and the retry', async () => {
  const scripts = [
    [{ type: 'auth_error', data: 'Please run /login · API Error: 401' }, { type: 'done', data: '' }],
    [{ type: 'text', data: 'recovered' }, { type: 'done', data: '' }],
  ] as SSEEvent[][];
  const order: string[] = [];
  let calls = 0;
  const runTurn = () => { order.push(`turn${calls}`); return fakeTurn(scripts[calls++]); };
  const warmup = async () => { order.push('warmup'); };
  await collect(streamChannels(baseOpts, runTurn, warmup));
  assert.deepEqual(order, ['turn0', 'warmup', 'turn1'],
    'warmup must run after the 401 and before the respawned retry, so the retry reads a fresh token');
});

test('happy path → warmup is NOT called', async () => {
  let warmups = 0;
  const script = [{ type: 'text', data: 'hi' }, { type: 'done', data: '' }] as SSEEvent[];
  await collect(streamChannels(baseOpts, () => fakeTurn(script), async () => { warmups++; }));
  assert.equal(warmups, 0, 'no warmup when there is no auth failure');
});

test('auth_error but not retryable (already aborted) → warmup is NOT called', async () => {
  const ac = new AbortController(); ac.abort();
  const opts = { ...baseOpts, abortSignal: ac.signal } as ChannelsStreamOptions;
  let warmups = 0;
  const auth = [{ type: 'auth_error', data: '401' }, { type: 'done', data: '' }] as SSEEvent[];
  await collect(streamChannels(opts, () => fakeTurn(auth), async () => { warmups++; }));
  assert.equal(warmups, 0, 'no warmup when the retry is not attempted');
});

test('auth_error on BOTH attempts → surfaced as a normal error (no infinite loop)', async () => {
  const auth = [{ type: 'auth_error', data: 'Please run /login · API Error: 401' }, { type: 'done', data: '' }] as SSEEvent[];
  let calls = 0;
  const events = await collect(streamChannels(baseOpts, () => { calls++; return fakeTurn(auth); }, noWarmup));

  assert.equal(calls, 2, 'capped at one retry');
  assert.ok(!events.some((e) => e.type === 'auth_error'), 'auth_error never leaks');
  const err = events.find((e) => e.type === 'error');
  assert.ok(err && /Please run \/login/.test(err.data), 'final failure surfaces the login prompt');
});

test('content already streamed before auth_error → no retry (avoid duplication)', async () => {
  const script = [
    { type: 'text', data: 'partial' },
    { type: 'auth_error', data: 'Please run /login · API Error: 401' },
    { type: 'done', data: '' },
  ] as SSEEvent[];
  let calls = 0;
  const events = await collect(streamChannels(baseOpts, () => { calls++; return fakeTurn(script); }));

  assert.equal(calls, 1, 'no retry once content has been forwarded');
  assert.ok(events.some((e) => e.type === 'text' && e.data === 'partial'), 'partial content preserved');
  assert.ok(events.some((e) => e.type === 'error'), 'auth error surfaced instead of retried');
});

test('normal turn (no auth error) → forwarded unchanged, no retry', async () => {
  const script = [{ type: 'text', data: 'hello' }, { type: 'done', data: '' }] as SSEEvent[];
  let calls = 0;
  const events = await collect(streamChannels(baseOpts, () => { calls++; return fakeTurn(script); }));

  assert.equal(calls, 1);
  assert.ok(!events.some((e) => e.type === 'session_reset'), 'no spurious reset on the happy path');
  assert.deepEqual(events.map((e) => e.type), ['text', 'done']);
});

test('downstream cancel mid-stream cancels the inner turn (no enqueue-after-close throw)', async () => {
  let innerCancelled = false;
  const inner = new ReadableStream<string>({
    start(c) { c.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'a' })}\n\n`); /* stay open */ },
    cancel() { innerCancelled = true; },
  });
  const stream = streamChannels(baseOpts, () => inner);
  const reader = stream.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  await reader.cancel(); // client/collector gone → tee cancels our source
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(innerCancelled, 'inner turn reader is cancelled on downstream teardown');
});

test('aborted by user → auth_error is NOT retried', async () => {
  const ac = new AbortController();
  ac.abort();
  const opts = { ...baseOpts, abortSignal: ac.signal } as ChannelsStreamOptions;
  const auth = [{ type: 'auth_error', data: 'Please run /login · API Error: 401' }, { type: 'done', data: '' }] as SSEEvent[];
  let calls = 0;
  const events = await collect(streamChannels(opts, () => { calls++; return fakeTurn(auth); }));

  assert.equal(calls, 1, 'no retry when the user already aborted');
  assert.ok(events.some((e) => e.type === 'error'), 'surfaces instead of retrying');
});
