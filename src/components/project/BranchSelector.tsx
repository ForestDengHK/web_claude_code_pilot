"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { GitBranchIcon, Loading02Icon, AlertCircleIcon } from "@hugeicons/core-free-icons";
import { ChevronDownIcon, CheckIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface BranchSelectorProps {
  workingDirectory: string;
  /** Current branch from file tree API (initial value) */
  gitBranch: string | null;
  /** Session ID for persisting branch to DB */
  sessionId?: string | null;
  /** Called after successful branch switch so parent can refresh */
  onBranchChanged?: (newBranch: string) => void;
}

interface BranchesData {
  current: string | null;
  local: string[];
  remote: string[];
  dirty: boolean;
}

export function BranchSelector({ workingDirectory, gitBranch, sessionId, onBranchChanged }: BranchSelectorProps) {
  const [branches, setBranches] = useState<BranchesData | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Create branch form state
  const [showCreate, setShowCreate] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [creating, setCreating] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Delete branch state
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Whether the branch has unmerged changes and needs force delete
  const [deleteNeedsForce, setDeleteNeedsForce] = useState(false);

  // Display branch: prefer real-time git branch, fall back to prop
  const displayBranch = branches?.current ?? gitBranch;

  // Fetch branches when dropdown opens
  const fetchBranches = useCallback(async () => {
    if (!workingDirectory) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/git/branches?dir=${encodeURIComponent(workingDirectory)}`);
      if (res.ok) {
        const data: BranchesData = await res.json();
        setBranches(data);
      } else {
        setError('Failed to load branches');
      }
    } catch {
      setError('Failed to load branches');
    } finally {
      setLoading(false);
    }
  }, [workingDirectory]);

  // Refresh branch list when dropdown opens; reset create form when closed
  useEffect(() => {
    if (open) {
      fetchBranches();
    } else {
      setShowCreate(false);
      setNewBranchName("");
      setError(null);
    }
  }, [open, fetchBranches]);

  // Auto-focus name input when create form appears
  useEffect(() => {
    if (showCreate) {
      const t = setTimeout(() => nameInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [showCreate]);

  const persistBranch = useCallback((branch: string) => {
    if (sessionId) {
      fetch(`/api/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ git_branch: branch }),
      }).catch(() => { /* best-effort */ });
    }
  }, [sessionId]);

  const handleCheckout = useCallback(async (branch: string) => {
    if (!workingDirectory || branch === branches?.current) return;

    setSwitching(true);
    setError(null);
    try {
      const res = await fetch('/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: workingDirectory, branch }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Checkout failed');
        return;
      }

      setBranches(prev => prev ? { ...prev, current: data.branch } : null);
      persistBranch(data.branch);
      onBranchChanged?.(data.branch);
      setOpen(false);
    } catch {
      setError('Checkout failed');
    } finally {
      setSwitching(false);
    }
  }, [workingDirectory, branches?.current, persistBranch, onBranchChanged]);

  const handleCreateBranch = useCallback(async () => {
    const trimmed = newBranchName.trim();
    if (!trimmed || !workingDirectory) return;

    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/git/branch/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dir: workingDirectory,
          name: trimmed,
          base: branches?.current || undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to create branch');
        return;
      }

      setBranches(prev => prev ? {
        ...prev,
        current: data.branch,
        local: [...prev.local, data.branch].sort(),
      } : null);
      persistBranch(data.branch);
      onBranchChanged?.(data.branch);
      setOpen(false);
    } catch {
      setError('Failed to create branch');
    } finally {
      setCreating(false);
    }
  }, [newBranchName, workingDirectory, branches?.current, persistBranch, onBranchChanged]);

  const handleDeleteBranch = useCallback(async (force?: boolean) => {
    if (!deleteTarget || !workingDirectory) return;

    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch('/api/git/branch/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: workingDirectory, branch: deleteTarget, force }),
      });
      const data = await res.json();

      if (!res.ok) {
        if (data.code === 'NOT_FULLY_MERGED' && !force) {
          // Show force delete option
          setDeleteNeedsForce(true);
          setDeleteError(data.error);
          return;
        }
        setDeleteError(data.error || 'Failed to delete branch');
        return;
      }

      // Remove from local state
      setBranches(prev => prev ? {
        ...prev,
        local: prev.local.filter(b => b !== deleteTarget),
      } : null);
      setDeleteTarget(null);
      setDeleteNeedsForce(false);
    } catch {
      setDeleteError('Failed to delete branch');
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, workingDirectory]);

  // No branch = not a git repo, render nothing
  if (!displayBranch) return null;

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5",
              "text-[11px] font-mono text-muted-foreground",
              "hover:bg-accent hover:text-accent-foreground",
              "transition-colors cursor-pointer",
              "max-w-full outline-none",
              "focus-visible:ring-1 focus-visible:ring-ring",
            )}
          >
            <HugeiconsIcon icon={GitBranchIcon} className="size-3 shrink-0" />
            <span className="truncate">{displayBranch}</span>
            <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          className="w-64 max-w-[calc(100vw-2rem)]"
        >
          {/* Error banner */}
          {error && (
            <div className="flex items-start gap-2 px-2 py-1.5 text-xs text-destructive bg-destructive/5 rounded-sm mx-1 mb-1">
              <HugeiconsIcon icon={AlertCircleIcon} className="size-3.5 shrink-0 mt-0.5" />
              <span className="break-words">{error}</span>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-4">
              <HugeiconsIcon icon={Loading02Icon} className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : branches ? (
            <>
              {/* Local branches */}
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Local
              </DropdownMenuLabel>
              <DropdownMenuGroup>
                {branches.local.map((b) => (
                  <DropdownMenuItem
                    key={b}
                    disabled={switching}
                    onSelect={(e) => {
                      e.preventDefault();
                      handleCheckout(b);
                    }}
                    className="gap-2 font-mono text-xs group/branch"
                  >
                    <CheckIcon className={cn(
                      "size-3.5 shrink-0",
                      b === branches.current ? "opacity-100" : "opacity-0"
                    )} />
                    <span className="truncate">{b}</span>
                    {b === branches.current ? (
                      <span className="ml-auto text-[10px] text-muted-foreground font-sans">current</span>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          setDeleteTarget(b);
                          setDeleteError(null);
                          setDeleteNeedsForce(false);
                        }}
                        className="ml-auto p-0.5 rounded md:opacity-0 md:group-hover/branch:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity shrink-0"
                        title={`Delete ${b}`}
                      >
                        <Trash2Icon className="size-3" />
                      </button>
                    )}
                  </DropdownMenuItem>
                ))}
                {branches.local.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">No local branches</div>
                )}
              </DropdownMenuGroup>

              {/* Remote branches (if any, excluding those already in local) */}
              {branches.remote.length > 0 && (() => {
                const localSet = new Set(branches.local);
                const remoteOnly = branches.remote.filter(r => {
                  const shortName = r.replace(/^[^/]+\//, '');
                  return !localSet.has(shortName);
                });
                if (remoteOnly.length === 0) return null;
                return (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                      Remote
                    </DropdownMenuLabel>
                    <DropdownMenuGroup>
                      {remoteOnly.map((b) => (
                        <DropdownMenuItem
                          key={b}
                          disabled={switching}
                          onSelect={(e) => {
                            e.preventDefault();
                            const shortName = b.replace(/^[^/]+\//, '');
                            handleCheckout(shortName);
                          }}
                          className="gap-2 font-mono text-xs"
                        >
                          <CheckIcon className="size-3.5 shrink-0 opacity-0" />
                          <span className="truncate text-muted-foreground">{b}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </>
                );
              })()}

              {/* Dirty warning */}
              {branches.dirty && (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1.5 text-[10px] text-amber-600 dark:text-amber-400">
                    Working directory has uncommitted changes
                  </div>
                </>
              )}

              {/* Create new branch */}
              <DropdownMenuSeparator />
              {showCreate ? (
                <div
                  className="px-2 py-2 space-y-2"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <p className="text-[10px] text-muted-foreground">
                    New branch from <span className="font-mono font-medium text-foreground">{branches.current}</span>
                  </p>
                  <Input
                    ref={nameInputRef}
                    placeholder="feat/my-feature"
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newBranchName.trim()) {
                        handleCreateBranch();
                      } else if (e.key === 'Escape') {
                        setShowCreate(false);
                        setNewBranchName("");
                        setError(null);
                      }
                    }}
                    disabled={creating}
                    className="h-7 text-xs font-mono"
                  />
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      className="h-6 text-[11px] flex-1"
                      disabled={creating || !newBranchName.trim()}
                      onClick={handleCreateBranch}
                    >
                      {creating ? "Creating..." : "Create"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[11px]"
                      disabled={creating}
                      onClick={() => {
                        setShowCreate(false);
                        setNewBranchName("");
                        setError(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    setShowCreate(true);
                  }}
                  className="gap-2 text-xs"
                >
                  <PlusIcon className="size-3.5 shrink-0" />
                  Create new branch
                </DropdownMenuItem>
              )}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Delete branch confirmation dialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setDeleteTarget(null);
            setDeleteError(null);
            setDeleteNeedsForce(false);
          }
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">Delete branch</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>Are you sure you want to delete this branch?</p>
                <p className="rounded bg-muted px-2 py-1 font-mono text-xs text-foreground break-all">
                  {deleteTarget}
                </p>
                {deleteError && (
                  <p className="text-xs text-destructive">{deleteError}</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" disabled={deleting}>Cancel</AlertDialogCancel>
            {deleteNeedsForce ? (
              <AlertDialogAction
                size="sm"
                variant="destructive"
                onClick={() => handleDeleteBranch(true)}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Force delete"}
              </AlertDialogAction>
            ) : (
              <AlertDialogAction
                size="sm"
                variant="destructive"
                onClick={() => handleDeleteBranch(false)}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete"}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
