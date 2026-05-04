"use client";
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TaskForm } from '@/components/scheduler/TaskForm';
import { NLAssistDialog } from '@/components/scheduler/NLAssistDialog';
import type { CreateTaskInput } from '@/lib/scheduler/types';

export default function NewTaskPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [draft, setDraft] = useState<Partial<CreateTaskInput>>({});
  const [formOpen, setFormOpen] = useState(true);
  const [showAssist, setShowAssist] = useState(false);

  useEffect(() => {
    const sid = params.get('sessionId');
    const text = params.get('text');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (sid || text) setShowAssist(true);
  }, [params]);

  async function create(v: CreateTaskInput) {
    const r = await fetch('/api/scheduler/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v),
    });
    const j = await r.json();
    if (!r.ok) { alert(j.error ?? 'failed'); return; }
    router.push('/scheduler');
  }

  return (
    <div className="flex h-full flex-col">
      <Dialog open={formOpen} onOpenChange={(open) => { setFormOpen(open); if (!open) router.push('/scheduler'); }}>
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
              onCancel={() => router.push('/scheduler')}
              submitLabel="Create"
            />
          </div>
        </DialogContent>
      </Dialog>
      {showAssist && (
        <NLAssistDialog
          initialText={params.get('text') ?? ''}
          fromSessionId={params.get('sessionId') ?? undefined}
          onResult={(d) => { setDraft(d); setShowAssist(false); setFormOpen(true); }}
          onClose={() => setShowAssist(false)}
        />
      )}
    </div>
  );
}
