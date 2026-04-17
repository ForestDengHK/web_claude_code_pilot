'use client';

import { useCallback, useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { HugeiconsIcon } from '@hugeicons/react';
import { Loading02Icon } from '@hugeicons/core-free-icons';
import { SkillEditor } from './SkillEditor';
import { CreateSkillDialog } from './CreateSkillDialog';
import type { SkillItem } from './SkillListItem';

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

interface CodexSkillDetail extends CodexSkill {
  content: string;
  dir: string;
  symlinkInfo?: { target: string; claudeOwned: boolean };
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
  const [showCreate, setShowCreate] = useState(false);

  const [detail, setDetail] = useState<CodexSkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

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
    load();
  }, [load]);

  // Fetch full detail when a skill is selected
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    setDetailLoading(true);
    setDetail(null);
    setDetailError(null);
    fetch(`/api/codex/skills/${encodeURIComponent(selected.name)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { skill: CodexSkillDetail }) => setDetail(d.skill))
      .catch((e: Error) => setDetailError(e.message))
      .finally(() => setDetailLoading(false));
  }, [selected]);

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

  const handleCreate = useCallback(
    async (name: string, _scope: string, content: string) => {
      const res = await fetch('/api/codex/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      load();
    },
    [load],
  );

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

  const codexScopeOptions = [
    {
      value: 'user',
      label: 'User',
      description: 'Saved in ~/.codex/skills/ (available everywhere)',
    },
  ];

  if (state.kind === 'empty') {
    return (
      <>
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <p>No Codex skills installed.</p>
          <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
            + New skill
          </Button>
          <a
            href="https://developers.openai.com/codex/skills"
            target="_blank"
            rel="noreferrer"
            className="text-xs underline"
          >
            Learn about Codex skills
          </a>
        </div>
        <CreateSkillDialog
          open={showCreate}
          onOpenChange={setShowCreate}
          onCreate={handleCreate}
          title="Create Codex skill"
          description="A new skill will be created as ~/.codex/skills/<name>/SKILL.md."
          scopeOptions={codexScopeOptions}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex h-full flex-col">
        <div className="mb-2 flex items-center justify-end px-1">
          <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
            + New
          </Button>
        </div>
        <ul className="flex flex-1 flex-col gap-1 overflow-y-auto">
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
      </div>

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-2xl p-0 flex flex-col">
          {/* Always-present header satisfies radix Dialog's accessibility
              requirement that every DialogContent include a DialogTitle. */}
          <SheetHeader className="px-4 pt-4 pb-2 border-b border-border">
            <SheetTitle className="text-base">
              {detail?.displayName ||
                detail?.name ||
                selected?.displayName ||
                selected?.name ||
                'Skill'}
            </SheetTitle>
            {detail && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Badge variant="secondary" className="text-xs">
                  {detail.scope}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {detail.enabled ? 'enabled' : 'disabled'}
                  {detail.scope === 'system' || detail.scope === 'admin'
                    ? ' · read-only'
                    : ''}
                </span>
              </div>
            )}
          </SheetHeader>

          {detailLoading && (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          )}
          {detailError && (
            <div className="p-6 text-sm text-destructive">
              Failed to load: {detailError}
            </div>
          )}
          {detail && (
            <DetailView
              detail={detail}
              onClose={() => setSelected(null)}
              onChange={load}
            />
          )}
        </SheetContent>
      </Sheet>

      <CreateSkillDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreate={handleCreate}
        title="Create Codex skill"
        description="A new skill will be created as ~/.codex/skills/<name>/SKILL.md."
        scopeOptions={codexScopeOptions}
      />
    </>
  );
}

function DetailView({
  detail,
  onClose,
  onChange,
}: {
  detail: CodexSkillDetail;
  onClose: () => void;
  onChange: () => void;
}) {
  const readOnly = detail.scope === 'system' || detail.scope === 'admin';
  const sym = detail.symlinkInfo;
  const claudeOwned = sym?.claudeOwned === true;

  const skillItem: SkillItem = {
    name: detail.name,
    description: detail.description,
    content: detail.content,
    source: 'codex',
    filePath: detail.path,
  };

  const handleSave = async (_: SkillItem, content: string) => {
    const res = await fetch(`/api/codex/skills/${encodeURIComponent(detail.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    onChange();
  };

  const handleDelete = async () => {
    if (!confirm(`Delete skill "${detail.name}"?`)) return;
    const res = await fetch(`/api/codex/skills/${encodeURIComponent(detail.name)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      onClose();
      onChange();
    } else {
      const body = await res.json().catch(() => ({}));
      alert(`Failed to delete: ${body.error || res.status}`);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header is rendered by the parent SheetContent so it's always present
          (radix DialogTitle accessibility requirement). */}

      {/* Symlink banners */}
      {claudeOwned && (
        <div className="mx-4 mt-3 rounded-md border border-blue-500/40 bg-blue-500/5 p-3 text-xs">
          <p className="font-medium text-blue-700 dark:text-blue-300">
            Claude-owned symlink
          </p>
          <p className="mt-1 text-muted-foreground break-all">
            Target: {sym!.target}
          </p>
          <p className="mt-1">
            Editing this skill on the Codex side would quietly mutate the Claude
            original. Use the Claude tab instead.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => {
              window.location.href = `/extensions?tab=skills&provider=claude&skill=${encodeURIComponent(detail.name)}`;
            }}
          >
            Edit in Claude tab →
          </Button>
        </div>
      )}
      {sym && !claudeOwned && (
        <div className="mx-4 mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <p className="font-medium text-amber-700 dark:text-amber-300">
            Shared symlink
          </p>
          <p className="mt-1 text-muted-foreground break-all">
            Target: {sym.target}
          </p>
          <p className="mt-1">
            This file is used by other tools as well. Edits affect all of them.
          </p>
        </div>
      )}

      {/* Reused editor */}
      <div className="flex-1 min-h-0">
        <SkillEditor
          skill={skillItem}
          onSave={readOnly || claudeOwned ? undefined : handleSave}
          onDelete={readOnly || claudeOwned ? undefined : handleDelete}
        />
      </div>
    </div>
  );
}
