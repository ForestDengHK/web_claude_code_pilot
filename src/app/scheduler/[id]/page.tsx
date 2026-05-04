"use client";
import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { TaskForm } from '@/components/scheduler/TaskForm';
import { RunHistoryList } from '@/components/scheduler/RunHistoryList';
import type { ScheduledTask, TaskRun, CreateTaskInput } from '@/lib/scheduler/types';

export default function EditTaskPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const [task, setTask] = useState<ScheduledTask | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);

  const load = useCallback(async () => {
    const [t, r] = await Promise.all([
      fetch(`/api/scheduler/tasks/${id}`).then(r => r.json()),
      fetch(`/api/scheduler/tasks/${id}/runs?limit=50`).then(r => r.json()),
    ]);
    setTask(t.task);
    setRuns(r.runs ?? []);
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  if (!task) return <div className="p-8">Loading…</div>;

  async function save(v: CreateTaskInput) {
    await fetch(`/api/scheduler/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v),
    });
    await load();
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 space-y-8">
      <h1 className="text-2xl font-semibold">{task.name}</h1>
      <section>
        <h2 className="text-lg font-medium mb-3">Configuration</h2>
        <TaskForm initial={task} onSubmit={save} onCancel={() => router.push('/scheduler')} submitLabel="Save changes" />
      </section>
      <section>
        <h2 className="text-lg font-medium mb-3">Run history</h2>
        <RunHistoryList runs={runs} />
      </section>
    </div>
  );
}
