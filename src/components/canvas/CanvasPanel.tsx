'use client';

import { useEffect, useState } from 'react';
import ExcalidrawView, { type SceneData } from './ExcalidrawView';
import DrawioView from './DrawioView';
import MermaidView from './MermaidView';
import AnnotateLayer from './AnnotateLayer';

export type CanvasMode = 'view' | 'edit' | 'annotate';

// Annotate (mark-up → send image to chat) only makes sense for the visual engines.
const ANNOTATABLE = new Set(['drawio', 'excalidraw']);

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
  // Mobile defaults to "view" (pinch only pans/zooms — never drags elements); desktop edits.
  const [mode, setMode] = useState<CanvasMode>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches ? 'view' : 'edit',
  );

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border, #e5e5e5)' }}>
        <strong style={{ fontSize: 13, flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>🎨 {scene?.title || 'Canvas'}</strong>
        {engine && <span style={{ fontSize: 11, opacity: 0.5, border: '1px solid var(--border,#ddd)', borderRadius: 4, padding: '0 5px', flexShrink: 0 }}>{engine}</span>}
        <span data-testid="canvas-status" style={{ fontSize: 12, opacity: 0.6, flexShrink: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{status}</span>
        <div role="group" aria-label="canvas mode" style={{ display: 'flex', flexShrink: 0, border: '1px solid var(--border,#ddd)', borderRadius: 6, overflow: 'hidden' }}>
          {(['view', 'edit', ...(engine && ANNOTATABLE.has(engine) ? ['annotate'] as const : [])] as CanvasMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              style={{ fontSize: 12, padding: '4px 12px', border: 'none', cursor: 'pointer', background: mode === m ? 'var(--accent,#0066cc)' : 'transparent', color: mode === m ? '#fff' : 'inherit' }}
            >{m === 'view' ? 'View' : m === 'edit' ? 'Edit' : 'Annotate'}</button>
          ))}
        </div>
        {onClose && <button onClick={onClose} style={{ fontSize: 12, flexShrink: 0 }}>Close</button>}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {error ? <div style={{ padding: 16 }}>{error}</div>
          : !scene ? <div style={{ padding: 16 }}>loading…</div>
          : mode === 'annotate' && engine && ANNOTATABLE.has(engine) ? <AnnotateLayer id={id} engine={engine} />
          : engine === 'drawio' ? <DrawioView id={id} initial={scene} onStatus={setStatus} mode={mode} />
          : engine === 'mermaid' ? <MermaidView id={id} initial={scene} onStatus={setStatus} mode={mode} />
          : <ExcalidrawView id={id} initial={scene} onStatus={setStatus} mode={mode} />}
      </div>
    </div>
  );
}
