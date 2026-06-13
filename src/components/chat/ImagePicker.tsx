'use client';

import { useState, useEffect, useCallback } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Folder01Icon, ArrowUp01Icon, Image01Icon } from '@hugeicons/core-free-icons';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

interface Entry {
  name: string;
  path: string;
}

interface BrowseResponse {
  current: string;
  parent: string | null;
  directories: Entry[];
  files: Entry[];
}

interface ImagePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the absolute path of the chosen image file. */
  onSelect: (path: string) => void;
  /** Directory to start browsing in. Defaults to the user's home directory. */
  initialPath?: string;
}

function rawUrl(filePath: string): string {
  return `/api/files/raw?path=${encodeURIComponent(filePath)}`;
}

/**
 * Browse the filesystem and pick an image file (with thumbnails). Used by the
 * `/img` command when no path is typed, so the user can select an image instead
 * of typing its full path.
 */
export function ImagePicker({ open, onOpenChange, onSelect, initialPath }: ImagePickerProps) {
  const [currentDir, setCurrentDir] = useState('');
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [directories, setDirectories] = useState<Entry[]>([]);
  const [files, setFiles] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const browse = useCallback(async (dir?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ images: '1' });
      if (dir) params.set('dir', dir);
      const res = await fetch(`/api/files/browse?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const data: BrowseResponse = await res.json();
      setCurrentDir(data.current);
      setParentDir(data.parent);
      setDirectories(data.directories || []);
      setFiles(data.files || []);
      setFilter('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Start browsing when the dialog opens (home dir unless an initialPath is given).
  useEffect(() => {
    if (open) browse(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = useCallback((filePath: string) => {
    onSelect(filePath);
    onOpenChange(false);
  }, [onSelect, onOpenChange]);

  // Live filter of the current folder's entries by the typed text. A path-like
  // value (starts with / or ~) is treated as a jump target on Enter, not a
  // filter, so it doesn't blank the list while being typed.
  const trimmed = filter.trim();
  const q = trimmed.startsWith('/') || trimmed.startsWith('~') ? '' : trimmed.toLowerCase();
  const shownDirs = q ? directories.filter((d) => d.name.toLowerCase().includes(q)) : directories;
  const shownFiles = q ? files.filter((f) => f.name.toLowerCase().includes(q)) : files;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Select an image</DialogTitle>
        </DialogHeader>

        {/* Current location (read-only) + up button */}
        <div className="flex items-center gap-2">
          <Button
            size="icon"
            variant="outline"
            className="h-8 w-8 shrink-0"
            onClick={() => parentDir && browse(parentDir)}
            disabled={!parentDir || loading}
            aria-label="Up one folder"
          >
            <HugeiconsIcon icon={ArrowUp01Icon} className="h-4 w-4" />
          </Button>
          <div
            className="min-w-0 flex-1 truncate rounded-md border bg-muted/30 px-2 py-1.5 text-left font-mono text-xs text-muted-foreground"
            title={currentDir}
            dir="rtl"
          >
            {/* dir=rtl keeps the current folder (path tail) visible when truncated */}
            <bdi>{currentDir || '…'}</bdi>
          </div>
        </div>

        {/* Type to filter the current folder live; or paste a /full/path
            (or ~/path) and press Enter to jump there — needed to reach folders
            macOS won't let us list (Desktop/Documents/Downloads) by opening a
            readable subfolder directly. */}
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            const v = filter.trim();
            if (e.key === 'Enter' && (v.startsWith('/') || v.startsWith('~'))) {
              e.preventDefault();
              browse(v);
            }
          }}
          placeholder="Filter… or paste a /path + Enter"
          className="h-8"
          spellCheck={false}
        />

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : (
            <div className="p-2">
              {/* Folders */}
              {shownDirs.length > 0 && (
                <ul className="mb-2 divide-y">
                  {shownDirs.map((d) => (
                    <li key={d.path}>
                      <button
                        type="button"
                        onClick={() => browse(d.path)}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                      >
                        <HugeiconsIcon icon={Folder01Icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{d.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* Image files — thumbnail grid */}
              {shownFiles.length > 0 ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {shownFiles.map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => pick(f.path)}
                      className="group flex flex-col overflow-hidden rounded-md border bg-muted/30 text-left transition hover:border-primary hover:ring-1 hover:ring-primary"
                      title={f.path}
                    >
                      <div className="flex aspect-square items-center justify-center overflow-hidden bg-[repeating-conic-gradient(#e0e0e0_0%_25%,transparent_0%_50%)] bg-[length:12px_12px] dark:bg-[repeating-conic-gradient(#333_0%_25%,transparent_0%_50%)]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={rawUrl(f.path)}
                          alt={f.name}
                          loading="lazy"
                          className="h-full w-full object-contain"
                        />
                      </div>
                      <span className="truncate px-2 py-1 text-[11px] text-muted-foreground group-hover:text-foreground">
                        {f.name}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                shownDirs.length === 0 && (
                  <div className="p-6 text-center text-xs text-muted-foreground">
                    {q ? `No folders or images match "${filter.trim()}".` : 'No images or subfolders here.'}
                  </div>
                )
              )}

              {shownFiles.length === 0 && shownDirs.length > 0 && !q && (
                <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                  No images in this folder — open a subfolder above.
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
