import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { getSession as getDbSession, updateChannelSessionId } from './db';
import { findClaudeBinary } from './platform';
import { ensureSession, killSession } from './channels/session-manager';
import type { ApiProvider } from '@/types';
import { tailTranscript, transcriptPath } from './channels/transcript-tailer';
import { subscribeChannelEvents } from './channels/event-bus';
import { resolveFinalReplyText } from './channels/reply-dedup';
import { loadEnabledPluginPaths, loadMergedMcpServers } from './claude-config-loader';
// The dashboard "model writes a JSON entry file → server scans + publishes after
// the turn" helpers are backend-neutral (Codex and T1 both lack the in-process
// SDK MCP tool). They live in codex-artifacts.ts; alias to neutral names here.
import {
  publishCodexDashboardFromFile as publishDashboardEntryFromFile,
  readArtifactMtimeMs,
  resolveArtifactPath,
  type CodexDashboardRequest as DashboardEntryRequest,
} from './codex-artifacts';
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
  /** Active provider to inject into the PTY env; null/undefined = default Claude auth. */
  provider?: ApiProvider | null;
  /**
   * Codex-style dashboard update for T1: the model writes this JSON entry file
   * during the turn, and on a clean turn-end the server reads it and appends it
   * to the project dashboard (T1 has no in-process SDK MCP tool).
   */
  dashboardRequest?: DashboardEntryRequest;
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

// Pre-dequeue wedge watchdog (fix B'). After we push a message, a HEALTHY
// `claude --channels` dequeues it within ~15ms to start the turn. When the CLI
// has wedged mid-turn (upstream research-preview instability), it never
// dequeues — the message just sits in its queue and the user gets total silence
// (the t1-session-wedged-no-reply incident). So if no dequeue AND no transcript
// progress happens within this window, the CLI is wedged → reap it (next message
// respawns via --resume). Deferred by real progress so a message legitimately
// QUEUED behind a long-running prior turn isn't reaped. Unlike STALL_TIMEOUT_MS
// this is safe to keep short: nothing legitimately delays a dequeue, and the
// model can't be "thinking" yet — the turn hasn't started.
const DEQUEUE_WEDGE_MS = 90_000;

/**
 * Tracks which non-reply tools are mid-flight during a turn, so the stall +
 * PTY-idle finish watchdogs can be suspended while a tool runs (the PTY is
 * legitimately idle then). Matched by tool_use id — NOT a bare counter —
 * because the CLI sometimes writes a tool_result transcript line BEFORE its
 * matching tool_use line (same-instant pair; file/line order isn't guaranteed).
 * A bare counter swallows the early decrement at zero and then never cancels
 * the late increment, pinning `inFlight` true forever and wedging the turn
 * until TURN_TIMEOUT (the session-stuck-streaming incident). Id sets are
 * order-independent: a tool is done once BOTH its use and result are seen, in
 * either order.
 */
export class ToolFlightTracker {
  private readonly started = new Set<string>();
  private readonly finished = new Set<string>();
  startTool(id: string): void { this.started.add(id); }
  finishTool(id: string): void { this.finished.add(id); }
  /** True while some started tool has not yet seen its matching result. */
  get inFlight(): boolean {
    for (const id of this.started) if (!this.finished.has(id)) return true;
    return false;
  }
}

/**
 * On a watchdog-forced turn teardown (timeout / stall), the turn-end detector
 * failed — but the model may already have produced a real answer this turn (it
 * called `reply` → `sawReply`, or streamed natural-language text). When this is
 * true the turn should be FINISHED with that answer (preserving it) rather than
 * failed with the watchdog's error message, so the user never loses an answer
 * the model actually delivered (the session-stuck-then-timed-out incident: the
 * reply was 'sent' to the channel but the timeout discarded it as an error).
 */
export function turnHasDeliverableAnswer(args: {
  sawReply: boolean;
  streamedText: string;
}): boolean {
  return args.sawReply || args.streamedText.trim().length > 0;
}

/**
 * Run a single channels turn. On an expired/invalid auth token it emits a
 * terminal `auth_error` event (instead of a generic `error`) and kills the PTY,
 * so the `streamChannels` wrapper can respawn + retry. All other terminal
 * conditions go through `finish`/`fail` as before.
 */
function runChannelsTurn(opts: ChannelsStreamOptions): ReadableStream<string> {
  return assembleStream({
    onStart: (emit, finish, fail) => {
      void (async () => {
        try {
          const db = getDbSession(opts.sessionId);
          // Snapshot the dashboard entry file's mtime BEFORE the turn so the
          // post-turn scan can tell whether the model actually (re)wrote it.
          const dashboardBeforeMtimeMs = opts.dashboardRequest
            ? readArtifactMtimeMs(resolveArtifactPath(opts.workingDirectory, opts.dashboardRequest.filePath))
            : null;
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
            provider: opts.provider ?? null,
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

          // Containment wrapper (fix A). Every PTY / timer / event callback runs
          // OUTSIDE the surrounding try below (it has already returned by the time
          // they fire), so a throw inside one escapes as a process-wide
          // `uncaughtException`. Node then limps on in an undefined state and the
          // watchdog timers stop firing — exactly the `replySeen` incident that
          // bricked a session for good. `safe` logs and swallows so a bug fails
          // only THIS turn (its own watchdogs still reap it); the whole server
          // stays healthy and other sessions are untouched.
          const safe = <A extends unknown[]>(label: string, fn: (...a: A) => void) =>
            (...a: A): void => {
              try { fn(...a); }
              catch (err) {
                console.error(`[channels:${opts.sessionId}] ${label} callback threw (turn isolated):`, err);
              }
            };

          const tail = tailTranscript(
            transcriptPath(opts.workingDirectory, claudeSessionId),
            safe('transcript-tailer', (events) => {
              // Transcript grew → the process is producing output again. If a
              // permission prompt was pending, the user's verdict has been applied
              // and the model has resumed (the prompt itself writes no transcript
              // entry), so clear the suspend flag before re-arming the watchdog.
              if (permissionPending) permissionPending = false;
              bumpStall(); // transcript grew → the process is alive
              // Defer the pre-dequeue wedge watchdog on any real model output —
              // covers a message legitimately queued behind a still-running turn.
              if (events.some((e) => e.type !== 'channel_queue')) bumpWedge();
              for (const e of events) {
                if (e.type === 'channel_queue') {
                  // Internal signal from the transcript tailer (not forwarded to
                  // the client). A `dequeue` means the CLI accepted our pushed
                  // message and the turn has started → disarm the pre-dequeue
                  // wedge watchdog (fix B'); from here the stall / PTY-idle
                  // watchdogs govern the running turn.
                  try { if (JSON.parse(e.data).op === 'dequeue') turnStarted(); }
                  catch { /* ignore malformed */ }
                  continue;
                }
                if (e.type === 'auth_error') {
                  // Expired/invalid OAuth token (this long-lived PTY held an access
                  // token past its ~8h refresh boundary). Tear the turn down and
                  // signal the retry wrapper; killing the PTY makes the next
                  // ensureSession spawn a fresh `claude` that re-mints the token.
                  failAuth(e.data);
                  return;
                }
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
                    // Guarded by inFlight so an out-of-order pair (this tool's
                    // result already seen) doesn't re-suspend an idle turn.
                    toolFlight.startTool(d.id);
                    if (toolFlight.inFlight) {
                      clearTimeout(stallTimer);
                      clearTimeout(finishTimer);
                    }
                  } catch { /* fall through and emit as-is */ }
                } else if (e.type === 'tool_result') {
                  try {
                    const d = JSON.parse(e.data);
                    if (replyToolUseIds.has(d.tool_use_id)) continue;
                    // Tool completed; re-arm watchdogs once all pending tools
                    // finish so a quiet PTY can again signal turn-end.
                    toolFlight.finishTool(d.tool_use_id);
                    if (!toolFlight.inFlight) { bumpStall(); armFinish(); }
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
            }),
          );

          let done = false;
          let finishTimer: ReturnType<typeof setTimeout> | undefined;
          let stallTimer: ReturnType<typeof setTimeout> | undefined;
          // Pre-dequeue wedge watchdog (fix B'): armed after the push, disarmed
          // once the CLI dequeues our message (turn started). See DEQUEUE_WEDGE_MS.
          let wedgeTimer: ReturnType<typeof setTimeout> | undefined;
          let turnDequeued = false;
          let permissionPending = false;
          // Tracks non-reply tools that are mid-flight; the stall + finish
          // watchdogs are suspended while any tool is in flight.
          const toolFlight = new ToolFlightTracker();
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
          // eslint-disable-next-line prefer-const
          let ptyHeartbeat: { dispose(): void } | undefined;
          // eslint-disable-next-line prefer-const
          let exitSub: { dispose(): void } | undefined;
          // eslint-disable-next-line prefer-const
          let heartbeatPing: ReturnType<typeof setInterval> | undefined;

          const cleanup = () => {
            tail.stop(); unsub(); ptyHeartbeat?.dispose(); exitSub?.dispose();
            clearTimeout(timeout); clearTimeout(finishTimer); clearTimeout(stallTimer);
            clearTimeout(wedgeTimer);
            clearInterval(heartbeatPing);
          };

          // Fail the turn AND kill the channel process. Used for stalls /
          // timeouts / transport errors: the process is in an unknown state,
          // so killing it lets the next message respawn a clean one (--resume
          // continues the transcript) instead of queueing behind a dead turn.
          //
          // preserveAnswer: for the watchdog kills (timeout / stall) the turn-end
          // DETECTOR failed, not the turn — if the model already delivered an
          // answer (called `reply`, or streamed natural text) we still kill the
          // PTY but FINISH with that answer (same path as finishTurn) instead of
          // surfacing `msg`, so a real reply isn't discarded as an error. Genuine
          // failures (wedge / push error / user stop) pass false.
          const failAndKill = (msg: string, preserveAnswer = false) => {
            if (done) return;
            done = true;
            cleanup();
            try { killSession(opts.sessionId); } catch { /* best effort */ }
            if (preserveAnswer && turnHasDeliverableAnswer({ sawReply, streamedText })) {
              finish(
                resolveFinalReplyText(streamedText, replyText),
                sawUsage ? turnUsage : undefined,
              );
              return;
            }
            fail(msg);
          };

          // (Re)arm the stall watchdog. Called on every transcript poll that
          // sees activity; if the gap between two calls exceeds STALL_TIMEOUT_MS
          // the process is wedged. Disabled once a permission prompt is pending
          // or while any tool is actively executing.
          const bumpStall = () => {
            if (done || permissionPending || toolFlight.inFlight) return;
            clearTimeout(stallTimer);
            stallTimer = setTimeout(
              safe('stall-watchdog', () => failAndKill('channel turn stalled — no activity', true)),
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
          // On a clean turn-end, scan the dashboard entry JSON the model was
          // asked to write and append it to the project dashboard — the T1
          // parallel of the SDK `update_project_dashboard` tool. Best-effort:
          // a missing/invalid file (model didn't write it) is logged, NOT
          // surfaced as a turn error, so the model's text answer still stands.
          const maybePublishDashboard = () => {
            if (!opts.dashboardRequest) return;
            try {
              const res = publishDashboardEntryFromFile({
                request: opts.dashboardRequest,
                workingDirectory: opts.workingDirectory,
                projectId: opts.workingDirectory,
                beforeMtimeMs: dashboardBeforeMtimeMs,
              });
              if (!res.payload) {
                console.warn(`[channels:${opts.sessionId}] dashboard update skipped: ${res.error}`);
                return;
              }
              const toolUseId = `channels-update-dashboard-${Date.now()}`;
              emit({ type: 'tool_use', data: JSON.stringify({
                id: toolUseId,
                name: 'update_project_dashboard',
                input: { file_path: opts.dashboardRequest.filePath },
              }) });
              emit({ type: 'tool_result', data: JSON.stringify({
                tool_use_id: toolUseId,
                content: JSON.stringify(res.payload),
                is_error: false,
              }) });
              emit({ type: 'artifact_published', data: JSON.stringify({
                artifactId: res.payload.artifact_id,
                version: res.payload.version,
                internalUrl: res.payload.internal_url,
                title: res.payload.title,
                favicon: res.payload.favicon,
              }) });
            } catch (err) {
              console.error(`[channels:${opts.sessionId}] dashboard publish threw:`, err);
            }
          };

          const finishTurn = () => {
            if (done) return;
            done = true;
            cleanup();
            maybePublishDashboard();
            finish(
              resolveFinalReplyText(streamedText, replyText),
              sawUsage ? turnUsage : undefined,
            );
          };

          // Auth token expired/invalid. Tear the turn down, kill the PTY (so the
          // next ensureSession respawns a fresh `claude` that re-mints the token),
          // then close the stream with a dedicated `auth_error` event. The retry
          // wrapper (streamChannels) consumes that event and re-runs the turn
          // transparently — the user never sees "Please run /login". The empty
          // finish('') only emits the terminal `done`, carrying no answer text.
          const failAuth = (errorText: string) => {
            if (done) return;
            done = true;
            cleanup();
            try { killSession(opts.sessionId); } catch { /* best effort */ }
            emit({ type: 'auth_error', data: errorText });
            finish('');
          };

          // Primary (and sole) turn-end detector: the PTY has gone quiet. Re-armed
          // on every PTY data chunk (the model is still working) and after a tool
          // result; suspended while a tool is executing or a permission prompt is
          // pending (the process is legitimately idle then). When the timer
          // actually fires, the PTY has produced nothing for PTY_IDLE_FINISH_MS —
          // the turn is over.
          const armFinish = () => {
            if (done || permissionPending || toolFlight.inFlight) return;
            clearTimeout(finishTimer);
            finishTimer = setTimeout(safe('finish-timer', finishTurn), PTY_IDLE_FINISH_MS);
          };

          // (Re)arm the pre-dequeue wedge watchdog (fix B'). Active only until the
          // CLI dequeues our pushed message; deferred by any real transcript
          // progress so a message queued behind a still-running prior turn is not
          // reaped. Fires only when the CLI accepted nothing and produced nothing.
          const bumpWedge = () => {
            if (done || turnDequeued) return;
            clearTimeout(wedgeTimer);
            wedgeTimer = setTimeout(
              safe('wedge-watchdog', () => failAndKill('channel never started the turn (no dequeue) — wedged')),
              DEQUEUE_WEDGE_MS,
            );
          };
          // The CLI dequeued our message → the turn is underway. Disarm the
          // pre-dequeue wedge watchdog permanently; the stall / PTY-idle
          // watchdogs govern the running turn from here.
          const turnStarted = () => {
            turnDequeued = true;
            clearTimeout(wedgeTimer);
          };

          // PTY output ⇒ the process is alive and the turn is still in progress.
          // Re-arm both the stall watchdog (kill, long backstop) and the finish
          // timer (close, short). Throttled to once per second: chunks arrive
          // far faster than that during a turn, and the timers are seconds long,
          // so a 1s reset cadence is plenty to keep them from firing mid-turn.
          let lastHeartbeat = 0;
          ptyHeartbeat = session.proc.onData(safe('pty-heartbeat', () => {
            const now = Date.now();
            if (now - lastHeartbeat < 1000) return;
            lastHeartbeat = now;
            bumpStall();
            armFinish();
          }));

          // If the PTY process exits unexpectedly mid-turn (crash, OOM, external
          // kill), nothing else would close this stream: the stall + PTY-idle
          // watchdogs are suspended whenever a tool is in flight
          // (toolFlight.inFlight), so a crash during a tool would hang until
          // TURN_TIMEOUT_MS and
          // leave the DB draft stuck in 'streaming' (→ recovery deadlock). React
          // to the exit directly: flush any trailing transcript line, then close
          // the stream so collectStreamResponse finalizes the draft.
          exitSub = session.proc.onExit(safe('pty-exit', () => {
            if (done) return;
            setTimeout(safe('pty-exit-finish', () => finishTurn()), 500);
          }));

          // Keep the client's connection-health watchdog satisfied during long
          // tool calls / thinking gaps, when T1 otherwise emits no SSE data for
          // the tool's full duration. Without this the client wrongly aborts the
          // stream after ~30s of silence and surfaces a spurious timeout.
          heartbeatPing = setInterval(safe('client-heartbeat', () => {
            if (!done) emit({ type: 'heartbeat', data: '' });
          }), HEARTBEAT_INTERVAL_MS);

          timeout = setTimeout(
            safe('turn-timeout', () => failAndKill('channel turn timed out', true)),
            TURN_TIMEOUT_MS,
          );

          unsub = subscribeChannelEvents(opts.sessionId, safe('channel-event', (ev) => {
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
          }));

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
          // Message handed to the channel server; start watching for the CLI to
          // actually accept it (dequeue). If it never does, the CLI is wedged and
          // bumpWedge's timer reaps it. (No-op if a dequeue already arrived.)
          else bumpWedge();
        } catch (err) {
          try { killSession(opts.sessionId); } catch { /* best effort */ }
          fail(err instanceof Error ? err.message : String(err));
        }
      })();
    },
  });
}

/**
 * Force the macOS Keychain OAuth access token to re-mint before a channels
 * retry, by running a tiny headless `claude -p` with `CLAUDE_CODE_OAUTH_TOKEN`
 * **removed** from its env.
 *
 * Why remove the env token: a `claude` that has `CLAUDE_CODE_OAUTH_TOKEN` set
 * uses it directly as a bearer and never touches the Keychain — so it would NOT
 * refresh the stale Keychain access token. The channels interactive PTY, by
 * contrast, relies on that short-lived (~8h) Keychain token; stripping the env
 * token forces this warmup down the Keychain path, where an expired access token
 * is re-minted from the refresh token (verified: an env-token-less `claude -p`
 * rewrites the Keychain `expiresAt` ~8h forward).
 *
 * This closes the gap behind the residual 401s: respawning the channels turn
 * alone was not enough — a freshly spawned interactive `claude` could still 401
 * (observed: two 401s ~10s apart, while a separate process succeeded ~78s
 * later, i.e. once the token had re-minted). We now actively re-mint here, then
 * retry. Best-effort and bounded by a timeout; never throws (a failed warmup
 * just means the retry proceeds as before and may surface "Please run /login").
 */
function refreshKeychainAuth(timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const bin = findClaudeBinary();
      if (!bin) return done();
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      // `-p` is non-interactive (prints and exits); the prompt only needs to
      // trigger one authenticated API call so the CLI notices the expired access
      // token and refreshes it. Output is discarded.
      execFile(bin, ['-p', 'ok'], { env, timeout: timeoutMs, maxBuffer: 1 << 20 }, () => done());
    } catch { done(); }
  });
}

/**
 * Public channels stream: runs a turn and, on an expired/invalid auth token,
 * re-mints the OAuth token and transparently retries once.
 *
 * Why this exists: a long-lived T1 `claude` PTY caches the OAuth access token at
 * spawn and does NOT refresh it across the token's ~8h boundary — so after that
 * boundary every send 401s ("Please run /login") until something re-mints the
 * token. This wrapper automates the recovery: `runChannelsTurn` kills the stale
 * PTY and ends the turn with a dedicated `auth_error` event; we swallow it, tell
 * the collector to reset, run `refreshKeychainAuth` to re-mint the token, then
 * re-run the turn — `ensureSession` spawns a fresh `claude` that now reads a
 * valid token. Capped at one retry: if it still fails the token is genuinely
 * invalid/revoked, so we surface "Please run /login" rather than loop.
 */
export function streamChannels(
  opts: ChannelsStreamOptions,
  // Seam for tests: how to run a single turn. Production always uses the real
  // PTY-backed turn machine; tests inject a fake to exercise the retry plumbing
  // without spawning `claude`.
  runTurn: (o: ChannelsStreamOptions) => ReadableStream<string> = runChannelsTurn,
  // Seam for tests: how to re-mint auth between attempts. Production re-mints the
  // Keychain token via a headless `claude -p`; tests inject a no-op (or a spy).
  warmupAuth: () => Promise<void> = refreshKeychainAuth,
): ReadableStream<string> {
  const MAX_ATTEMPTS = 2; // original turn + one auth-refresh retry
  // Downstream-teardown flag. The route tees this stream; if every branch goes
  // away (client gone AND collector done) our source is cancelled and the
  // controller closes. Guard all controller ops so a late enqueue/close can't
  // throw ERR_INVALID_STATE → uncaughtException (which degrades the whole server
  // — see assembleStream's own `if (!closed)` guard).
  let closed = false;
  let currentReader: ReadableStreamDefaultReader<string> | null = null;
  const safeEnqueue = (chunk: string, controller: ReadableStreamDefaultController<string>) => {
    if (closed) return;
    try { controller.enqueue(chunk); } catch { closed = true; }
  };
  return new ReadableStream<string>({
    async start(controller) {
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS && !closed; attempt++) {
          const reader = runTurn(opts).getReader();
          currentReader = reader;
          let authErrorText: string | null = null;
          // Track whether the failed attempt streamed any real content. Auth-401
          // always fails on the first API call (before any output), but if a turn
          // somehow streamed content before failing, retrying would duplicate it —
          // so in that case we surface the error instead of retrying.
          let forwardedContent = false;
          try {
            while (!closed) {
              const { done, value } = await reader.read();
              if (done) break;
              let forwardChunk = true;
              for (const line of value.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                let evt: SSEEvent | undefined;
                try { evt = JSON.parse(line.slice(6)) as SSEEvent; } catch { continue; }
                if (evt.type === 'auth_error') {
                  authErrorText = evt.data;
                  forwardChunk = false; // swallow — the wrapper decides what to do
                } else if (evt.type === 'text' || evt.type === 'tool_use'
                  || evt.type === 'tool_result' || evt.type === 'thinking') {
                  forwardedContent = true;
                }
              }
              if (authErrorText !== null) break; // stop before the trailing `done`
              if (forwardChunk) safeEnqueue(value, controller);
            }
          } finally {
            try { reader.releaseLock(); } catch { /* noop */ }
            currentReader = null;
          }

          if (closed || authErrorText === null) return; // cancelled, or finished/failed normally

          const canRetry = attempt + 1 < MAX_ATTEMPTS
            && !forwardedContent
            && !opts.abortSignal?.aborted;
          if (canRetry) {
            // Discard any partial draft + reset the recovery buffer.
            safeEnqueue(sse({ type: 'session_reset', data: 'Authentication token refreshed — retrying…' }), controller);
            // Actively re-mint the token before respawning. Respawn alone is not
            // enough: a freshly spawned interactive `claude` can still 401 until
            // the stale Keychain access token is re-minted, so we trigger that
            // re-mint here and only then loop back to run the turn again.
            await warmupAuth();
            continue;
          }
          // Out of retries (or unsafe to retry): surface it like any failed turn
          // so the user sees it and an assistant row is persisted.
          safeEnqueue(sse({ type: 'error', data: authErrorText }), controller);
          safeEnqueue(sse({ type: 'done', data: '' }), controller);
          return;
        }
      } catch (err) {
        safeEnqueue(sse({ type: 'error', data: err instanceof Error ? err.message : String(err) }), controller);
      } finally {
        if (!closed) { try { controller.close(); } catch { /* already closed */ } }
      }
    },
    async cancel() {
      // Downstream cancelled (all tee branches gone). Stop pulling the inner turn.
      closed = true;
      if (currentReader) { try { await currentReader.cancel(); } catch { /* noop */ } }
    },
  });
}
