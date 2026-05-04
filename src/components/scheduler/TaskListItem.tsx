"use client";
import Link from 'next/link';
import { HugeiconsIcon } from '@hugeicons/react';
import { Delete02Icon, PlayCircleIcon } from '@hugeicons/core-free-icons';
import { Badge } from '@/components/ui/badge';
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
    <div className="flex flex-col gap-3 border-b px-4 py-3 last:border-b-0 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Switch className="mt-0.5 shrink-0" checked={task.enabled} onCheckedChange={onToggle} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Link href={`/scheduler/${task.id}`} className="truncate font-medium hover:underline">
              {task.name}
            </Link>
            <Badge variant={task.enabled ? 'outline' : 'secondary'} className="rounded-md">
              {task.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            {lastStatus && (
              <Badge variant="secondary" className="rounded-md">
                Last: {lastStatus}
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
            {task.description || 'No description'}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{projectName}</span>
            <span>{task.backend}</span>
            <span>{triggerLabel(task)}</span>
            <span>{task.nextRunAt ? `Next: ${formatTime(task.nextRunAt)}` : 'Next: -'}</span>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 justify-end gap-2 pl-9 sm:pl-0">
        <Button variant="outline" size="sm" onClick={onRunNow} disabled={!task.enabled}>
          <HugeiconsIcon icon={PlayCircleIcon} className="h-3.5 w-3.5" />
          Run now
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete}>
          <HugeiconsIcon icon={Delete02Icon} className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}

function triggerLabel(t: ScheduledTask): string {
  if (t.trigger.kind === 'cron') return `Cron ${t.trigger.cron}`;
  if (t.trigger.kind === 'once') return `Once ${new Date(t.trigger.runAt).toLocaleString()}`;
  return `Every ${Math.round(t.trigger.everyMs / 1000)}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}
