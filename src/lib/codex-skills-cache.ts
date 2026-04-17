/**
 * Shared in-process cache for Codex skills list.
 *
 * Lives in its own module so that both the GET route
 * (`/api/codex/skills`) and the PATCH route (`/api/codex/skills/[name]`)
 * reference the same instance — Next.js can otherwise load each route file
 * into its own module scope, which would silently break cache invalidation.
 */

export interface CodexSkillEntry {
  name: string;
  description: string;
  path: string;
  scope: 'user' | 'repo' | 'system' | 'admin';
  enabled: boolean;
  shortDescription?: string;
  displayName?: string;
  brandColor?: string;
  iconSmall?: string;
}

interface CacheState {
  skills: CodexSkillEntry[] | null;
  at: number;
}

// Use a property on globalThis so Hot-Module-Reload in dev (and any
// route-level module re-evaluation) doesn't reset the cache.
const GLOBAL_KEY = '__codepilotCodexSkillsCache__';

function getStore(): CacheState {
  const g = globalThis as Record<string, unknown>;
  let store = g[GLOBAL_KEY] as CacheState | undefined;
  if (!store) {
    store = { skills: null, at: 0 };
    g[GLOBAL_KEY] = store;
  }
  return store;
}

export function getCachedSkills(): { skills: CodexSkillEntry[] | null; at: number } {
  const s = getStore();
  return { skills: s.skills, at: s.at };
}

export function setCachedSkills(skills: CodexSkillEntry[]): void {
  const s = getStore();
  s.skills = skills;
  s.at = Date.now();
}

export function invalidateSkillsCache(): void {
  const s = getStore();
  s.skills = null;
  s.at = 0;
}
