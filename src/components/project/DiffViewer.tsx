"use client";

import { useState, useEffect } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Loading02Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

interface DiffViewerProps {
  workingDirectory: string;
  file: string;
  commit?: string;
  onClose: () => void;
  width: number;
}

type LineType = "add" | "remove" | "context" | "hunk" | "header";

interface DiffLine {
  type: LineType;
  content: string;
}

const lineStyles: Record<LineType, string> = {
  add: "bg-green-500/15 text-green-700 dark:text-green-300",
  remove: "bg-red-500/15 text-red-700 dark:text-red-300",
  context: "",
  hunk: "bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs font-medium",
  header: "text-muted-foreground text-xs",
};

const MAX_LINES = 10_000;

function classifyLine(line: string): LineType {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ")
  ) {
    return "header";
  }
  return "context";
}

function parseDiff(raw: string): { lines: DiffLine[]; truncated: boolean } {
  const rawLines = raw.split("\n");
  const truncated = rawLines.length > MAX_LINES;
  const slice = truncated ? rawLines.slice(0, MAX_LINES) : rawLines;
  const lines: DiffLine[] = slice.map((content) => ({
    type: classifyLine(content),
    content,
  }));
  return { lines, truncated };
}

/** Show last 2–3 path segments for brevity. */
function shortPath(file: string): string {
  const parts = file.split("/");
  return parts.slice(Math.max(0, parts.length - 3)).join("/");
}

export function DiffViewer({
  workingDirectory,
  file,
  commit,
  onClose,
  width,
}: DiffViewerProps) {
  const [lines, setLines] = useState<DiffLine[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workingDirectory || !file) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setLines([]);
    setTruncated(false);

    const params = new URLSearchParams({ dir: workingDirectory, file });
    if (commit) params.set("commit", commit);

    fetch(`/api/git/diff?${params}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
        } else {
          const { lines: parsed, truncated: trunc } = parseDiff(data.diff ?? "");
          setLines(parsed);
          setTruncated(trunc);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load diff");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workingDirectory, file, commit]);

  const shortCommit = commit ? commit.slice(0, 7) : null;
  const nonEmpty = lines.some((l) => l.type === "add" || l.type === "remove");

  return (
    <div
      data-mobile-overlay=""
      style={{ width }}
      className={cn(
        "flex flex-col overflow-hidden bg-background",
        "fixed inset-0 z-[60]",
        "md:static md:inset-auto md:z-auto md:h-full md:shrink-0 md:border-l md:border-border/40"
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 px-3 py-2 border-b shrink-0">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate" title={file}>
            {shortPath(file)}
          </p>
          {shortCommit && (
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
              {shortCommit}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onClose}
          aria-label="Close diff viewer"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={16} />
        </Button>
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground gap-2">
          <HugeiconsIcon icon={Loading02Icon} size={18} className="animate-spin" />
          <span className="text-sm">Loading diff…</span>
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center px-4">
          <p className="text-sm text-destructive text-center">{error}</p>
        </div>
      ) : !nonEmpty ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">No changes</p>
        </div>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="font-mono text-xs leading-5">
            {truncated && (
              <div className="px-3 py-1.5 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 text-xs border-b">
                Diff too large — showing first {MAX_LINES.toLocaleString()} lines only.
              </div>
            )}
            {lines.map((line, i) => (
              <div
                key={i}
                className={cn("px-3 whitespace-pre-wrap break-all", lineStyles[line.type])}
              >
                {line.content || "\u00a0"}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
