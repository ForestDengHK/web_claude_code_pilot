"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useTheme } from "next-themes";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Copy01Icon, Tick01Icon, Loading02Icon, ArrowExpandIcon, ArrowShrinkIcon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
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
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { usePanel } from "@/hooks/usePanel";
import { useTTS } from "@/contexts/TTSContext";
import { TTSButton } from "@/components/chat/TTSButton";
import { findTextRange, highlightRange, scrollToRange } from "@/lib/tts/highlight";
import type { FilePreview as FilePreviewType } from "@/types";

const streamdownPlugins = { cjk, code, math, mermaid };

/**
 * Custom paragraph component for DocPreview.
 * Streamdown wraps images in <div> (for download button / hover overlay),
 * but MarkdownParagraph only unwraps the <p> when the sole child is <img>.
 * README files often have badges like [![img](url)](link) where the direct
 * child is <a>, not <img>, so the <div> ends up inside <p> → hydration error.
 * Using <div> instead of <p> avoids the invalid nesting entirely.
 */
const docPreviewComponents = {
  p: ({ node, ...rest }: Record<string, unknown>) => <div {...rest} />,
};

type ViewMode = "source" | "rendered";

interface DocPreviewProps {
  filePath: string;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onClose: () => void;
  width: number;
}

/** Extensions that support a rendered preview */
const RENDERABLE_EXTENSIONS = new Set([
  ".md", ".mdx", ".html", ".htm",
  ".json", ".csv", ".tsv", ".svg", ".xml", ".yaml", ".yml",
  ".pdf",
]);

import { IMAGE_EXTENSIONS_SET as IMAGE_EXTENSIONS } from '@/lib/config';

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".aac", ".flac"]);

function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
}

function isRenderable(filePath: string): boolean {
  return RENDERABLE_EXTENSIONS.has(getExtension(filePath));
}

function isHtml(filePath: string): boolean {
  const ext = getExtension(filePath);
  return ext === ".html" || ext === ".htm";
}

function isJson(filePath: string): boolean {
  return getExtension(filePath) === ".json";
}

function isCsv(filePath: string): boolean {
  const ext = getExtension(filePath);
  return ext === ".csv" || ext === ".tsv";
}

function isSvg(filePath: string): boolean {
  return getExtension(filePath) === ".svg";
}

function isPdf(filePath: string): boolean {
  return getExtension(filePath) === ".pdf";
}

function isImage(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(filePath));
}

function isVideo(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(getExtension(filePath));
}

function isAudio(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(getExtension(filePath));
}

function isMarkdown(filePath: string): boolean {
  const ext = getExtension(filePath);
  return ext === ".md" || ext === ".mdx";
}

export function DocPreview({
  filePath,
  viewMode,
  onViewModeChange,
  onClose,
  width,
}: DocPreviewProps) {
  const { resolvedTheme } = useTheme();
  const { workingDirectory } = usePanel();
  const isDark = resolvedTheme === "dark";
  const [preview, setPreview] = useState<FilePreviewType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isPdfFile = isPdf(filePath);
  const isImageFile = isImage(filePath);
  const isVideoFile = isVideo(filePath);
  const isAudioFile = isAudio(filePath);
  const isBinaryPreview = isPdfFile || isImageFile || isVideoFile || isAudioFile;
  const isMarkdownFile = isMarkdown(filePath);

  // TTS for markdown preview
  const ttsMessageId = `file-preview-${filePath}`;
  const tts = useTTS();
  const renderedContentRef = useRef<HTMLDivElement>(null);
  const ttsCleanupRef = useRef<(() => void) | null>(null);
  const isThisFileActive = tts.activeMessageId === ttsMessageId;

  // Sequential position tracking — prevents highlight from jumping to
  // earlier occurrences of repeated/similar text in the document
  const lastMatchEndRef = useRef(0);
  const prevSegmentRef = useRef(-1);

  // TTS highlight effect
  useEffect(() => {
    ttsCleanupRef.current?.();
    ttsCleanupRef.current = null;

    if (!isThisFileActive || !renderedContentRef.current) {
      // Reset position tracking when TTS is not active on this file
      lastMatchEndRef.current = 0;
      prevSegmentRef.current = -1;
      return;
    }
    if (tts.activeSegmentIndex < 0 || tts.activeSegmentIndex >= tts.segments.length) return;

    // Only use position tracking for sequential advance (index incremented by 1);
    // for seeks or jumps, reset to search from the beginning
    const isSequential = tts.activeSegmentIndex === prevSegmentRef.current + 1;
    prevSegmentRef.current = tts.activeSegmentIndex;
    const searchAfter = isSequential ? lastMatchEndRef.current : 0;

    const activeSegment = tts.segments[tts.activeSegmentIndex];
    const result = findTextRange(renderedContentRef.current, activeSegment.text, searchAfter);
    if (!result) return;

    lastMatchEndRef.current = result.textOffset;
    ttsCleanupRef.current = highlightRange(result.range, renderedContentRef.current);

    // Auto-scroll within the preview's scroll container
    const scrollContainer = renderedContentRef.current.closest('.flex-1.min-h-0.overflow-auto');
    scrollToRange(result.range, scrollContainer);

    return () => {
      ttsCleanupRef.current?.();
      ttsCleanupRef.current = null;
    };
  }, [isThisFileActive, tts.activeSegmentIndex, tts.segments]);

  // Stop TTS when file changes or component unmounts
  useEffect(() => {
    return () => {
      if (tts.activeMessageId?.startsWith('file-preview-')) {
        tts.stop();
      }
    };
  }, [filePath]);

  // Tap-to-seek handler for markdown rendered view
  const handleSeekClick = useCallback((e: React.MouseEvent) => {
    if (!isThisFileActive || !renderedContentRef.current) return;
    if (tts.state !== 'playing' && tts.state !== 'paused') return;
    if (tts.segments.length === 0) return;

    const target = e.target as HTMLElement;
    if (target.closest('button, a')) return;

    // Seek handler searches all segments sequentially from document start
    let seekSearchAfter = 0;
    for (let i = 0; i < tts.segments.length; i++) {
      const result = findTextRange(renderedContentRef.current, tts.segments[i].text, seekSearchAfter);
      if (!result) continue;
      seekSearchAfter = result.textOffset;

      const rects = result.range.getClientRects();
      for (let r = 0; r < rects.length; r++) {
        const rect = rects[r];
        if (e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom) {
          tts.seekToSegment(i);
          return;
        }
      }
    }
  }, [isThisFileActive, tts]);

  useEffect(() => {
    // Reset edit mode when file changes
    setEditing(false);
    setEditContent("");
  }, [filePath]);

  useEffect(() => {
    // Binary files — skip text preview fetch
    if (isBinaryPreview) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function loadPreview() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/files/preview?path=${encodeURIComponent(filePath)}&maxLines=0${workingDirectory ? `&baseDir=${encodeURIComponent(workingDirectory)}` : ''}`
        );
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to load file");
        }
        const data = await res.json();
        if (!cancelled) {
          setPreview(data.preview);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load file");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadPreview();
    return () => {
      cancelled = true;
    };
  }, [filePath, isBinaryPreview]);

  const handleCopyContent = async () => {
    const text = preview?.content || filePath;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleEnterEdit = () => {
    if (!preview) return;
    setEditContent(preview.content);
    setEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setEditContent("");
  };

  const handleConfirmSave = async () => {
    setShowConfirm(false);
    setSaving(true);
    try {
      const res = await fetch("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: filePath,
          content: editContent,
          baseDir: workingDirectory || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }
      // Update preview with new content
      const lines = editContent.split("\n");
      setPreview((prev) =>
        prev ? { ...prev, content: editContent, line_count: lines.length } : prev
      );
      setEditing(false);
      setEditContent("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save file");
      setSaving(false);
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = editing && preview && editContent !== preview.content;

  const fileName = filePath.split("/").pop() || filePath;

  // Build breadcrumb — show last 3 segments
  const breadcrumb = useMemo(() => {
    const segments = filePath.split("/").filter(Boolean);
    const display = segments.slice(-3);
    const prefix = display.length < segments.length ? ".../" : "";
    return prefix + display.join("/");
  }, [filePath]);

  const canRender = isRenderable(filePath);

  return (
    <div
      data-mobile-overlay=""
      className={cn(
        "flex flex-col overflow-hidden bg-background",
        "fixed inset-0 z-[60]",
        expanded
          ? ""
          : "md:static md:inset-auto md:z-auto md:h-full md:shrink-0 md:border-l md:border-border/40"
      )}
      style={expanded ? undefined : { width }}
    >
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {editing && <span className="text-blue-500 mr-1.5 text-xs font-normal">Editing</span>}
            {fileName}
          </p>
        </div>

        {editing ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancelEdit}
              className="h-6 px-2 text-xs"
            >
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => setShowConfirm(true)}
              disabled={saving || !hasChanges}
              className="h-6 px-2 text-xs"
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </>
        ) : (
          <>
            {canRender && !isBinaryPreview && (
              <ViewModeToggle value={viewMode} onChange={onViewModeChange} />
            )}

            {preview && !loading && !error && isMarkdownFile && (
              <TTSButton messageId={ttsMessageId} text={preview.content} />
            )}

            {preview && !loading && !error && !isBinaryPreview && (
              <Button variant="ghost" size="icon-sm" onClick={handleEnterEdit} title="Edit file">
                <HugeiconsIcon icon={PencilEdit02Icon} className="h-3.5 w-3.5" />
                <span className="sr-only">Edit file</span>
              </Button>
            )}

            <Button variant="ghost" size="icon-sm" onClick={handleCopyContent}>
              {copied ? (
                <HugeiconsIcon icon={Tick01Icon} className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <HugeiconsIcon icon={Copy01Icon} className="h-3.5 w-3.5" />
              )}
              <span className="sr-only">Copy content</span>
            </Button>

            <Button variant="ghost" size="icon-sm" className="hidden md:inline-flex" onClick={() => setExpanded(!expanded)}>
              <HugeiconsIcon icon={expanded ? ArrowShrinkIcon : ArrowExpandIcon} className="h-3.5 w-3.5" />
              <span className="sr-only">{expanded ? "Shrink preview" : "Expand preview"}</span>
            </Button>

            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <HugeiconsIcon icon={Cancel01Icon} className="h-3.5 w-3.5" />
              <span className="sr-only">Close preview</span>
            </Button>
          </>
        )}
      </div>

      {/* Breadcrumb + language — subtle, no border */}
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
        <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/60">
          {breadcrumb}
        </p>
        {preview && (
          <span className="shrink-0 text-[10px] text-muted-foreground/50">
            {preview.language}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {editing ? (
          <textarea
            ref={textareaRef}
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            spellCheck={false}
            className={cn(
              "h-full w-full resize-none border-0 p-3 font-mono text-xs leading-relaxed focus:outline-none",
              isDark ? "bg-[#282c34] text-[#abb2bf]" : "bg-white text-[#383a42]"
            )}
          />
        ) : loading ? (
          <div className="flex items-center justify-center py-12">
            <HugeiconsIcon
              icon={Loading02Icon}
              className="h-5 w-5 animate-spin text-muted-foreground"
            />
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        ) : isVideoFile ? (
          <VideoRenderedView filePath={filePath} baseDir={workingDirectory} />
        ) : isAudioFile ? (
          <AudioRenderedView filePath={filePath} baseDir={workingDirectory} />
        ) : isImageFile ? (
          <ImageRenderedView filePath={filePath} baseDir={workingDirectory} />
        ) : isPdfFile ? (
          <PdfRenderedView filePath={filePath} baseDir={workingDirectory} />
        ) : preview ? (
          viewMode === "rendered" && canRender ? (
            <RenderedView
              content={preview.content}
              filePath={filePath}
              contentRef={isMarkdownFile ? renderedContentRef : undefined}
              onSeekClick={isThisFileActive ? handleSeekClick : undefined}
            />
          ) : (
            <SourceView preview={preview} isDark={isDark} />
          )
        ) : null}
      </div>

      {/* Save confirmation dialog */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This will overwrite{" "}
              <span className="font-mono text-foreground">{fileName}</span> on
              disk. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSave}>
              Save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Capsule toggle for Source / Preview view mode */
function ViewModeToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div className="flex h-6 items-center rounded-full bg-muted p-0.5 text-[11px]">
      <button
        className={`rounded-full px-2 py-0.5 font-medium transition-colors ${
          value === "source"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => onChange("source")}
      >
        Source
      </button>
      <button
        className={`rounded-full px-2 py-0.5 font-medium transition-colors ${
          value === "rendered"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => onChange("rendered")}
      >
        Preview
      </button>
    </div>
  );
}

/** Source code view using react-syntax-highlighter */
function SourceView({ preview, isDark }: { preview: FilePreviewType; isDark: boolean }) {
  return (
    <div className="text-xs">
      <SyntaxHighlighter
        language={preview.language}
        style={isDark ? oneDark : oneLight}
        showLineNumbers
        customStyle={{
          margin: 0,
          padding: "8px",
          borderRadius: 0,
          fontSize: "11px",
          lineHeight: "1.5",
          background: "transparent",
        }}
        lineNumberStyle={{
          minWidth: "2.5em",
          paddingRight: "8px",
          color: isDark ? "#636d83" : "#9ca3af",
          userSelect: "none",
        }}
      >
        {preview.content}
      </SyntaxHighlighter>
    </div>
  );
}

/** Rendered view for markdown / HTML / JSON / CSV / SVG files */
function RenderedView({
  content,
  filePath,
  contentRef,
  onSeekClick,
}: {
  content: string;
  filePath: string;
  contentRef?: React.RefObject<HTMLDivElement | null>;
  onSeekClick?: (e: React.MouseEvent) => void;
}) {
  if (isHtml(filePath)) {
    // Serve HTML via path-based URL so relative resources (CSS, JS, images)
    // resolve naturally against the file's directory.
    const previewUrl = `/api/preview${filePath}`;
    return (
      <iframe
        src={previewUrl}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
        className="h-full w-full border-0"
        title="HTML Preview"
      />
    );
  }

  if (isJson(filePath)) {
    return <JsonRenderedView content={content} />;
  }

  if (isCsv(filePath)) {
    const sep = getExtension(filePath) === ".tsv" ? "\t" : ",";
    return <CsvRenderedView content={content} separator={sep} />;
  }

  if (isSvg(filePath)) {
    return <SvgRenderedView content={content} />;
  }

  if (isPdf(filePath)) {
    return <PdfRenderedView filePath={filePath} />;
  }

  const ext = getExtension(filePath);
  if ([".xml", ".yaml", ".yml", ".toml"].includes(ext)) {
    const lang = ext === ".xml" ? "xml" : ext === ".toml" ? "toml" : "yaml";
    return (
      <div className="px-6 py-4 overflow-x-hidden break-words">
        <Streamdown
          className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-6 [&_ol]:pl-6"
          plugins={streamdownPlugins}
        >
          {`\`\`\`${lang}\n${content}\n\`\`\``}
        </Streamdown>
      </div>
    );
  }

  // Markdown / MDX
  return (
    <div
      ref={contentRef}
      className="px-6 py-4 overflow-x-hidden break-words"
      onClick={onSeekClick}
    >
      <Streamdown
        className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-6 [&_ol]:pl-6"
        plugins={streamdownPlugins}
        components={docPreviewComponents}
      >
        {content}
      </Streamdown>
    </div>
  );
}

/* ── JSON Rendered View ── */

function JsonRenderedView({ content }: { content: string }) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, data: JSON.parse(content) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Invalid JSON" };
    }
  }, [content]);

  if (!parsed.ok) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-sm text-destructive">JSON parse error: {parsed.error}</p>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 font-mono text-xs leading-relaxed">
      <JsonNode value={parsed.data} depth={0} />
    </div>
  );
}

function JsonNode({ value, depth, keyName }: { value: unknown; depth: number; keyName?: string }) {
  const [collapsed, setCollapsed] = useState(depth > 2);

  if (value === null) {
    return (
      <div className="flex items-baseline gap-1">
        {keyName !== undefined && <span className="text-foreground">{keyName}: </span>}
        <span className="italic text-muted-foreground">null</span>
      </div>
    );
  }

  if (typeof value === "boolean") {
    return (
      <div className="flex items-baseline gap-1">
        {keyName !== undefined && <span className="text-foreground">{keyName}: </span>}
        <span className="text-orange-500">{String(value)}</span>
      </div>
    );
  }

  if (typeof value === "number") {
    return (
      <div className="flex items-baseline gap-1">
        {keyName !== undefined && <span className="text-foreground">{keyName}: </span>}
        <span className="text-blue-500">{String(value)}</span>
      </div>
    );
  }

  if (typeof value === "string") {
    return (
      <div className="flex items-baseline gap-1 min-w-0">
        {keyName !== undefined && <span className="shrink-0 text-foreground">{keyName}: </span>}
        <span className="text-green-600 dark:text-green-400 break-all">&quot;{value}&quot;</span>
      </div>
    );
  }

  if (Array.isArray(value)) {
    const count = value.length;
    return (
      <div>
        <button
          type="button"
          className="flex items-baseline gap-1 hover:bg-muted/50 rounded px-0.5 -mx-0.5"
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className="text-muted-foreground text-[10px]">{collapsed ? "▶" : "▼"}</span>
          {keyName !== undefined && <span className="text-foreground">{keyName}: </span>}
          <span className="text-muted-foreground">[{collapsed ? <span className="text-[10px] mx-0.5">{count}</span> : ""}]</span>
        </button>
        {!collapsed && (
          <div className="ml-4 border-l border-border/40 pl-2">
            {value.map((item, i) => (
              <JsonNode key={i} value={item} depth={depth + 1} keyName={String(i)} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const count = entries.length;
    return (
      <div>
        <button
          type="button"
          className="flex items-baseline gap-1 hover:bg-muted/50 rounded px-0.5 -mx-0.5"
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className="text-muted-foreground text-[10px]">{collapsed ? "▶" : "▼"}</span>
          {keyName !== undefined && <span className="text-foreground">{keyName}: </span>}
          <span className="text-muted-foreground">{"{"}{collapsed ? <span className="text-[10px] mx-0.5">{count}</span> : ""}{"}"}</span>
        </button>
        {!collapsed && (
          <div className="ml-4 border-l border-border/40 pl-2">
            {entries.map(([k, v]) => (
              <JsonNode key={k} value={v} depth={depth + 1} keyName={k} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return <span className="text-muted-foreground">{String(value)}</span>;
}

/* ── CSV/TSV Rendered View ── */

function CsvRenderedView({ content, separator }: { content: string; separator: string }) {
  const { headers, rows } = useMemo(() => {
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return { headers: [] as string[], rows: [] as string[][] };
    const hdr = lines[0].split(separator);
    const data = lines.slice(1).map((line) => line.split(separator));
    return { headers: hdr, rows: data };
  }, [content, separator]);

  if (headers.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-sm text-muted-foreground">Empty file</p>
      </div>
    );
  }

  return (
    <div className="overflow-auto text-xs">
      <table className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-semibold text-foreground border-b border-border/40"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className={ri % 2 === 1 ? "bg-muted/30" : ""}>
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-1 text-foreground whitespace-nowrap border-b border-border/20">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-[10px] text-muted-foreground">
        {rows.length} row{rows.length !== 1 ? "s" : ""}
      </p>
    </div>
  );
}

/* ── SVG Rendered View (sandboxed iframe) ── */

function SvgRenderedView({ content }: { content: string }) {
  const srcDoc = useMemo(() => {
    return `<!DOCTYPE html>
<html><head><style>
  body {
    margin: 0; display: flex; align-items: center; justify-content: center;
    min-height: 100vh; overflow: auto;
    background-image:
      linear-gradient(45deg, #e0e0e0 25%, transparent 25%),
      linear-gradient(-45deg, #e0e0e0 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #e0e0e0 75%),
      linear-gradient(-45deg, transparent 75%, #e0e0e0 75%);
    background-size: 16px 16px;
    background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  }
  @media (prefers-color-scheme: dark) {
    body {
      background-image:
        linear-gradient(45deg, #333 25%, transparent 25%),
        linear-gradient(-45deg, #333 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #333 75%),
        linear-gradient(-45deg, transparent 75%, #333 75%);
    }
  }
  svg { max-width: 100%; max-height: 100vh; }
</style></head><body>${content}</body></html>`;
  }, [content]);

  return (
    <iframe
      srcDoc={srcDoc}
      sandbox=""
      className="h-full w-full border-0"
      title="SVG Preview"
    />
  );
}

/* ── Image Rendered View (with pinch-to-zoom & pan on mobile) ── */

function ImageRenderedView({ filePath, baseDir }: { filePath: string; baseDir?: string }) {
  const src = rawFileUrl(filePath, baseDir);
  const fileName = filePath.split("/").pop() || "image";

  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });

  // Refs for gesture tracking (avoid stale closures)
  const gestureRef = useRef({
    initialDistance: 0,
    initialScale: 1,
    lastTouchX: 0,
    lastTouchY: 0,
    isPinching: false,
    isPanning: false,
  });

  const resetZoom = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  // Reset when file changes
  useEffect(() => {
    resetZoom();
  }, [filePath, resetZoom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const g = gestureRef.current;

    function getDistance(t1: Touch, t2: Touch) {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        e.preventDefault();
        g.isPinching = true;
        g.isPanning = false;
        g.initialDistance = getDistance(e.touches[0], e.touches[1]);
        g.initialScale = scale;
      } else if (e.touches.length === 1 && scale > 1) {
        // Single-finger pan only when zoomed in
        g.isPanning = true;
        g.isPinching = false;
        g.lastTouchX = e.touches[0].clientX;
        g.lastTouchY = e.touches[0].clientY;
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (g.isPinching && e.touches.length === 2) {
        e.preventDefault();
        const dist = getDistance(e.touches[0], e.touches[1]);
        const newScale = Math.min(
          5,
          Math.max(1, g.initialScale * (dist / g.initialDistance))
        );
        setScale(newScale);
        // Reset translate if zoomed back to 1
        if (newScale <= 1) {
          setTranslate({ x: 0, y: 0 });
        }
      } else if (g.isPanning && e.touches.length === 1 && scale > 1) {
        e.preventDefault();
        const dx = e.touches[0].clientX - g.lastTouchX;
        const dy = e.touches[0].clientY - g.lastTouchY;
        g.lastTouchX = e.touches[0].clientX;
        g.lastTouchY = e.touches[0].clientY;
        setTranslate((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
      }
    }

    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) {
        g.isPinching = false;
      }
      if (e.touches.length === 0) {
        g.isPanning = false;
      }
    }

    // Use { passive: false } so we can preventDefault to stop browser zoom
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [scale, resetZoom]);

  // Double-tap to reset zoom
  const lastTapRef = useRef(0);
  const handleDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      if (scale > 1) {
        resetZoom();
      } else {
        setScale(2.5);
      }
    }
    lastTapRef.current = now;
  }, [scale, resetZoom]);

  const isZoomed = scale > 1;

  return (
    <div
      ref={containerRef}
      className="relative flex h-full items-center justify-center p-4 bg-[repeating-conic-gradient(#e0e0e0_0%_25%,transparent_0%_50%)] dark:bg-[repeating-conic-gradient(#333_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] overflow-hidden touch-none"
      onClick={handleDoubleTap}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={fileName}
        className="max-w-full max-h-full object-contain rounded select-none"
        draggable={false}
        style={{
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          transition: isZoomed ? "none" : "transform 0.2s ease-out",
        }}
      />
      {isZoomed && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            resetZoom();
          }}
          className="absolute top-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded-full backdrop-blur-sm"
        >
          {Math.round(scale * 100)}% ✕
        </button>
      )}
    </div>
  );
}

/** Build the /api/files/raw URL with optional baseDir for scoped access */
function rawFileUrl(filePath: string, baseDir?: string): string {
  let url = `/api/files/raw?path=${encodeURIComponent(filePath)}`;
  if (baseDir) url += `&baseDir=${encodeURIComponent(baseDir)}`;
  return url;
}

/* ── Video Rendered View (HTML5 video with streaming) ── */

function VideoRenderedView({ filePath, baseDir }: { filePath: string; baseDir?: string }) {
  const src = rawFileUrl(filePath, baseDir);
  const fileName = filePath.split("/").pop() || "video";

  return (
    <div className="flex h-full items-center justify-center bg-black p-2">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        key={filePath}
        src={src}
        controls
        preload="metadata"
        playsInline
        className="max-h-full max-w-full rounded"
        title={fileName}
      />
    </div>
  );
}

/* ── Audio Rendered View (HTML5 audio player) ── */

function AudioRenderedView({ filePath, baseDir }: { filePath: string; baseDir?: string }) {
  const src = rawFileUrl(filePath, baseDir);
  const fileName = filePath.split("/").pop() || "audio";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-muted">
        <svg className="h-10 w-10 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      </div>
      <p className="text-sm text-muted-foreground">{fileName}</p>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        key={filePath}
        src={src}
        controls
        preload="metadata"
        className="w-full max-w-sm"
        title={fileName}
      />
    </div>
  );
}

/* ── PDF Rendered View (browser built-in viewer) ── */

function PdfRenderedView({ filePath, baseDir }: { filePath: string; baseDir?: string }) {
  const src = rawFileUrl(filePath, baseDir);
  return (
    <iframe
      src={src}
      className="h-full w-full border-0"
      title="PDF Preview"
    />
  );
}
