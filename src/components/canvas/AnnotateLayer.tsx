'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface Props { id: string; engine: string; }

const COLORS = ['#e8453c', '#1a73e8', '#34a853', '#f9a825', '#202124'];

// Annotate mode: freezes the current diagram as a snapshot image, lets the user mark it
// up by hand (1 finger = draw, 2 fingers = pan/zoom), then composites diagram + strokes
// into one PNG and pushes it into the chat composer as an image attachment — so Claude
// sees exactly what the user pointed at. Snapshot-on-entry keeps strokes and image in one
// coordinate space, so compositing is exact regardless of zoom.
export default function AnnotateLayer({ id, engine }: Props) {
  const [status, setStatus] = useState('capturing…');
  const [color, setColor] = useState(COLORS[0]);
  const [ready, setReady] = useState(false);
  const colorRef = useRef(color);
  colorRef.current = color;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const drawRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });

  // pan/zoom transform (identity = fitted)
  const view = useRef({ scale: 1, tx: 0, ty: 0 });
  const applyView = useCallback(() => {
    const s = stageRef.current; if (!s) return;
    const v = view.current;
    s.style.transform = `translate(${v.tx}px,${v.ty}px) scale(${v.scale})`;
  }, []);

  const fit = useCallback(() => {
    const c = containerRef.current; const { w, h } = sizeRef.current;
    if (!c || !w || !h) return;
    const r = c.getBoundingClientRect();
    const scale = Math.min(r.width / w, r.height / h) * 0.95 || 1;
    view.current = { scale, tx: (r.width - w * scale) / 2, ty: (r.height - h * scale) / 2 };
    applyView();
  }, [applyView]);

  // ---- capture the diagram as a snapshot image ----
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const url = engine === 'drawio' ? await captureDrawio(id) : await captureExcalidraw(id);
        if (!alive) return;
        const img = new Image();
        img.onload = () => {
          if (!alive) return;
          const w = img.naturalWidth || 1200, h = img.naturalHeight || 800;
          sizeRef.current = { w, h };
          const el = imgRef.current, dc = drawRef.current, st = stageRef.current;
          if (!el || !dc || !st) return;
          el.src = url; el.width = w; el.height = h;
          dc.width = w; dc.height = h;
          st.style.width = `${w}px`; st.style.height = `${h}px`;
          setReady(true); setStatus('1 finger: draw · 2 fingers: pan/zoom');
          requestAnimationFrame(fit);
        };
        img.onerror = () => alive && setStatus('snapshot failed to load');
        img.src = url;
      } catch (e) {
        if (alive) setStatus('capture failed: ' + (e instanceof Error ? e.message : String(e)));
      }
    })();
    return () => { alive = false; };
  }, [id, engine, fit]);

  // ---- drawing + gestures ----
  useEffect(() => {
    const container = containerRef.current; const draw = drawRef.current;
    if (!container || !draw) return;
    const ctx = draw.getContext('2d');
    if (!ctx) return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    const pointers = new Map<number, { x: number; y: number }>();
    let drawing = false;
    let last: { x: number; y: number } | null = null;
    let strokeStart: ImageData | null = null;   // snapshot before current stroke (undo + cancel)
    const undoStack: ImageData[] = [];
    let pinchDist = 0, pinchMid: { x: number; y: number } | null = null;

    const toImg = (cx: number, cy: number) => {
      const r = container.getBoundingClientRect(); const v = view.current;
      return { x: (cx - r.left - v.tx) / v.scale, y: (cy - r.top - v.ty) / v.scale };
    };
    const lineWidth = () => Math.max(1.5, 2.5 / view.current.scale);

    const onDown = (e: PointerEvent) => {
      try { container.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        // begin a stroke
        strokeStart = ctx.getImageData(0, 0, draw.width, draw.height);
        drawing = true;
        last = toImg(e.clientX, e.clientY);
        // a dot for taps
        ctx.beginPath(); ctx.fillStyle = colorRef.current;
        ctx.arc(last.x, last.y, lineWidth() / 2, 0, Math.PI * 2); ctx.fill();
      } else if (pointers.size === 2) {
        // second finger → cancel the partial stroke, switch to pan/zoom
        if (strokeStart) ctx.putImageData(strokeStart, 0, 0);
        drawing = false; last = null;
        const v = Array.from(pointers.values());
        pinchDist = Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y);
        pinchMid = { x: (v[0].x + v[1].x) / 2, y: (v[0].y + v[1].y) / 2 };
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const v = Array.from(pointers.values());
      if (v.length === 1 && drawing && last) {
        const p = toImg(e.clientX, e.clientY);
        ctx.strokeStyle = colorRef.current; ctx.lineWidth = lineWidth();
        ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        last = p;
      } else if (v.length === 2) {
        const dist = Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y);
        const mid = { x: (v[0].x + v[1].x) / 2, y: (v[0].y + v[1].y) / 2 };
        if (pinchDist && pinchMid) {
          const vw = view.current;
          vw.tx += mid.x - pinchMid.x; vw.ty += mid.y - pinchMid.y;
          const r = container.getBoundingClientRect();
          const f = dist / pinchDist; const ns = Math.min(20, Math.max(0.1, vw.scale * f));
          const k = ns / vw.scale; const x = mid.x - r.left, y = mid.y - r.top;
          vw.tx = x - (x - vw.tx) * k; vw.ty = y - (y - vw.ty) * k; vw.scale = ns;
          applyView();
        }
        pinchDist = dist; pinchMid = mid;
      }
    };
    const onUp = (e: PointerEvent) => {
      const wasDrawing = drawing && pointers.size === 1;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) { pinchDist = 0; pinchMid = null; }
      if (pointers.size === 0) {
        if (wasDrawing && strokeStart) { undoStack.push(strokeStart); if (undoStack.length > 25) undoStack.shift(); }
        drawing = false; last = null; strokeStart = null;
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = container.getBoundingClientRect(); const vw = view.current;
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12; const ns = Math.min(20, Math.max(0.1, vw.scale * f));
      const k = ns / vw.scale; const x = e.clientX - r.left, y = e.clientY - r.top;
      vw.tx = x - (x - vw.tx) * k; vw.ty = y - (y - vw.ty) * k; vw.scale = ns; applyView();
    };

    const undo = () => { const d = undoStack.pop(); if (d) ctx.putImageData(d, 0, 0); };
    const clear = () => {
      undoStack.push(ctx.getImageData(0, 0, draw.width, draw.height));
      ctx.clearRect(0, 0, draw.width, draw.height);
    };
    undoRef.current = undo; clearRef.current = clear;

    container.addEventListener('pointerdown', onDown);
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerup', onUp);
    container.addEventListener('pointercancel', onUp);
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      container.removeEventListener('pointerdown', onDown);
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerup', onUp);
      container.removeEventListener('pointercancel', onUp);
      container.removeEventListener('wheel', onWheel);
    };
  }, [ready, applyView]);

  const undoRef = useRef<() => void>(() => {});
  const clearRef = useRef<() => void>(() => {});

  const sendToChat = useCallback(() => {
    const img = imgRef.current, draw = drawRef.current; const { w, h } = sizeRef.current;
    if (!img || !draw || !w) return;
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const octx = out.getContext('2d'); if (!octx) return;
    octx.fillStyle = '#ffffff'; octx.fillRect(0, 0, w, h);
    octx.drawImage(img, 0, 0, w, h);
    octx.drawImage(draw, 0, 0);
    out.toBlob((blob) => {
      if (!blob) { setStatus('export failed'); return; }
      const file = new File([blob], `canvas-${id}-annotated.png`, { type: 'image/png' });
      window.dispatchEvent(new CustomEvent('attach-image-to-chat', { detail: { file } }));
      setStatus('✓ Added to chat — close the canvas to send');
    }, 'image/png');
  }, [id]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border,#e5e5e5)', flexWrap: 'wrap' }}>
        {COLORS.map((c) => (
          <button key={c} aria-label={`pen ${c}`} onClick={() => setColor(c)}
            style={{ width: 22, height: 22, borderRadius: '50%', background: c, cursor: 'pointer', flexShrink: 0, border: color === c ? '2px solid #000' : '2px solid transparent', outline: color === c ? '1px solid #fff' : 'none' }} />
        ))}
        <span style={{ width: 1, height: 18, background: 'var(--border,#ddd)', flexShrink: 0 }} />
        <button onClick={() => undoRef.current()} style={{ fontSize: 12, flexShrink: 0 }}>Undo</button>
        <button onClick={() => clearRef.current()} style={{ fontSize: 12, flexShrink: 0 }}>Clear</button>
        <span style={{ flex: 1 }} />
        <button onClick={sendToChat} disabled={!ready}
          style={{ fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 6, border: 'none', background: ready ? 'var(--accent,#0066cc)' : '#ccc', color: '#fff', cursor: ready ? 'pointer' : 'default', flexShrink: 0 }}>
          Send to chat
        </button>
      </div>
      <div style={{ position: 'absolute', left: 10, bottom: 8, fontSize: 11, opacity: 0.6, pointerEvents: 'none' }}>{status}</div>
      <div ref={containerRef} style={{ position: 'absolute', left: 0, right: 0, top: 41, bottom: 0, overflow: 'hidden', touchAction: 'none', background: '#fafafa' }}>
        <div ref={stageRef} style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', willChange: 'transform' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img ref={imgRef} alt="diagram snapshot" style={{ display: 'block', position: 'absolute', left: 0, top: 0, pointerEvents: 'none', userSelect: 'none' }} />
          <canvas ref={drawRef} style={{ display: 'block', position: 'absolute', left: 0, top: 0 }} />
        </div>
      </div>
    </div>
  );
}

// Rasterize the read-only draw.io viewer's SVG into a snapshot data URL (same-origin iframe).
function captureDrawio(id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:1400px;height:900px;border:none';
    iframe.src = `/drawio/canvas-view.html?id=${encodeURIComponent(id)}`;
    let tries = 0;
    const cleanup = () => { try { iframe.remove(); } catch { /* ignore */ } };
    iframe.onload = () => {
      const poll = setInterval(() => {
        tries++;
        let svg: SVGSVGElement | null = null;
        try { svg = iframe.contentDocument?.querySelector('svg') ?? null; } catch (e) { clearInterval(poll); cleanup(); reject(e); return; }
        if (svg) {
          clearInterval(poll);
          const clone = svg.cloneNode(true) as SVGSVGElement;
          const w = parseInt(svg.getAttribute('width') || '') || Math.round(svg.getBoundingClientRect().width) || 1200;
          const h = parseInt(svg.getAttribute('height') || '') || Math.round(svg.getBoundingClientRect().height) || 800;
          clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          clone.setAttribute('width', String(w)); clone.setAttribute('height', String(h));
          const xml = new XMLSerializer().serializeToString(clone);
          cleanup();
          resolve('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml));
        } else if (tries > 50) { clearInterval(poll); cleanup(); reject(new Error('viewer timeout')); }
      }, 80);
    };
    document.body.appendChild(iframe);
  });
}

// Export the Excalidraw scene to a PNG data URL via the library's own exporter.
async function captureExcalidraw(id: string): Promise<string> {
  const res = await fetch(`/api/canvas/${id}`);
  if (!res.ok) throw new Error('scene fetch failed');
  const scene = await res.json();
  const { exportToBlob, restoreElements } = await import('@excalidraw/excalidraw');
  const elements = restoreElements(scene.elements || [], null);
  const blob = await exportToBlob({
    elements,
    files: {},
    mimeType: 'image/png',
    exportPadding: 16,
    appState: { exportBackground: true, viewBackgroundColor: '#ffffff' },
  } as never);
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('blob read failed'));
    r.readAsDataURL(blob);
  });
}
