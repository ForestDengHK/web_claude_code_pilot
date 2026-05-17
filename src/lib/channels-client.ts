import { randomUUID } from 'node:crypto';
import { getSession as getDbSession, updateChannelSessionId } from './db';
import { ensureSession } from './channels/session-manager';
import { tailTranscript, transcriptPath } from './channels/transcript-tailer';
import { subscribeChannelEvents } from './channels/event-bus';
import type { SSEEvent } from '@/types';

function sse(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Pure, testable stream assembler. `onStart` gets emit + finish + fail callbacks. */
export function assembleStream(opts: {
  onStart: (emit: (e: SSEEvent) => void, finish: (finalText: string) => void,
            fail: (msg: string) => void) => void;
}): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      let closed = false;
      const emit = (e: SSEEvent) => { if (!closed) controller.enqueue(sse(e)); };
      const close = () => { if (!closed) { closed = true; controller.close(); } };
      const finish = (finalText: string) => {
        // The model delivers its answer through the `reply` tool; that text
        // arrives here as finalText. Emit it as a `text` event so it flows
        // through the standard text-accumulation path (DB persistence + UI
        // render) — the `result` event below carries no consumer for it.
        if (finalText) emit({ type: 'text', data: finalText });
        emit({ type: 'result', data: JSON.stringify({ result: finalText }) });
        emit({ type: 'done', data: '' });
        close();
      };
      const fail = (msg: string) => { emit({ type: 'error', data: msg }); close(); };
      opts.onStart(emit, finish, fail);
    },
  });
}

export interface ChannelsStreamOptions {
  prompt: string;
  sessionId: string;            // CodePilot session id
  workingDirectory: string;
  model?: string;
  internalUrl: string;          // CodePilot's own base URL, e.g. http://127.0.0.1:4000
}

const TURN_TIMEOUT_MS = 10 * 60_000;

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
          });
          emit({ type: 'status', data: JSON.stringify({ session_id: claudeSessionId }) });

          // The `reply` tool is CodePilot's answer-delivery channel, not a
          // real tool action — drop its tool_use (and matching tool_result)
          // so it doesn't render as a tool block. The answer text itself is
          // surfaced via finish() instead.
          const replyToolUseIds = new Set<string>();
          const tail = tailTranscript(
            transcriptPath(opts.workingDirectory, claudeSessionId),
            (events) => {
              for (const e of events) {
                if (e.type === 'tool_use') {
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
                }
                emit(e);
              }
            },
          );

          let done = false;

          // cleanup references timeout and unsub — both are declared below.
          // cleanup is only ever *called* from callbacks that fire after all
          // declarations have run, so the const TDZ is not a problem at runtime.
          // eslint-disable-next-line prefer-const
          let timeout: ReturnType<typeof setTimeout>;
          // eslint-disable-next-line prefer-const
          let unsub: () => void;

          const cleanup = () => { tail.stop(); unsub(); clearTimeout(timeout); };

          timeout = setTimeout(() => {
            if (done) return; done = true; cleanup(); fail('channel turn timed out');
          }, TURN_TIMEOUT_MS);

          unsub = subscribeChannelEvents(opts.sessionId, (ev) => {
            if (ev.kind === 'permission_request') {
              emit({ type: 'permission_request', data: JSON.stringify({
                permissionRequestId: ev.request.request_id,
                toolName: ev.request.tool_name,
                description: ev.request.description,
                input_preview: ev.request.input_preview,
              }) });
            } else if (ev.kind === 'reply') {
              if (done) return; done = true;
              setTimeout(() => { cleanup(); finish(ev.text); }, 400);
            }
          });

          const res = await fetch(`http://127.0.0.1:${session.channelPort}/push`, {
            method: 'POST', body: opts.prompt,
          });
          if (!res.ok && !done) { done = true; cleanup(); fail('failed to push message'); }
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      })();
    },
  });
}
