import { NextRequest } from 'next/server';
import { resolvePendingInputRequest } from '@/lib/input-request-registry';
import type { InputResponseRequest } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body: InputResponseRequest = await request.json();
    const { inputRequestId, answers } = body;

    if (!inputRequestId || !answers) {
      return new Response(
        JSON.stringify({ error: 'inputRequestId and answers are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const found = resolvePendingInputRequest(inputRequestId, answers);

    if (!found) {
      return new Response(
        JSON.stringify({ error: 'Input request not found or already resolved' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
