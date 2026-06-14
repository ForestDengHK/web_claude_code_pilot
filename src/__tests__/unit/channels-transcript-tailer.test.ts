import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';

/* eslint-disable @typescript-eslint/no-require-imports */
const { transcriptEntriesToEvents, transcriptPath } = require('../../lib/channels/transcript-tailer') as typeof import('../../lib/channels/transcript-tailer');

test('assistant text entry becomes a text SSEEvent', () => {
  const entry = { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
  assert.deepEqual(transcriptEntriesToEvents([entry]), [{ type: 'text', data: 'hello' }]);
});

test('assistant tool_use entry becomes a tool_use SSEEvent', () => {
  const entry = { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
  ] } };
  const events = transcriptEntriesToEvents([entry]);
  assert.equal(events[0].type, 'tool_use');
  assert.match(events[0].data, /Bash/);
});

test('thinking block becomes a thinking SSEEvent', () => {
  const entry = { type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'hmm' },
  ] } };
  assert.deepEqual(transcriptEntriesToEvents([entry]), [{ type: 'thinking', data: 'hmm' }]);
});

test('user-entry text blocks are ignored (CodePilot-side prompt echoes)', () => {
  const entry = { type: 'user', message: { content: [{ type: 'text', text: 'x' }] } };
  assert.deepEqual(transcriptEntriesToEvents([entry]), []);
});

test('user-entry tool_result block becomes a tool_result SSEEvent', () => {
  const entry = { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 't1', content: 'done' },
  ] } };
  const events = transcriptEntriesToEvents([entry]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tool_result');
  assert.match(events[0].data, /t1/);
});

test('transcriptPath builds ~/.claude/projects/<encoded>/<id>.jsonl', () => {
  const result = transcriptPath('/root/clawd', 'sess-1');
  const expected = path.join(
    os.homedir(), '.claude', 'projects', '-root-clawd', 'sess-1.jsonl',
  );
  assert.equal(result, expected);
});

test('assistant entry with usage emits a result SSEEvent carrying token totals', () => {
  const entry = {
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 5, output_tokens: 12, cache_read_input_tokens: 100 },
    },
  };
  const events = transcriptEntriesToEvents([entry]);
  const result = events.find((e) => e.type === 'result');
  assert.ok(result, 'expected a result event');
  const usage = JSON.parse(result.data).usage;
  assert.equal(usage.output_tokens, 12);
  assert.equal(usage.input_tokens, 5);
  assert.equal(usage.model, 'claude-sonnet-4-6');
});

test('assistant entry with rate-limit error emits a rate_limit SSEEvent', () => {
  const entry = { type: 'assistant', error: 'rate_limit', message: { content: [] } };
  const events = transcriptEntriesToEvents([entry]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'rate_limit');
});

// Turn-end is NOT inferred from the transcript. In T1 every assistant entry —
// including tool_use ones — carries stop_reason='end_turn', so no single entry
// can signal the turn ended. streamChannels decides turn-end from the reply
// event + PTY quiet instead. The tailer must therefore NEVER emit turn_complete,
// regardless of stop_reason, so it can't prematurely close an agentic turn.
test('end_turn text entry does NOT emit turn_complete (T1 stop_reason is unreliable)', () => {
  const entry = { type: 'assistant', message: {
    stop_reason: 'end_turn', content: [{ type: 'text', text: 'all done' }],
  } };
  const events = transcriptEntriesToEvents([entry]);
  assert.ok(events.some((e) => e.type === 'text'), 'text is still surfaced');
  assert.ok(!events.some((e) => e.type === 'turn_complete'),
    'tailer must not infer turn-end');
});

test('end_turn tool_use entry does NOT emit turn_complete (the bug: T1 stamps tool_use as end_turn)', () => {
  // This is the exact entry shape that caused the truncation bug: a tool_use
  // block written with stop_reason='end_turn'. The tailer must surface the
  // tool_use for display but must NOT treat it as a turn end.
  const entry = { type: 'assistant', message: {
    stop_reason: 'end_turn',
    content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: {} }],
  } };
  const events = transcriptEntriesToEvents([entry]);
  assert.ok(events.some((e) => e.type === 'tool_use'), 'tool_use is still surfaced');
  assert.ok(!events.some((e) => e.type === 'turn_complete'),
    'a tool_use entry is never a turn end, even with stop_reason=end_turn');
});

test('thinking-only end_turn entry does NOT emit turn_complete', () => {
  const entry = { type: 'assistant', message: {
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: 'reasoning…' }],
  } };
  const events = transcriptEntriesToEvents([entry]);
  assert.ok(!events.some((e) => e.type === 'turn_complete'));
});

test('synthetic assistant entry (model "<synthetic>") emits no events', () => {
  // `claude --resume` injects this when it classifies the prior turn as
  // interrupted. Without filtering, its synthetic "No response requested."
  // text would be surfaced as the turn's response.
  const entry = { type: 'assistant', message: {
    model: '<synthetic>',
    stop_reason: 'stop_sequence',
    content: [{ type: 'text', text: 'No response requested.' }],
    usage: { input_tokens: 0, output_tokens: 0 },
  } };
  assert.deepEqual(transcriptEntriesToEvents([entry]), []);
});

test('synthetic API-error entry (isApiErrorMessage) surfaces an error event, not dropped', () => {
  // The fable-paused bug: the CLI writes the API failure as a synthetic
  // assistant entry. It must be surfaced (so the user sees it and an assistant
  // row is persisted, breaking the "reconnecting" deadlock) BEFORE the
  // '<synthetic>' drop swallows it. The human-readable reason comes from the
  // text block; we keep the entry's own wording.
  const entry = {
    type: 'assistant', error: 'model_not_found', isApiErrorMessage: true,
    message: {
      model: '<synthetic>', stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: "There's an issue with the selected model (claude-fable-5[1m]). It may not exist or you may not have access to it. Run /model to pick a different model." }],
    },
  };
  const events = transcriptEntriesToEvents([entry]);
  const err = events.find((e) => e.type === 'error');
  assert.ok(err, 'expected an error event');
  assert.match(err.data, /claude-fable-5/);
  // Must NOT also leak the text block as a plain text event.
  assert.ok(!events.some((e) => e.type === 'text'), 'no stray text event');
});

test('synthetic API-error entry with rate_limit still maps to rate_limit', () => {
  // A rate/usage limit also arrives as a synthetic API-error entry; it keeps the
  // dedicated rate_limit event rather than a generic error.
  const entry = {
    type: 'assistant', error: 'rate_limit', isApiErrorMessage: true,
    message: {
      model: '<synthetic>', stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: "You've hit your limit" }],
    },
  };
  const events = transcriptEntriesToEvents([entry]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'rate_limit');
});

test('synthetic API-error entry with 401 maps to auth_error (drives auto-respawn retry)', () => {
  // The OAuth access token crosses its ~8h refresh boundary while a long-lived
  // T1 PTY holds a stale copy → the CLI writes a synthetic assistant entry with
  // apiErrorStatus 401 / error "authentication_failed". It must surface as a
  // DISTINCT auth_error (not a generic error) so streamChannels can respawn the
  // session — a fresh `claude` re-mints the token — and retry transparently
  // instead of dumping "Please run /login" on the user.
  const entry = {
    type: 'assistant', error: 'authentication_failed', isApiErrorMessage: true, apiErrorStatus: 401,
    message: {
      model: '<synthetic>', stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: 'Please run /login · API Error: 401 Invalid authentication credentials' }],
    },
  };
  const events = transcriptEntriesToEvents([entry]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'auth_error');
  assert.match(events[0].data, /Please run \/login/);
  // Must NOT also leak the text block as a plain text event.
  assert.ok(!events.some((e) => e.type === 'text'), 'no stray text event');
});

test('isMeta user entry ("Continue from where you left off.") emits no events', () => {
  // The other half of the synthetic recovery pair the SDK writes on resume.
  const entry = {
    type: 'user', isMeta: true,
    message: { content: [{ type: 'text', text: 'Continue from where you left off.' }] },
  };
  assert.deepEqual(transcriptEntriesToEvents([entry]), []);
});

test('queue-operation dequeue becomes a channel_queue event (turn-started signal)', () => {
  // Surfaced internally so streamChannels can disarm the pre-dequeue wedge
  // watchdog once the CLI accepts a pushed message. See t1-session-wedged-no-reply.
  const entry = { type: 'queue-operation', operation: 'dequeue',
    timestamp: '2026-05-31T20:24:02.631Z' };
  assert.deepEqual(transcriptEntriesToEvents([entry]),
    [{ type: 'channel_queue', data: JSON.stringify({ op: 'dequeue' }) }]);
});

test('queue-operation enqueue becomes a channel_queue event', () => {
  const entry = { type: 'queue-operation', operation: 'enqueue',
    timestamp: '2026-05-31T20:28:41.386Z', content: 'hi' };
  assert.deepEqual(transcriptEntriesToEvents([entry]),
    [{ type: 'channel_queue', data: JSON.stringify({ op: 'enqueue' }) }]);
});
