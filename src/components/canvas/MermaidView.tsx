'use client';

import { useEffect, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import { mermaid } from '@streamdown/mermaid';
import type { SceneData } from './ExcalidrawView';
import type { CanvasMode } from './CanvasPanel';

interface Props { id: string; initial: SceneData; onStatus: (s: string) => void; mode: CanvasMode; }

// Mermaid engine view: textarea (source) + live preview via the shared Streamdown
// mermaid plugin. Bidirectional: user edits text → save; Claude rewrites source → reload.
export default function MermaidView({ id, initial, onStatus, mode }: Props) {
  const [source, setSource] = useState(initial.source ?? 'graph TD\n  A[Start] --> B[End]');
  const myVersionRef = useRef(initial.version);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/canvas/${id}/stream`);
    es.onmessage = async (ev) => {
      let msg: { type?: string; version?: number };
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type !== 'canvas_updated' || typeof msg.version !== 'number') return;
      if (msg.version <= myVersionRef.current) return;
      const res = await fetch(`/api/canvas/${id}`);
      if (!res.ok) return;
      const scene = await res.json();
      myVersionRef.current = scene.version;
      setSource(scene.source ?? '');
      onStatus(`updated by Claude → v${scene.version}`);
    };
    return () => es.close();
  }, [id, onStatus]);

  const onEdit = (val: string) => {
    setSource(val);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const res = await fetch(`/api/canvas/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: val, author: 'user' }) });
      if (res.ok) { const r = await res.json(); myVersionRef.current = r.version; onStatus(`saved v${r.version}`); }
    }, 600);
  };

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {mode === 'edit' && (
        <textarea
          value={source}
          onChange={(e) => onEdit(e.target.value)}
          spellCheck={false}
          style={{ width: '40%', height: '100%', resize: 'none', border: 'none', borderRight: '1px solid var(--border,#e5e5e5)', padding: 12, fontFamily: 'monospace', fontSize: 13, outline: 'none' }}
        />
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        <Streamdown plugins={{ mermaid }}>{'```mermaid\n' + source + '\n```'}</Streamdown>
      </div>
    </div>
  );
}
