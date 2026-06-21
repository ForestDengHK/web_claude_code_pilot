'use client';

import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import '@excalidraw/excalidraw/index.css';

// Excalidraw touches window at import → client-only dynamic import.
const Excalidraw = dynamic(
  async () => (await import('@excalidraw/excalidraw')).Excalidraw,
  { ssr: false, loading: () => <div style={{ padding: 16 }}>loading canvas…</div> },
);

// Minimal surface of the Excalidraw imperative API we rely on.
export interface ExcalidrawApi {
  updateScene: (scene: { elements: readonly unknown[] }) => void;
  getSceneElements: () => readonly unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
}

interface Props {
  initialElements: unknown[];
  onApi: (api: ExcalidrawApi) => void;
  onChange: (elements: readonly unknown[]) => void;
}

export default function ExcalidrawCanvas({ initialElements, onApi, onChange }: Props) {
  // mount-only: hand the API up to the parent
  useEffect(() => () => { /* unmount cleanup handled by Excalidraw */ }, []);
  return (
    <Excalidraw
      initialData={{ elements: initialElements as never, scrollToContent: true }}
      excalidrawAPI={(api) => onApi(api as unknown as ExcalidrawApi)}
      onChange={(elements) => onChange(elements)}
    />
  );
}
