"use client";
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { CreateTaskInput } from '@/lib/scheduler/types';

interface Props {
  initialText?: string;
  fromSessionId?: string;
  onResult: (draft: CreateTaskInput) => void;
  onClose: () => void;
}

export function NLAssistDialog({ initialText = '', fromSessionId, onResult, onClose }: Props) {
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/scheduler/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, sessionId: fromSessionId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'extraction failed');
      onResult(j.draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-background border rounded-lg shadow-lg w-full max-w-xl p-6 space-y-4">
        <h2 className="text-lg font-semibold">Describe your task</h2>
        <p className="text-sm text-muted-foreground">
          {fromSessionId
            ? 'I will use the recent messages of the current chat plus your text below to fill in the form.'
            : 'In one or two sentences, describe what should run, when, and where. The form below will be pre-filled.'}
        </p>
        <Textarea rows={6} value={text} onChange={e => setText(e.target.value)} placeholder="every weekday at 9am, run a security review of /Users/me/proj on the main branch" />
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={run} disabled={busy || (!text && !fromSessionId)}>
            {busy ? 'Generating…' : 'Generate draft'}
          </Button>
        </div>
      </div>
    </div>
  );
}
