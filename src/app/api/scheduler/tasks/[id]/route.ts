import { NextRequest } from 'next/server';
import { getTask, updateTask, deleteTask } from '@/lib/scheduler/scheduler-db';
import { reschedule, unschedule, setEnabled as managerSetEnabled } from '@/lib/scheduler/scheduler-manager';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const t = getTask(id);
  if (!t) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json({ task: t });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json();
  if (typeof body.enabled === 'boolean' && Object.keys(body).length === 1) {
    managerSetEnabled(id, body.enabled);
    return Response.json({ task: getTask(id) });
  }
  if ('description' in body && (typeof body.description !== 'string' || !body.description.trim())) {
    return Response.json({ error: 'description is required' }, { status: 400 });
  }
  const updated = updateTask(id, body);
  if (!updated) return Response.json({ error: 'not found' }, { status: 404 });
  reschedule(id);
  return Response.json({ task: updated });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  unschedule(id);
  deleteTask(id);
  return Response.json({ ok: true });
}
