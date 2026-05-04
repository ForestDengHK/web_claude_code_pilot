"use client";

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { HugeiconsIcon } from '@hugeicons/react';
import { HelpCircleIcon } from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { CreateTaskInput, TriggerSpec } from '@/lib/scheduler/types';
import {
  DEFAULT_MAX_TURNS, DEFAULT_TOOL_TIMEOUT_SECONDS, DEFAULT_WALL_CLOCK_TIMEOUT_SECONDS,
} from '@/lib/scheduler/types';
import {
  fetchModelCatalog, getEffortOptionsForModel, getDefaultEffortForModel,
  type ModelCatalog,
} from '@/lib/model-selection';
import { cn } from '@/lib/utils';

interface Props {
  initial?: Partial<CreateTaskInput>;
  onSubmit: (v: CreateTaskInput) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}

const MODEL_DEFAULT = '__backend_default__';

function defaultTrigger(): TriggerSpec {
  return { kind: 'cron', cron: '0 9 * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
}

export function TaskForm({ initial = {}, onSubmit, onCancel, submitLabel = 'Save' }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [backend, setBackend] = useState<'claude' | 'codex'>('claude');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [trigger, setTrigger] = useState<TriggerSpec>(defaultTrigger());
  const [prompt, setPrompt] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [skipPermissions, setSkipPermissions] = useState(true);
  const [maxTurns, setMaxTurns] = useState(DEFAULT_MAX_TURNS);
  const [toolTimeoutSeconds, setToolTimeoutSeconds] = useState(DEFAULT_TOOL_TIMEOUT_SECONDS);
  const [wallClockTimeoutSeconds, setWallClockTimeoutSeconds] = useState(DEFAULT_WALL_CLOCK_TIMEOUT_SECONDS);
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setName(initial.name ?? '');
    setDescription(initial.description ?? '');
    setWorkingDirectory(initial.workingDirectory ?? '');
    setBackend(initial.backend ?? 'claude');
    setModel(initial.model ?? '');
    setEffort(initial.effort ?? '');
    setTrigger((initial.trigger as TriggerSpec) ?? defaultTrigger());
    setPrompt(initial.prompt ?? '');
    setSystemPrompt(initial.systemPrompt ?? '');
    setSkipPermissions(initial.skipPermissions ?? true);
    setMaxTurns(initial.maxTurns ?? DEFAULT_MAX_TURNS);
    setToolTimeoutSeconds(initial.toolTimeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS);
    setWallClockTimeoutSeconds(initial.wallClockTimeoutSeconds ?? DEFAULT_WALL_CLOCK_TIMEOUT_SECONDS);
    setEnabled(initial.enabled ?? true);
  }, [initial]);

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

  useEffect(() => {
    if (!catalog || !model) return;
    const selected = catalog.models.find(m => m.value === model);
    if (selected && selected.group !== backend) {
      setModel('');
      setEffort('');
    }
  }, [backend, catalog, model]);

  useEffect(() => {
    if (!catalog || !model) return;
    const opts = getEffortOptionsForModel(model, catalog.claudeEffortInfo, catalog.codexModelInfo);
    if (opts.length === 0) {
      if (effort !== '') setEffort('');
      return;
    }
    if (!opts.some(o => o.value === effort)) {
      setEffort(getDefaultEffortForModel(model, catalog.claudeEffortInfo, catalog.codexModelInfo) ?? opts[0]?.value ?? '');
    }
  }, [model, catalog, effort]);

  const timezone = trigger.timezone || 'UTC';
  const canSubmit = Boolean(name.trim() && description.trim() && workingDirectory.trim() && prompt.trim());

  function updateTriggerKind(kind: TriggerSpec['kind']) {
    if (kind === 'cron') setTrigger({ kind: 'cron', cron: '0 9 * * *', timezone });
    else if (kind === 'once') setTrigger({ kind: 'once', runAt: Date.now() + 60_000, timezone });
    else setTrigger({ kind: 'interval', everyMs: 3_600_000, timezone });
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        workingDirectory: workingDirectory.trim(),
        backend,
        model: model || null,
        effort: effort || null,
        mode: 'acceptEdits',
        trigger,
        prompt: prompt.trim(),
        systemPrompt: systemPrompt.trim() || null,
        skipPermissions,
        maxTurns,
        toolTimeoutSeconds,
        wallClockTimeoutSeconds,
        enabled,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-5">
        <FormSection title="Task">
          <Field
            label="Name"
            help="A short title shown in the scheduler list and in the generated chat session."
            required
          >
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Daily repository review" />
          </Field>
          <Field
            label="Description"
            help="Required context for future you. Use it to describe why the task exists and what a successful run should produce."
            required
          >
            <Textarea
              rows={3}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Review the project every morning and summarize risky changes, failing checks, and suggested next actions."
            />
          </Field>
          <Field
            label="Working directory"
            help="Absolute local path where the agent starts. This also determines which project the run session appears under."
            required
          >
            <Input value={workingDirectory} onChange={e => setWorkingDirectory(e.target.value)} placeholder="/Users/me/projects/codepilot" />
          </Field>
        </FormSection>

        <FormSection title="Agent">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Backend" help="Choose which agent runtime executes this task." required>
              <Select value={backend} onValueChange={v => setBackend(v as 'claude' | 'codex')}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude">Claude</SelectItem>
                  <SelectItem value="codex">Codex</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Model" help="Defaults to the selected backend's configured default. Pick a model only when the task needs a specific capability.">
              <Select
                value={model || MODEL_DEFAULT}
                onValueChange={v => setModel(v === MODEL_DEFAULT ? '' : v)}
                disabled={!catalog}
              >
                <SelectTrigger className="w-full"><SelectValue placeholder="Backend default" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={MODEL_DEFAULT}>Backend default</SelectItem>
                  {backendModels.map(m => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {effortOptions.length > 0 && (
            <Field label="Reasoning effort" help="Controls reasoning depth for models that expose effort levels. Higher effort is slower and more expensive, but better for complex tasks.">
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger className="w-full sm:w-64"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {effortOptions.map(o => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </FormSection>

        <FormSection title="Schedule">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Trigger" help="Cron is best for calendar schedules, Once is for a single future run, Interval repeats after a fixed delay." required>
              <Select value={trigger.kind} onValueChange={v => updateTriggerKind(v as TriggerSpec['kind'])}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cron">Cron</SelectItem>
                  <SelectItem value="once">Once</SelectItem>
                  <SelectItem value="interval">Interval</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Timezone" help="Use an IANA timezone such as America/Los_Angeles, Europe/Dublin, or Asia/Shanghai." required>
              <Input value={timezone} onChange={e => setTrigger({ ...trigger, timezone: e.target.value })} />
            </Field>
          </div>
          {trigger.kind === 'cron' && (
            <Field label="Cron expression" help="Five-field cron syntax: minute hour day-of-month month day-of-week. Example: 0 9 * * 1-5 runs at 09:00 on weekdays." required>
              <Input value={trigger.cron} onChange={e => setTrigger({ ...trigger, cron: e.target.value })} placeholder="0 9 * * 1-5" />
            </Field>
          )}
          {trigger.kind === 'once' && (
            <Field label="Run at" help="The local date and time for a one-off run. The task disables itself after it fires." required>
              <Input
                type="datetime-local"
                value={new Date(trigger.runAt).toISOString().slice(0, 16)}
                onChange={e => setTrigger({ ...trigger, runAt: new Date(e.target.value).getTime() })}
              />
            </Field>
          )}
          {trigger.kind === 'interval' && (
            <Field label="Every" help="Fixed repeat interval in seconds. Use cron instead when you need calendar-aware timing." required>
              <div className="flex items-center gap-2">
                <Input
                  className="w-32"
                  type="number"
                  min={5}
                  value={Math.round(trigger.everyMs / 1000)}
                  onChange={e => setTrigger({ ...trigger, everyMs: Math.max(5, Number(e.target.value)) * 1000 })}
                />
                <span className="text-sm text-muted-foreground">seconds</span>
              </div>
            </Field>
          )}
        </FormSection>

        <FormSection title="Instructions">
          <Field
            label="Prompt"
            help="The exact instruction sent to the agent each time the task runs. Include expected output, constraints, and any files or commands it should inspect."
            required
          >
            <Textarea rows={6} value={prompt} onChange={e => setPrompt(e.target.value)} />
          </Field>
          <Field
            label="System prompt"
            help="Optional persistent behavior override for this task. Leave empty unless the task needs a special operating style."
          >
            <Textarea rows={3} value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} />
          </Field>
        </FormSection>

        <FormSection title="Run controls">
          <Field
            label="Skip permissions"
            help="Required for unattended runs. If disabled, a task can pause forever waiting for approval and will eventually time out."
          >
            <div className="flex items-center gap-3">
              <Switch checked={skipPermissions} onCheckedChange={setSkipPermissions} />
              <span className={cn("text-xs", skipPermissions ? "text-muted-foreground" : "text-amber-600")}>
                {skipPermissions ? 'Unattended tool calls are allowed.' : 'Tool approval prompts will time out unattended.'}
              </span>
            </div>
          </Field>
          <Field label="Enabled" help="Disabled tasks stay saved but will not auto-run. You can still edit or delete them.">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </Field>
          <details className="rounded-md border bg-muted/20 p-3">
            <summary className="cursor-pointer text-sm font-medium">Advanced timeouts and limits</summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field label="Max turns" help="Stops the agent after this many assistant turns to prevent runaway loops.">
                <Input type="number" min={1} value={maxTurns} onChange={e => setMaxTurns(Number(e.target.value))} />
              </Field>
              <Field label="Tool timeout" help="Maximum seconds a single tool call may run before the scheduler marks it as timed out.">
                <Input type="number" min={1} value={toolTimeoutSeconds} onChange={e => setToolTimeoutSeconds(Number(e.target.value))} />
              </Field>
              <Field label="Wall-clock timeout" help="Maximum seconds for the whole run, including model time and tool time.">
                <Input type="number" min={1} value={wallClockTimeoutSeconds} onChange={e => setWallClockTimeoutSeconds(Number(e.target.value))} />
              </Field>
            </div>
          </details>
        </FormSection>

        <div className="rounded-md border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
          Scheduled runs create normal chat sessions under the selected project. Use the run history to jump to output. For reliable unattended work, keep prompts explicit, set a wall-clock limit, and leave skip permissions enabled only for repositories where automated edits are acceptable.
        </div>
      </div>

      <div className="sticky bottom-0 -mx-1 flex flex-col-reverse gap-2 border-t bg-background/95 px-1 pt-4 pb-1 backdrop-blur sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={submitting || !canSubmit}>
          {submitting ? 'Saving...' : submitLabel}
        </Button>
      </div>
    </div>
  );
}

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-md border p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Field({
  label,
  help,
  required,
  children,
}: {
  label: string;
  help: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Label className="text-sm">
          {label}
          {required && <span className="text-destructive">*</span>}
        </Label>
        <FieldHelp>{help}</FieldHelp>
      </div>
      {children}
    </div>
  );
}

function FieldHelp({ children }: { children: ReactNode }) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/55 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Show field help"
        >
          <HugeiconsIcon icon={HelpCircleIcon} className="h-3.5 w-3.5" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 w-72 rounded-md border bg-popover p-3 text-xs leading-relaxed text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
        >
          {children}
          <PopoverPrimitive.Arrow className="fill-border" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
