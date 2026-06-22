'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ExcalidrawCanvas, { type ExcalidrawApi } from './ExcalidrawCanvas';
import type { CanvasMode } from './CanvasPanel';

export interface SceneData { id: string; engine: string; version: number; title: string; elements?: unknown[]; source?: string }

interface Props { id: string; initial: SceneData; onStatus: (s: string) => void; mode: CanvasMode; }

// Excalidraw engine view: load → debounced user save → live reload on external (Claude) writes.
export default function ExcalidrawView({ id, initial, onStatus, mode }: Props) {
  const [ready, setReady] = useState(false);
  const [initialElements, setInitialElements] = useState<unknown[]>([]);
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const myVersionRef = useRef(initial.version);
  const applyingExternalRef = useRef(false);
  const lastSigRef = useRef('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sigOf = (els: readonly unknown[]) =>
    (els as { id?: string; version?: number; isDeleted?: boolean }[])
      .filter((e) => !e.isDeleted).map((e) => `${e.id}:${e.version ?? 0}`).join(',');

  const normalize = async (els: unknown[]): Promise<unknown[]> => {
    if (!els?.length) return [];
    try { const { restoreElements } = await import('@excalidraw/excalidraw'); return restoreElements(els as never, null) as unknown[]; }
    catch { return els; }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const els = await normalize(initial.elements || []);
      if (!alive) return;
      lastSigRef.current = sigOf(els);
      setInitialElements(els);
      setReady(true);
    })();
    return () => { alive = false; };
  }, [initial]);

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
      const els = await normalize(scene.elements || []);
      myVersionRef.current = scene.version;
      lastSigRef.current = sigOf(els);
      applyingExternalRef.current = true;
      apiRef.current?.updateScene({ elements: els });
      onStatus(`updated by Claude → v${scene.version}`);
      setTimeout(() => { applyingExternalRef.current = false; }, 50);
    };
    return () => es.close();
  }, [id, onStatus]);

  const onChange = useCallback((elements: readonly unknown[]) => {
    if (!ready || applyingExternalRef.current) return;
    const sig = sigOf(elements);
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const res = await fetch(`/api/canvas/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ elements, author: 'user' }) });
      if (res.ok) { const r = await res.json(); myVersionRef.current = r.version; onStatus(`saved v${r.version}`); }
    }, 600);
  }, [id, ready, onStatus]);

  if (!ready) return <div style={{ padding: 16 }}>loading…</div>;
  return <ExcalidrawCanvas initialElements={initialElements} onApi={(api) => { apiRef.current = api; }} onChange={onChange} viewMode={mode === 'view'} />;
}
