"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CommitSummary {
  hash: string;
  shortHash: string;
  subject: string;
  message: string;
  author: string;
  date: string;
  filesChanged: number;
}

interface CommitFileChange {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
}

interface CommitCardProps {
  commit: CommitSummary;
  workingDirectory: string;
  onFileClick: (file: string, commit: string) => void;
}

const statusColors: Record<string, string> = {
  M: "text-yellow-600 dark:text-yellow-400",
  A: "text-green-600 dark:text-green-400",
  D: "text-red-600 dark:text-red-400",
  R: "text-blue-600 dark:text-blue-400",
};

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function CommitCard({ commit, workingDirectory, onFileClick }: CommitCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<CommitFileChange[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleToggle() {
    const next = !expanded;
    setExpanded(next);

    // Fetch file details on first expand only
    if (next && files === null && !loading) {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/git/show?dir=${encodeURIComponent(workingDirectory)}&commit=${encodeURIComponent(commit.hash)}`
        );
        if (res.ok) {
          const data = await res.json();
          setFiles(data.files ?? []);
        } else {
          setFiles([]);
        }
      } catch {
        setFiles([]);
      } finally {
        setLoading(false);
      }
    }
  }

  // The multi-line body is the message minus the subject line
  const bodyLines = commit.message
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const hasBody =
    bodyLines.length > 0 &&
    !(bodyLines.length === 1 && bodyLines[0] === commit.subject.trim());

  return (
    <div className="border-b last:border-b-0">
      {/* Collapsed header — always visible */}
      <button
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
        onClick={handleToggle}
      >
        <ChevronRightIcon
          className={cn(
            "h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90"
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-mono text-[10px] text-muted-foreground shrink-0">
              {commit.shortHash}
            </span>
            <span className="text-xs text-foreground truncate">{commit.subject}</span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">
            {relativeTime(commit.date)}
          </div>
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {/* Author */}
          <p className="text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">{commit.author}</span>
          </p>

          {/* Full message body */}
          {hasBody && (
            <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words font-sans leading-relaxed">
              {bodyLines.join("\n")}
            </pre>
          )}

          {/* File list */}
          <div className="rounded-md bg-muted/60 overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-3">
                <HugeiconsIcon
                  icon={Loading02Icon}
                  className="h-4 w-4 animate-spin text-muted-foreground"
                />
              </div>
            ) : files && files.length > 0 ? (
              files.map((f) => (
                <button
                  key={f.path}
                  className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-muted transition-colors text-xs min-w-0"
                  onClick={() => onFileClick(f.path, commit.hash)}
                >
                  {/* Status letter */}
                  <span
                    className={cn(
                      "font-mono font-bold shrink-0 text-[11px]",
                      statusColors[f.status] ?? "text-muted-foreground"
                    )}
                  >
                    {f.status}
                  </span>
                  {/* Path */}
                  <span className="truncate text-foreground flex-1">{f.path}</span>
                  {/* Stats */}
                  {f.insertions >= 0 && f.deletions >= 0 && (
                    <span className="shrink-0 text-[10px] tabular-nums">
                      {f.insertions > 0 && (
                        <span className="text-green-600 dark:text-green-400">
                          +{f.insertions}
                        </span>
                      )}
                      {f.insertions > 0 && f.deletions > 0 && (
                        <span className="text-muted-foreground"> </span>
                      )}
                      {f.deletions > 0 && (
                        <span className="text-red-600 dark:text-red-400">
                          -{f.deletions}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              ))
            ) : files !== null ? (
              <p className="px-3 py-2 text-[11px] text-muted-foreground">No files changed</p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
