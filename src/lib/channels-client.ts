import { randomUUID } from 'node:crypto';
import { getSession as getDbSession, updateChannelSessionId } from './db';
import { ensureSession, killSession } from './channels/session-manager';
import { tailTranscript, transcriptPath } from './channels/transcript-tailer';
import { subscribeChannelEvents } from './channels/event-bus';
import { resolveFinalReplyText } from './channels/reply-dedup';
import { loadEnabledPluginPaths, loadMergedMcpServers } from './claude-config-loader';
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
  effort?: string;              // reasoning effort level (low/medium/high/xhigh/max)
  fastMode?: boolean;           // fast mode — adds --settings '{"fastMode":true}'
  skipPermissions?: boolean;    // shield toggle — adds --dangerously-skip-permissions
  /**
   * AbortSignal that, when triggered, immediately fails the turn AND kills the
   * underlying PTY process. Required for the user's Stop button: without this,
   * killing the PTY externally still leaves the stream hanging until
   * STALL_TIMEOUT_MS of transcript silence elapses.
   */
  abortSignal?: AbortSignal;
}

// Absolute per-turn cap. Agentic T1 turns can legitimately run long (many
// tool calls, some taking a minute each), so this is generous — it only exists
// to reap a turn that is genuinely wedged, not to bound normal work.
const TURN_TIMEOUT_MS = 30 * 60_000;

// Heartbeat cadence. The client aborts the stream if it sees no SSE data for
// ~30s (mobile sockets die silently). During a long tool call or a long
// thinking gap T1 emits nothing for the whole duration, so without a heartbeat
// the client wrongly concludes the connection dropped. Mirror T2, which sends
// a heartbeat on this cadence.
const HEARTBEAT_INTERVAL_MS = 10_000;

// Turn-end detection for T1 is PTY-driven (see the heartbeat below). The
// interactive `claude --channels` process emits PTY output continuously while
// it works — streaming text, thinking spinners, tool status — and goes silent
// once the turn ends and it waits for the next input. Empirically the gap is
// stark: during a turn the PTY is never quiet for more than ~0.6s, while an
// idle turn produces no PTY output for tens of seconds. So a quiet PTY is a
// reliable end-of-turn signal — unlike the transcript's stop_reason, which is
// always 'end_turn' in T1 even mid-tool-use.
//
// This is the SOLE turn-end trigger. We deliberately do NOT close early when
// the model calls the `reply` tool: the model sometimes calls `reply` mid-turn
// and then keeps working (more thinking / a second reply / a final text block),
// so a reply-triggered early close truncated the real answer. Waiting for the
// PTY to actually go quiet costs a few seconds of extra spinner after each
// turn but never cuts a turn short. PTY_IDLE_FINISH_MS is ~10x the observed
// max in-turn idle, so normal activity never trips it; post-turn settling
// redraws finish within a few seconds, then the PTY is silent.
const PTY_IDLE_FINISH_MS = 6_000;

// If the channel transcript produces no new activity for this long, the
// underlying `claude --channels` process is considered stalled (the research-
// preview interactive process can wedge mid-turn). The turn is failed and the
// process killed so the *next* message respawns a fresh one via --resume —
// otherwise a single stall bricks the whole session, with every later message
// queued behind the dead turn. Suspended while a permission prompt is pending
// (the model is then legitimately idle, waiting on the user's verdict), and
// while any tool is actively executing — the transcript won't grow between a
// tool_use and its tool_result, and that gap can be arbitrarily long for shell
// commands, builds, network calls, or extended-thinking API responses.
const STALL_TIMEOUT_MS = 300_000;

export function streamChannels(opts: ChannelsStreamOptions): ReadableStream<string> {
  return assembleStream({
    onStart: (emit, finish, fail) => {
      void (async () => {
        try {
          const db = getDbSession(opts.sessionId);
          // Prefer channel_session_id; fall back to sdk_session_id when T1 is
          // entered for the first time after T2 has already been logging turns
          // (channel_session_id is empty in that case). Both backends write
          // their transcripts to the same `~/.claude/projects/{cwd}/{id}.jsonl`
          // scheme, so reusing the SDK's id lets `--resume` pick up the full
          // conversation. The seed normally happens at switch-time via
          // seedChannelResumeFromSdk, but this safety net covers paths that
          // don't go through switchToTier (e.g. backend changed externally).
          const existingId = db?.channel_session_id || db?.sdk_session_id || null;
          const resuming = !!existingId;
          const claudeSessionId = existingId ?? randomUUID();
          if (!db?.channel_session_id) updateChannelSessionId(opts.sessionId, claudeSessionId);

          // Load plugins + user/project MCP servers via the shared loader
          // so T1 sees the same set as T2. Done per turn (not cached) so the
          // configChanged check picks up changes the user makes between turns,
          // e.g. installing a new plugin or editing .mcp.json.
          const pluginPaths = loadEnabledPluginPaths();
          const extraMcpServers = loadMergedMcpServers(opts.workingDirectory);

          const session = await ensureSession({
            codepilotSessionId: opts.sessionId,
            claudeSessionId,
            cwd: opts.workingDirectory,
            model: opts.model,
            resume: resuming,
            internalUrl: opts.internalUrl,
            mode: opts.mode,
            systemPrompt: opts.systemPrompt,
            effort: opts.effort,
            fastMode: opts.fastMode,
            skipPermissions: opts.skipPermissions,
            extraMcpServers,
            pluginPaths,
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
          // Accumulate the natural (pre-reply) text streamed to the UI this
          // turn. The MCP `reply` tool's text argument is the model's full final
          // answer; whether that answer was ALSO already streamed as natural
          // text varies turn to turn — sometimes the model types the answer then
          // restates it into reply, sometimes the natural text is only
          // working-notes ("Let me load the reply tool…") and the answer lives
          // ONLY in reply. resolveFinalReplyText() compares this accumulator
          // against the reply text at finish to decide whether reply still needs
          // delivering (avoids both the duplicate AND the dropped-answer bug).
          let streamedText = '';
          // Set once the model has called `reply` (its "answer sent" action).
          // Any natural text the model writes AFTER that is a restatement /
          // closing remark — e.g. it types "I'll note this", writes a file,
          // then types "I've noted it" and also calls reply. Surfacing every
          // such block produced a duplicated-looking answer. Once reply has
          // fired we suppress further natural text blocks; tool work continues
          // to stream so genuine post-reply actions aren't lost.
          let sawReply = false;
          const tail = tailTranscript(
            transcriptPath(opts.workingDirectory, claudeSessionId),
            (events) => {
              // Transcript grew → the process is producing output again. If a
              // permission prompt was pending, the user's verdict has been
              // applied and the model has resumed (the prompt itself writes no
              // transcript entry), so clear the suspend flag before re-arming
              // the watchdogs below.
              if (permissionPending) permissionPending = false;
              bumpStall(); // transcript grew → the process is alive
              for (const e of events) {
                if (e.type === 'text') {
                  // Drop restatement text the model writes after it already
                  // called reply — surfacing it duplicates the answer.
                  if (sawReply) continue;
                  streamedText += e.data;
                } else if (e.type === 'tool_use') {
                  try {
                    const d = JSON.parse(e.data);
                    if (d.name === 'mcp__codepilot__reply') {
                      replyToolUseIds.add(d.id);
                      sawReply = true;
                      continue;
                    }
                    // A tool is starting: the turn is definitely not over, so
                    // cancel any pending PTY-idle finish and suspend both
                    // watchdogs until the tool_result arrives (which can take
                    // minutes for a shell command, build, or network call).
                    activeToolCount++;
                    clearTimeout(stallTimer);
                    clearTimeout(finishTimer);
                  } catch { /* fall through and emit as-is */ }
                } else if (e.type === 'tool_result') {
                  try {
                    const d = JSON.parse(e.data);
                    if (replyToolUseIds.has(d.tool_use_id)) continue;
                    // Tool completed; re-arm watchdogs once all pending tools
                    // finish so a quiet PTY can again signal turn-end.
                    if (activeToolCount > 0) {
                      activeToolCount--;
                      if (activeToolCount === 0) { bumpStall(); armFinish(); }
                    }
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
                }
                emit(e);
              }
            },
          );

          let done = false;
          let finishTimer: ReturnType<typeof setTimeout> | undefined;
          let stallTimer: ReturnType<typeof setTimeout> | undefined;
          let permissionPending = false;
          // Count of non-reply tool_use blocks whose tool_result has not yet
          // arrived. The stall + finish watchdogs are suspended while this is > 0.
          let activeToolCount = 0;
          // The text the model passed to the `reply` tool. Used only as a
          // fallback answer when the model used ONLY reply and streamed no
          // natural text — reply does NOT drive turn-end timing (see
          // PTY_IDLE_FINISH_MS above for why).
          let replyText = '';

          // cleanup references timeout, unsub, ptyHeartbeat, heartbeatPing,
          // exitSub — all declared below. cleanup is only ever *called* from
          // callbacks that fire after all declarations have run, so the const
          // TDZ is not a problem at runtime.
          // eslint-disable-next-line prefer-const
          let timeout: ReturnType<typeof setTimeout>;
          // eslint-disable-next-line prefer-const
          let unsub: () => void;
          let ptyHeartbeat: { dispose(): void } | undefined;
          let exitSub: { dispose(): void } | undefined;
          let heartbeatPing: ReturnType<typeof setInterval> | undefined;

          const cleanup = () => {
            tail.stop(); unsub(); ptyHeartbeat?.dispose(); exitSub?.dispose();
            clearTimeout(timeout); clearTimeout(finishTimer); clearTimeout(stallTimer);
            clearInterval(heartbeatPing);
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
          // the process is wedged. Disabled once a permission prompt is pending
          // or while any tool is actively executing.
          const bumpStall = () => {
            if (done || permissionPending || activeToolCount > 0) return;
            clearTimeout(stallTimer);
            stallTimer = setTimeout(
              () => failAndKill('channel turn stalled — no activity'),
              STALL_TIMEOUT_MS,
            );
          };

          // Close the stream. The model's full final answer is the `reply`
          // text (captured in replyText). resolveFinalReplyText decides whether
          // it still needs emitting: if the same answer already streamed as
          // natural text it returns '' (avoid a duplicate); if the streamed text
          // was only working-notes / narration it returns replyText so the
          // answer isn't dropped (the recurring truncation bug). See
          // reply-dedup.ts for the full rationale.
          const finishTurn = () => {
            if (done) return;
            done = true;
            cleanup();
            finish(
              resolveFinalReplyText(streamedText, replyText),
              sawUsage ? turnUsage : undefined,
            );
          };

          // Primary (and sole) turn-end detector: the PTY has gone quiet. Re-armed
          // on every PTY data chunk (the model is still working) and after a tool
          // result; suspended while a tool is executing or a permission prompt is
          // pending (the process is legitimately idle then). When the timer
          // actually fires, the PTY has produced nothing for PTY_IDLE_FINISH_MS —
          // the turn is over.
          const armFinish = () => {
            if (done || permissionPending || activeToolCount > 0) return;
            clearTimeout(finishTimer);
            finishTimer = setTimeout(finishTurn, PTY_IDLE_FINISH_MS);
          };

          // PTY output ⇒ the process is alive and the turn is still in progress.
          // Re-arm both the stall watchdog (kill, long backstop) and the finish
          // timer (close, short). Throttled to once per second: chunks arrive
          // far faster than that during a turn, and the timers are seconds long,
          // so a 1s reset cadence is plenty to keep them from firing mid-turn.
          let lastHeartbeat = 0;
          ptyHeartbeat = session.proc.onData(() => {
            const now = Date.now();
            if (now - lastHeartbeat < 1000) return;
            lastHeartbeat = now;
            bumpStall();
            armFinish();
          });

          // If the PTY process exits unexpectedly mid-turn (crash, OOM, external
          // kill), nothing else would close this stream: the stall + PTY-idle
          // watchdogs are suspended whenever a tool is in flight (activeToolCount
          // > 0), so a crash during a tool would hang until TURN_TIMEOUT_MS and
          // leave the DB draft stuck in 'streaming' (→ recovery deadlock). React
          // to the exit directly: flush any trailing transcript line, then close
          // the stream so collectStreamResponse finalizes the draft.
          exitSub = session.proc.onExit(() => {
            if (done) return;
            setTimeout(() => finishTurn(), 500);
          });

          // Keep the client's connection-health watchdog satisfied during long
          // tool calls / thinking gaps, when T1 otherwise emits no SSE data for
          // the tool's full duration. Without this the client wrongly aborts the
          // stream after ~30s of silence and surfaces a spurious timeout.
          heartbeatPing = setInterval(() => {
            if (!done) emit({ type: 'heartbeat', data: '' });
          }, HEARTBEAT_INTERVAL_MS);

          timeout = setTimeout(
            () => failAndKill('channel turn timed out'),
            TURN_TIMEOUT_MS,
          );

          unsub = subscribeChannelEvents(opts.sessionId, (ev) => {
            if (ev.kind === 'permission_request') {
              // The model is now legitimately idle, waiting on the user's
              // verdict — suspend BOTH watchdogs so the wait isn't mistaken for
              // a wedged process (stall) or a finished turn (the PTY goes quiet
              // while waiting for the verdict, which would otherwise trip the
              // PTY-idle finish). The TURN_TIMEOUT_MS cap remains.
              permissionPending = true;
              clearTimeout(stallTimer);
              clearTimeout(finishTimer);
              emit({ type: 'permission_request', data: JSON.stringify({
                permissionRequestId: ev.request.request_id,
                toolName: ev.request.tool_name,
                toolUseId: '',
                toolInput: permissionToolInput(ev.request.input_preview),
                description: ev.request.description,
              }) });
            } else if (ev.kind === 'reply') {
              // Record the reply text as a fallback answer (used only if the
              // model streamed no natural transcript text). Deliberately does
              // NOT close the stream: the model sometimes calls reply mid-turn
              // and keeps working (more thinking, a second reply, a final text
              // block), so closing on reply truncated the real answer. The
              // PTY-quiet timer is the only thing that ends the turn. Still arm
              // it here in case reply arrives after the PTY already went quiet.
              // Mark sawReply so post-reply restatement text is suppressed (the
              // transcript tailer also sets this; whichever observes the reply
              // first wins — this event can beat the tailed tool_use entry).
              replyText = ev.text;
              sawReply = true;
              armFinish();
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
