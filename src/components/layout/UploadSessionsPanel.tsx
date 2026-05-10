"use client";

import { useState, useMemo, useCallback, useEffect, useRef, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Loading02Icon,
  FolderOpenIcon,
  GitBranchIcon,
  ClockIcon,
  FileImportIcon,
  MessageAddIcon,
  CheckmarkCircle02Icon,
  Alert02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import {
  extractSessionInfoFromContent,
  decodeProjectPath,
  type ClaudeSessionInfo,
} from "@/lib/claude-session-shared";

interface KnownCwd {
  cwd: string;
  basename: string;
}

type MatchType = "by-name" | "no-match" | "multiple-candidates" | "edited";

interface UploadCandidate {
  /** Session UUID — also the filename without .jsonl */
  sessionId: string;
  /** Parsed metadata from the jsonl file */
  info: ClaudeSessionInfo;
  /** The original File for upload */
  file: File;
  /** The cwd recorded inside the jsonl */
  originalCwd: string;
  /** Target cwd to install at on the server (editable) */
  targetCwd: string;
  /** How targetCwd was derived */
  matchType: MatchType;
  /** All cwds on server with same basename — used for the dropdown */
  candidates: string[];
}

interface UploadResult {
  sessionId: string;
  status: string;
  detail?: string;
  codepilotSessionId?: string;
  existingCodepilotSessionId?: string;
  resolvedCwd?: string;
}

interface UploadSessionsPanelProps {
  onClose: () => void;
}

type ClientOS = "mac" | "linux" | "windows" | "other";

function detectOS(): ClientOS {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS/i.test(ua)) return "mac";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "other";
}

function osHintPath(os: ClientOS): string {
  switch (os) {
    case "windows":
      return "%USERPROFILE%\\.claude\\projects\\";
    case "mac":
    case "linux":
      return "~/.claude/projects/";
    default:
      return "~/.claude/projects/";
  }
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pathBasename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function matchTypeBadge(t: MatchType): { label: string; variant: "default" | "secondary" | "outline" | "destructive" } {
  switch (t) {
    case "by-name":
      return { label: "Matched by name", variant: "secondary" };
    case "multiple-candidates":
      return { label: "Multiple matches", variant: "outline" };
    case "edited":
      return { label: "Edited", variant: "secondary" };
    case "no-match":
      return { label: "No match", variant: "outline" };
  }
}

export function UploadSessionsPanel({ onClose }: UploadSessionsPanelProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<"pick" | "loading" | "review" | "uploading" | "done">("pick");
  const [candidates, setCandidates] = useState<UploadCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [knownCwds, setKnownCwds] = useState<KnownCwd[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<UploadResult[]>([]);
  const os = useMemo(detectOS, []);

  const handleFolderPick = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      if (!fileList || fileList.length === 0) return;

      setPhase("loading");
      setError(null);

      // Filter to .jsonl files
      const jsonlFiles: File[] = [];
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        if (f.name.endsWith(".jsonl")) jsonlFiles.push(f);
      }
      if (jsonlFiles.length === 0) {
        setError(
          "No .jsonl files found in the selected folder. Make sure you picked your Claude Code projects directory.",
        );
        setPhase("pick");
        return;
      }

      // Fetch known cwds from server (in parallel with parsing)
      const knownCwdsPromise = fetch("/api/claude-sessions/known-cwds")
        .then(r => r.json())
        .then((d): KnownCwd[] => d.cwds || [])
        .catch(() => [] as KnownCwd[]);

      // Parse each file client-side
      const parsed: UploadCandidate[] = [];
      for (const file of jsonlFiles) {
        const sessionId = file.name.replace(/\.jsonl$/, "");

        // Derive a fallback projectPath from the parent directory name (decoded).
        const rel = file.webkitRelativePath || file.name;
        const parts = rel.split("/");
        const parentDir = parts.length >= 2 ? parts[parts.length - 2] : "";
        const fallbackProjectPath = parentDir ? decodeProjectPath(parentDir) : "";

        let content: string;
        try {
          content = await file.text();
        } catch {
          continue;
        }

        const info = extractSessionInfoFromContent(content, sessionId, fallbackProjectPath, {
          fileSize: file.size,
          mtimeMs: file.lastModified,
        });
        if (!info) continue; // skip empty / unparseable

        parsed.push({
          sessionId,
          info,
          file,
          originalCwd: info.cwd,
          targetCwd: info.cwd, // placeholder, will be overwritten by matching
          matchType: "no-match",
          candidates: [],
        });
      }

      const known = await knownCwdsPromise;

      // Build basename → cwds map for matching
      const basenameMap = new Map<string, string[]>();
      for (const k of known) {
        const lower = k.basename.toLowerCase();
        const list = basenameMap.get(lower) || [];
        list.push(k.cwd);
        basenameMap.set(lower, list);
      }

      // Apply matching
      for (const c of parsed) {
        const bn = pathBasename(c.originalCwd).toLowerCase();
        const matches = basenameMap.get(bn) || [];
        if (matches.length === 1) {
          c.targetCwd = matches[0];
          c.matchType = "by-name";
          c.candidates = matches;
        } else if (matches.length > 1) {
          c.targetCwd = matches[0];
          c.matchType = "multiple-candidates";
          c.candidates = matches;
        } else {
          c.targetCwd = c.originalCwd; // keep original; user may edit
          c.matchType = "no-match";
          c.candidates = [];
        }
      }

      // Sort newest-first like the import dialog
      parsed.sort((a, b) => new Date(b.info.updatedAt).getTime() - new Date(a.info.updatedAt).getTime());

      setKnownCwds(known);
      setCandidates(parsed);
      setSelected(new Set(parsed.map(c => c.sessionId)));
      setPhase("review");
    },
    [],
  );

  const toggleSelected = useCallback((sessionId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const editTargetCwd = useCallback((sessionId: string, newCwd: string) => {
    setCandidates(prev =>
      prev.map(c =>
        c.sessionId === sessionId
          ? { ...c, targetCwd: newCwd, matchType: "edited" }
          : c,
      ),
    );
  }, []);

  const handleSelectAll = useCallback((value: boolean) => {
    if (value) setSelected(new Set(candidates.map(c => c.sessionId)));
    else setSelected(new Set());
  }, [candidates]);

  const handleUpload = useCallback(async () => {
    const toUpload = candidates.filter(c => selected.has(c.sessionId));
    if (toUpload.length === 0) return;

    setPhase("uploading");
    setError(null);

    const formData = new FormData();
    formData.append(
      "metadata",
      JSON.stringify(
        toUpload.map(c => ({
          sessionId: c.sessionId,
          originalCwd: c.originalCwd,
          targetCwd: c.targetCwd,
        })),
      ),
    );
    for (const c of toUpload) {
      formData.append("files", c.file, `${c.sessionId}.jsonl`);
    }

    try {
      const res = await fetch("/api/claude-sessions/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Upload failed (${res.status})`);
      }
      setResults(data.results || []);
      setPhase("done");
      // Notify chat list to refresh
      window.dispatchEvent(new CustomEvent("session-created"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("review");
    }
  }, [candidates, selected]);

  const handleResetToPick = useCallback(() => {
    setCandidates([]);
    setSelected(new Set());
    setResults([]);
    setError(null);
    setPhase("pick");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // Reset when component unmounts (e.g., dialog closed)
  useEffect(() => () => undefined, []);

  // Render phases
  if (phase === "pick") {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center gap-4">
        <HugeiconsIcon icon={FolderOpenIcon} className="h-10 w-10 text-muted-foreground/50" />
        <div className="space-y-2 max-w-md">
          <p className="text-sm font-medium">Upload sessions from another machine</p>
          <p className="text-xs text-muted-foreground">
            On <strong className="text-foreground">{os === "windows" ? "Windows" : os === "mac" ? "macOS" : os === "linux" ? "Linux" : "your device"}</strong>,
            navigate to your Claude Code projects directory and select the folder:
          </p>
          <code className="block text-xs bg-muted px-2 py-1.5 rounded font-mono break-all">
            {osHintPath(os)}
          </code>
          <p className="text-[11px] text-muted-foreground/80">
            All <code className="font-mono">.jsonl</code> files inside will be parsed locally —
            nothing is uploaded until you confirm.
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          // @ts-expect-error — webkitdirectory is non-standard but supported by all major browsers
          webkitdirectory=""
          directory=""
          multiple
          className="hidden"
          onChange={handleFolderPick}
        />
        <Button onClick={() => fileInputRef.current?.click()} size="sm">
          <HugeiconsIcon icon={FolderOpenIcon} className="h-4 w-4 mr-1.5" />
          Select folder
        </Button>
        {error && (
          <p className="text-xs text-destructive max-w-md">{error}</p>
        )}
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div className="flex items-center justify-center py-12">
        <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Reading sessions...</span>
      </div>
    );
  }

  if (phase === "uploading") {
    return (
      <div className="flex items-center justify-center py-12">
        <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Uploading {selected.size} session(s)...</span>
      </div>
    );
  }

  if (phase === "done") {
    const imported = results.filter(r => r.status === "imported");
    const skipped = results.filter(r => r.status !== "imported");

    return (
      <div className="flex flex-col gap-3 py-2">
        {imported.length > 0 && (
          <div className="rounded-md bg-emerald-500/10 border border-emerald-500/20 px-3 py-2">
            <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
              <HugeiconsIcon icon={CheckmarkCircle02Icon} className="h-4 w-4" />
              Imported {imported.length} session{imported.length !== 1 ? "s" : ""}
            </div>
          </div>
        )}
        {skipped.length > 0 && (
          <div className="rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2">
            <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300 mb-1.5">
              <HugeiconsIcon icon={Alert02Icon} className="h-4 w-4" />
              Skipped {skipped.length} session{skipped.length !== 1 ? "s" : ""}
            </div>
            <ul className="text-xs space-y-0.5 ml-6 text-muted-foreground">
              {skipped.map(r => (
                <li key={r.sessionId} className="font-mono">
                  {r.sessionId.slice(0, 8)}… — {r.status}
                  {r.detail ? `: ${r.detail}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={handleResetToPick}>
            Upload more
          </Button>
          {imported.length > 0 && (
            <Button
              size="sm"
              onClick={() => {
                onClose();
                router.push(`/chat/${imported[0].codepilotSessionId}`);
              }}
            >
              Open first session
            </Button>
          )}
          {imported.length === 0 && (
            <Button size="sm" onClick={onClose}>Close</Button>
          )}
        </div>
      </div>
    );
  }

  // phase === "review"
  const allSelected = candidates.length > 0 && selected.size === candidates.length;
  const someSelected = selected.size > 0 && !allSelected;

  return (
    <div className="flex flex-col min-h-0 flex-1 gap-2">
      {/* Datalist for known cwds — reused across all rows */}
      <datalist id="codepilot-known-cwds">
        {knownCwds.map(k => (
          <option key={k.cwd} value={k.cwd}>{k.basename}</option>
        ))}
      </datalist>

      <div className="flex items-center justify-between text-xs">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={allSelected}
            ref={el => { if (el) el.indeterminate = someSelected; }}
            onChange={e => handleSelectAll(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span className="text-muted-foreground">
            {selected.size} of {candidates.length} selected
          </span>
        </label>
        <Button variant="ghost" size="sm" onClick={handleResetToPick} className="h-7 text-xs">
          Pick a different folder
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6">
        <div className="flex flex-col gap-2 pb-2">
          {candidates.map(c => {
            const isSelected = selected.has(c.sessionId);
            const totalMessages = c.info.userMessageCount + c.info.assistantMessageCount;
            const badge = matchTypeBadge(c.matchType);

            return (
              <div
                key={c.sessionId}
                className={cn(
                  "flex flex-col gap-1.5 rounded-lg border p-3 transition-colors",
                  isSelected ? "bg-accent/30" : "opacity-70",
                )}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelected(c.sessionId)}
                    className="h-3.5 w-3.5 mt-1 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-medium text-sm truncate">
                        {c.info.projectName}
                      </span>
                      {c.info.gitBranch && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                          <HugeiconsIcon icon={GitBranchIcon} className="h-2.5 w-2.5 mr-0.5" />
                          {c.info.gitBranch}
                        </Badge>
                      )}
                      <Badge variant={badge.variant} className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                        {badge.label}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2 break-all">
                      {c.info.preview}
                    </p>

                    {/* Mapping row */}
                    <div className="mt-2 flex flex-col gap-0.5 text-[11px]">
                      <span className="text-muted-foreground/70 font-mono break-all">
                        from: {c.originalCwd}
                      </span>
                      <div className="flex items-center gap-1">
                        <span className="text-muted-foreground/60 shrink-0">→</span>
                        <Input
                          value={c.targetCwd}
                          list="codepilot-known-cwds"
                          onChange={e => editTargetCwd(c.sessionId, e.target.value)}
                          className="h-6 text-[11px] font-mono"
                          placeholder="Target path on this server"
                        />
                      </div>
                    </div>

                    {/* Metadata row */}
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60 mt-1.5 flex-wrap">
                      <span className="flex items-center gap-0.5 shrink-0">
                        <HugeiconsIcon icon={MessageAddIcon} className="h-2.5 w-2.5" />
                        {totalMessages} msg{totalMessages !== 1 ? "s" : ""}
                      </span>
                      <span className="flex items-center gap-0.5 shrink-0">
                        <HugeiconsIcon icon={ClockIcon} className="h-2.5 w-2.5" />
                        {formatRelativeTime(c.info.updatedAt)}
                      </span>
                      <span className="shrink-0">{formatFileSize(c.info.fileSize)}</span>
                      {c.info.version && <span className="shrink-0">v{c.info.version}</span>}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex justify-end pt-2 border-t">
        <Button onClick={handleUpload} disabled={selected.size === 0} size="sm">
          <HugeiconsIcon icon={FileImportIcon} className="h-3.5 w-3.5 mr-1.5" />
          Upload &amp; import {selected.size} session{selected.size !== 1 ? "s" : ""}
        </Button>
      </div>
    </div>
  );
}
