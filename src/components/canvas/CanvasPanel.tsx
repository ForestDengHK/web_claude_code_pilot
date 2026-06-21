'use client';

import { useEffect, useState } from 'react';
import ExcalidrawView, { type SceneData } from './ExcalidrawView';
import DrawioView from './DrawioView';
import MermaidView from './MermaidView';

interface Props {
  id: string;
  onClose?: () => void;
}

// Engine-agnostic host: loads the scene once, then delegates to the per-engine
// view (Excalidraw / draw.io / Mermaid). Each view owns its own save + live-SSE
// loop. New engines plug in here without touching the API, store, or MCP layers.
export default function CanvasPanel({ id, onClose }: Props) {
  const [scene, setScene] = useState<SceneData | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch(`/api/canvas/${id}`);
      if (!alive) return;
      if (!res.ok) { setError('not found'); return; }
      setScene(await res.json());
    })();
    return () => { alive = false; };
  }, [id]);

  const engine = scene?.engine;
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 10px', borderBottom: '1px solid var(--border, #e5e5e5)' }}>
        <strong style={{ fontSize: 13 }}>🎨 {scene?.title || 'Canvas'}</strong>
        {engine && <span style={{ fontSize: 11, opacity: 0.5, border: '1px solid var(--border,#ddd)', borderRadius: 4, padding: '0 5px' }}>{engine}</span>}
        <span data-testid="canvas-status" style={{ fontSize: 12, opacity: 0.6 }}>{status}</span>
        <span style={{ flex: 1 }} />
        {onClose && <button onClick={onClose} style={{ fontSize: 12 }}>关闭</button>}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {error ? <div style={{ padding: 16 }}>{error}</div>
          : !scene ? <div style={{ padding: 16 }}>loading…</div>
          : engine === 'drawio' ? <DrawioView id={id} initial={scene} onStatus={setStatus} />
          : engine === 'mermaid' ? <MermaidView id={id} initial={scene} onStatus={setStatus} />
          : <ExcalidrawView id={id} initial={scene} onStatus={setStatus} />}
      </div>
    </div>
  );
}
