"use client";
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { TaskForm } from '@/components/scheduler/TaskForm';
import { NLAssistDialog } from '@/components/scheduler/NLAssistDialog';
import type { CreateTaskInput } from '@/lib/scheduler/types';

export default function NewTaskPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [draft, setDraft] = useState<Partial<CreateTaskInput>>({});
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
    <div className="max-w-2xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">New Scheduled Task</h1>
        <Button variant="outline" onClick={() => setShowAssist(true)}>AI fill</Button>
      </div>
      <TaskForm
        initial={draft}
        onSubmit={create}
        onCancel={() => router.push('/scheduler')}
        submitLabel="Create"
      />
      {showAssist && (
        <NLAssistDialog
          initialText={params.get('text') ?? ''}
          fromSessionId={params.get('sessionId') ?? undefined}
          onResult={(d) => { setDraft(d); setShowAssist(false); }}
          onClose={() => setShowAssist(false)}
        />
      )}
    </div>
  );
}
