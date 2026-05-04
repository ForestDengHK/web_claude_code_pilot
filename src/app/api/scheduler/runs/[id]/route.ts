import { NextRequest } from 'next/server';
import { getRun } from '@/lib/scheduler/scheduler-db';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json({ run });
}
