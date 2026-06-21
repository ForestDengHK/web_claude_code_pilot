import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapResponsesEvent,
  parseResponsesFrame,
  streamOpenAI,
  type ResponsesStreamEvent,
} from '../../lib/openai-client';

// ---------------------------------------------------------------------------
// Pure mapping: Responses stream event -> our SSEEvent union
// ---------------------------------------------------------------------------

describe('mapResponsesEvent', () => {
  it('maps output_text.delta -> text', () => {
    assert.deepEqual(
      mapResponsesEvent({ type: 'response.output_text.delta', delta: 'Hel' }),
      { type: 'text', data: 'Hel' },
    );
  });

  it('maps reasoning_summary_text.delta -> thinking (reuses Codex reasoning channel)', () => {
    assert.deepEqual(
      mapResponsesEvent({ type: 'response.reasoning_summary_text.delta', delta: 'planning…' }),
      { type: 'thinking', data: 'planning…' },
    );
  });

  it('surfaces refusal deltas as text instead of dropping them', () => {
    assert.deepEqual(
      mapResponsesEvent({ type: 'response.refusal.delta', delta: 'I can’t help with that' }),
      { type: 'text', data: 'I can’t help with that' },
    );
  });

  it('maps response.completed -> result carrying token usage as a JSON string', () => {
    const sse = mapResponsesEvent({
      type: 'response.completed',
      response: { usage: { input_tokens: 12, output_tokens: 34 } },
    });
    assert.equal(sse?.type, 'result');
    assert.deepEqual(JSON.parse(sse!.data), {
      subtype: 'success',
      usage: { input_tokens: 12, output_tokens: 34 },
    });
  });

  it('maps response.failed -> error with the server message', () => {
    assert.deepEqual(
      mapResponsesEvent({ type: 'response.failed', response: { error: { message: 'overloaded' } } }),
      { type: 'error', data: 'overloaded' },
    );
  });

  it('maps a top-level error event -> error', () => {
    assert.deepEqual(
      mapResponsesEvent({ type: 'error', error: { message: 'bad key' } }),
      { type: 'error', data: 'bad key' },
    );
  });

  it('skips events the planner POC does not need (returns null)', () => {
    const ignored = [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.done',
      'response.function_call_arguments.delta',
    ];
    for (const type of ignored) {
      assert.equal(mapResponsesEvent({ type } as ResponsesStreamEvent), null, type);
    }
  });
});

// ---------------------------------------------------------------------------
// Wire frame parsing
// ---------------------------------------------------------------------------

describe('parseResponsesFrame', () => {
  it('extracts the JSON payload from a typed SSE frame', () => {
    const frame = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}';
    assert.deepEqual(parseResponsesFrame(frame), {
      type: 'response.output_text.delta',
      delta: 'Hi',
    });
  });

  it('ignores [DONE] sentinels and unparseable frames', () => {
    assert.equal(parseResponsesFrame('data: [DONE]'), null);
    assert.equal(parseResponsesFrame('data: not-json'), null);
    assert.equal(parseResponsesFrame(': keep-alive comment'), null);
  });
});

// ---------------------------------------------------------------------------
// End-to-end driver with an injected fake fetch (no network, no API key)
// ---------------------------------------------------------------------------

/** Build a fake fetch whose Response body streams the given raw SSE text in chunks. */
function fakeFetch(rawSSE: string, chunkSize = 17): typeof fetch {
  return (async () => {
    const bytes = new TextEncoder().encode(rawSSE);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.slice(i, i + chunkSize));
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

async function collect(stream: ReadableStream<string>): Promise<{ type: string; data: string }[]> {
  const reader = stream.getReader();
  let buf = '';
  const events: { type: string; data: string }[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      if (line.startsWith('data:')) events.push(JSON.parse(line.slice('data:'.length).trim()));
    }
  }
  return events;
}

describe('streamOpenAI (driver, injected fetch)', () => {
  const RAW = [
    'event: response.created',
    'data: {"type":"response.created"}',
    '',
    'event: response.reasoning_summary_text.delta',
    'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"Hello"}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":" world"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}',
    '',
    '',
  ].join('\n');

  it('translates a full Responses byte stream into our SSE event sequence', async () => {
    const stream = streamOpenAI(
      { prompt: 'hi', apiKey: 'test-key' },
      { fetch: fakeFetch(RAW) },
    );
    const events = await collect(stream);

    assert.deepEqual(
      events.map((e) => e.type),
      ['thinking', 'text', 'text', 'result', 'done'],
    );
    assert.equal(events.filter((e) => e.type === 'text').map((e) => e.data).join(''), 'Hello world');
    assert.deepEqual(JSON.parse(events.find((e) => e.type === 'result')!.data), {
      subtype: 'success',
      usage: { input_tokens: 5, output_tokens: 2 },
    });
  });

  it('emits error + done (never throws) when the API key is missing', async () => {
    const stream = streamOpenAI({ prompt: 'hi', apiKey: '' }, { fetch: fakeFetch('') });
    const events = await collect(stream);
    assert.deepEqual(events.map((e) => e.type), ['error', 'done']);
    assert.match(events[0].data, /OPENAI_API_KEY/);
  });

  it('surfaces a non-2xx HTTP response as error + done', async () => {
    const errFetch = (async () =>
      new Response('{"error":"nope"}', { status: 401 })) as unknown as typeof fetch;
    const stream = streamOpenAI({ prompt: 'hi', apiKey: 'k' }, { fetch: errFetch });
    const events = await collect(stream);
    assert.deepEqual(events.map((e) => e.type), ['error', 'done']);
    assert.match(events[0].data, /HTTP 401/);
  });
});
