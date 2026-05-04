import { NextRequest } from 'next/server';
import { getTask } from '@/lib/scheduler/scheduler-db';
import { runOnce, isRunning } from '@/lib/scheduler/scheduler-manager';

export const runtime = 'nodejs';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const task = getTask(id);
  if (!task) return Response.json({ error: 'not found' }, { status: 404 });
  if (isRunning(id)) return Response.json({ error: 'already running' }, { status: 409 });
  void runOnce(id, 'manual');
  return Response.json({ ok: true });
}
