'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ExcalidrawCanvas, { type ExcalidrawApi } from './ExcalidrawCanvas';

interface Props {
  id: string;
  onClose?: () => void;
}

// Engine-agnostic orchestrator (Phase 1: Excalidraw). Handles:
//  - initial load (GET /api/canvas/<id>)
//  - user-draw save (debounced PUT)
//  - live reload when an EXTERNAL writer (Claude via MCP, or another client) bumps the file
export default function CanvasPanel({ id, onClose }: Props) {
  const [ready, setReady] = useState(false);
  const [initialElements, setInitialElements] = useState<unknown[]>([]);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('');
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const myVersionRef = useRef(0);          // highest version this client has produced/seen
  const applyingExternalRef = useRef(false); // suppress save echo while applying a remote scene
  const lastSigRef = useRef('');           // content signature of the last loaded/saved scene
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cheap content signature: ignores Excalidraw's on-load normalization (same ids+versions).
  const sigOf = (elements: readonly unknown[]) =>
    (elements as { id?: string; version?: number; isDeleted?: boolean }[])
      .filter((e) => !e.isDeleted)
      .map((e) => `${e.id}:${e.version ?? 0}`).join(',');

  // initial load
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch(`/api/canvas/${id}`);
      if (!res.ok) { if (alive) setStatus('not found'); return; }
      const scene = await res.json();
      if (!alive) return;
      myVersionRef.current = scene.version;
      lastSigRef.current = sigOf(scene.elements || []);
      setTitle(scene.title || id);
      setInitialElements(scene.elements || []);
      setReady(true);
    })();
    return () => { alive = false; };
  }, [id]);

  // live updates from disk (user save echoes are filtered by version)
  useEffect(() => {
    const es = new EventSource(`/api/canvas/${id}/stream`);
    es.onmessage = async (ev) => {
      let msg: { type?: string; version?: number };
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type !== 'canvas_updated' || typeof msg.version !== 'number') return;
      if (msg.version <= myVersionRef.current) return; // our own / older change
      // external change (e.g. Claude) -> pull the new scene and apply it live
      const res = await fetch(`/api/canvas/${id}`);
      if (!res.ok) return;
      const scene = await res.json();
      myVersionRef.current = scene.version;
      lastSigRef.current = sigOf(scene.elements || []);
      applyingExternalRef.current = true;
      apiRef.current?.updateScene({ elements: scene.elements });
      setStatus(`updated by Claude → v${scene.version}`);
      setTimeout(() => { applyingExternalRef.current = false; }, 50);
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
    return () => es.close();
  }, [id]);

  const onChange = useCallback((elements: readonly unknown[]) => {
    if (!ready || applyingExternalRef.current) return;
    const sig = sigOf(elements);
    if (sig === lastSigRef.current) return; // no real content change (load normalization, selection, pan…)
    lastSigRef.current = sig;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const res = await fetch(`/api/canvas/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ elements, author: 'user' }),
      });
      if (res.ok) {
        const r = await res.json();
        myVersionRef.current = r.version; // mark our own save so the SSE echo is ignored
        setStatus(`saved v${r.version}`);
      }
    }, 600);
  }, [id, ready]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 10px', borderBottom: '1px solid var(--border, #e5e5e5)' }}>
        <strong style={{ fontSize: 13 }}>🎨 {title || 'Canvas'}</strong>
        <span data-testid="canvas-status" style={{ fontSize: 12, opacity: 0.6 }}>{status}</span>
        <span style={{ flex: 1 }} />
        {onClose && <button onClick={onClose} style={{ fontSize: 12 }}>关闭</button>}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {ready
          ? <ExcalidrawCanvas initialElements={initialElements} onApi={(api) => { apiRef.current = api; }} onChange={onChange} />
          : <div style={{ padding: 16 }}>{status || 'loading…'}</div>}
      </div>
    </div>
  );
}
