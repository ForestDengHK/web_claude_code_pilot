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

  // Channel (T1) PTY lifecycle. Each active session holds a Claude CLI process
  // + MCP server child + a TCP port.
  const { reapIdle, reapOrphanChannelProcs } = await import('@/lib/channels/session-manager');

  // One-shot at boot: kill channel PTYs orphaned by a PREVIOUS server instance.
  // reapIdle (below) only sees this process's registry, so PTYs whose owning
  // next-server survived a restart (reparented to PID 1) leak across restarts.
  // At boot our registry is empty, so any stray channel process for this project
  // is a leftover and is killed here; it resumes via `--resume` on next use.
  try {
    const reaped = reapOrphanChannelProcs();
    if (reaped > 0) console.log(`[channels] startup: reaped ${reaped} orphaned PTY(s)`);
  } catch (err) {
    console.error('[channels] startup orphan reap failed', err);
  }

  // Periodic: reap idle sessions in THIS instance so long-lived servers don't
  // accumulate live-but-unused PTYs. Reaped sessions resume cleanly via
  // `claude --resume` against the persisted transcript, so this is safe.
  const REAP_INTERVAL_MS = 5 * 60_000;
  const IDLE_THRESHOLD_MS = 30 * 60_000;
  setInterval(() => {
    try { reapIdle(IDLE_THRESHOLD_MS); }
    catch (err) { console.error('[channels] reapIdle failed', err); }
  }, REAP_INTERVAL_MS).unref();
}
