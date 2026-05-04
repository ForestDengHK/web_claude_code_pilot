import { listRunningRuns, updateRunStatus } from './scheduler-db';
import { getDb } from '@/lib/db';

export function recoverInterruptedRuns(): number {
  const stale = listRunningRuns();
  for (const run of stale) {
    updateRunStatus(run.id, {
      status: 'interrupted',
      finishedAt: Date.now(),
      error: 'process restart while run was in flight',
    });
  }
  // Finalize any draft messages that were streaming.
  const db = getDb();
  db.prepare("UPDATE messages SET status = 'complete' WHERE status = 'streaming'").run();
  return stale.length;
}
