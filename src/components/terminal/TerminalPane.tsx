// src/components/terminal/TerminalPane.tsx
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { ServerMessage, ClientMessage } from '@/lib/terminal/provider';
import { TerminalPaneHeader } from './TerminalPaneHeader';

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

  const sendJson = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // Mount xterm.js, measure actual size, then open WebSocket with those dimensions
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: { background: '#09090b' },  // matches zinc-950
      fontFamily: 'var(--font-geist-mono), monospace',
      fontSize: 13,
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    const linksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(linksAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;
    fitRef.current = fitAddon;

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

    term.onData((data) => sendJson({ type: 'input', data }));

    // Refit whenever the container resizes, then sync the PTY size
    const ro = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return;
      fitRef.current.fit();
      sendJson({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      ws.close();
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
          style={{ visibility: status === 'ready' ? 'visible' : 'hidden' }}
        />
      </div>
    </div>
  );
}
