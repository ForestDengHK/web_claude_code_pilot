// src/app/api/chat/sessions/organize/route.ts
import { NextRequest } from 'next/server';
import type { OrganizeConfig, OrganizeSSEEvent } from '@/types/organize';
import { DEFAULT_ORGANIZE_CONFIG } from '@/types/organize';
import { runOrganizeAnalysis } from '@/lib/organize-engine';

function formatSSE(event: OrganizeSSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));

  const config: OrganizeConfig = {
    ...DEFAULT_ORGANIZE_CONFIG,
    ...body,
  };

  let heartbeatInterval: ReturnType<typeof setInterval>;

  const stream = new ReadableStream<string>({
    async start(controller) {
      heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(formatSSE({ type: 'heartbeat' }));
        } catch {
          clearInterval(heartbeatInterval);
        }
      }, 10_000);

      try {
        await runOrganizeAnalysis(
          config,
          {
            onEvent: (event) => {
              try {
                controller.enqueue(formatSSE(event));
              } catch {
                // Controller closed
              }
            },
          },
        );
      } catch (error) {
        try {
          controller.enqueue(formatSSE({
            type: 'error',
            message: error instanceof Error ? error.message : 'Unknown error',
          }));
        } catch {
          // Controller closed
        }
      } finally {
        clearInterval(heartbeatInterval);
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }
    },
    cancel() {
      clearInterval(heartbeatInterval);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
