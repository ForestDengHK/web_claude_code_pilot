export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { recoverInterruptedRuns } = await import('@/lib/scheduler/recovery');
  const { start } = await import('@/lib/scheduler/scheduler-manager');

  try {
    const fixed = recoverInterruptedRuns();
    if (fixed > 0) console.log(`[scheduler] recovered ${fixed} interrupted run(s)`);
    start();
  } catch (err) {
    console.error('[scheduler] failed to start', err);
  }

  // Periodically reap idle channel (T1) PTY sessions. Each active session
  // holds a Claude CLI process + MCP server child + a TCP port; without a
  // sweeper they accumulate forever until the next dev/server restart. Reaped
  // sessions resume cleanly on the next message via `claude --resume` against
  // the persisted transcript, so this is safe.
  const { reapIdle } = await import('@/lib/channels/session-manager');
  const REAP_INTERVAL_MS = 5 * 60_000;
  const IDLE_THRESHOLD_MS = 30 * 60_000;
  setInterval(() => {
    try { reapIdle(IDLE_THRESHOLD_MS); }
    catch (err) { console.error('[channels] reapIdle failed', err); }
  }, REAP_INTERVAL_MS).unref();
}
