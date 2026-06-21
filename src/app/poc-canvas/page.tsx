'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import '@excalidraw/excalidraw/index.css';

// Excalidraw must load client-side only (it touches window at import).
const Excalidraw = dynamic(
  async () => (await import('@excalidraw/excalidraw')).Excalidraw,
  { ssr: false, loading: () => <div>loading excalidraw…</div> },
);

export default function PocCanvasPage() {
  const [api, setApi] = useState<any>(null);
  const [result, setResult] = useState<string>('');

  async function exportPng() {
    if (!api) { setResult('no api'); return; }
    const { exportToBlob } = await import('@excalidraw/excalidraw');
    const blob = await exportToBlob({
      elements: api.getSceneElements(),
      appState: api.getAppState(),
      files: api.getFiles(),
      mimeType: 'image/png',
    });
    setResult(`png-bytes:${blob.size}`);
  }

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 8 }}>
        <button onClick={exportPng}>Export PNG</button>
        <span data-testid="poc-result" style={{ marginLeft: 12 }}>{result}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Excalidraw excalidrawAPI={(a) => setApi(a)} />
      </div>
    </div>
  );
}
