'use client';

import { useState, useRef, useCallback } from 'react';
import { toast } from 'sonner';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SyncStatus =
  | 'idle'
  | 'loading'
  | 'success'      // maps from API's 'pulled' response
  | 'up-to-date'
  | 'dirty'
  | 'error'
  | 'not-git';

export interface SyncState {
  status: SyncStatus;
  message?: string;
}

export interface UseGitSyncReturn {
  /** Per-project sync state; key = working_directory path */
  syncStates: Map<string, SyncState>;
  /** Pull a single project and show an individual toast */
  pullProject: (dir: string, displayName: string) => Promise<void>;
  /** Pull all projects concurrently and show one summary toast */
  pullAll: (projects: Array<{ dir: string; displayName: string }>) => Promise<void>;
  /** True while any project is loading — use to disable Pull All button */
  isAnyLoading: boolean;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useGitSync(): UseGitSyncReturn {
  const [syncStates, setSyncStates] = useState<Map<string, SyncState>>(new Map());
  // Tracks active idle-reset timers per directory so we can cancel them
  const resetTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  /** Immutably update the state for one directory */
  const setProjectState = useCallback((dir: string, state: SyncState) => {
    setSyncStates(prev => new Map(prev).set(dir, state));
  }, []);

  /**
   * Schedule an idle reset for `dir` in 3 seconds.
   * Cancels any existing timer first to prevent race conditions where a stale
   * timer fires during an in-progress pull.
   */
  const scheduleReset = useCallback((dir: string) => {
    const existing = resetTimers.current.get(dir);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      setProjectState(dir, { status: 'idle' });
      resetTimers.current.delete(dir);
    }, 3000);
    resetTimers.current.set(dir, timer);
  }, [setProjectState]);

  /**
   * Internal: call the API, update state, schedule idle reset.
   * Does NOT fire toasts — callers decide what to show.
   */
  const executePull = useCallback(async (dir: string): Promise<SyncState> => {
    setProjectState(dir, { status: 'loading' });

    let state: SyncState;
    try {
      const res = await fetch('/api/git/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      });
      const data: { status: string; message?: string } = await res.json();
      // Map API's 'pulled' → hook's 'success' (API and hook use different names)
      const hookStatus = data.status === 'pulled' ? 'success' : data.status as SyncStatus;
      state = { status: hookStatus, message: data.message };
    } catch {
      state = { status: 'error', message: 'Network error' };
    }

    setProjectState(dir, state);
    scheduleReset(dir);
    return state;
  }, [setProjectState, scheduleReset]);

  /** Pull a single project; show an individual Sonner toast for the result */
  const pullProject = useCallback(async (dir: string, displayName: string) => {
    const state = await executePull(dir);

    switch (state.status) {
      case 'success':
        toast.success(`${displayName}: updated`);
        break;
      case 'up-to-date':
        toast.success(`${displayName}: already up to date`);
        break;
      case 'dirty':
        toast.warning(`${displayName}: uncommitted changes, skipped`);
        break;
      case 'error':
        toast.error(`${displayName}: ${state.message ?? 'pull failed'}`);
        break;
      case 'not-git':
        toast.error(`${displayName}: not a git repository`);
        break;
    }
  }, [executePull]);

  /**
   * Pull all projects concurrently; show ONE summary toast at the end.
   * Individual toasts are suppressed by calling executePull directly (not pullProject).
   * not-git results are excluded from the summary count.
   */
  const pullAll = useCallback(
    async (projects: Array<{ dir: string; displayName: string }>) => {
      const results = await Promise.all(
        projects.map(({ dir, displayName }) =>
          executePull(dir).then(state => ({ dir, displayName, state }))
        )
      );

      const pulled    = results.filter(r => r.state.status === 'success' || r.state.status === 'up-to-date');
      const dirty     = results.filter(r => r.state.status === 'dirty');
      const errored   = results.filter(r => r.state.status === 'error');
      const notGit    = results.filter(r => r.state.status === 'not-git');
      const realTotal = projects.length - notGit.length;

      if (dirty.length === 0 && errored.length === 0) {
        toast.success(`All ${realTotal} project${realTotal !== 1 ? 's' : ''} up to date`);
        return;
      }

      // Build a mixed-result summary line
      const parts: string[] = [];
      if (pulled.length > 0) parts.push(`✓ ${pulled.length} updated`);
      if (dirty.length > 0) {
        const names = dirty.map(r => r.displayName).join(', ');
        parts.push(`⚠ skipped (dirty): ${names}`);
      }
      if (errored.length > 0) {
        const names = errored.map(r => r.displayName).join(', ');
        parts.push(`✗ failed: ${names}`);
      }
      toast.warning(parts.join(' · '), { duration: 8000 });
    },
    [executePull]
  );

  const isAnyLoading = [...syncStates.values()].some(s => s.status === 'loading');

  return { syncStates, pullProject, pullAll, isAnyLoading };
}
