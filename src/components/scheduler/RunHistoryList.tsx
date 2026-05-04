"use client";
import Link from 'next/link';
import type { TaskRun } from '@/lib/scheduler/types';

export function RunHistoryList({ runs }: { runs: TaskRun[] }) {
  if (runs.length === 0) return <div className="text-sm text-muted-foreground py-4">No runs yet.</div>;
  return (
    <div className="border rounded-lg divide-y">
      {runs.map(r => (
        <div key={r.id} className="flex items-center gap-4 px-4 py-2 text-sm">
          <span className={`px-2 py-0.5 rounded text-xs ${statusColor(r.status)}`}>{r.status}</span>
          <span className="text-muted-foreground flex-1">
            {new Date(r.scheduledAt).toLocaleString()} · {r.triggerSource}
            {r.error && <span className="block text-red-600 truncate">{r.error}</span>}
          </span>
          {r.sessionId && <Link className="underline" href={`/chat?session=${r.sessionId}`}>Open session</Link>}
        </div>
      ))}
    </div>
  );
}

function statusColor(s: TaskRun['status']): string {
  switch (s) {
    case 'success': return 'bg-green-100 text-green-800';
    case 'failed':
    case 'timed_out':
    case 'tool_timed_out':
    case 'blocked_on_input':
    case 'max_turns_exceeded': return 'bg-red-100 text-red-800';
    case 'cancelled':
    case 'interrupted': return 'bg-amber-100 text-amber-800';
    case 'running':
    case 'pending': return 'bg-blue-100 text-blue-800';
  }
}
