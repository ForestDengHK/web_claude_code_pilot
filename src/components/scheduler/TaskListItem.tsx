"use client";
import Link from 'next/link';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import type { ScheduledTask } from '@/lib/scheduler/types';

interface Props {
  task: ScheduledTask;
  lastStatus: string | null;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onDelete: () => void;
}

export function TaskListItem({ task, lastStatus, onToggle, onRunNow, onDelete }: Props) {
  const projectName = task.workingDirectory.split('/').filter(Boolean).pop() ?? task.workingDirectory;
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b">
      <Switch checked={task.enabled} onCheckedChange={onToggle} />
      <div className="flex-1 min-w-0">
        <Link href={`/scheduler/${task.id}`} className="font-medium hover:underline">
          {task.name}
        </Link>
        <div className="text-xs text-muted-foreground truncate">
          {projectName} · {task.backend} · {triggerLabel(task)}
        </div>
        <div className="text-xs text-muted-foreground">
          {task.nextRunAt ? `next: ${formatTime(task.nextRunAt)}` : 'next: —'}
          {lastStatus && <span className="ml-2">last: {lastStatus}</span>}
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={onRunNow} disabled={!task.enabled}>Run now</Button>
      <Button variant="ghost" size="sm" onClick={onDelete}>Delete</Button>
    </div>
  );
}

function triggerLabel(t: ScheduledTask): string {
  if (t.trigger.kind === 'cron') return `cron "${t.trigger.cron}"`;
  if (t.trigger.kind === 'once') return `once @ ${new Date(t.trigger.runAt).toLocaleString()}`;
  return `every ${Math.round(t.trigger.everyMs / 1000)}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}
