"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { RefreshIcon, Loading02Icon } from "@hugeicons/core-free-icons";
import { GitCommitHorizontalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePanel } from "@/hooks/usePanel";
import { CommitCard, type CommitSummary } from "./CommitCard";

interface HistoryPanelProps {
  workingDirectory: string;
}

interface ChangedFile {
  path: string;
  status: string;
}

const statusDotColors: Record<string, string> = {
  M: "bg-yellow-500",
  A: "bg-green-500",
  D: "bg-red-500",
  "?": "bg-green-500",
};

const statusColors: Record<string, string> = {
  M: "text-yellow-600 dark:text-yellow-400",
  A: "text-green-600 dark:text-green-400",
  D: "text-red-600 dark:text-red-400",
  "?": "text-green-600 dark:text-green-400",
};

const PAGE_SIZE = 50;

export function HistoryPanel({ workingDirectory }: HistoryPanelProps) {
  const { setDiffTarget } = usePanel();

  // Uncommitted changes state
  const [uncommitted, setUncommitted] = useState<ChangedFile[]>([]);
  const [loadingUncommitted, setLoadingUncommitted] = useState(false);

  // Commit log state
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const offsetRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchUncommitted = useCallback(async () => {
    if (!workingDirectory) return;
    setLoadingUncommitted(true);
    try {
      const res = await fetch(
        `/api/git/diff?dir=${encodeURIComponent(workingDirectory)}&listOnly=true`
      );
      if (res.ok) {
        const data = await res.json();
        setUncommitted(data.files ?? []);
      } else {
        setUncommitted([]);
      }
    } catch {
      setUncommitted([]);
    } finally {
      setLoadingUncommitted(false);
    }
  }, [workingDirectory]);

  const fetchCommits = useCallback(async (reset = false) => {
    if (!workingDirectory) return;

    const offset = reset ? 0 : offsetRef.current;

    if (reset) {
      setLoadingCommits(true);
    } else {
      setLoadingMore(true);
    }

    try {
      const res = await fetch(
        `/api/git/log?dir=${encodeURIComponent(workingDirectory)}&limit=${PAGE_SIZE}&offset=${offset}`
      );
      if (res.ok) {
        const data = await res.json();
        const fetched: CommitSummary[] = data.commits ?? [];
        if (reset) {
          setCommits(fetched);
          offsetRef.current = fetched.length;
        } else {
          setCommits((prev) => [...prev, ...fetched]);
          offsetRef.current = offset + fetched.length;
        }
        setHasMore(data.hasMore ?? false);
      } else {
        if (reset) setCommits([]);
        setHasMore(false);
      }
    } catch {
      if (reset) setCommits([]);
      setHasMore(false);
    } finally {
      setLoadingCommits(false);
      setLoadingMore(false);
    }
  }, [workingDirectory]);

  // Initial load
  useEffect(() => {
    if (!workingDirectory) return;
    offsetRef.current = 0;
    fetchUncommitted();
    fetchCommits(true);
  }, [workingDirectory, fetchUncommitted, fetchCommits]);

  const handleRefresh = useCallback(() => {
    offsetRef.current = 0;
    fetchUncommitted();
    fetchCommits(true);
  }, [fetchUncommitted, fetchCommits]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loadingMore || !hasMore) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 200) {
      fetchCommits(false);
    }
  }, [loadingMore, hasMore, fetchCommits]);

  const handleFileClick = useCallback(
    (file: string, commit?: string) => {
      setDiffTarget(commit ? { file, commit } : { file });
    },
    [setDiffTarget]
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b">
        <GitCommitHorizontalIcon className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium flex-1">History</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleRefresh}
          disabled={loadingCommits || loadingUncommitted}
          className="h-7 w-7 shrink-0"
          title="Refresh"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            className={cn(
              "h-3.5 w-3.5",
              (loadingCommits || loadingUncommitted) && "animate-spin"
            )}
          />
          <span className="sr-only">Refresh</span>
        </Button>
      </div>

      {/* Scrollable content */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto"
        onScroll={handleScroll}
      >
        {/* Uncommitted changes section */}
        {(uncommitted.length > 0 || loadingUncommitted) && (
          <>
            <div className="px-3 py-1.5 sticky top-0 bg-background/95 backdrop-blur-sm z-10">
              <p className="text-[10px] font-semibold tracking-wider uppercase text-muted-foreground">
                {loadingUncommitted
                  ? "UNCOMMITTED CHANGES"
                  : `UNCOMMITTED CHANGES (${uncommitted.length})`}
              </p>
            </div>

            {loadingUncommitted ? (
              <div className="flex items-center justify-center py-4">
                <HugeiconsIcon
                  icon={Loading02Icon}
                  className="h-4 w-4 animate-spin text-muted-foreground"
                />
              </div>
            ) : (
              <div className="pb-1">
                {uncommitted.map((f) => (
                  <button
                    key={f.path}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/50 transition-colors min-w-0"
                    onClick={() => handleFileClick(f.path)}
                  >
                    {/* Status dot */}
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full shrink-0",
                        statusDotColors[f.status] ?? "bg-muted-foreground"
                      )}
                    />
                    {/* Path */}
                    <span className="text-xs text-foreground truncate flex-1">
                      {f.path}
                    </span>
                    {/* Status letter */}
                    <span
                      className={cn(
                        "text-[10px] font-mono font-semibold shrink-0",
                        statusColors[f.status] ?? "text-muted-foreground"
                      )}
                    >
                      {f.status}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Separator */}
            <div className="border-b mx-3 mb-1" />
          </>
        )}

        {/* Commit log section */}
        {loadingCommits ? (
          <div className="flex items-center justify-center py-8">
            <HugeiconsIcon
              icon={Loading02Icon}
              className="h-4 w-4 animate-spin text-muted-foreground"
            />
          </div>
        ) : commits.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            No commits yet
          </p>
        ) : (
          <div>
            {commits.map((commit) => (
              <CommitCard
                key={commit.hash}
                commit={commit}
                workingDirectory={workingDirectory}
                onFileClick={(file, commitHash) => handleFileClick(file, commitHash)}
              />
            ))}

            {/* Loading more indicator */}
            {loadingMore && (
              <div className="flex items-center justify-center py-4">
                <HugeiconsIcon
                  icon={Loading02Icon}
                  className="h-4 w-4 animate-spin text-muted-foreground"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
