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
}
