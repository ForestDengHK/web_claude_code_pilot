// src/components/terminal/TerminalPane.tsx
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { ServerMessage, ClientMessage } from '@/lib/terminal/provider';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { TerminalAccessoryBar } from './TerminalAccessoryBar';

interface TerminalPaneProps {
  paneId: string;
  sessionId: string | null;   // null → request a new session from WS server
  wsBaseUrl: string;
  hostId: string;
  title: string;
  isFocused: boolean;
  isVisible: boolean;          // false = visibility:hidden, but keep mounted
  onReady: (sessionId: string) => void;
  onClose: () => void;
  onToggleFocus: () => void;
  onRename: (title: string) => void;
}

export function TerminalPane({
  paneId, sessionId, wsBaseUrl, hostId,
  title, isFocused, isVisible,
  onReady, onClose, onToggleFocus, onRename,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');

  // Sticky Ctrl for the accessory key bar (phones lack a physical Ctrl key). The
  // ref is read inside the once-mounted onData handler; the state drives the UI.
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const ctrlArmedRef = useRef(false);
  const setCtrl = useCallback((v: boolean) => {
    ctrlArmedRef.current = v;
    setCtrlArmed(v);
  }, []);

  // The accessory bar only helps where the keyboard is missing those keys, so
  // show it on touch devices / narrow screens, not on a desktop with a keyboard.
  const [showBar, setShowBar] = useState(false);

  const sendJson = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // Send a raw key sequence from the accessory bar through the normal input
  // channel, clear any armed Ctrl, and keep xterm focused so typing continues.
  const sendKey = useCallback((seq: string) => {
    sendJson({ type: 'input', data: seq });
    if (ctrlArmedRef.current) setCtrl(false);
    termRef.current?.focus();
  }, [sendJson, setCtrl]);

  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse), (max-width: 768px)');
    const update = () => setShowBar(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Mount xterm.js, measure actual size, then open WebSocket with those dimensions
  useEffect(() => {
    if (!containerRef.current) return;

    // Slightly smaller glyphs on phones — 13px reads a touch large on a narrow
    // screen; keep 13px on desktop.
    const isMobile = typeof window !== 'undefined'
      && window.matchMedia('(max-width: 640px)').matches;

    // xterm measures cell width by rasterizing the font to a canvas, and the
    // Canvas 2D `font` string cannot resolve a CSS `var(--font-geist-mono)` — it
    // silently falls back to the system monospace, whose wider metrics make the
    // cells too wide. The result on a phone: glyphs look spaced out, the prompt
    // wraps early, and the first typed character gets pushed off the right edge
    // (the "I can't see the p of pwd" report). Resolve the next/font variable to
    // its real family name so measurement matches what is actually rendered.
    const monoFont = typeof window !== 'undefined'
      ? getComputedStyle(document.body).getPropertyValue('--font-geist-mono').trim()
      : '';
    const fontFamily = monoFont ? `${monoFont}, monospace` : 'monospace';

    const term = new Terminal({
      theme: { background: '#09090b' },  // matches zinc-950
      fontFamily,
      fontSize: isMobile ? 12 : 13,
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    const linksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(linksAddon);
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fitAddon;
    term.onData((data) => {
      let out = data;
      // If Ctrl is armed, fold the next typed character to its control code
      // (e.g. 'r' → \x12 = Ctrl-R) so phone keyboards can reach Ctrl combos.
      if (ctrlArmedRef.current) {
        if (data.length === 1) {
          const c = data.charCodeAt(0);
          if (c >= 64 && c <= 122) out = String.fromCharCode(c & 0x1f);
        }
        setCtrl(false);
      }
      sendJson({ type: 'input', data: out });
    });

    let disposed = false;

    // Open the WebSocket only AFTER measuring the terminal with the real font
    // loaded. xterm derives the column count from the glyph width; if it fits
    // before Geist Mono (next/font, loaded asynchronously) is ready, it measures
    // the fallback font, gets the wrong cols, and spawns the PTY at that wrong
    // width. The shell then draws its prompt for a width that doesn't match what
    // is rendered, so on a narrow phone the first typed characters land off the
    // right edge / clipped until a later redraw. Waiting for the font makes the
    // first fit — and the cols handed to the PTY — correct. Cap the wait so a
    // slow/failed font load can't leave the terminal stuck on "Connecting…".
    const connect = () => {
      if (disposed || !containerRef.current) return;
      fitAddon.fit();
      const { cols, rows } = term;
      const sid = sessionId ?? 'new';
      const url = `${wsBaseUrl}/terminal/${sid}?hostId=${encodeURIComponent(hostId)}&cols=${cols}&rows=${rows}`;

      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // Raw PTY output — pass directly to xterm.js
          term.write(new Uint8Array(event.data));
        } else {
          const msg = JSON.parse(event.data as string) as ServerMessage;
          if (msg.type === 'ready') {
            setStatus('ready');
            onReady(msg.sessionId);
          } else if (msg.type === 'error') {
            setStatus('error');
            setErrorMsg(msg.message);
          } else if (msg.type === 'killed') {
            ws.close();
          }
        }
      };

      ws.onerror = () => {
        setStatus('error');
        setErrorMsg('WebSocket connection failed. Is the terminal server running?');
      };
    };

    const fontsReady = (typeof document !== 'undefined' && document.fonts?.ready)
      ? document.fonts.ready
      : Promise.resolve();
    Promise.race([fontsReady, new Promise((r) => setTimeout(r, 1500))]).then(connect);

    // Refit whenever the container resizes, then sync the PTY size
    const ro = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return;
      fitRef.current.fit();
      sendJson({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows });
    });
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
    // Intentionally run only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When focus or visibility changes, refit xterm after CSS layout settles
  useEffect(() => {
    if (!isVisible) return;
    const t = setTimeout(() => {
      fitRef.current?.fit();
      if (termRef.current) {
        sendJson({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows });
      }
    }, 50);
    return () => clearTimeout(t);
  }, [isVisible, isFocused, sendJson]);

  // The terminal is opened and measured while its container is visibility:hidden
  // (we need its size to open the WebSocket before the server sends 'ready').
  // Once it becomes visible, refit and force a full repaint so the first frame
  // is clean and the renderer's cached dimensions are correct.
  useEffect(() => {
    if (status !== 'ready') return;
    const t = setTimeout(() => {
      if (!fitRef.current || !termRef.current) return;
      fitRef.current.fit();
      termRef.current.refresh(0, termRef.current.rows - 1);
      sendJson({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows });
    }, 50);
    return () => clearTimeout(t);
  }, [status, sendJson]);

  function handleClose() {
    sendJson({ type: 'kill' });
    onClose();
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
      <TerminalPaneHeader
        title={title}
        isFocused={isFocused}
        onClose={handleClose}
        onToggleFocus={onToggleFocus}
        onRename={onRename}
      />
      <div className="relative min-h-0 flex-1">
        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950 p-4 text-center text-sm text-red-400">
            {errorMsg || 'Connection failed'}
          </div>
        )}
        {status === 'connecting' && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950 text-sm text-zinc-500">
            Connecting…
          </div>
        )}
        <div
          ref={containerRef}
          className="h-full w-full p-1"
          onClick={() => termRef.current?.focus()}
          style={{ visibility: status === 'ready' ? 'visible' : 'hidden' }}
        />
      </div>
      {showBar && status === 'ready' && (
        <TerminalAccessoryBar
          onKey={sendKey}
          ctrlArmed={ctrlArmed}
          onToggleCtrl={() => setCtrl(!ctrlArmedRef.current)}
        />
      )}
    </div>
  );
}
