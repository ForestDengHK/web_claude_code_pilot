import { randomUUID } from 'node:crypto';
import { getSession as getDbSession, updateChannelSessionId } from './db';
import { ensureSession, killSession } from './channels/session-manager';
import { tailTranscript, transcriptPath } from './channels/transcript-tailer';
import { subscribeChannelEvents } from './channels/event-bus';
import type { SSEEvent } from '@/types';

function sse(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Pure, testable stream assembler. `onStart` gets emit + finish + fail callbacks. */
export function assembleStream(opts: {
  onStart: (emit: (e: SSEEvent) => void,
            finish: (finalText: string, usage?: unknown) => void,
            fail: (msg: string) => void) => void;
}): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      let closed = false;
      const emit = (e: SSEEvent) => { if (!closed) controller.enqueue(sse(e)); };
      const close = () => { if (!closed) { closed = true; controller.close(); } };
      const finish = (finalText: string, usage?: unknown) => {
        // The model delivers its answer through the `reply` tool; that text
        // arrives here as finalText. Emit it as a `text` event so it flows
        // through the standard text-accumulation path (DB persistence + UI
        // render). `usage`, when present, carries the turn's token totals.
        if (finalText) emit({ type: 'text', data: finalText });
        if (usage) emit({ type: 'result', data: JSON.stringify({ usage }) });
        emit({ type: 'done', data: '' });
        close();
      };
      const fail = (msg: string) => { emit({ type: 'error', data: msg }); close(); };
      opts.onStart(emit, finish, fail);
    },
  });
}

/**
 * Build a structured `toolInput` object from the channel permission relay's
 * `input_preview`. The relay only carries `input_preview` — a JSON string
 * truncated to ~200 chars — so parse it when valid and otherwise wrap the raw
 * text in `{ input }`. The frontend's permission dialog expects an object;
 * omitting it entirely used to crash `StreamingMessage`.
 */
export function permissionToolInput(inputPreview: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(inputPreview);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { input: parsed };
  } catch {
    return { input: inputPreview };
  }
}

export interface ChannelsStreamOptions {
  prompt: string;
  sessionId: string;            // CodePilot session id
  workingDirectory: string;
  model?: string;
  internalUrl: string;          // CodePilot's own base URL, e.g. http://127.0.0.1:4000
  mode?: string;                // permission mode for the channel session
  systemPrompt?: string;        // extra system prompt for the channel session
  /**
   * AbortSignal that, when triggered, immediately fails the turn AND kills the
   * underlying PTY process. Required for the user's Stop button: without this,
   * killing the PTY externally still leaves the stream hanging until
   * STALL_TIMEOUT_MS (~150s) of transcript silence elapses.
   */
  abortSignal?: AbortSignal;
}

const TURN_TIMEOUT_MS = 10 * 60_000;

// After a terminal `turn_complete` is tailed, wait this long for the transcript
// to settle before closing the stream. The turn's final message is often
// tailed as separate `thinking` then `text` entries; this debounce window lets
// any trailing entries arrive (the poll interval is 120ms) so the answer text
// is not cut off. Each new `turn_complete` resets the timer.
const TURN_SETTLE_MS = 700;

// If the channel transcript produces no new activity for this long, the
// underlying `claude --channels` process is considered stalled (the research-
// preview interactive process can wedge mid-turn). The turn is failed and the
// process killed so the *next* message respawns a fresh one via --resume —
// otherwise a single stall bricks the whole session, with every later message
// queued behind the dead turn. Suspended while a permission prompt is pending
// (the model is then legitimately idle, waiting on the user's verdict).
const STALL_TIMEOUT_MS = 150_000;

export function streamChannels(opts: ChannelsStreamOptions): ReadableStream<string> {
  return assembleStream({
    onStart: (emit, finish, fail) => {
      void (async () => {
        try {
          const db = getDbSession(opts.sessionId);
          const resuming = !!db?.channel_session_id;
          const claudeSessionId = db?.channel_session_id ?? randomUUID();
          if (!resuming) updateChannelSessionId(opts.sessionId, claudeSessionId);

          const session = await ensureSession({
            codepilotSessionId: opts.sessionId,
            claudeSessionId,
            cwd: opts.workingDirectory,
            model: opts.model,
            resume: resuming,
            internalUrl: opts.internalUrl,
            mode: opts.mode,
            systemPrompt: opts.systemPrompt,
          });
          emit({ type: 'status', data: JSON.stringify({ session_id: claudeSessionId }) });

          // The `reply` tool is CodePilot's answer-delivery channel, not a
          // real tool action — drop its tool_use (and matching tool_result)
          // so it doesn't render as a tool block. The answer text itself is
          // surfaced via finish() instead.
          const replyToolUseIds = new Set<string>();
          // Accumulate per-message token usage from the transcript tail into a
          // single turn total, emitted once via finish() so the UI shows the
          // same `model · N tokens` badge it shows for the SDK backend.
          const turnUsage = {
            input_tokens: 0, output_tokens: 0,
            cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
            model: undefined as string | undefined,
          };
          let sawUsage = false;
          // Track whether the transcript already streamed natural text for
          // this turn. The MCP `reply` tool's text argument is the model's
          // full final answer — when the model writes natural text AND calls
          // reply (the normal case, encouraged by the MCP server instructions),
          // emitting ev.text in the reply handler appends the same answer a
          // second time. Only fall back to ev.text when no transcript text
          // arrived (model used only the reply tool).
          let sawTextFromTranscript = false;
          const tail = tailTranscript(
            transcriptPath(opts.workingDirectory, claudeSessionId),
            (events) => {
              bumpStall(); // transcript grew → the process is alive
              for (const e of events) {
                if (e.type === 'text') {
                  sawTextFromTranscript = true;
                } else if (e.type === 'tool_use') {
                  try {
                    const d = JSON.parse(e.data);
                    if (d.name === 'mcp__codepilot__reply') {
                      replyToolUseIds.add(d.id);
                      continue;
                    }
                  } catch { /* fall through and emit as-is */ }
                } else if (e.type === 'tool_result') {
                  try {
                    const d = JSON.parse(e.data);
                    if (replyToolUseIds.has(d.tool_use_id)) continue;
                  } catch { /* fall through and emit as-is */ }
                } else if (e.type === 'result') {
                  try {
                    const u = JSON.parse(e.data).usage;
                    if (u) {
                      sawUsage = true;
                      // output sums across the turn; input/cache reflect the
                      // latest message (the running context size).
                      turnUsage.output_tokens += u.output_tokens ?? 0;
                      turnUsage.input_tokens = u.input_tokens ?? turnUsage.input_tokens;
                      turnUsage.cache_read_input_tokens =
                        u.cache_read_input_tokens ?? turnUsage.cache_read_input_tokens;
                      turnUsage.cache_creation_input_tokens =
                        u.cache_creation_input_tokens ?? turnUsage.cache_creation_input_tokens;
                      if (u.model) turnUsage.model = u.model;
                    }
                  } catch { /* ignore malformed usage */ }
                  continue; // accumulated, not forwarded per-message
                } else if (e.type === 'turn_complete') {
                  // The assistant turn ended (terminal stop_reason in the
                  // transcript). Schedule the stream close; do not forward
                  // this internal event to the client.
                  scheduleFinish();
                  continue;
                }
                emit(e);
              }
            },
          );

          let done = false;
          let finishTimer: ReturnType<typeof setTimeout> | undefined;
          let stallTimer: ReturnType<typeof setTimeout> | undefined;
          let permissionPending = false;

          // cleanup references timeout and unsub — both are declared below.
          // cleanup is only ever *called* from callbacks that fire after all
          // declarations have run, so the const TDZ is not a problem at runtime.
          // eslint-disable-next-line prefer-const
          let timeout: ReturnType<typeof setTimeout>;
          // eslint-disable-next-line prefer-const
          let unsub: () => void;

          const cleanup = () => {
            tail.stop(); unsub();
            clearTimeout(timeout); clearTimeout(finishTimer); clearTimeout(stallTimer);
          };

          // Fail the turn AND kill the channel process. Used for stalls /
          // timeouts / transport errors: the process is in an unknown state,
          // so killing it lets the next message respawn a clean one (--resume
          // continues the transcript) instead of queueing behind a dead turn.
          const failAndKill = (msg: string) => {
            if (done) return;
            done = true;
            cleanup();
            try { killSession(opts.sessionId); } catch { /* best effort */ }
            fail(msg);
          };

          // (Re)arm the stall watchdog. Called on every transcript poll that
          // sees activity; if the gap between two calls exceeds STALL_TIMEOUT_MS
          // the process is wedged. Disabled once a permission prompt is pending.
          const bumpStall = () => {
            if (done || permissionPending) return;
            clearTimeout(stallTimer);
            stallTimer = setTimeout(
              () => failAndKill('channel turn stalled — no activity'),
              STALL_TIMEOUT_MS,
            );
          };

          // Close the stream once the transcript reports the turn is over.
          // Debounced (TURN_SETTLE_MS) so trailing thinking/text entries are
          // tailed before we stop; a later turn_complete resets the timer.
          // This is the primary turn terminator — the `reply` channel event
          // below is a secondary signal the model only sometimes emits.
          const scheduleFinish = () => {
            if (done) return;
            clearTimeout(finishTimer);
            finishTimer = setTimeout(() => {
              if (done) return;
              done = true;
              cleanup();
              // The answer text already streamed via the transcript tail, so
              // pass '' — finish() would otherwise emit it a second time.
              finish('', sawUsage ? turnUsage : undefined);
            }, TURN_SETTLE_MS);
          };

          timeout = setTimeout(
            () => failAndKill('channel turn timed out'),
            TURN_TIMEOUT_MS,
          );

          unsub = subscribeChannelEvents(opts.sessionId, (ev) => {
            if (ev.kind === 'permission_request') {
              // The model is now legitimately idle, waiting on the user's
              // verdict — suspend the stall watchdog so the wait isn't
              // mistaken for a wedged process. The TURN_TIMEOUT_MS cap remains.
              permissionPending = true;
              clearTimeout(stallTimer);
              emit({ type: 'permission_request', data: JSON.stringify({
                permissionRequestId: ev.request.request_id,
                toolName: ev.request.tool_name,
                toolUseId: '',
                toolInput: permissionToolInput(ev.request.input_preview),
                description: ev.request.description,
              }) });
            } else if (ev.kind === 'reply') {
              if (done) return; done = true;
              setTimeout(() => {
                cleanup();
                // If the transcript already streamed the model's natural text
                // for this turn, ev.text repeats the same content (the MCP
                // server tells the model to put its full final answer in the
                // reply tool's `text` arg, but the model also writes it as
                // natural text first). Skip the re-emit in that case to avoid
                // duplicating the answer in the saved message. When no
                // transcript text arrived (model used only the reply tool),
                // fall back to ev.text so the answer isn't lost.
                finish(
                  sawTextFromTranscript ? '' : ev.text,
                  sawUsage ? turnUsage : undefined,
                );
              }, 400);
            }
          });

          // Arm the stall watchdog now that the turn is underway. Covers the
          // case where the process produces no transcript output at all.
          bumpStall();

          // User Stop / Force Stop: abort immediately. T1 has no graceful
          // turn-cancel primitive in the channel protocol, so we fail the
          // turn AND kill the PTY. The session resumes on the next user
          // message via --resume against the transcript on disk.
          if (opts.abortSignal) {
            if (opts.abortSignal.aborted) {
              failAndKill('stopped by user');
            } else {
              opts.abortSignal.addEventListener('abort', () => {
                failAndKill('stopped by user');
              }, { once: true });
            }
          }

          const res = await fetch(`http://127.0.0.1:${session.channelPort}/push`, {
            method: 'POST', body: opts.prompt,
          });
          if (!res.ok) failAndKill('failed to push message');
        } catch (err) {
          try { killSession(opts.sessionId); } catch { /* best effort */ }
          fail(err instanceof Error ? err.message : String(err));
        }
      })();
    },
  });
}
