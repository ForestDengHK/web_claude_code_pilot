/**
 * POC streaming client for an OpenAI (GPT-5.5 / 5.5-pro) backend.
 *
 * Mirrors `streamCodex()` / `streamClaude()` — returns a `ReadableStream<string>`
 * of SSE-formatted lines that emit the SAME `SSEEvent` union the frontend already
 * understands. Internally it talks to the OpenAI **Responses API** over plain
 * `fetch` (no SDK dependency) and translates Responses streaming events into our
 * SSE event format.
 *
 * STATUS: proof-of-concept. Purely additive — nothing here is wired into
 * `ChatSession.backend`, the chat routes, or the UI yet, so it cannot affect
 * existing Claude/Codex/Channels usage (open/closed). The only uncertain piece
 * this POC de-risks is the Responses-stream -> SSEEvent mapping, which is unit
 * tested offline in `src/__tests__/unit/openai-sse-mapping.test.ts`.
 *
 * What this POC covers (planner tier):
 *   - response.output_text.delta            -> { type: 'text' }
 *   - response.reasoning_summary_text.delta -> { type: 'thinking' }   (reuses Codex's reasoning UI)
 *   - response.completed                    -> { type: 'result' } (+ token usage) then { type: 'done' }
 *   - response.failed / error               -> { type: 'error' } then { type: 'done' }
 *
 * Deliberately NOT covered here (execution tier — see capability notes):
 *   - response.output_item.added(function_call) / response.function_call_arguments.delta
 *   - mcp_approval_request  (would map to our existing { type: 'permission_request' })
 *   These are where tool/file execution would hook in later.
 */

import type { SSEEvent } from '@/types'; // type-only: erased at runtime, no alias resolution needed

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface OpenAIStreamOptions {
  prompt: string;
  /** Defaults to 'gpt-5.5'. Use 'gpt-5.5-pro' for the strongest planning tier. */
  model?: string;
  /** System prompt -> Responses API `instructions`. */
  instructions?: string;
  /** Reasoning effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'. Omit to use model default. */
  effort?: string;
  /** Cross-backend context handoff text (from context-bridge.ts), prepended to the user input. */
  contextBridgePrompt?: string;
  /** Responses API multi-turn chaining; pass the previous response id to continue a thread. */
  previousResponseId?: string;
  /** Defaults to process.env.OPENAI_API_KEY. */
  apiKey?: string;
  abortController?: AbortController;
}

/** Injectable dependencies (lets tests supply a fake fetch — no network/key needed). */
export interface OpenAIStreamDeps {
  fetch?: typeof fetch;
  endpoint?: string;
}

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/responses';

// ---------------------------------------------------------------------------
// SSE formatting (mirrors codex-client.ts formatSSE; kept local to stay additive)
// ---------------------------------------------------------------------------

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ---------------------------------------------------------------------------
// Pure mapping: one parsed Responses stream event -> one SSEEvent (or null = skip)
// This is the core "uncertain" logic the POC exists to prove. Keep it pure.
// ---------------------------------------------------------------------------

/** Minimal shape of a parsed Responses API streaming event (only fields we read). */
export interface ResponsesStreamEvent {
  type: string;
  delta?: string;
  message?: string;
  response?: {
    usage?: unknown;
    error?: { message?: string } | null;
  } | null;
  error?: { message?: string } | string | null;
}

export function mapResponsesEvent(evt: ResponsesStreamEvent): SSEEvent | null {
  switch (evt.type) {
    // Assistant visible text, streamed token-by-token.
    case 'response.output_text.delta':
      return evt.delta ? { type: 'text', data: evt.delta } : null;

    // Reasoning summary (GPT-5.5 reasoning models). Reuses the Codex "thinking" channel.
    case 'response.reasoning_summary_text.delta':
      return evt.delta ? { type: 'thinking', data: evt.delta } : null;

    // A refusal still carries user-facing text; surface it rather than dropping silently.
    case 'response.refusal.delta':
      return evt.delta ? { type: 'text', data: evt.delta } : null;

    // Terminal success: emit a result carrying token usage (data must be a string).
    case 'response.completed':
      return {
        type: 'result',
        data: JSON.stringify({ subtype: 'success', usage: evt.response?.usage ?? null }),
      };

    // Terminal failures.
    case 'response.failed':
      return { type: 'error', data: evt.response?.error?.message ?? 'OpenAI response failed' };
    case 'response.error':
    case 'error': {
      const msg = typeof evt.error === 'string' ? evt.error : evt.error?.message ?? evt.message;
      return { type: 'error', data: msg ?? 'OpenAI stream error' };
    }

    // Everything else (created, in_progress, output_item.*, content_part.*, *.done,
    // function_call args, etc.) is not needed for the planner POC.
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Wire parsing: raw Responses SSE bytes -> parsed event objects
// The Responses API emits typed SSE frames; the `data:` JSON already carries `type`,
// so we only need the data lines. `[DONE]` is handled defensively.
// ---------------------------------------------------------------------------

export function parseResponsesFrame(frame: string): ResponsesStreamEvent | null {
  const dataLine = frame
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('data:'));
  if (!dataLine) return null;
  const payload = dataLine.slice('data:'.length).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload) as ResponsesStreamEvent;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stream driver: Responses API -> ReadableStream<string> of SSE lines
// ---------------------------------------------------------------------------

export function streamOpenAI(
  options: OpenAIStreamOptions,
  deps: OpenAIStreamDeps = {},
): ReadableStream<string> {
  const fetchImpl = deps.fetch ?? fetch;
  const endpoint = deps.endpoint ?? DEFAULT_ENDPOINT;
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

  return new ReadableStream<string>({
    async start(controller) {
      const emit = (e: SSEEvent) => controller.enqueue(formatSSE(e));
      const fail = (msg: string) => {
        emit({ type: 'error', data: msg });
        emit({ type: 'done', data: '' });
        controller.close();
      };

      if (!apiKey) {
        fail('OPENAI_API_KEY is not set');
        return;
      }

      const input = [options.contextBridgePrompt, options.prompt].filter(Boolean).join('\n\n');
      const body: Record<string, unknown> = {
        model: options.model ?? DEFAULT_MODEL,
        stream: true,
        input,
      };
      if (options.instructions) body.instructions = options.instructions;
      if (options.effort) body.reasoning = { effort: options.effort, summary: 'auto' };
      if (options.previousResponseId) body.previous_response_id = options.previousResponseId;

      let res: Response;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: options.abortController?.signal,
        });
      } catch (err) {
        fail(`OpenAI request failed: ${(err as Error).message}`);
        return;
      }

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        fail(`OpenAI HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawResult = false;

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line.
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const evt = parseResponsesFrame(frame);
            if (!evt) continue;
            const sse = mapResponsesEvent(evt);
            if (!sse) continue;
            if (sse.type === 'result') sawResult = true;
            emit(sse);
          }
        }
      } catch (err) {
        emit({ type: 'error', data: `OpenAI stream aborted: ${(err as Error).message}` });
      }

      // Guarantee a terminal result (token usage may be absent on abort) + done.
      if (!sawResult) emit({ type: 'result', data: JSON.stringify({ subtype: 'success', usage: null }) });
      emit({ type: 'done', data: '' });
      controller.close();
    },
  });
}
