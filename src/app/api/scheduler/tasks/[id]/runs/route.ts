import { NextRequest } from 'next/server';
import { listRuns, getTask } from '@/lib/scheduler/scheduler-db';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const task = getTask(id);
  if (!task) return Response.json({ error: 'not found' }, { status: 404 });
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? '50');
  return Response.json({ runs: listRuns(id, limit) });
}
