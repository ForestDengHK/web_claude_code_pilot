"use client";

/**
 * Markdown editor for a single CLAUDE.md file (user- or project-scoped).
 *
 * Self-contained: fetches its own content on mount via GET /api/claude-md,
 * saves via PUT. The parent (ClaudeMdSection) provides scope + cwd and
 * handles tab switching; this component only knows about one file at a time.
 *
 * UX mirrors SkillEditor (edit / preview / split + Save button + dirty dot
 * + Cmd/Ctrl-S shortcut + Tab indent) so users feel at home moving between
 * the two.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  FloppyDiskIcon,
  EyeIcon,
  Edit02Icon,
  Loading02Icon,
  LayoutTwoColumnIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import type { ClaudeMdScope } from "@/lib/claude-md-fs";

type ViewMode = "edit" | "preview" | "split";

interface ClaudeMdEditorProps {
  scope: ClaudeMdScope;
  /** Required for project scope; ignored for user scope. */
  cwd?: string;
  /** Optional placeholder when the file doesn't exist yet. */
  emptyTemplate?: string;
}

interface LoadedState {
  exists: boolean;
  content: string;
  path: string;
  mtimeMs?: number;
}

export function ClaudeMdEditor({
  scope,
  cwd,
  emptyTemplate = "",
}: ClaudeMdEditorProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("edit");
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isDirty = !!loaded && content !== loaded.content;
  const disabled = scope === "project" && !cwd;

  // --- Fetch on mount / when scope or cwd changes -------------------------
  const reload = useCallback(async () => {
    if (disabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ scope });
      if (cwd) params.set("cwd", cwd);
      const res = await fetch(`/api/claude-md?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.error ?? `HTTP ${res.status}`);
        setLoaded(null);
        setContent("");
        return;
      }
      const next: LoadedState = {
        exists: !!data.exists,
        content: data.content ?? "",
        path: data.path ?? "",
        mtimeMs: typeof data.mtimeMs === "number" ? data.mtimeMs : undefined,
      };
      setLoaded(next);
      // If the file is empty / doesn't exist, seed the editor with the
      // empty template so the user has a starting structure. If they don't
      // want it, hitting save-with-empty-content still works.
      setContent(next.exists ? next.content : emptyTemplate);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "load failed");
      setLoaded(null);
      setContent("");
    } finally {
      setLoading(false);
    }
  }, [scope, cwd, emptyTemplate, disabled]);

  useEffect(() => {
    reload();
  }, [reload]);

  // --- Save ---------------------------------------------------------------
  const handleSave = useCallback(async () => {
    if (!loaded || saving || disabled) return;
    setSaving(true);
    try {
      const res = await fetch("/api/claude-md", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, content }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? `Save failed (HTTP ${res.status})`);
        return;
      }
      setLoaded({ ...loaded, exists: true, content, mtimeMs: Date.now() });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success("CLAUDE.md saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }, [loaded, saving, disabled, scope, cwd, content]);

  // --- Keyboard shortcuts -------------------------------------------------
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const newContent =
          content.substring(0, start) + "  " + content.substring(end);
        setContent(newContent);
        requestAnimationFrame(() => {
          textarea.selectionStart = start + 2;
          textarea.selectionEnd = start + 2;
        });
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty) handleSave();
      }
    },
    [content, isDirty, handleSave],
  );

  // --- Render -------------------------------------------------------------
  if (disabled) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Open a project (set a working directory) to edit the project-level
        CLAUDE.md.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm">
        <p className="text-destructive">{loadError}</p>
        <Button variant="outline" size="sm" onClick={reload}>
          <HugeiconsIcon icon={RefreshIcon} className="h-3 w-3 mr-1" />
          Retry
        </Button>
      </div>
    );
  }

  const markdownContent = (
    <div className="prose prose-sm dark:prose-invert max-w-none p-4 overflow-auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content || "_(empty)_"}
      </ReactMarkdown>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-semibold">CLAUDE.md</span>
          {isDirty && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-orange-400"
              title="Unsaved changes"
            />
          )}
          {loaded && !loaded.exists && (
            <span className="shrink-0 rounded border border-border px-1.5 py-0 text-[10px] text-muted-foreground">
              new
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={viewMode === "edit" ? "secondary" : "ghost"}
                size="icon-xs"
                onClick={() => setViewMode("edit")}
                aria-label="Edit view"
                title="Edit"
              >
                <HugeiconsIcon icon={Edit02Icon} className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={viewMode === "preview" ? "secondary" : "ghost"}
                size="icon-xs"
                onClick={() => setViewMode("preview")}
                aria-label="Preview view"
                title="Preview"
              >
                <HugeiconsIcon icon={EyeIcon} className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Preview</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={viewMode === "split" ? "secondary" : "ghost"}
                size="icon-xs"
                onClick={() => setViewMode("split")}
                aria-label="Split view"
                title="Split"
              >
                <HugeiconsIcon
                  icon={LayoutTwoColumnIcon}
                  className="h-3 w-3"
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Split</TooltipContent>
          </Tooltip>

          <div className="mx-1 h-4 w-px bg-border" />

          <Button
            size="xs"
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="gap-1"
          >
            {saving ? (
              <HugeiconsIcon
                icon={Loading02Icon}
                className="h-3 w-3 animate-spin"
              />
            ) : (
              <HugeiconsIcon icon={FloppyDiskIcon} className="h-3 w-3" />
            )}
            {saving ? "Saving" : saved ? "Saved" : "Save"}
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {viewMode === "edit" && (
          <Textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-full w-full min-h-[400px] resize-none rounded-none border-0 font-mono text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
            placeholder="# CLAUDE.md&#10;&#10;Project/user-level instructions for Claude Code…"
          />
        )}
        {viewMode === "preview" && (
          <div className="h-full overflow-auto">{markdownContent}</div>
        )}
        {viewMode === "split" && (
          <div className="flex h-full divide-x divide-border">
            <div className="min-w-0 flex-1">
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={handleKeyDown}
                className="h-full w-full resize-none rounded-none border-0 font-mono text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
                placeholder="# CLAUDE.md…"
              />
            </div>
            <div className="min-w-0 flex-1 overflow-auto">
              {markdownContent}
            </div>
          </div>
        )}
      </div>

      {/* Footer (path) */}
      {loaded?.path && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-1.5">
          <span className="truncate text-xs text-muted-foreground">
            {loaded.path}
          </span>
        </div>
      )}
    </div>
  );
}
