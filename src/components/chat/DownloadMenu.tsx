'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { DownloadIcon, CheckIcon, Loader2Icon, FileTextIcon, FileIcon } from 'lucide-react';

interface DownloadMenuProps {
  /** Markdown text to download. For full-session PDF, this can be fetched on demand. */
  markdown: string;
  /** Used for filename: {filenameBase}.md / .pdf */
  filenameBase: string;
  /** Whether the menu opens above or below the trigger button. */
  menuPlacement?: 'top' | 'bottom';
  /**
   * For full-session PDF: if provided, this function is called to get the markdown
   * instead of using the `markdown` prop. This avoids passing huge session markdown
   * through props when it's only needed for PDF.
   */
  fetchMarkdown?: () => Promise<string>;
}

type Status = 'idle' | 'loading' | 'success' | 'error';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function DownloadMenu({
  markdown,
  filenameBase,
  menuPlacement = 'top',
  fetchMarkdown,
}: DownloadMenuProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  // Cleanup timer on unmount
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const showSuccess = useCallback(() => {
    setStatus('success');
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setStatus('idle'), 2000);
  }, []);

  const handleDownloadMd = useCallback(async () => {
    setOpen(false);
    if (fetchMarkdown) setStatus('loading'); // Only show spinner for async fetch
    try {
      const md = fetchMarkdown ? await fetchMarkdown() : markdown;
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      downloadBlob(blob, `${filenameBase}.md`);
      showSuccess();
    } catch (error) {
      console.error('MD download failed:', error);
      setStatus('error');
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setStatus('idle'), 2000);
    }
  }, [markdown, filenameBase, fetchMarkdown, showSuccess]);

  const handleDownloadPdf = useCallback(async () => {
    setOpen(false);
    setStatus('loading');
    try {
      // Get the markdown content (either from prop or by fetching)
      const md = fetchMarkdown ? await fetchMarkdown() : markdown;

      const res = await fetch('/api/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: md, title: filenameBase }),
      });

      if (!res.ok) {
        throw new Error(`PDF generation failed: ${res.status}`);
      }

      const blob = await res.blob();
      downloadBlob(blob, `${filenameBase}.pdf`);
      showSuccess();
    } catch (error) {
      console.error('PDF download failed:', error);
      setStatus('error');
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setStatus('idle'), 2000);
    }
  }, [markdown, filenameBase, fetchMarkdown, showSuccess]);

  // Icon based on status
  const icon =
    status === 'loading' ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" /> :
    status === 'success' ? <CheckIcon className="h-3.5 w-3.5 text-green-500" /> :
    status === 'error'   ? <DownloadIcon className="h-3.5 w-3.5 text-red-500" /> :
                           <DownloadIcon className="h-3.5 w-3.5" />;
  const menuPositionClass = menuPlacement === 'bottom'
    ? 'absolute top-full right-0 mt-1'
    : 'absolute bottom-full right-0 mb-1';

  return (
    <div ref={menuRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => { if (status === 'idle') setOpen(!open); }}
        disabled={status === 'loading'}
        className="inline-flex items-center justify-center rounded-md min-w-[32px] min-h-[32px] px-1.5 py-1 text-xs text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted active:bg-muted/80 transition-colors disabled:opacity-50"
        title="Download"
      >
        {icon}
      </button>

      {open && (
        <div className={`${menuPositionClass} bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[160px] z-50`}>
          <button
            type="button"
            onClick={handleDownloadMd}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground hover:bg-muted transition-colors"
          >
            <FileTextIcon className="h-3.5 w-3.5 text-muted-foreground" />
            Markdown (.md)
          </button>
          <button
            type="button"
            onClick={handleDownloadPdf}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-foreground hover:bg-muted transition-colors"
          >
            <FileIcon className="h-3.5 w-3.5 text-muted-foreground" />
            PDF (.pdf)
          </button>
        </div>
      )}
    </div>
  );
}
