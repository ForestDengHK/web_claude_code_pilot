// src/app/api/chat/sessions/organize/status/route.ts
import { NextResponse } from 'next/server';
import type { OrganizeStatusResponse, OrganizeConfig, OrganizeSuggestion } from '@/types/organize';
import { getLatestOrganizeTask } from '@/lib/db';
import { getOrganizeBuffer } from '@/lib/organize-buffer-registry';

export async function GET() {
  const task = getLatestOrganizeTask();

  if (!task) {
    return NextResponse.json({ hasTask: false } satisfies OrganizeStatusResponse);
  }

  let config: OrganizeConfig | undefined;
  let results: OrganizeSuggestion[] | undefined;
  try {
    config = JSON.parse(task.config) as OrganizeConfig;
  } catch { /* ignore */ }
  try {
    results = JSON.parse(task.results) as OrganizeSuggestion[];
  } catch { /* ignore */ }

  const buffer = getOrganizeBuffer(task.id);

  const response: OrganizeStatusResponse = {
    hasTask: true,
    taskId: task.id,
    status: task.status as 'running' | 'done' | 'error',
    config,
    results,
    progress: buffer
      ? { phase: buffer.phase, completed: buffer.completed, total: buffer.total }
      : undefined,
  };

  return NextResponse.json(response);
}
