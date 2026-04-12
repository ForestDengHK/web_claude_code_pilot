// src/lib/organize-buffer-registry.ts
/**
 * In-memory progress buffer for organize tasks.
 * Mirrors streaming-buffer-registry.ts pattern (globalThis-backed).
 *
 * When the mobile browser drops the SSE connection during analysis,
 * the backend keeps running. This registry captures progress so the
 * recovery-polling status endpoint can return intermediate state.
 */

import type { OrganizeSuggestion } from '@/types/organize';

export interface OrganizeBuffer {
  phase: 'rules' | 'ai';
  completed: number;
  total: number;
  suggestions: OrganizeSuggestion[];
}

const globalKey = '__organizeBufferRegistry__' as const;

function getRegistry(): Map<string, OrganizeBuffer> {
  if (!(globalThis as Record<string, unknown>)[globalKey]) {
    (globalThis as Record<string, unknown>)[globalKey] = new Map<string, OrganizeBuffer>();
  }
  return (globalThis as Record<string, unknown>)[globalKey] as Map<string, OrganizeBuffer>;
}

export function initOrganizeBuffer(taskId: string, total: number): void {
  getRegistry().set(taskId, {
    phase: 'rules',
    completed: 0,
    total,
    suggestions: [],
  });
}

export function updateOrganizePhase(taskId: string, phase: 'rules' | 'ai', total: number): void {
  const buf = getRegistry().get(taskId);
  if (buf) {
    buf.phase = phase;
    buf.completed = 0;
    buf.total = total;
  }
}

export function pushOrganizeSuggestion(taskId: string, suggestion: OrganizeSuggestion): void {
  const buf = getRegistry().get(taskId);
  if (buf) {
    buf.suggestions.push(suggestion);
    buf.completed++;
  }
}

export function getOrganizeBuffer(taskId: string): OrganizeBuffer | null {
  return getRegistry().get(taskId) ?? null;
}

export function clearOrganizeBuffer(taskId: string): void {
  getRegistry().delete(taskId);
}
