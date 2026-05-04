"use client";
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import type { TaskRun } from '@/lib/scheduler/types';

export function RunHistoryList({ runs }: { runs: TaskRun[] }) {
  if (runs.length === 0) return <div className="text-sm text-muted-foreground py-4">No runs yet.</div>;
  return (
    <div className="divide-y rounded-md border">
      {runs.map(r => (
        <div key={r.id} className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center">
          <Badge variant={statusVariant(r.status)} className="rounded-md">{r.status}</Badge>
          <span className="min-w-0 flex-1 text-muted-foreground">
            {new Date(r.scheduledAt).toLocaleString()} - {r.triggerSource}
            {r.error && <span className="block text-red-600 truncate">{r.error}</span>}
          </span>
          {r.sessionId && <Link className="underline" href={`/chat?session=${r.sessionId}`}>Open session</Link>}
        </div>
      ))}
    </div>
  );
}

function statusVariant(s: TaskRun['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (s) {
    case 'success': return 'outline';
    case 'failed':
    case 'timed_out':
    case 'tool_timed_out':
    case 'blocked_on_input':
    case 'max_turns_exceeded': return 'destructive';
    case 'cancelled':
    case 'interrupted': return 'secondary';
    case 'running':
    case 'pending': return 'default';
  }
}
