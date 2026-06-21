import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getDiagramsDir, reconcileFromMeta } from '@/lib/canvas-store';

interface RouteContext { params: Promise<{ id: string }>; }

// GET /api/canvas/<id>/stream  -> Server-Sent Events: emits {type:'canvas_updated', id, version}
// whenever the diagram's file changes on disk (user save, MCP server, or Claude Write).
// Uses fs.watch on the diagrams dir (no extra deps) — file = source of truth.
export async function GET(_req: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const dir = getDiagramsDir();
  const metaFile = `${id}.meta.json`;
  const encoder = new TextEncoder();

  let watcher: fs.FSWatcher | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    watcher?.close();
    watcher = null;
    heartbeat = null;
  };

  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: unknown) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { cleanup(); }
      };
      send({ type: 'hello', id });

      let lastVersion = -1;
      const tick = () => {
        const res = reconcileFromMeta(id);
        if (res && res.version !== lastVersion) {
          lastVersion = res.version;
          send({ type: 'canvas_updated', id, version: res.version });
        }
      };
      tick(); // emit current state immediately

      try {
        watcher = fs.watch(dir, (_event, filename) => {
          if (filename && path.basename(filename) === metaFile) tick();
        });
      } catch {
        // fs.watch unsupported on this platform -> heartbeat poll below still catches changes
      }

      // Heartbeat keeps the connection alive + coarse poll fallback if fs.watch missed an event.
      heartbeat = setInterval(() => { send({ type: 'ping' }); tick(); }, 15000);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
    },
  });
}
