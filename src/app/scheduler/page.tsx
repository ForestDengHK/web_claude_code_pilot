"use client";
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { TaskListItem } from '@/components/scheduler/TaskListItem';
import type { ScheduledTask, TaskRun } from '@/lib/scheduler/types';

export default function SchedulerPage() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [latestRunStatus, setLatestRunStatus] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const r = await fetch('/api/scheduler/tasks');
    const j = await r.json();
    setTasks(j.tasks ?? []);

    const statusMap: Record<string, string> = {};
    await Promise.all(
      (j.tasks ?? []).map(async (t: ScheduledTask) => {
        const rr = await fetch(`/api/scheduler/tasks/${t.id}/runs?limit=1`);
        const jj = await rr.json();
        const run: TaskRun | undefined = jj.runs?.[0];
        if (run) statusMap[t.id] = run.status;
      }),
    );
    setLatestRunStatus(statusMap);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function toggle(id: string, enabled: boolean) {
    await fetch(`/api/scheduler/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    await load();
  }

  async function runNow(id: string) {
    await fetch(`/api/scheduler/tasks/${id}/run-now`, { method: 'POST' });
  }

  async function remove(id: string) {
    if (!confirm('Delete this task and all its run history?')) return;
    await fetch(`/api/scheduler/tasks/${id}`, { method: 'DELETE' });
    await load();
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Scheduled Tasks</h1>
        <Link href="/scheduler/new">
          <Button>New Task</Button>
        </Link>
      </div>
      {tasks.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No scheduled tasks yet. <Link href="/scheduler/new" className="underline">Create one</Link>.
        </div>
      )}
      <div className="border rounded-lg overflow-hidden">
        {tasks.map(t => (
          <TaskListItem
            key={t.id}
            task={t}
            lastStatus={latestRunStatus[t.id] ?? null}
            onToggle={(e) => toggle(t.id, e)}
            onRunNow={() => runNow(t.id)}
            onDelete={() => remove(t.id)}
          />
        ))}
      </div>
    </div>
  );
}
