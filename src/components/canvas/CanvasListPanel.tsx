'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import CanvasPanel from './CanvasPanel';

interface Entry { id: string; title: string; engine: string; version: number; elementCount: number; updatedAt: string }
interface Props { sessionId: string }

// In-chat Canvas panel (RightPanel tab). Lists THIS conversation's canvases and
// opens one inline beside the chat. Auto-selects a canvas the moment Claude draws
// one during the conversation (poll picks up the new id) — the Claude-Design loop.
export default function CanvasListPanel({ sessionId }: Props) {
  const [items, setItems] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const knownIds = useRef<Set<string>>(new Set());
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    const res = await fetch(`/api/canvas?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return;
    const data = await res.json();
    const list: Entry[] = data.diagrams || [];
    // auto-open a canvas that just appeared (e.g. Claude drew it), but not on first paint
    if (!firstLoad.current) {
      const fresh = list.find((d) => !knownIds.current.has(d.id));
      if (fresh) setSelected(fresh.id);
    }
    knownIds.current = new Set(list.map((d) => d.id));
    firstLoad.current = false;
    setItems(list);
  }, [sessionId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000); // pick up canvases Claude creates mid-conversation
    return () => clearInterval(t);
  }, [load]);

  const create = async (engine: 'excalidraw' | 'drawio' | 'mermaid') => {
    const scene = engine === 'mermaid' ? 'graph TD\n  A[Start] --> B[End]'
      : engine === 'drawio' ? '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>'
      : { elements: [] };
    const res = await fetch('/api/canvas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, engine, title: `New ${engine}`, scene }) });
    const { id } = await res.json();
    knownIds.current.add(id);
    await load();
    setSelected(id);
  };

  if (selected) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <button onClick={() => setSelected(null)} className="shrink-0 text-left text-xs text-muted-foreground px-3 py-2 border-b">← Canvas list</button>
        <div className="flex-1 min-h-0"><CanvasPanel id={selected} /></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-auto">
      <div className="flex flex-wrap gap-2 p-3 border-b">
        <button onClick={() => create('excalidraw')} className="text-xs border rounded px-2 py-1">+ Excalidraw</button>
        <button onClick={() => create('drawio')} className="text-xs border rounded px-2 py-1">+ draw.io</button>
        <button onClick={() => create('mermaid')} className="text-xs border rounded px-2 py-1">+ Mermaid</button>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground p-3">No canvases in this conversation yet. Create one above, or ask Claude to draw one in the chat — it&apos;ll appear here automatically.</p>
      ) : (
        <ul className="flex flex-col">
          {items.map((d) => (
            <li key={d.id}>
              <button onClick={() => setSelected(d.id)} className="w-full text-left px-3 py-2 hover:bg-muted/50 flex items-center gap-2 border-b">
                <span className="text-sm truncate">{d.title || d.id}</span>
                <span className="ml-auto text-[11px] text-muted-foreground shrink-0">{d.engine} · v{d.version}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
