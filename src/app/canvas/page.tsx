'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Entry { id: string; title: string; engine: string; version: number; elementCount: number; updatedAt: string; }

export default function CanvasIndexPage() {
  const [items, setItems] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const res = await fetch('/api/canvas');
    const data = await res.json();
    setItems(data.diagrams || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const create = async (engine: 'excalidraw' | 'drawio' | 'mermaid') => {
    const scene = engine === 'mermaid' ? 'graph TD\n  A[Start] --> B[End]'
      : engine === 'drawio' ? '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>'
      : { elements: [] };
    const res = await fetch('/api/canvas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine, title: `New ${engine}`, scene }),
    });
    const { id } = await res.json();
    window.location.href = `/canvas/${id}`;
  };

  return (
    <div style={{ padding: 24, maxWidth: 760, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>🎨 Canvases</h1>
        <span style={{ flex: 1 }} />
        <button onClick={() => create('excalidraw')} style={{ fontSize: 13, padding: '6px 10px', border: '1px solid var(--border,#ccc)', borderRadius: 6 }}>+ Excalidraw</button>
        <button onClick={() => create('drawio')} style={{ fontSize: 13, padding: '6px 10px', border: '1px solid var(--border,#ccc)', borderRadius: 6 }}>+ draw.io</button>
        <button onClick={() => create('mermaid')} style={{ fontSize: 13, padding: '6px 10px', border: '1px solid var(--border,#ccc)', borderRadius: 6 }}>+ Mermaid</button>
        <button onClick={load} style={{ fontSize: 13 }}>↻</button>
      </div>
      {loading ? <p>loading…</p> : items.length === 0 ? (
        <p style={{ opacity: 0.6 }}>No canvases yet. Create one, or ask Claude to draw a diagram in chat.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1)).map((d) => (
            <li key={d.id}>
              <Link href={`/canvas/${d.id}`} style={{ display: 'flex', gap: 12, padding: '10px 12px', border: '1px solid var(--border,#e5e5e5)', borderRadius: 8, textDecoration: 'none' }}>
                <span style={{ fontWeight: 500 }}>{d.title || d.id}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, opacity: 0.6 }}>{d.engine} · {d.elementCount} els · v{d.version}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
