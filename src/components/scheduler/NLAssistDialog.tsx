"use client";
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Describe your task</DialogTitle>
          <DialogDescription>
          {fromSessionId
            ? 'I will use the recent messages of the current chat plus your text below to fill in the form.'
            : 'In one or two sentences, describe what should run, when, and where. The form below will be pre-filled.'}
          </DialogDescription>
        </DialogHeader>
        <Textarea rows={6} value={text} onChange={e => setText(e.target.value)} placeholder="every weekday at 9am, run a security review of /Users/me/proj on the main branch" />
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={run} disabled={busy || (!text && !fromSessionId)}>
            {busy ? 'Generating...' : 'Generate draft'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
