'use client';

import { useCallback, useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { HugeiconsIcon } from '@hugeicons/react';
import { Loading02Icon } from '@hugeicons/core-free-icons';

interface CodexSkill {
  name: string;
  description: string;
  path: string;
  scope: 'user' | 'repo' | 'system' | 'admin';
  enabled: boolean;
  displayName?: string;
  brandColor?: string;
  iconSmall?: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; skills: CodexSkill[] }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

export function CodexSkillsList() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [selected, setSelected] = useState<CodexSkill | null>(null);
  const [pendingToggle, setPendingToggle] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/codex/skills', { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        setState({ kind: 'error', message: body || `HTTP ${res.status}` });
        return;
      }
      const data = (await res.json()) as { skills?: CodexSkill[] };
      const skills = data.skills ?? [];
      if (skills.length === 0) {
        setState({ kind: 'empty' });
      } else {
        setState({ kind: 'ok', skills });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error';
      setState({ kind: 'error', message });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleToggle = useCallback(async (skill: CodexSkill, next: boolean) => {
    const key = skill.path;
    setPendingToggle((prev) => new Set(prev).add(key));

    // Optimistic update
    setState((prev) => {
      if (prev.kind !== 'ok') return prev;
      return {
        kind: 'ok',
        skills: prev.skills.map((s) =>
          s.path === skill.path ? { ...s, enabled: next } : s,
        ),
      };
    });

    try {
      const res = await fetch(`/api/codex/skills/${encodeURIComponent(skill.name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { effectiveEnabled: boolean };
      // Reconcile with server truth (normally same as `next`)
      if (data.effectiveEnabled !== next) {
        setState((prev) => {
          if (prev.kind !== 'ok') return prev;
          return {
            kind: 'ok',
            skills: prev.skills.map((s) =>
              s.path === skill.path ? { ...s, enabled: data.effectiveEnabled } : s,
            ),
          };
        });
      }
    } catch {
      // Rollback
      setState((prev) => {
        if (prev.kind !== 'ok') return prev;
        return {
          kind: 'ok',
          skills: prev.skills.map((s) =>
            s.path === skill.path ? { ...s, enabled: !next } : s,
          ),
        };
      });
    } finally {
      setPendingToggle((prev) => {
        const nextSet = new Set(prev);
        nextSet.delete(key);
        return nextSet;
      });
    }
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <HugeiconsIcon
          icon={Loading02Icon}
          className="h-5 w-5 animate-spin text-muted-foreground"
        />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm">
        <p className="text-destructive">Failed to load Codex skills.</p>
        <p className="text-muted-foreground text-xs max-w-md text-center break-words">
          {state.message}
        </p>
        <Button onClick={load} variant="outline" size="sm">
          Retry
        </Button>
      </div>
    );
  }

  if (state.kind === 'empty') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <p>No Codex skills installed.</p>
        <a
          href="https://developers.openai.com/codex/skills"
          target="_blank"
          rel="noreferrer"
          className="text-xs underline"
        >
          Learn about Codex skills
        </a>
      </div>
    );
  }

  return (
    <>
      <ul className="flex h-full flex-col gap-1 overflow-y-auto">
        {state.skills.map((s) => {
          const readOnly = s.scope === 'system' || s.scope === 'admin';
          const rowMuted = !s.enabled;
          return (
            <li key={s.path} className="flex items-start gap-2 px-3 py-2 rounded-md border border-transparent hover:border-border hover:bg-muted/50">
              <button
                type="button"
                onClick={() => setSelected(s)}
                className={`flex flex-1 flex-col items-start gap-1 text-left min-w-0 ${rowMuted ? 'opacity-50' : ''}`}
              >
                <div className="flex w-full items-center gap-2">
                  <span className="font-medium truncate">{s.displayName || s.name}</span>
                  <Badge variant="secondary" className="text-xs shrink-0">
                    {s.scope}
                  </Badge>
                </div>
                {s.description && (
                  <span className="text-xs text-muted-foreground line-clamp-2">
                    {s.description}
                  </span>
                )}
              </button>
              <div className="flex items-center pt-1 shrink-0" title={readOnly ? 'Codex system skills are read-only' : undefined}>
                <Switch
                  checked={s.enabled}
                  disabled={readOnly || pendingToggle.has(s.path)}
                  onCheckedChange={(next) => handleToggle(s, next)}
                  aria-label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`}
                />
              </div>
            </li>
          );
        })}
      </ul>

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-lg">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.displayName || selected.name}</SheetTitle>
              </SheetHeader>
              <div className="mt-4 flex flex-col gap-3 px-4 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{selected.scope}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {selected.enabled ? 'enabled' : 'disabled'}
                    {(selected.scope === 'system' || selected.scope === 'admin') ? ' · read-only' : ''}
                  </span>
                </div>
                {selected.description && (
                  <p className="text-muted-foreground">{selected.description}</p>
                )}
                <div className="mt-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Path
                  </p>
                  <p className="mt-1 break-all font-mono text-xs">{selected.path}</p>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
