"use client";
import { useEffect, useState, useCallback } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { AiMagicIcon, CalendarAdd01Icon, Clock01Icon } from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { NLAssistDialog } from '@/components/scheduler/NLAssistDialog';
import { TaskForm } from '@/components/scheduler/TaskForm';
import { TaskListItem } from '@/components/scheduler/TaskListItem';
import type { CreateTaskInput, ScheduledTask, TaskRun } from '@/lib/scheduler/types';

export default function SchedulerPage() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [latestRunStatus, setLatestRunStatus] = useState<Record<string, string>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [showAssist, setShowAssist] = useState(false);
  const [draft, setDraft] = useState<Partial<CreateTaskInput>>({});

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

  // eslint-disable-next-line react-hooks/set-state-in-effect
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

  async function create(v: CreateTaskInput) {
    const r = await fetch('/api/scheduler/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v),
    });
    const j = await r.json();
    if (!r.ok) { alert(j.error ?? 'Failed to create task'); return; }
    setCreateOpen(false);
    setDraft({});
    await load();
  }

  async function remove(id: string) {
    if (!confirm('Delete this task and all its run history?')) return;
    await fetch(`/api/scheduler/tasks/${id}`, { method: 'DELETE' });
    await load();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-4 py-4 md:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Scheduled Tasks</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Centralized automation across projects. Runs create normal chat sessions in the selected working directory.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={() => setShowAssist(true)}>
              <HugeiconsIcon icon={AiMagicIcon} className="h-3.5 w-3.5" />
              AI fill
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <HugeiconsIcon icon={CalendarAdd01Icon} className="h-3.5 w-3.5" />
              New Task
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          {tasks.length === 0 ? (
            <div className="rounded-md border border-dashed p-8 text-center">
              <HugeiconsIcon icon={Clock01Icon} className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
              <h2 className="text-sm font-medium">No scheduled tasks yet</h2>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Create a task to run Claude or Codex on a cron, one-off, or interval schedule.
              </p>
              <Button className="mt-4" onClick={() => setCreateOpen(true)}>Create task</Button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border">
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
          )}

          <section className="rounded-md border bg-muted/20 p-4">
            <h2 className="text-sm font-semibold">How scheduled tasks work</h2>
            <div className="mt-3 grid gap-3 text-sm text-muted-foreground md:grid-cols-3">
              <p><span className="font-medium text-foreground">Scope.</span> Each task belongs to a working directory, but this page manages tasks across every project.</p>
              <p><span className="font-medium text-foreground">Output.</span> Every run creates or resumes a normal chat session, so results are available from project history and run history.</p>
              <p><span className="font-medium text-foreground">Reliability.</span> Unattended runs should keep skip permissions enabled, with max turns and wall-clock timeout set to bounded values.</p>
            </div>
          </section>
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[calc(100dvh-1rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>New Scheduled Task</DialogTitle>
            <DialogDescription>
              Define when the agent runs, where it runs, and what it should do.
            </DialogDescription>
          </DialogHeader>
          <div className="p-5">
            <TaskForm
              initial={draft}
              onSubmit={create}
              onCancel={() => { setCreateOpen(false); setDraft({}); }}
              submitLabel="Create"
            />
          </div>
        </DialogContent>
      </Dialog>

      {showAssist && (
        <NLAssistDialog
          onResult={(d) => { setDraft(d); setShowAssist(false); setCreateOpen(true); }}
          onClose={() => setShowAssist(false)}
        />
      )}
    </div>
  );
}
