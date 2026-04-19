/**
 * Verify adaptive thinking on SDK 0.2.112 + Opus 4.7.
 *
 * Context: docs/plans/2026-04-16-opus-4-7-adoption-plan.md → Task 1.
 *
 * Tests two scenarios referenced in that plan:
 *   A: explicit thinking: { type: 'adaptive', display: 'summarized' }
 *      — This is the configuration the "show thinking" toggle (Task 2)
 *        will rely on. Issue #168 was that setting this silently nullified
 *        `maxThinkingTokens` and disabled thinking. We want proof that
 *        thinking_delta events now carry non-empty text.
 *   B: bare effort: 'xhigh', no thinking option
 *      — Opus 4.7 is supposed to always use adaptive thinking internally.
 *        With display defaulting to 'omitted' we expect thinking *blocks*
 *        (with signatures) but empty text — confirming the model still
 *        thinks, just quietly.
 *
 * Run:
 *   npx tsx scripts/verify-adaptive-thinking.ts
 *
 * Cost: two short Opus 4.7 runs with tools disabled. A few cents.
 * This script is disposable — delete after Task 1 is closed out.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

// Something that genuinely needs multi-step reasoning — simple algebraic
// proofs are too trivial for Opus 4.7 and adaptive thinking correctly skips
// them (no thinking expected → false negative).
const PROMPT =
  'A 10x10x10 cube is built from 1000 unit cubes. You paint the outside, then disassemble. ' +
  'How many unit cubes have exactly 2 painted faces? Then generalize to an n x n x n cube ' +
  'and prove your formula is correct. Show your full reasoning.';

const MODEL = 'claude-opus-4-7';

const DEBUG = process.env.VERIFY_DEBUG === '1';

interface Result {
  label: string;
  thinkingBlocksSeen: number;
  thinkingTextChars: number;
  signaturesSeen: number;
  firstThinkingSample: string;
  ttftMs?: number;
  durationMs: number;
  resultSubtype?: string;
  resultEffort?: string;
  error?: string;
  outputSample: string;
  eventTypeCounts: Record<string, number>;
  deltaTypeCounts: Record<string, number>;
  assistantBlockTypeCounts: Record<string, number>;
}

async function runScenario(
  label: string,
  extra: Partial<Options>,
): Promise<Result> {
  const started = Date.now();
  const options: Options = {
    model: MODEL,
    maxTurns: 1,
    includePartialMessages: true,
    cwd: process.cwd(),
    // Don't pull in the user's skills / plugins / MCP servers.
    settingSources: [],
    // Tools off — we just want the model to talk.
    tools: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    ...extra,
  };

  const state = {
    thinkingBlocksSeen: 0,
    thinkingTextChars: 0,
    signaturesSeen: 0,
    firstThinkingSample: '',
    outputSample: '',
    ttftMs: undefined as number | undefined,
    resultSubtype: undefined as string | undefined,
    error: undefined as string | undefined,
    // Stream-event kinds we observed, for debugging whether options were wired through.
    eventTypeCounts: {} as Record<string, number>,
    deltaTypeCounts: {} as Record<string, number>,
    assistantBlockTypeCounts: {} as Record<string, number>,
    // Raw usage from the result (which reports the actual `effort` the SDK ended up with).
    resultEffort: undefined as string | undefined,
  };

  const bump = (bag: Record<string, number>, k: string) => {
    bag[k] = (bag[k] ?? 0) + 1;
  };

  try {
    const q = query({ prompt: PROMPT, options });
    for await (const msg of q) {
      // SDKPartialAssistantMessage carries BetaRawMessageStreamEvent on `.event`.
      // The event types we care about:
      //   - content_block_start with content_block.type === 'thinking'
      //   - content_block_delta with delta.type === 'thinking_delta' (text)
      //   - content_block_delta with delta.type === 'signature_delta' (encrypted sig)
      //   - content_block_delta with delta.type === 'text_delta' (final answer)
      if (msg.type === 'stream_event') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ev: any = msg.event;
        if (ev?.type) bump(state.eventTypeCounts, ev.type);

        if (
          ev?.type === 'content_block_start' &&
          ev?.content_block?.type === 'thinking'
        ) {
          state.thinkingBlocksSeen += 1;
        }
        if (ev?.type === 'content_block_delta') {
          const d = ev.delta;
          if (d?.type) bump(state.deltaTypeCounts, d.type);
          if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
            state.thinkingTextChars += d.thinking.length;
            if (!state.firstThinkingSample) {
              state.firstThinkingSample = d.thinking.slice(0, 200);
            }
          }
          if (d?.type === 'signature_delta') {
            state.signaturesSeen += 1;
          }
          if (d?.type === 'text_delta' && typeof d.text === 'string') {
            if (state.outputSample.length < 200) {
              state.outputSample += d.text;
            }
          }
        }
        if (msg.ttft_ms && state.ttftMs === undefined) {
          state.ttftMs = msg.ttft_ms;
        }

        if (DEBUG) {
          console.error('[stream_event]', JSON.stringify(ev).slice(0, 400));
        }
      }

      // SDKAssistantMessage carries the fully-assembled content array from
      // each Anthropic API response. Thinking blocks with signatures should
      // appear here even when `display: 'omitted'` strips the text.
      if (msg.type === 'assistant') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type) bump(state.assistantBlockTypeCounts, block.type);
            if (block?.type === 'thinking') {
              // Assistant-message thinking block: count it independently from stream_event.
              // Increment blocks only if we didn't already see start events for them.
              if (state.thinkingBlocksSeen === 0) {
                state.thinkingBlocksSeen += 1;
              }
              if (typeof block.thinking === 'string' && block.thinking.length > 0) {
                state.thinkingTextChars = Math.max(
                  state.thinkingTextChars,
                  block.thinking.length,
                );
                if (!state.firstThinkingSample) {
                  state.firstThinkingSample = block.thinking.slice(0, 200);
                }
              }
              if (typeof block.signature === 'string' && block.signature.length > 0) {
                if (state.signaturesSeen === 0) state.signaturesSeen = 1;
              }
            }
          }
        }
      }

      if (msg.type === 'result') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r: any = msg;
        state.resultSubtype = r.subtype;
        state.resultEffort = r.usage?.effort;
      }
    }
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  }

  return {
    label,
    durationMs: Date.now() - started,
    ...state,
    outputSample: state.outputSample.slice(0, 200),
  };
}

function verdict(r: Result): { ok: boolean; note: string } {
  if (r.error) return { ok: false, note: `errored: ${r.error}` };
  if (r.resultSubtype && r.resultSubtype !== 'success') {
    return { ok: false, note: `result subtype: ${r.resultSubtype}` };
  }
  // We consider thinking "happening" if either thinking blocks or
  // thinking text were observed. Signatures alone also prove the model
  // produced encrypted thinking content.
  if (r.thinkingBlocksSeen > 0 || r.thinkingTextChars > 0 || r.signaturesSeen > 0) {
    return { ok: true, note: 'thinking observed' };
  }
  return { ok: false, note: 'NO thinking blocks / deltas / signatures observed' };
}

async function main() {
  console.log('[verify-adaptive-thinking] Opus 4.7 adaptive-thinking sanity check');
  console.log(`[verify-adaptive-thinking] model=${MODEL}`);
  console.log(`[verify-adaptive-thinking] prompt="${PROMPT}"\n`);

  const scenarios: { label: string; extra: Partial<Options> }[] = [
    {
      label: "A: thinking:{type:'adaptive', display:'summarized'}",
      extra: {
        thinking: { type: 'adaptive', display: 'summarized' },
      },
    },
    {
      label: "B: bare effort:'xhigh', no thinking option",
      extra: {
        effort: 'xhigh',
      },
    },
  ];

  const results: Result[] = [];
  for (const s of scenarios) {
    console.log(`--- running: ${s.label} ---`);
    const r = await runScenario(s.label, s.extra);
    results.push(r);
    const v = verdict(r);
    console.log(`[${v.ok ? 'PASS' : 'FAIL'}] ${v.note}`);
    console.log(JSON.stringify(r, null, 2));
    console.log();
  }

  console.log('===== summary =====');
  let anyFail = false;
  for (const r of results) {
    const v = verdict(r);
    if (!v.ok) anyFail = true;
    console.log(
      `${v.ok ? 'PASS' : 'FAIL'}  ${r.label}  blocks=${r.thinkingBlocksSeen} textChars=${r.thinkingTextChars} sigs=${r.signaturesSeen}  (${v.note})`,
    );
  }
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
