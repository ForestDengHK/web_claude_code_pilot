# Codex Skills Parity Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Codex skills into the `/extensions` UI as a read-only tab, under a provider-registry architecture extensible to future backends, with zero impact on existing Claude code paths.

**Architecture:** Pure-logic `types.ts` + `filter.ts` unit (testable). React provider definitions in `.tsx` files registered in an `index.ts` array. A `ProviderSkillsTabs` component consumes the registry, renders inner tabs, and isolates failures per tab via Error Boundaries. The existing `/extensions` page swaps `<SkillsManager />` for `<ProviderSkillsTabs />` — one-line change.

**Tech Stack:** Next.js 15 (App Router, standalone), React, TypeScript, radix-ui primitives (already in `src/components/ui/*`), `node:test` + `node:assert/strict` run via `npx tsx --test`.

**Reference spec:** `docs/superpowers/specs/2026-04-17-codex-skills-parity-design.md`

---

## File Structure

**Create (pure logic — unit-tested)**
- `src/lib/skill-providers/types.ts` — `UnifiedSkill`, `SkillCapabilities`, `SkillProvider`
- `src/lib/skill-providers/filter.ts` — `resolveAvailableProviders(providers)`; pure fn, never throws
- `src/lib/__tests__/skill-providers-filter.test.ts`

**Create (React — manual-tested)**
- `src/lib/skill-providers/claude.tsx` — thin wrapper around existing `SkillsManager`
- `src/lib/skill-providers/codex.tsx` — new provider; probes `/api/codex/skills?probe=1`
- `src/lib/skill-providers/index.ts` — exports `SKILL_PROVIDERS` array + `useAvailableSkillProviders()` hook
- `src/components/skills/CodexSkillsList.tsx` — read-only list + detail sheet
- `src/components/skills/ProviderSkillsTabs.tsx` — consumes registry + per-panel Error Boundary

**Modify (minimal)**
- `src/app/api/codex/skills/route.ts` — add `?probe=1` fast-path (no process spawn)
- `src/app/extensions/page.tsx` — replace `<SkillsManager />` with `<ProviderSkillsTabs />` inside the `skills` tab body

**Must NOT modify**
- `src/components/skills/SkillsManager.tsx`, `SkillEditor.tsx`, `CreateSkillDialog.tsx`, `SkillListItem.tsx`
- `src/app/api/skills/**` (any file)
- `src/components/chat/MessageInput.tsx`
- `src/app/api/plugins/**`, `src/components/plugins/**`
- MCP tab and Plugins tab of `extensions/page.tsx`

---

## Task 1: Types + pure filter utility (TDD)

**Files:**
- Create: `src/lib/skill-providers/types.ts`
- Create: `src/lib/skill-providers/filter.ts`
- Test:   `src/lib/__tests__/skill-providers-filter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/skill-providers-filter.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAvailableProviders } from '../skill-providers/filter';
import type { SkillProvider } from '../skill-providers/types';

function make(
  id: string,
  isAvailable: SkillProvider['isAvailable'],
): SkillProvider {
  return {
    id,
    label: id,
    capabilities: { read: true, enableToggle: false, edit: false, create: false },
    isAvailable,
    // ListComponent is not exercised by filter; a no-op placeholder is fine
    ListComponent: (() => null) as unknown as SkillProvider['ListComponent'],
  };
}

describe('resolveAvailableProviders', () => {
  it('returns an empty array when given no providers', async () => {
    const out = await resolveAvailableProviders([]);
    assert.deepEqual(out, []);
  });

  it('includes providers whose isAvailable resolves to true', async () => {
    const a = make('a', async () => true);
    const b = make('b', async () => true);
    const out = await resolveAvailableProviders([a, b]);
    assert.deepEqual(out.map((p) => p.id), ['a', 'b']);
  });

  it('excludes providers whose isAvailable resolves to false', async () => {
    const a = make('a', async () => true);
    const b = make('b', async () => false);
    const out = await resolveAvailableProviders([a, b]);
    assert.deepEqual(out.map((p) => p.id), ['a']);
  });

  it('coerces thrown exceptions to unavailable', async () => {
    const a = make('a', async () => true);
    const b = make('b', async () => { throw new Error('boom'); });
    const out = await resolveAvailableProviders([a, b]);
    assert.deepEqual(out.map((p) => p.id), ['a']);
  });

  it('preserves input order', async () => {
    const providers = ['x', 'y', 'z'].map((id) => make(id, async () => true));
    const out = await resolveAvailableProviders(providers);
    assert.deepEqual(out.map((p) => p.id), ['x', 'y', 'z']);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx tsx --test src/lib/__tests__/skill-providers-filter.test.ts`
Expected: failure with `ERR_MODULE_NOT_FOUND` (filter.ts doesn't exist yet).

- [ ] **Step 3: Create the types file**

Create `src/lib/skill-providers/types.ts`:

```ts
import type { ComponentType, ReactNode } from 'react';

/**
 * Minimal common shape across backends. Backend-specific fields
 * (e.g. Codex brandColor, scope) live inside each provider's
 * ListComponent and are not part of this unified type.
 */
export interface UnifiedSkill {
  /** Stable within a provider (e.g. Codex path, Claude name). */
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface SkillCapabilities {
  read: boolean;
  /** Phase 2 (not implemented yet). */
  enableToggle: boolean;
  /** Phase 3 (not implemented yet). */
  edit: boolean;
  /** Phase 3 (not implemented yet). */
  create: boolean;
}

export interface SkillProvider {
  id: string;
  label: string;
  icon?: ReactNode;
  capabilities: SkillCapabilities;
  /**
   * Probe — resolves to `true` when the provider can be used.
   * Must never throw; implementations should catch all errors internally.
   * Callers (see filter.ts) coerce throws to `false` as a safety net.
   */
  isAvailable: () => Promise<boolean>;
  /** Owns its own fetching, rendering, and error handling. */
  ListComponent: ComponentType;
}
```

- [ ] **Step 4: Create the filter utility**

Create `src/lib/skill-providers/filter.ts`:

```ts
import type { SkillProvider } from './types';

/**
 * Probes each provider's `isAvailable()` in parallel and returns
 * the subset that reported true. Throws from `isAvailable` are
 * treated as unavailable — the function itself never throws.
 * Input order is preserved.
 */
export async function resolveAvailableProviders(
  providers: readonly SkillProvider[],
): Promise<SkillProvider[]> {
  const flags = await Promise.all(
    providers.map(async (p) => {
      try {
        return await p.isAvailable();
      } catch {
        return false;
      }
    }),
  );
  return providers.filter((_, i) => flags[i]);
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx tsx --test src/lib/__tests__/skill-providers-filter.test.ts`
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/skill-providers/types.ts \
        src/lib/skill-providers/filter.ts \
        src/lib/__tests__/skill-providers-filter.test.ts
git commit -m "feat(skill-providers): add registry types and availability filter

Pure-logic scaffolding for the provider-registry architecture. No
React yet; just the types and a filter function that probes each
provider's isAvailable() in parallel and returns the available
subset. Throws are coerced to unavailable.

Part of Codex skills parity, Phase 1."
```

---

## Task 2: Probe endpoint fast-path (TDD-lite via extraction)

**Files:**
- Create: `src/lib/codex-availability.ts`
- Test:   `src/lib/__tests__/codex-availability.test.ts`
- Modify: `src/app/api/codex/skills/route.ts` (additive branch only)

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/codex-availability.test.ts`:

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isCodexAvailable, __resetCodexAvailabilityCache } from '../codex-availability';

describe('isCodexAvailable', () => {
  beforeEach(() => {
    __resetCodexAvailabilityCache();
  });

  it('returns true when the probe command resolves', () => {
    const probe = () => '/fake/path/codex\n';
    assert.equal(isCodexAvailable(probe), true);
  });

  it('returns false when the probe command throws', () => {
    const probe = () => { throw new Error('not found'); };
    assert.equal(isCodexAvailable(probe), false);
  });

  it('caches the result across calls within the TTL', () => {
    let calls = 0;
    const probe = () => { calls += 1; return '/x'; };
    isCodexAvailable(probe);
    isCodexAvailable(probe);
    isCodexAvailable(probe);
    assert.equal(calls, 1);
  });

  it('re-probes after the cache is reset', () => {
    let calls = 0;
    const probe = () => { calls += 1; return '/x'; };
    isCodexAvailable(probe);
    __resetCodexAvailabilityCache();
    isCodexAvailable(probe);
    assert.equal(calls, 2);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx tsx --test src/lib/__tests__/codex-availability.test.ts`
Expected: `ERR_MODULE_NOT_FOUND` (codex-availability.ts missing).

- [ ] **Step 3: Implement the availability module**

Create `src/lib/codex-availability.ts`:

```ts
import { execFileSync } from 'node:child_process';

type Probe = () => string;

const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { value: boolean; at: number } | null = null;

const defaultProbe: Probe = () =>
  execFileSync('which', ['codex'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();

/**
 * Returns true when the `codex` binary is on PATH. Cached for 5 minutes
 * per-process to avoid repeated shell-outs. `probe` is injectable for
 * tests; production callers should omit it.
 */
export function isCodexAvailable(probe: Probe = defaultProbe): boolean {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  let value: boolean;
  try {
    const out = probe();
    value = typeof out === 'string' && out.trim().length > 0;
  } catch {
    value = false;
  }
  cached = { value, at: Date.now() };
  return value;
}

/** Test-only helper. Do not call from production code. */
export function __resetCodexAvailabilityCache(): void {
  cached = null;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx tsx --test src/lib/__tests__/codex-availability.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Wire the probe fast-path into the route**

Modify `src/app/api/codex/skills/route.ts`. Find the `GET` handler (around line 137) and add an early branch *before* the cached-skills check. The existing handler body stays unchanged otherwise.

Insert this import near the top of the file (keep alphabetical import order):

```ts
import { isCodexAvailable } from '@/lib/codex-availability';
```

Replace the current first lines of `GET` (the `const cwd = ...` line and below) with:

```ts
export async function GET(request: NextRequest) {
  // Fast path: availability probe for the extensions UI. Does not spawn
  // a Codex process and does not touch the skills cache.
  if (request.nextUrl.searchParams.get('probe') === '1') {
    return Response.json({ available: isCodexAvailable() });
  }

  const cwd = request.nextUrl.searchParams.get('cwd') || undefined;

  // Return cached skills if fresh
  if (cachedSkills && Date.now() - cachedAt < CACHE_TTL) {
    return Response.json({ skills: cachedSkills });
  }
  // ... rest of existing handler unchanged ...
```

- [ ] **Step 6: Smoke-test the route manually**

With the dev server running on port 4000:

```bash
curl -s 'http://localhost:4000/api/codex/skills?probe=1'
```
Expected (codex installed): `{"available":true}`
Expected (codex not on PATH): `{"available":false}` (returns quickly, under ~50ms either way).

Also confirm the non-probe path still works:

```bash
curl -s 'http://localhost:4000/api/codex/skills' | head -c 200
```
Expected: a JSON object with a `skills` array. No regression.

- [ ] **Step 7: Commit**

```bash
git add src/lib/codex-availability.ts \
        src/lib/__tests__/codex-availability.test.ts \
        src/app/api/codex/skills/route.ts
git commit -m "feat(codex): add codex availability probe endpoint

Adds a cached \`isCodexAvailable\` helper and a \`?probe=1\` fast-path
on /api/codex/skills that returns {available: boolean} without
spawning a Codex process. Used by the upcoming provider registry
to decide whether to render the Codex skills tab.

Part of Codex skills parity, Phase 1."
```

---

## Task 3: Claude provider (wrapper around existing SkillsManager)

**Files:**
- Create: `src/lib/skill-providers/claude.tsx`

- [ ] **Step 1: Create the provider file**

```tsx
import { SkillsManager } from '@/components/skills/SkillsManager';
import type { SkillProvider } from './types';

export const claudeSkillProvider: SkillProvider = {
  id: 'claude',
  label: 'Claude',
  capabilities: {
    read: true,
    enableToggle: true,
    edit: true,
    create: true,
  },
  // Claude is the default backend. Always available from the frontend
  // perspective — backend errors still surface inside SkillsManager.
  isAvailable: async () => true,
  ListComponent: SkillsManager,
};
```

- [ ] **Step 2: Sanity check — type-check locally**

Run: `npx tsc --noEmit`
Expected: no new TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/skill-providers/claude.tsx
git commit -m "feat(skill-providers): add Claude provider wrapping SkillsManager

Thin wrapper that registers the existing Claude SkillsManager as a
SkillProvider with full capabilities. Zero behavior change — this
provider is not yet rendered; that happens in a later task.

Part of Codex skills parity, Phase 1."
```

---

## Task 4: Codex provider (probe + placeholder ListComponent)

**Files:**
- Create: `src/lib/skill-providers/codex.tsx`
- Create: `src/lib/skill-providers/index.ts`

This task registers the Codex provider using a placeholder `ListComponent` so the registry wires up end-to-end. The real list component arrives in Task 5 and replaces the placeholder in that task's commit.

- [ ] **Step 1: Create the Codex provider with a placeholder list**

Create `src/lib/skill-providers/codex.tsx`:

```tsx
import type { SkillProvider } from './types';

// Placeholder — replaced by the real component in Task 5.
function CodexSkillsListPlaceholder() {
  return (
    <div className="p-6 text-sm text-muted-foreground">
      Codex skills list — implementation pending.
    </div>
  );
}

async function probeCodex(): Promise<boolean> {
  try {
    const res = await fetch('/api/codex/skills?probe=1', {
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { available?: boolean };
    return data.available === true;
  } catch {
    return false;
  }
}

export const codexSkillProvider: SkillProvider = {
  id: 'codex',
  label: 'Codex',
  capabilities: {
    read: true,
    enableToggle: false, // Phase 2
    edit: false,         // Phase 3
    create: false,       // Phase 3
  },
  isAvailable: probeCodex,
  ListComponent: CodexSkillsListPlaceholder,
};
```

- [ ] **Step 2: Create the registry index with a React hook**

Create `src/lib/skill-providers/index.ts`:

```ts
'use client';

import { useEffect, useState } from 'react';
import { claudeSkillProvider } from './claude';
import { codexSkillProvider } from './codex';
import { resolveAvailableProviders } from './filter';
import type { SkillProvider } from './types';

/**
 * Registry of all skill providers. Order determines tab order in the UI.
 * Add new backends by appending a provider here — no other file needs to change.
 */
export const SKILL_PROVIDERS: readonly SkillProvider[] = [
  claudeSkillProvider,
  codexSkillProvider,
];

export type { SkillProvider, UnifiedSkill, SkillCapabilities } from './types';

/**
 * React hook: returns the subset of providers that reported available.
 * Re-probes once on mount; does not poll.
 */
export function useAvailableSkillProviders(): {
  providers: SkillProvider[];
  loading: boolean;
} {
  const [state, setState] = useState<{ providers: SkillProvider[]; loading: boolean }>(
    { providers: [], loading: true },
  );

  useEffect(() => {
    let cancelled = false;
    resolveAvailableProviders(SKILL_PROVIDERS).then((providers) => {
      if (!cancelled) setState({ providers, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/skill-providers/codex.tsx src/lib/skill-providers/index.ts
git commit -m "feat(skill-providers): add Codex provider and registry index

Registers Codex as a read-only provider that probes availability via
/api/codex/skills?probe=1 (with error coercion). The list component
is a placeholder for now; the real list lands in the next commit.
The index exports SKILL_PROVIDERS and a useAvailableSkillProviders
hook consumed by the upcoming ProviderSkillsTabs component.

Part of Codex skills parity, Phase 1."
```

---

## Task 5: Codex skills list + read-only detail sheet

**Files:**
- Create: `src/components/skills/CodexSkillsList.tsx`
- Modify: `src/lib/skill-providers/codex.tsx` (replace placeholder)

- [ ] **Step 1: Create the list component**

Create `src/components/skills/CodexSkillsList.tsx`:

```tsx
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

async function fetchSkillContent(path: string): Promise<string> {
  // Codex skills live on disk at `path`. We read them via the existing
  // content endpoint if one exists; otherwise fall back to the path string.
  // Phase 1 displays the raw file path and description only — a full
  // content viewer is deferred to Phase 3 when edits land.
  return path;
}

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
      <ul className="flex flex-col gap-1 overflow-y-auto">
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
```

- [ ] **Step 2: Wire the real component into the Codex provider**

In `src/lib/skill-providers/codex.tsx`:

Replace these lines:

```tsx
// Placeholder — replaced by the real component in Task 5.
function CodexSkillsListPlaceholder() {
  return (
    <div className="p-6 text-sm text-muted-foreground">
      Codex skills list — implementation pending.
    </div>
  );
}
```

with:

```tsx
import { CodexSkillsList } from '@/components/skills/CodexSkillsList';
```

And change the last property of the exported provider:

```tsx
  ListComponent: CodexSkillsListPlaceholder,
```

to:

```tsx
  ListComponent: CodexSkillsList,
```

- [ ] **Step 3: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/skill-providers src/components/skills/CodexSkillsList.tsx`
Expected: clean exit.

- [ ] **Step 4: Commit**

```bash
git add src/components/skills/CodexSkillsList.tsx \
        src/lib/skill-providers/codex.tsx
git commit -m "feat(skill-providers): implement Codex skills read-only list

Fetches /api/codex/skills, handles loading/empty/error states with a
retry button, and opens a read-only Sheet with scope + path when a
row is selected. Replaces the placeholder ListComponent on the Codex
provider.

Part of Codex skills parity, Phase 1."
```

---

## Task 6: ProviderSkillsTabs + per-panel Error Boundary

**Files:**
- Create: `src/components/skills/ProviderSkillsTabs.tsx`

- [ ] **Step 1: Create the tabs component with inline Error Boundary**

```tsx
'use client';

import React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { HugeiconsIcon } from '@hugeicons/react';
import { Loading02Icon } from '@hugeicons/core-free-icons';
import {
  useAvailableSkillProviders,
  type SkillProvider,
} from '@/lib/skill-providers';

/**
 * Isolates rendering failures in one provider's list from other tabs.
 * Keeping this inline (rather than a generic ErrorBoundary export) makes
 * its single responsibility obvious.
 */
class ProviderErrorBoundary extends React.Component<
  { providerLabel: string; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm">
          <p className="text-destructive">
            The {this.props.providerLabel} skills panel crashed.
          </p>
          <p className="text-muted-foreground text-xs max-w-md text-center break-words">
            {this.state.error.message}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

function ProviderPanel({ provider }: { provider: SkillProvider }) {
  const ListComponent = provider.ListComponent;
  return (
    <ProviderErrorBoundary providerLabel={provider.label}>
      <ListComponent />
    </ProviderErrorBoundary>
  );
}

export function ProviderSkillsTabs() {
  const { providers, loading } = useAvailableSkillProviders();
  const [active, setActive] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!active && providers.length > 0) {
      setActive(providers[0].id);
    }
  }, [active, providers]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <HugeiconsIcon
          icon={Loading02Icon}
          className="h-5 w-5 animate-spin text-muted-foreground"
        />
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        No skill providers available.
      </div>
    );
  }

  return (
    <Tabs
      value={active ?? providers[0].id}
      onValueChange={setActive}
      className="flex h-full flex-col"
    >
      <TabsList className="w-fit">
        {providers.map((p) => (
          <TabsTrigger key={p.id} value={p.id} className="text-xs">
            {p.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {providers.map((p) => (
        <TabsContent
          key={p.id}
          value={p.id}
          className="flex-1 min-h-0 overflow-hidden mt-3"
        >
          <ProviderPanel provider={p} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/skills/ProviderSkillsTabs.tsx
git commit -m "feat(skill-providers): add ProviderSkillsTabs with error isolation

Consumes the skill-providers registry and renders one inner tab per
available provider. Each tab body is wrapped in a class-based Error
Boundary so a failure in one provider (e.g. a Codex render crash)
cannot take down the Claude tab.

Part of Codex skills parity, Phase 1."
```

---

## Task 7: Wire ProviderSkillsTabs into the Extensions page

**Files:**
- Modify: `src/app/extensions/page.tsx`

- [ ] **Step 1: Replace the Skills tab body**

In `src/app/extensions/page.tsx`, change the import block to add:

```tsx
import { ProviderSkillsTabs } from "@/components/skills/ProviderSkillsTabs";
```

Keep the existing `SkillsManager` import in place for now — it's still referenced indirectly through the Claude provider.

Find this line:

```tsx
        {tab === "skills" && <SkillsManager />}
```

Replace it with:

```tsx
        {tab === "skills" && <ProviderSkillsTabs />}
```

Remove the now-unused direct import of `SkillsManager` from this file only (it is still imported by `claudeSkillProvider`):

```tsx
import { SkillsManager } from "@/components/skills/SkillsManager";
```

Delete that line from `extensions/page.tsx`.

- [ ] **Step 2: Build to confirm nothing downstream broke**

Run: `npx tsc --noEmit && npx eslint src/app/extensions/page.tsx`
Expected: clean.

- [ ] **Step 3: Manually smoke-test on dev**

The dev service (launchd `com.codepilot.web`, port 4000) is running via HMR; do NOT restart it (project convention — HMR handles `src/` edits).

Open `http://localhost:4000/extensions` in a browser. Verify:
- Outer tabs visible: Skills / MCP Servers / Plugins
- Inside Skills: inner tabs with `Claude` and (if codex installed) `Codex`
- Click Claude → existing `SkillsManager` renders with all prior create/edit/delete controls intact
- Click Codex → list of Codex skills or friendly empty/error state

Do NOT proceed to commit if Claude tab regressed.

- [ ] **Step 4: Commit**

```bash
git add src/app/extensions/page.tsx
git commit -m "feat(extensions): render skill providers via ProviderSkillsTabs

The Skills tab now delegates to the provider registry. Claude
continues to render through its existing SkillsManager (now wrapped
as a provider); Codex appears as a new read-only inner tab when the
codex CLI is on PATH. MCP and Plugins tabs are unchanged.

Part of Codex skills parity, Phase 1."
```

---

## Task 8: Manual regression verification (gates Phase 1 DoD)

No code. Do not commit anything in this task. Record results in a note; if anything fails, open a follow-up task and **do not** proceed to Task 9.

- [ ] **Step 1: Run the automated unit tests**

Run:

```bash
npx tsx --test src/lib/__tests__/skill-providers-filter.test.ts \
              src/lib/__tests__/codex-availability.test.ts
```
Expected: 9 tests pass, 0 fail.

- [ ] **Step 2: Verify the non-modified guard**

Run:

```bash
git diff --stat main -- \
  src/components/skills/SkillsManager.tsx \
  src/components/skills/SkillEditor.tsx \
  src/components/skills/CreateSkillDialog.tsx \
  src/components/skills/SkillListItem.tsx \
  src/app/api/skills \
  src/components/chat/MessageInput.tsx \
  src/app/api/plugins \
  src/components/plugins
```
Expected: **empty output** (no files in the Must-NOT-Modify list were changed).

- [ ] **Step 3: Dev-mode functional checks (port 4000)**

With Codex CLI present on PATH:

1. `/extensions` → Skills tab → both inner tabs visible
2. Codex tab list count matches `codex skills list`
3. Click a Codex skill → read-only Sheet opens with scope + path; no edit/delete/save buttons
4. Claude tab: create a new skill, edit it, delete it — all succeed
5. MCP Servers tab and Plugins tab: unchanged behavior
6. In a chat: `/` autocomplete still shows both Claude and Codex skills

- [ ] **Step 4: Codex-absent check (port 4000)**

Temporarily break PATH for the dev server by setting an env that hides codex, OR rename the binary (remember to restore). Restart just the dev service (launchd ID `com.codepilot.web`) — because env changes require a restart:

```bash
lsof -ti :4000 | xargs kill -9
launchctl kickstart -k gui/$(id -u)/com.codepilot.web
```
(Kill only port 4000 per project convention.)

Reload `/extensions`:
- Codex inner tab is NOT rendered
- Claude inner tab renders normally
- No red screens, no console errors other than the expected probe failure

Restore PATH / binary when done; restart the dev service the same way.

- [ ] **Step 5: Error-injection check (port 4000)**

In the browser devtools Network panel, block `/api/codex/skills` (non-probe) or throttle it to fail. Reload `/extensions`:
- Codex tab still renders (because probe succeeded)
- Inside Codex tab: error card with message and [Retry] button
- Claude tab unaffected

- [ ] **Step 6: Production mode check (port 4001)**

Rebuild and deploy production per project convention:

```bash
./scripts/rebuild-production.sh
```

Open `https://ccpilot.swifttools.eu/extensions` (or the local proxy). Repeat Step 3 checks. All must pass on production too.

- [ ] **Step 7: Mobile check**

On a real phone over Tailscale, open `/extensions`:
- Inner tabs readable (not wrapping badly)
- Codex list scrolls
- Detail Sheet fits viewport

- [ ] **Step 8: Record the result**

If any check failed: stop here, file a follow-up issue/task, do not start Task 9.

If all passed: write a one-line note to yourself (not committed) confirming the Phase 1 DoD is met, and proceed to Task 9.

---

## Task 9: Phase 2/3 feasibility POC (decision gate)

No code change. Target: 45 minutes. Produce a written decision at the end.

- [ ] **Step 1: Inspect the Codex skills filesystem**

Run:

```bash
ls -la ~/.codex/skills/ 2>/dev/null | head -20
find ~/.codex/skills -maxdepth 3 -type f 2>/dev/null | head -20
```

Record:
- Are skills single `.md` files or directories containing `SKILL.md`?
- Is there a `plugin.json` or manifest alongside?
- Which scopes map to which paths (`user` = `~/.codex/skills/user/`? etc.)?

- [ ] **Step 2: Test direct filesystem write**

Pick one `user`-scope skill (NOT `system`/`admin`). Back it up, edit one line, save. Start a fresh Codex chat in CodePilot. Ask Codex to list its skills or run that skill.

Record:
- Did Codex pick up the edit without a restart? (Yes / No)
- If No: did killing the `TEMP_SESSION_ID` Codex process (via `CodexProcessManager.kill`) force a reload?

Restore the backup when done.

- [ ] **Step 3: Check for a skills/refresh RPC**

Run:

```bash
codex --help 2>&1 | grep -i -E 'skill|refresh|reload' | head -10
```

And grep the Codex 0.121 changelog for `skills/refresh` or similar. Record what's available.

- [ ] **Step 4: Confirm scope boundaries**

Check whether `~/.codex/skills/system/` and `~/.codex/skills/admin/` (or equivalent) are user-writable. They should not be — confirm this.

- [ ] **Step 5: Write the decision**

Append a new dated section to `lessons-learned.md` (or the equivalent project-memory file) with one of:

- **Green**: "Writes work, cache reliably refreshes. Safe to proceed with Phase 2/3. [Details]"
- **Yellow**: "Writes work, but require a manual reload. Phase 2/3 OK with a Reload Skills button. [Details]"
- **Red**: "Write path blocked by [specific reason]. Phase 2/3 unsafe; revisit when Codex exposes [specific primitive]. [Details]"

- [ ] **Step 6: Commit the decision record**

```bash
git add lessons-learned.md
git commit -m "docs(lessons): record Codex skills Phase 2/3 feasibility POC

Outcome: [Green|Yellow|Red]. Details inline."
```

- [ ] **Step 7: Hand off**

Report the decision to the user. Do **not** start writing a Phase 2/3 spec automatically — the user decides whether to continue based on the POC result, per the brainstorming agreement ("做完1的话, 评估一下2和3, 它们的功能是不是可行?").

---

## Self-Review (filled in by the planner)

**Spec coverage:** Every spec section maps to a task.
- Architecture → Tasks 1, 4, 6
- Files table (new/modified/unchanged) → Tasks 1-7; Task 8 Step 2 asserts the unchanged list
- Data flow → Tasks 4 (probe), 5 (list), 6 (tabs)
- Error handling → Task 4 (probe coercion), Task 5 (fetch states + retry), Task 6 (Error Boundary), Task 8 (manual error injection)
- Mobile considerations → Task 8 Step 7
- Testing strategy: automated → Tasks 1, 2; manual → Task 8
- Phase 1 DoD → Task 8
- Post-Phase-1 POC → Task 9

**Placeholder scan:** No "TBD", "TODO", or "implement later" in task steps. All code blocks are complete. Error-message text is literal. Commit messages are final.

**Type consistency:** `CodexSkill` interface in Task 5 matches the shape produced by `/api/codex/skills` (confirmed by reading `src/app/api/codex/skills/route.ts` line 22-32 during design). `SkillProvider` shape is identical across Tasks 1, 3, 4, 6. `resolveAvailableProviders` signature matches the test in Task 1 and the hook in Task 4.
