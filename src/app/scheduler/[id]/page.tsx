"use client";
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, PencilEdit01Icon } from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TaskForm } from '@/components/scheduler/TaskForm';
import { RunHistoryList } from '@/components/scheduler/RunHistoryList';
import type { ScheduledTask, TaskRun, CreateTaskInput } from '@/lib/scheduler/types';

export default function EditTaskPage() {
  const params = useParams();
  const id = params.id as string;
  const [task, setTask] = useState<ScheduledTask | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    const [t, r] = await Promise.all([
      fetch(`/api/scheduler/tasks/${id}`).then(r => r.json()),
      fetch(`/api/scheduler/tasks/${id}/runs?limit=50`).then(r => r.json()),
    ]);
    setTask(t.task);
    setRuns(r.runs ?? []);
  }, [id]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  if (!task) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading...</div>;

  async function save(v: CreateTaskInput) {
    const r = await fetch(`/api/scheduler/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v),
    });
    const j = await r.json();
    if (!r.ok) { alert(j.error ?? 'Failed to save task'); return; }
    setEditOpen(false);
    await load();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-4 py-4 md:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <Link href="/scheduler" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <HugeiconsIcon icon={ArrowLeft01Icon} className="h-3.5 w-3.5" />
              Scheduled Tasks
            </Link>
            <h1 className="truncate text-xl font-semibold">{task.name}</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{task.description}</p>
          </div>
          <Button className="shrink-0" onClick={() => setEditOpen(true)}>
            <HugeiconsIcon icon={PencilEdit01Icon} className="h-3.5 w-3.5" />
            Edit
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          <section className="rounded-md border p-4">
            <h2 className="text-sm font-semibold">Configuration</h2>
            <div className="mt-3 grid gap-3 text-sm text-muted-foreground md:grid-cols-2 lg:grid-cols-4">
              <Info label="Working directory" value={task.workingDirectory} />
              <Info label="Backend" value={task.backend} />
              <Info label="Trigger" value={triggerLabel(task)} />
              <Info label="Next run" value={task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : '-'} />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold">Run history</h2>
            <RunHistoryList runs={runs} />
          </section>
        </div>
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[calc(100dvh-1rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>Edit Scheduled Task</DialogTitle>
            <DialogDescription>
              Changes take effect the next time the scheduler evaluates this task.
            </DialogDescription>
          </DialogHeader>
          <div className="p-5">
            <TaskForm
              initial={task}
              onSubmit={save}
              onCancel={() => setEditOpen(false)}
              submitLabel="Save changes"
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-foreground">{value}</div>
    </div>
  );
}

function triggerLabel(t: ScheduledTask): string {
  if (t.trigger.kind === 'cron') return `Cron ${t.trigger.cron}`;
  if (t.trigger.kind === 'once') return `Once ${new Date(t.trigger.runAt).toLocaleString()}`;
  return `Every ${Math.round(t.trigger.everyMs / 1000)}s`;
}
