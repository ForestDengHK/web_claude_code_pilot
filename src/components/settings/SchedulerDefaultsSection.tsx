"use client";
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_TOOL_TIMEOUT_SECONDS,
  DEFAULT_WALL_CLOCK_TIMEOUT_SECONDS,
} from '@/lib/scheduler/types';

const KEY = 'scheduler_defaults';

interface Defaults {
  maxTurns: number;
  toolTimeoutSeconds: number;
  wallClockTimeoutSeconds: number;
}

export function SchedulerDefaultsSection() {
  const [d, setD] = useState<Defaults>({
    maxTurns: DEFAULT_MAX_TURNS,
    toolTimeoutSeconds: DEFAULT_TOOL_TIMEOUT_SECONDS,
    wallClockTimeoutSeconds: DEFAULT_WALL_CLOCK_TIMEOUT_SECONDS,
  });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    void fetch('/api/settings/app')
      .then(r => r.json())
      .then(j => {
        const raw = j?.settings?.[KEY];
        if (typeof raw === 'string' && raw) {
          try {
            const parsed = JSON.parse(raw) as Partial<Defaults>;
            setD(prev => ({
              maxTurns: Number.isFinite(parsed.maxTurns) ? Number(parsed.maxTurns) : prev.maxTurns,
              toolTimeoutSeconds: Number.isFinite(parsed.toolTimeoutSeconds) ? Number(parsed.toolTimeoutSeconds) : prev.toolTimeoutSeconds,
              wallClockTimeoutSeconds: Number.isFinite(parsed.wallClockTimeoutSeconds) ? Number(parsed.wallClockTimeoutSeconds) : prev.wallClockTimeoutSeconds,
            }));
          } catch {
            /* ignore malformed value */
          }
        }
      })
      .catch(() => { /* silent */ });
  }, []);

  async function save() {
    setSaving(true);
    try {
      await fetch('/api/settings/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { [KEY]: JSON.stringify(d) } }),
      });
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 max-w-md">
      <div>
        <h2 className="text-lg font-medium">Scheduler defaults</h2>
        <p className="text-sm text-muted-foreground">
          These values pre-fill new task forms. They do not change existing tasks.
        </p>
      </div>
      <Field label="Max turns">
        <Input
          type="number"
          value={d.maxTurns}
          onChange={e => setD({ ...d, maxTurns: Number(e.target.value) })}
        />
      </Field>
      <Field label="Per-tool timeout (seconds)">
        <Input
          type="number"
          value={d.toolTimeoutSeconds}
          onChange={e => setD({ ...d, toolTimeoutSeconds: Number(e.target.value) })}
        />
      </Field>
      <Field label="Wall-clock timeout (seconds)">
        <Input
          type="number"
          value={d.wallClockTimeoutSeconds}
          onChange={e => setD({ ...d, wallClockTimeoutSeconds: Number(e.target.value) })}
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {savedAt && !saving && (
          <span className="text-xs text-muted-foreground">Saved.</span>
        )}
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
