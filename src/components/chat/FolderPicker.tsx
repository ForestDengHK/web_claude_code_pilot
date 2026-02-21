'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { HugeiconsIcon } from "@hugeicons/react";
import { Folder01Icon, FolderOpenIcon, ArrowRight01Icon, ArrowUp01Icon, StarIcon, StarOffIcon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';

interface FolderEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  current: string;
  parent: string | null;
  directories: FolderEntry[];
  drives?: string[];
}

interface FavoriteDir {
  path: string;
  name: string;
}

type TabId = 'browse' | 'clone';

function extractRepoInfo(url: string): { name: string; cloneUrl: string } | null {
  const trimmed = url.trim();
  // Shorthand: user/repo
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    return { name: trimmed.split('/')[1], cloneUrl: `https://github.com/${trimmed}` };
  }
  // SSH: git@github.com:user/repo.git
  const sshMatch = trimmed.match(/git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) return { name: sshMatch[2], cloneUrl: trimmed };
  // HTTPS URL
  try {
    const u = new URL(trimmed);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return { name: parts[parts.length - 1].replace(/\.git$/, ''), cloneUrl: trimmed };
    }
  } catch { /* not a URL */ }
  return null;
}

interface FolderPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
  initialPath?: string;
}

export function FolderPicker({ open, onOpenChange, onSelect, initialPath }: FolderPickerProps) {
  const [activeTab, setActiveTab] = useState<TabId>('browse');
  const [currentDir, setCurrentDir] = useState('');
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [directories, setDirectories] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [drives, setDrives] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<FavoriteDir[]>([]);

  // Clone tab state
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneBaseDir, setCloneBaseDir] = useState('/Users/party/working');
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState('');
  const [cloneAlreadyExists, setCloneAlreadyExists] = useState<string | null>(null);

  // Fetch favorites and clone base dir when dialog opens
  useEffect(() => {
    if (open) {
      fetch('/api/favorites')
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data) setFavorites(data.favorites || []);
        })
        .catch(() => {});
      fetch('/api/settings/app')
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data?.settings?.clone_base_directory) {
            setCloneBaseDir(data.settings.clone_base_directory);
          }
        })
        .catch(() => {});
      // Reset clone tab state
      setCloneUrl('');
      setCloneError('');
      setCloneAlreadyExists(null);
      setCloning(false);
    }
  }, [open]);

  const isFavorite = useCallback((dirPath: string) => {
    return favorites.some(f => f.path === dirPath);
  }, [favorites]);

  const toggleFavorite = useCallback(async (dirPath: string, dirName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const isFav = isFavorite(dirPath);
    try {
      const res = await fetch('/api/favorites', {
        method: isFav ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath, name: dirName }),
      });
      if (res.ok) {
        const data = await res.json();
        setFavorites(data.favorites || []);
      }
    } catch { /* silent */ }
  }, [isFavorite]);

  const browse = useCallback(async (dir?: string, { updateInput = true }: { updateInput?: boolean } = {}) => {
    setLoading(true);
    try {
      const url = dir
        ? `/api/files/browse?dir=${encodeURIComponent(dir)}`
        : '/api/files/browse';
      const res = await fetch(url);
      if (res.ok) {
        const data: BrowseResponse = await res.json();
        setCurrentDir(data.current);
        setParentDir(data.parent);
        setDirectories(data.directories);
        if (updateInput) setPathInput(data.current);
        setDrives(data.drives || []);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      browse(initialPath || undefined);
    }
  }, [open, initialPath, browse]);

  const handleNavigate = (dir: string) => {
    browse(dir);
  };

  const handleGoUp = () => {
    if (parentDir) browse(parentDir);
  };

  // Debounced auto-browse: update directory list as user types
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlePathChange = (value: string) => {
    setPathInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const trimmed = value.trim();
      if (trimmed && trimmed !== currentDir) {
        browse(trimmed, { updateInput: false });
      }
    }, 400);
  };

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (pathInput.trim()) {
      browse(pathInput.trim());
    }
  };

  const handleSelect = () => {
    onSelect(currentDir);
    onOpenChange(false);
  };

  const repoInfo = extractRepoInfo(cloneUrl);

  const handleClone = async () => {
    if (!repoInfo) return;
    setCloning(true);
    setCloneError('');
    setCloneAlreadyExists(null);
    try {
      const res = await fetch('/api/git/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cloneUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCloneError(data.error || 'Clone failed');
        return;
      }
      if (data.alreadyExists) {
        setCloneAlreadyExists(data.path);
        return;
      }
      // Success — open session with cloned path
      onSelect(data.path);
      onOpenChange(false);
    } catch {
      setCloneError('Network error');
    } finally {
      setCloning(false);
    }
  };

  const handleOpenExisting = () => {
    if (cloneAlreadyExists) {
      onSelect(cloneAlreadyExists);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>Select Project Folder</DialogTitle>
        </DialogHeader>

        {/* Tab switcher */}
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          <button
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === 'browse'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('browse')}
          >
            <HugeiconsIcon icon={Folder01Icon} className="mr-1.5 inline h-4 w-4 align-text-bottom" />
            Browse
          </button>
          <button
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === 'clone'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('clone')}
          >
            <HugeiconsIcon icon={GitBranchIcon} className="mr-1.5 inline h-4 w-4 align-text-bottom" />
            Clone
          </button>
        </div>

        {activeTab === 'browse' ? (
          <>
            {/* Path input */}
            <form onSubmit={handlePathSubmit} className="flex gap-2">
              <Input
                value={pathInput}
                onChange={(e) => handlePathChange(e.target.value)}
                placeholder="/path/to/project"
                className="flex-1 font-mono text-sm"
              />
              <Button type="submit" variant="outline" size="sm">
                Go
              </Button>
            </form>

            {/* Directory browser */}
            <div className="rounded-md border border-border">
              {/* Current path + go up + drive switcher + star current */}
              <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleGoUp}
                  disabled={!parentDir}
                  className="shrink-0"
                >
                  <HugeiconsIcon icon={ArrowUp01Icon} className="h-4 w-4" />
                </Button>
                {drives.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-6 px-1.5 text-xs font-mono shrink-0">
                        {currentDir.charAt(0).toUpperCase()}:
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {drives.map((drive) => {
                        const letter = drive.charAt(0).toUpperCase();
                        const isCurrent = currentDir.toUpperCase().startsWith(letter + ':');
                        return (
                          <DropdownMenuItem
                            key={drive}
                            className="font-mono text-sm gap-2"
                            onClick={() => browse(drive)}
                          >
                            <span className={isCurrent ? 'font-bold' : ''}>{letter}:</span>
                            <span className="text-muted-foreground text-xs">{drive}</span>
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <span className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs font-mono text-muted-foreground">
                  {currentDir}
                </span>
                {currentDir && (
                  <button
                    className={`shrink-0 rounded p-1 transition-colors ${
                      isFavorite(currentDir)
                        ? 'text-yellow-500 hover:bg-yellow-500/10'
                        : 'text-muted-foreground hover:text-yellow-500 hover:bg-yellow-500/10'
                    }`}
                    onClick={(e) => toggleFavorite(currentDir, currentDir.split('/').pop() || currentDir, e)}
                    title={isFavorite(currentDir) ? 'Remove from favorites' : 'Add to favorites'}
                  >
                    <HugeiconsIcon icon={isFavorite(currentDir) ? StarIcon : StarOffIcon} className="h-4 w-4" />
                  </button>
                )}
              </div>

              {/* Folder list */}
              <ScrollArea className="h-64">
                {loading ? (
                  <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                    Loading...
                  </div>
                ) : directories.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                    No subdirectories
                  </div>
                ) : (
                  <div className="p-1">
                    {directories.map((dir) => (
                      <div
                        key={dir.path}
                        className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-accent transition-colors text-left group"
                      >
                        <button
                          className="flex flex-1 items-center gap-2 min-w-0"
                          onClick={() => handleNavigate(dir.path)}
                        >
                          <HugeiconsIcon icon={Folder01Icon} className="h-4 w-4 shrink-0 text-blue-500" />
                          <span className="truncate">{dir.name}</span>
                        </button>
                        <button
                          className={`shrink-0 rounded p-1 opacity-0 group-hover:opacity-100 transition-all ${
                            isFavorite(dir.path)
                              ? 'text-yellow-500 opacity-100 hover:bg-yellow-500/10'
                              : 'text-muted-foreground hover:text-yellow-500 hover:bg-yellow-500/10'
                          }`}
                          onClick={(e) => toggleFavorite(dir.path, dir.name, e)}
                          title={isFavorite(dir.path) ? 'Remove from favorites' : 'Add to favorites'}
                        >
                          <HugeiconsIcon icon={isFavorite(dir.path) ? StarIcon : StarOffIcon} className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="shrink-0 text-muted-foreground"
                          onClick={() => handleNavigate(dir.path)}
                        >
                          <HugeiconsIcon icon={ArrowRight01Icon} className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSelect} className="gap-2">
                <HugeiconsIcon icon={FolderOpenIcon} className="h-4 w-4" />
                Select This Folder
              </Button>
            </DialogFooter>
          </>
        ) : (
          /* Clone tab */
          <div className="space-y-4">
            <div className="space-y-2">
              <Input
                value={cloneUrl}
                onChange={(e) => {
                  setCloneUrl(e.target.value);
                  setCloneError('');
                  setCloneAlreadyExists(null);
                }}
                placeholder="https://github.com/user/repo  or  user/repo"
                className="font-mono text-sm"
                disabled={cloning}
              />
              {repoInfo && (
                <p className="text-xs font-mono text-muted-foreground truncate px-1">
                  Target: {cloneBaseDir}/{repoInfo.name}
                </p>
              )}
            </div>

            {cloneError && (
              <p className="text-sm text-destructive px-1">{cloneError}</p>
            )}

            {cloneAlreadyExists && (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 space-y-2">
                <p className="text-sm text-muted-foreground">Already cloned at this location.</p>
                <Button size="sm" onClick={handleOpenExisting} className="gap-2">
                  <HugeiconsIcon icon={FolderOpenIcon} className="h-4 w-4" />
                  Open Existing
                </Button>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleClone}
                disabled={!repoInfo || cloning}
                className="gap-2"
              >
                {cloning ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Cloning...
                  </>
                ) : (
                  <>
                    <HugeiconsIcon icon={GitBranchIcon} className="h-4 w-4" />
                    Clone & Open
                  </>
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
