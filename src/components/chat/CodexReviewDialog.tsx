"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loading02Icon, RefreshIcon, SearchList01Icon, SourceCodeIcon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CodexReviewResponse } from "@/types";
import { usePanel } from "@/hooks/usePanel";
import { cn } from "@/lib/utils";

const streamdownPlugins = { cjk, code, math, mermaid };

/* ------------------------------------------------------------------ */
/*  Cache                                                             */
/* ------------------------------------------------------------------ */

interface CachedReviewEntry {
  response: CodexReviewResponse;
  reviewedAt: number;
}

const reviewCache = new Map<string, CachedReviewEntry>();

export function hasCachedCodexReview(sessionId: string): boolean {
  return reviewCache.has(sessionId);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** Color-coded priority: P1 = critical red, P2 = warning amber, P3 = info blue, P4+ = neutral */
function priorityColor(priority: number) {
  if (priority <= 1) return { bg: "bg-red-500/10 dark:bg-red-500/20", text: "text-red-600 dark:text-red-400", dot: "bg-red-500" };
  if (priority === 2) return { bg: "bg-amber-500/10 dark:bg-amber-500/20", text: "text-amber-600 dark:text-amber-400", dot: "bg-amber-500" };
  if (priority === 3) return { bg: "bg-blue-500/10 dark:bg-blue-500/20", text: "text-blue-600 dark:text-blue-400", dot: "bg-blue-500" };
  return { bg: "bg-muted", text: "text-muted-foreground", dot: "bg-muted-foreground/40" };
}

function priorityLabel(priority: number): string {
  if (priority <= 1) return "Critical";
  if (priority === 2) return "Warning";
  if (priority === 3) return "Info";
  return "Note";
}

/** Split absolute path into filename + directory for display */
function splitPath(absPath: string): { filename: string; directory: string } {
  const lastSlash = absPath.lastIndexOf("/");
  if (lastSlash < 0) return { filename: absPath, directory: "" };
  return {
    filename: absPath.slice(lastSlash + 1),
    directory: absPath.slice(0, lastSlash),
  };
}

function formatLineRange(start: number, end: number): string {
  return start === end ? `L${start}` : `L${start}\u2013${end}`;
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes <= 0) return `${remainder}s`;
  return `${minutes}m ${remainder}s`;
}

/** Clean up raw review event text for display.
 *  "Running: /bin/zsh -lc \"git diff -- src/foo.ts\"" → "git diff -- src/foo.ts" */
function formatReviewEvent(raw: string): string {
  let s = raw;
  // Strip "Running: " prefix
  if (s.startsWith("Running: ")) s = s.slice(9);
  // Strip shell wrapper: /bin/zsh -lc "..." or /bin/bash -lc '...'
  const shellMatch = s.match(/^\/bin\/(?:zsh|bash|sh)\s+-\w+\s+['"](.+)['"]$/);
  if (shellMatch) s = shellMatch[1];
  // Strip heredoc noise (<<'EOF' blocks)
  const heredocIdx = s.indexOf(" <<");
  if (heredocIdx > 0) s = s.slice(0, heredocIdx);
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  // Truncate long commands
  if (s.length > 120) s = s.slice(0, 117) + "…";
  return s || raw;
}

function formatReviewedAt(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

interface CodexReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  onRunningChange?: (running: boolean) => void;
}

export function CodexReviewDialog({
  open,
  onOpenChange,
  sessionId,
  onRunningChange,
}: CodexReviewDialogProps) {
  const { setPanelContent, setPanelOpen, setPreviewFile, setPreviewLine, setPreviewViewMode } = usePanel();
  const [review, setReview] = useState<CodexReviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noChanges, setNoChanges] = useState(false);
  const [selectedFindingIndex, setSelectedFindingIndex] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [reviewedAt, setReviewedAt] = useState<number | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  /** Live progress from the server (thinking preview, status text). */
  const [progressText, setProgressText] = useState("");
  const inFlightReviewRef = useRef<Promise<void> | null>(null);
  /** AbortController for the current fetch — aborted by visibilitychange recovery. */
  const reviewAbortRef = useRef<AbortController | null>(null);
  /** Timer for polling progress during review. */
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ---- run review ---- */

  const runReview = useCallback(async (options?: { force?: boolean }) => {
    if (inFlightReviewRef.current) {
      return inFlightReviewRef.current;
    }

    if (!options?.force) {
      const cachedReview = reviewCache.get(sessionId);
      if (cachedReview) {
        setReview(cachedReview.response);
        setReviewedAt(cachedReview.reviewedAt);
        setError(null);
        return;
      }
    }

    const pendingReview = (async () => {
      setLoading(true);
      setError(null);
      setNoChanges(false);
      setProgressText("");
      setStartedAt(Date.now());
      setElapsedSeconds(0);
      onRunningChange?.(true);

      const ac = new AbortController();
      reviewAbortRef.current = ac;

      // Start polling progress from the status endpoint so the UI shows
      // thinking/status updates while the long-running fetch blocks.
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
      progressTimerRef.current = setInterval(() => {
        fetch(`/api/codex/review/status?session_id=${encodeURIComponent(sessionId)}`)
          .then(res => res.ok ? res.json() : null)
          .then(status => {
            if (!status?.progress) return;
            const p = status.progress as {
              thinkingPreview?: string;
              statusText?: string;
              events?: string[];
            };
            // Prefer thinking preview > status text > last event
            const text = (p.thinkingPreview || p.statusText || "").trim();
            if (text) {
              setProgressText(text);
            } else if (p.events?.length) {
              // Review mode doesn't emit thinking/reasoning deltas — show
              // what Codex is actively running (tool executions) instead.
              setProgressText(formatReviewEvent(p.events[p.events.length - 1]));
            }
          })
          .catch(() => {});
      }, 2000);

      try {
        const response = await fetch("/api/codex/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, force: options?.force }),
          signal: ac.signal,
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Failed to run Codex review");
        }

        // Server signals no uncommitted changes — don't treat as error
        if (data.noChanges) {
          setNoChanges(true);
          return;
        }

        const completedAt = Date.now();
        setReview(data);
        setReviewedAt(completedAt);
        reviewCache.set(sessionId, {
          response: data,
          reviewedAt: completedAt,
        });
      } catch (err) {
        // Intentional abort from visibilitychange recovery — don't show error,
        // the recovery handler already set the result or re-issued the request.
        if (err instanceof DOMException && err.name === "AbortError") return;

        setError(err instanceof Error ? err.message : "Failed to run Codex review");
        if (!reviewCache.has(sessionId)) {
          setReview(null);
          setReviewedAt(null);
        }
      } finally {
        if (progressTimerRef.current) {
          clearInterval(progressTimerRef.current);
          progressTimerRef.current = null;
        }
        reviewAbortRef.current = null;
        inFlightReviewRef.current = null;
        setLoading(false);
        setStartedAt(null);
        setElapsedSeconds(0);
        setProgressText("");
        onRunningChange?.(false);
      }
    })();

    inFlightReviewRef.current = pendingReview;
    return pendingReview;
  }, [onRunningChange, sessionId]);

  /* ---- side-effects ---- */

  useEffect(() => {
    const cachedReview = reviewCache.get(sessionId) ?? null;
    setReview(cachedReview?.response ?? null);
    setReviewedAt(cachedReview?.reviewedAt ?? null);
    setError(null);
    setNoChanges(false);
    setProgressText("");
    setSelectedFindingIndex(0);
    setShowSummary(false);
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    if (loading) return;
    if (reviewCache.has(sessionId) || review || error || noChanges) return;
    void runReview();
  }, [open, loading, review, error, noChanges, runReview, sessionId]);

  useEffect(() => {
    if (!review?.findings.length) {
      setSelectedFindingIndex(0);
      return;
    }
    setSelectedFindingIndex((current) => Math.min(current, review.findings.length - 1));
  }, [review]);

  useEffect(() => {
    if (!loading || !startedAt) return;
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [loading, startedAt]);

  // Mobile resilience: when the tab resumes from background, the long-running
  // fetch for /api/codex/review may have been killed by the OS.  The server-
  // side review keeps running (or may have already finished) — poll the status
  // endpoint to retrieve the result without starting a new review.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      // Only act if a review was in-flight or just failed (possible dropped fetch)
      if (!loading && !error) return;
      if (!open) return;

      fetch(`/api/codex/review/status?session_id=${encodeURIComponent(sessionId)}`)
        .then(res => res.ok ? res.json() : null)
        .then(status => {
          if (!status) return;

          if (status.status === 'completed' && status.result) {
            // Review finished while we were away — use the cached result.
            // Abort the stale fetch first so its catch doesn't overwrite state.
            reviewAbortRef.current?.abort();

            const completedAt = Date.now();
            setReview(status.result);
            setReviewedAt(completedAt);
            reviewCache.set(sessionId, { response: status.result, reviewedAt: completedAt });
            setError(null);
            setLoading(false);
            setStartedAt(null);
            setElapsedSeconds(0);
            inFlightReviewRef.current = null;
            onRunningChange?.(false);
          } else if (status.status === 'failed' && status.error) {
            reviewAbortRef.current?.abort();
            setError(status.error);
            setLoading(false);
            setStartedAt(null);
            setElapsedSeconds(0);
            inFlightReviewRef.current = null;
            onRunningChange?.(false);
          } else if (status.status === 'running' && error) {
            // Review is still running but our fetch dropped — re-join.
            // Clear the error so runReview can proceed; the server registry
            // will deduplicate and return the same in-flight promise.
            setError(null);
            void runReview();
          }
        })
        .catch(() => {});
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    // iOS Safari sometimes fires focus without visibilitychange
    window.addEventListener('focus', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
    };
  }, [loading, error, open, sessionId, runReview, onRunningChange]);

  /* ---- handlers ---- */

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      if (!inFlightReviewRef.current) {
        setLoading(false);
        setStartedAt(null);
        setElapsedSeconds(0);
      }
      // Clean up progress polling when dialog closes
      if (progressTimerRef.current) {
        clearInterval(progressTimerRef.current);
        progressTimerRef.current = null;
      }
    }
    onOpenChange(nextOpen);
  }, [onOpenChange]);

  const handleOpenFinding = useCallback((index: number) => {
    if (!review) return;
    const finding = review.findings[index];
    if (!finding) return;
    setSelectedFindingIndex(index);
    setPanelContent("files");
    setPanelOpen(true);
    setPreviewFile(finding.code_location.absolute_file_path);
    setPreviewLine(finding.code_location.line_range.start);
    setPreviewViewMode("source");
  }, [review, setPanelContent, setPanelOpen, setPreviewFile, setPreviewLine, setPreviewViewMode]);

  const handleRunNewReview = useCallback(() => {
    setError(null);
    setNoChanges(false);
    setSelectedFindingIndex(0);
    setShowSummary(false);
    void runReview({ force: true });
  }, [runReview]);

  /* ---- derived ---- */

  const selectedFinding = review?.findings[selectedFindingIndex] ?? null;
  const reviewSummary = review?.review?.trim() || review?.overallExplanation?.trim() || "";
  const findingsCount = review?.findings.length ?? 0;

  /* ---- render ---- */

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[min(96vw,1600px)] gap-0 overflow-hidden p-0">
        {/* ---- Header ---- */}
        <DialogHeader className="border-b px-5 py-3.5 pr-14 sm:pr-16">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3 pr-8 sm:pr-0">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <HugeiconsIcon icon={SearchList01Icon} className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-sm font-semibold">Codex Review</DialogTitle>
                <DialogDescription className="truncate text-xs">
                  {reviewedAt
                    ? `Last reviewed ${formatReviewedAt(reviewedAt)}`
                    : "Uncommitted changes"}
                </DialogDescription>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pr-8 sm:pr-0">
              {review && findingsCount > 0 && (
                <Badge
                  variant="outline"
                  className="tabular-nums"
                >
                  {findingsCount} {findingsCount === 1 ? "finding" : "findings"}
                </Badge>
              )}
              {review && reviewSummary && (
                <Button
                  variant={showSummary ? "secondary" : "ghost"}
                  size="xs"
                  onClick={() => setShowSummary((v) => !v)}
                  className="text-xs"
                >
                  Summary
                </Button>
              )}
              {(review || noChanges) && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={handleRunNewReview}
                  disabled={loading}
                >
                  <HugeiconsIcon icon={RefreshIcon} className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Re-run</span>
                </Button>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* ---- Body ---- */}
        <div className="flex min-h-[400px] flex-col">
          {/* Loading */}
          {loading ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12">
              <div className="relative flex h-10 w-10 items-center justify-center">
                <span className="absolute inset-0 animate-ping rounded-full bg-primary/20" />
                <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-primary" />
              </div>
              <div className="w-full max-w-lg space-y-3 text-center">
                <p className="text-sm font-medium">Reviewing changes&hellip;</p>
                {progressText && (
                  <div className="mx-auto max-w-md rounded-lg border bg-muted/40 px-3 py-2">
                    <p className="break-words font-mono text-[11px] leading-relaxed text-foreground/70 sm:text-xs">
                      {progressText.slice(-200)}
                    </p>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  {formatElapsed(elapsedSeconds)} &middot; You can close this and keep working
                </p>
              </div>
            </div>

          /* No uncommitted changes */
          ) : noChanges ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <HugeiconsIcon icon={SearchList01Icon} className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="max-w-sm space-y-1 text-center">
                <p className="text-sm font-medium">No uncommitted changes</p>
                <p className="text-xs text-muted-foreground">
                  There are no staged or modified files to review. Make some changes and try again.
                </p>
              </div>
            </div>

          /* Error */
          ) : error ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16">
              <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-center text-sm text-foreground/80">
                {error}
              </div>
              <Button variant="outline" size="sm" onClick={() => void runReview()} disabled={loading}>
                <HugeiconsIcon icon={RefreshIcon} className="mr-1.5 h-3.5 w-3.5" />
                Retry
              </Button>
            </div>

          /* Summary overlay */
          ) : review && showSummary ? (
            <ScrollArea className="h-[min(82vh,860px)] min-h-0">
              <div className="mx-auto max-w-3xl px-6 py-6">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Review Summary</h3>
                  <div className="flex items-center gap-2">
                    {typeof review.overallCorrectness === "string" && review.overallCorrectness.trim() && (
                      <Badge variant="outline" className="text-[10px]">{review.overallCorrectness}</Badge>
                    )}
                    {typeof review.overallConfidenceScore === "number" && (
                      <Badge variant="outline" className="text-[10px]">
                        Confidence {review.overallConfidenceScore.toFixed(2)}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="rounded-xl border bg-card p-5">
                  <Streamdown
                    className="prose prose-sm max-w-none text-[14px] leading-7 dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-6 [&_ol]:pl-6 [&_code]:font-mono [&_pre]:overflow-x-auto"
                    plugins={streamdownPlugins}
                  >
                    {reviewSummary}
                  </Streamdown>
                </div>
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>

          /* Main two-column results */
          ) : review ? (
            <div className="grid h-[min(82vh,860px)] min-h-0 gap-0 lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
              {/* ---- Left: Findings list ---- */}
              {findingsCount > 0 ? (
                <ScrollArea className="border-b lg:border-b-0 lg:border-r">
                  <div className="p-3">
                    {review.findings.map((finding, index) => {
                      const pc = priorityColor(finding.priority);
                      const { filename } = splitPath(finding.code_location.absolute_file_path);
                      const startLine = finding.code_location.line_range.start;
                      const endLine = finding.code_location.line_range.end;
                      const isSelected = index === selectedFindingIndex;

                      return (
                        <button
                          key={`${finding.code_location.absolute_file_path}:${startLine}:${finding.title}`}
                          type="button"
                          onClick={() => handleOpenFinding(index)}
                          className={cn(
                            "group mb-1 flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                            isSelected
                              ? "bg-primary/[0.07] dark:bg-primary/[0.12]"
                              : "hover:bg-accent/50"
                          )}
                        >
                          {/* Priority dot */}
                          <span
                            className={cn(
                              "mt-[7px] h-2 w-2 shrink-0 rounded-full",
                              pc.dot
                            )}
                          />

                          <div className="min-w-0 flex-1">
                            {/* Title */}
                            <p className={cn(
                              "text-[13px] font-medium leading-5",
                              isSelected ? "text-foreground" : "text-foreground/85"
                            )}>
                              {finding.title}
                            </p>

                            {/* Meta line: filename + line range + priority */}
                            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                                <HugeiconsIcon icon={SourceCodeIcon} className="h-3 w-3 opacity-50" />
                                {filename}
                              </span>
                              <span className="text-[11px] tabular-nums text-muted-foreground/70">
                                {formatLineRange(startLine, endLine)}
                              </span>
                              <Badge
                                variant="secondary"
                                className={cn("h-4 px-1.5 text-[9px] font-semibold uppercase", pc.bg, pc.text)}
                              >
                                {priorityLabel(finding.priority)}
                              </Badge>
                            </div>
                          </div>

                          {/* Arrow indicator for selected */}
                          {isSelected && (
                            <HugeiconsIcon
                              icon={ArrowRight01Icon}
                              className="mt-1 hidden h-3.5 w-3.5 shrink-0 text-primary lg:block"
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </ScrollArea>
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 border-b p-6 lg:border-b-0 lg:border-r">
                  <span className="text-lg">&#10003;</span>
                  <p className="text-sm font-medium text-foreground">All clear</p>
                  <p className="text-xs text-muted-foreground">No issues found in uncommitted changes.</p>
                </div>
              )}

              {/* ---- Right: Finding detail ---- */}
              <ScrollArea className="min-h-0">
                {selectedFinding ? (
                  <div className="px-5 py-5 lg:px-6">
                    {/* Detail header */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="secondary"
                            className={cn(
                              "text-[10px] font-semibold uppercase",
                              priorityColor(selectedFinding.priority).bg,
                              priorityColor(selectedFinding.priority).text,
                            )}
                          >
                            P{selectedFinding.priority} &middot; {priorityLabel(selectedFinding.priority)}
                          </Badge>
                          <span className="text-[11px] tabular-nums text-muted-foreground">
                            Confidence {selectedFinding.confidence_score.toFixed(2)}
                          </span>
                        </div>
                        <h3 className="mt-2.5 text-base font-semibold leading-6 tracking-tight">
                          {selectedFinding.title}
                        </h3>
                      </div>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => handleOpenFinding(selectedFindingIndex)}
                        className="shrink-0"
                      >
                        Open File
                      </Button>
                    </div>

                    {/* File path */}
                    {(() => {
                      const { filename, directory } = splitPath(selectedFinding.code_location.absolute_file_path);
                      const startLine = selectedFinding.code_location.line_range.start;
                      const endLine = selectedFinding.code_location.line_range.end;
                      return (
                        <div className="mt-3 rounded-lg border bg-muted/40 px-3 py-2">
                          <div className="flex items-center gap-2">
                            <HugeiconsIcon icon={SourceCodeIcon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="font-mono text-[13px] font-medium text-foreground">{filename}</span>
                            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                              {formatLineRange(startLine, endLine)}
                            </span>
                          </div>
                          {directory && (
                            <p className="mt-0.5 pl-[22px] font-mono text-[11px] leading-4 text-muted-foreground/70">
                              {directory}
                            </p>
                          )}
                        </div>
                      );
                    })()}

                    {/* Body */}
                    <div className="mt-4 text-[13.5px] leading-7 text-foreground/85">
                      <Streamdown
                        className="prose prose-sm max-w-none dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-6 [&_ol]:pl-6 [&_code]:font-mono [&_code]:text-[12px] [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted/40"
                        plugins={streamdownPlugins}
                      >
                        {selectedFinding.body}
                      </Streamdown>
                    </div>

                    {/* Inline navigation */}
                    <div className="mt-5 flex items-center gap-2 border-t pt-4">
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={selectedFindingIndex <= 0}
                        onClick={() => handleOpenFinding(selectedFindingIndex - 1)}
                        className="text-xs text-muted-foreground"
                      >
                        &larr; Prev
                      </Button>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {selectedFindingIndex + 1} / {findingsCount}
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={selectedFindingIndex >= findingsCount - 1}
                        onClick={() => handleOpenFinding(selectedFindingIndex + 1)}
                        className="text-xs text-muted-foreground"
                      >
                        Next &rarr;
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                    Select a finding to view details.
                  </div>
                )}
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
