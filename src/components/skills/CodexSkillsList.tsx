'use client';

import { useCallback, useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
        {state.skills.map((s) => (
          <li key={s.path}>
            <button
              type="button"
              onClick={() => setSelected(s)}
              className="flex w-full flex-col items-start gap-1 rounded-md border border-transparent px-3 py-2 text-left hover:border-border hover:bg-muted/50"
            >
              <div className="flex w-full items-center gap-2">
                <span className="font-medium">{s.displayName || s.name}</span>
                <Badge variant="secondary" className="text-xs">
                  {s.scope}
                </Badge>
              </div>
              {s.description && (
                <span className="text-xs text-muted-foreground line-clamp-2">
                  {s.description}
                </span>
              )}
            </button>
          </li>
        ))}
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
                  <span className="text-xs text-muted-foreground">read-only</span>
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
