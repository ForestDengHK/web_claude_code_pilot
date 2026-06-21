'use client';

import { useEffect, useRef } from 'react';
import type { SceneData } from './ExcalidrawView';

interface Props { id: string; initial: SceneData; onStatus: (s: string) => void; }

const EMBED_URL = 'https://embed.diagrams.net/?embed=1&proto=json&spin=1&libraries=1&configure=0&noSaveBtn=1';

// draw.io engine view: embeds the diagrams.net editor in an iframe and speaks its
// JSON postMessage protocol (init/load/autosave) — the same iframe⇄host shape as
// baoyu's Tweaks protocol. Bidirectional: user edits → autosave → save XML;
// Claude rewrites the mxGraph XML → reload the editor with the new XML.
export default function DrawioView({ id, initial, onStatus }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const myVersionRef = useRef(initial.version);
  const sourceRef = useRef(initial.source ?? '');

  const post = (msg: object) => iframeRef.current?.contentWindow?.postMessage(JSON.stringify(msg), '*');

  useEffect(() => {
    const onMessage = async (evt: MessageEvent) => {
      if (typeof evt.data !== 'string') return;
      let data: { event?: string; xml?: string };
      try { data = JSON.parse(evt.data); } catch { return; }
      if (data.event === 'init') {
        post({ action: 'load', xml: sourceRef.current, autosave: 1 });
      } else if (data.event === 'autosave' || data.event === 'save') {
        const xml = data.xml ?? '';
        sourceRef.current = xml;
        const res = await fetch(`/api/canvas/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: xml, author: 'user' }) });
        if (res.ok) { const r = await res.json(); myVersionRef.current = r.version; onStatus(`saved v${r.version}`); }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [id, onStatus]);

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
      sourceRef.current = scene.source ?? '';
      post({ action: 'load', xml: sourceRef.current, autosave: 1 });
      onStatus(`updated by Claude → v${scene.version}`);
    };
    return () => es.close();
  }, [id, onStatus]);

  return <iframe ref={iframeRef} src={EMBED_URL} title="draw.io" style={{ width: '100%', height: '100%', border: 'none' }} />;
}
