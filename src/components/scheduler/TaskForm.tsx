"use client";
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import type { CreateTaskInput, TriggerSpec } from '@/lib/scheduler/types';
import {
  DEFAULT_MAX_TURNS, DEFAULT_TOOL_TIMEOUT_SECONDS, DEFAULT_WALL_CLOCK_TIMEOUT_SECONDS,
} from '@/lib/scheduler/types';
import {
  fetchModelCatalog, getEffortOptionsForModel, getDefaultEffortForModel,
  type ModelCatalog,
} from '@/lib/model-selection';

interface Props {
  initial?: Partial<CreateTaskInput>;
  onSubmit: (v: CreateTaskInput) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}

export function TaskForm({ initial = {}, onSubmit, onCancel, submitLabel = 'Save' }: Props) {
  const [name, setName] = useState(initial.name ?? '');
  const [description, setDescription] = useState(initial.description ?? '');
  const [workingDirectory, setWorkingDirectory] = useState(initial.workingDirectory ?? '');
  const [backend, setBackend] = useState<'claude' | 'codex'>(initial.backend ?? 'claude');
  const [model, setModel] = useState(initial.model ?? '');
  const [effort, setEffort] = useState(initial.effort ?? '');
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [trigger, setTrigger] = useState<TriggerSpec>(
    (initial.trigger as TriggerSpec) ?? { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
  );
  const [prompt, setPrompt] = useState(initial.prompt ?? '');
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt ?? '');
  const [skipPermissions, setSkipPermissions] = useState(initial.skipPermissions ?? true);
  const [maxTurns, setMaxTurns] = useState(initial.maxTurns ?? DEFAULT_MAX_TURNS);
  const [toolTimeoutSeconds, setToolTimeoutSeconds] = useState(initial.toolTimeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS);
  const [wallClockTimeoutSeconds, setWallClockTimeoutSeconds] = useState(initial.wallClockTimeoutSeconds ?? DEFAULT_WALL_CLOCK_TIMEOUT_SECONDS);
  const [enabled, setEnabled] = useState(initial.enabled ?? true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchModelCatalog().then((c) => { if (!cancelled) setCatalog(c); });
    return () => { cancelled = true; };
  }, []);

  const backendModels = useMemo(
    () => (catalog?.models ?? []).filter(m => m.group === backend),
    [catalog, backend],
  );

  const effortOptions = useMemo(() => {
    if (!catalog || !model) return [];
    return getEffortOptionsForModel(model, catalog.claudeEffortInfo, catalog.codexModelInfo);
  }, [catalog, model]);

  // When model changes, reset effort to that model's default (or clear if unsupported).
  useEffect(() => {
    if (!catalog || !model) return;
    const opts = getEffortOptionsForModel(model, catalog.claudeEffortInfo, catalog.codexModelInfo);
    if (opts.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (effort !== '') setEffort('');
      return;
    }
    if (!opts.some(o => o.value === effort)) {
      const def = getDefaultEffortForModel(model, catalog.claudeEffortInfo, catalog.codexModelInfo) ?? opts[0]?.value ?? '';
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEffort(def);
    }
  }, [model, catalog, effort]);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      await onSubmit({
        name, description: description || null, workingDirectory, backend,
        model: model || null, effort: effort || null, mode: 'acceptEdits',
        trigger, prompt, systemPrompt: systemPrompt || null,
        skipPermissions, maxTurns, toolTimeoutSeconds, wallClockTimeoutSeconds, enabled,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Name">
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="Daily code review" />
      </Field>
      <Field label="Description (optional)">
        <Input value={description} onChange={e => setDescription(e.target.value)} />
      </Field>
      <Field label="Working directory">
        <Input value={workingDirectory} onChange={e => setWorkingDirectory(e.target.value)} placeholder="/Users/me/projects/foo" />
      </Field>
      <Field label="Backend">
        <select className="border rounded px-2 py-1" value={backend} onChange={e => setBackend(e.target.value as 'claude' | 'codex')}>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </Field>
      <Field label="Model (optional, defaults to backend default)">
        <select
          className="border rounded px-2 py-1 w-full max-w-md"
          value={model}
          onChange={e => setModel(e.target.value)}
          disabled={!catalog}
        >
          <option value="">(backend default)</option>
          {backendModels.map(m => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </Field>
      {effortOptions.length > 0 && (
        <Field label="Reasoning effort">
          <select
            className="border rounded px-2 py-1 w-full max-w-md"
            value={effort}
            onChange={e => setEffort(e.target.value)}
          >
            {effortOptions.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Trigger">
        <select className="border rounded px-2 py-1" value={trigger.kind} onChange={e => {
          const k = e.target.value as TriggerSpec['kind'];
          if (k === 'cron') setTrigger({ kind: 'cron', cron: '0 9 * * *', timezone: trigger.timezone });
          else if (k === 'once') setTrigger({ kind: 'once', runAt: Date.now() + 60_000, timezone: trigger.timezone });
          else setTrigger({ kind: 'interval', everyMs: 3_600_000, timezone: trigger.timezone });
        }}>
          <option value="cron">Cron</option>
          <option value="once">Once</option>
          <option value="interval">Interval</option>
        </select>
      </Field>
      {trigger.kind === 'cron' && (
        <Field label="Cron expression">
          <Input value={trigger.cron} onChange={e => setTrigger({ ...trigger, cron: e.target.value })} />
        </Field>
      )}
      {trigger.kind === 'once' && (
        <Field label="Run at (local datetime)">
          <Input
            type="datetime-local"
            value={new Date(trigger.runAt).toISOString().slice(0, 16)}
            onChange={e => setTrigger({ ...trigger, runAt: new Date(e.target.value).getTime() })}
          />
        </Field>
      )}
      {trigger.kind === 'interval' && (
        <Field label="Every (seconds, min 5)">
          <Input
            type="number"
            min={5}
            value={trigger.everyMs / 1000}
            onChange={e => setTrigger({ ...trigger, everyMs: Math.max(5, Number(e.target.value)) * 1000 })}
          />
        </Field>
      )}
      <Field label="Timezone (IANA)">
        <Input value={trigger.timezone} onChange={e => setTrigger({ ...trigger, timezone: e.target.value })} />
      </Field>

      <Field label="Prompt (the instruction sent to the agent)">
        <Textarea rows={5} value={prompt} onChange={e => setPrompt(e.target.value)} />
      </Field>
      <Field label="System prompt (optional)">
        <Textarea rows={2} value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} />
      </Field>

      <Field label="Skip permissions (required for unattended runs)">
        <div className="flex items-center gap-2">
          <Switch checked={skipPermissions} onCheckedChange={setSkipPermissions} />
          {!skipPermissions && (
            <span className="text-sm text-amber-600">
              Without skip-permissions, any tool call will time out after 5 minutes.
            </span>
          )}
        </div>
      </Field>

      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">Advanced timeouts and limits</summary>
        <div className="space-y-3 mt-3 pl-4">
          <Field label="Max turns"><Input type="number" value={maxTurns} onChange={e => setMaxTurns(Number(e.target.value))} /></Field>
          <Field label="Per-tool timeout (seconds)"><Input type="number" value={toolTimeoutSeconds} onChange={e => setToolTimeoutSeconds(Number(e.target.value))} /></Field>
          <Field label="Wall-clock timeout (seconds)"><Input type="number" value={wallClockTimeoutSeconds} onChange={e => setWallClockTimeoutSeconds(Number(e.target.value))} /></Field>
        </div>
      </details>

      <Field label="Enabled">
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </Field>

      <div className="flex justify-end gap-2 pt-4 border-t">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={submitting || !name || !workingDirectory || !prompt}>
          {submitting ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-sm font-medium mb-1">{label}</div>
      {children}
    </label>
  );
}
