"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useTheme } from "next-themes";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Copy01Icon, Tick01Icon, Loading02Icon, ArrowExpandIcon, ArrowShrinkIcon, PencilEdit02Icon, Download04Icon } from "@hugeicons/core-free-icons";
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
import { Streamdown, defaultRemarkPlugins, TableDownloadDropdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { visit } from "unist-util-visit";
import { usePanel } from "@/hooks/usePanel";
import { useTTS } from "@/contexts/TTSContext";
import { TTSButton } from "@/components/chat/TTSButton";
import { findTextRange, highlightRange, scrollToRange } from "@/lib/tts/highlight";
import { PinchZoomContainer } from "@/components/project/PinchZoomContainer";
import type { FilePreview as FilePreviewType } from "@/types";
import type { PDFDocumentProxy } from "pdfjs-dist";

const streamdownPlugins = { cjk, code, math, mermaid };

// Streamdown's `remarkPlugins` prop replaces (not extends) the default set,
// which would drop remark-gfm and break tables/strikethrough/etc. Compose
// our capture plugin onto the defaults so we keep GFM behavior.
const markdownRemarkPlugins = [...Object.values(defaultRemarkPlugins), remarkCaptureImageSrc];

/**
 * Replace each image URL with an absolute sentinel path that encodes the
 * original markdown URL. The mdast→hast→DOM pipeline normalizes relative
 * `../foo` URLs against the page URL, destroying the writer's intent.
 * Encoding as `/__md_asset__/<encoded>` keeps the URL absolute (no further
 * normalization) and lets the img component recover the original to
 * resolve against the markdown file's directory.
 */
const MD_ASSET_SENTINEL = "__md_asset__";

function remarkCaptureImageSrc() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    visit(tree, "image", (node: any) => {
      if (typeof node.url !== "string") return;
      // External URLs and data/blob/mailto/fragment refs: leave alone.
      if (
        /^[a-z][a-z0-9+.-]*:/i.test(node.url) ||
        node.url.startsWith("//") ||
        node.url.startsWith("#")
      ) {
        return;
      }
      node.url = `/${MD_ASSET_SENTINEL}/${encodeURIComponent(node.url)}`;
    });
  };
}

function decodeMdAssetSrc(src: string): string | null {
  const prefix = `/${MD_ASSET_SENTINEL}/`;
  if (!src.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(src.slice(prefix.length));
  } catch {
    return null;
  }
}

function rawUrlFor(absPath: string, baseDir: string | null): string {
  const params = new URLSearchParams({ path: absPath });
  if (baseDir) params.set("baseDir", baseDir);
  return `/api/files/raw?${params.toString()}`;
}

function normalizePosix(p: string): string {
  const parts = p.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return "/" + stack.join("/");
}

/**
 * Build a list of candidate URLs to try for a markdown asset src, in order.
 * - External URLs (http(s):, data:, blob:, mailto:, protocol-relative,
 *   fragment) pass through unchanged as a single candidate.
 * - Relative paths resolve against the markdown file's directory.
 * - Absolute web-style paths (e.g. `/images/foo.png`) are ambiguous: blogs
 *   built with Next.js / Docusaurus map these to `public/` or `static/`
 *   under the project root. Try those conventions first, then the literal
 *   path under the working directory, so the previewer "just works" without
 *   knowing the framework.
 */
function buildAssetCandidates(
  src: string,
  mdFilePath: string,
  baseDir: string | null,
): string[] {
  if (!src) return [src];
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//") || src.startsWith("#")) {
    return [src];
  }

  let decoded = src;
  try {
    decoded = decodeURI(src);
  } catch {
    // leave as-is on malformed encoding
  }

  const fsCandidates: string[] = [];
  const pushUnique = (p: string) => {
    if (!fsCandidates.includes(p)) fsCandidates.push(p);
  };

  if (decoded.startsWith("/")) {
    if (baseDir) {
      pushUnique(normalizePosix(`${baseDir}/public${decoded}`));
      pushUnique(normalizePosix(`${baseDir}/static${decoded}`));
      pushUnique(normalizePosix(`${baseDir}${decoded}`));
    } else {
      pushUnique(normalizePosix(decoded));
    }
  } else {
    const lastSlash = mdFilePath.lastIndexOf("/");
    const mdDir = lastSlash >= 0 ? mdFilePath.slice(0, lastSlash) : "";
    pushUnique(normalizePosix(`${mdDir}/${decoded}`));

    // Auto-generated docs commonly have relative paths with the wrong
    // number of `../` segments (e.g. `../../images/x.png` when the actual
    // file is at `../images/x.png`). Walk up ancestors of the markdown
    // file's directory and try `<ancestor>/<tail>` where tail is the path
    // with leading `./` and `../` segments stripped. Stops at baseDir.
    const tail = decoded.replace(/^(?:\.\.?\/)+/, "");
    if (tail && tail !== decoded) {
      const stopAt = baseDir ? normalizePosix(baseDir) : "";
      let ancestor = mdDir;
      for (let i = 0; i < 8; i++) {
        const sep = ancestor.lastIndexOf("/");
        if (sep <= 0) break;
        ancestor = ancestor.slice(0, sep);
        if (stopAt && !ancestor.startsWith(stopAt)) break;
        pushUnique(normalizePosix(`${ancestor}/${tail}`));
        if (stopAt && ancestor === stopAt) break;
      }
    }
  }

  return fsCandidates.map((p) => rawUrlFor(p, baseDir));
}

/**
 * Build Streamdown component overrides for the markdown preview.
 *
 * - `p` → `div`: Streamdown wraps images in <div> (for download button / hover
 *   overlay), but MarkdownParagraph only unwraps the <p> when the sole child
 *   is <img>. README files often have badges like [![img](url)](link) where
 *   the direct child is <a>, not <img>, so the <div> ends up inside <p> →
 *   hydration error. Using <div> avoids the invalid nesting entirely.
 * - `img`: rewrite relative src to /api/files/raw so embedded images in the
 *   markdown file actually load.
 */
function buildMarkdownComponents(mdFilePath: string, baseDir: string | null) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p: ({ node: _node, ...props }: any) => <div {...props} />,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    table: MarkdownPreviewTable as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    img: ({ node: _node, src, alt, ...rest }: any) => {
      // The remark plugin replaced raw markdown URLs with a `/__md_asset__/`
      // sentinel so the URL pipeline can't strip leading `../`. Recover the
      // original here. External URLs (http:, data:, etc.) bypassed the
      // sentinel and arrive unchanged.
      const decoded = typeof src === "string" ? decodeMdAssetSrc(src) : null;
      const effective = decoded ?? (typeof src === "string" ? src : "");
      const candidates = effective
        ? buildAssetCandidates(effective, mdFilePath, baseDir)
        : [src];
      return <ResolvedImg candidates={candidates} alt={alt ?? ""} {...rest} />;
    },
  };
}

function copyTextFallback(text: string) {
  const copyFallback = () => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(copyFallback);
    return;
  }

  copyFallback();
}

function extractTableRows(table: HTMLTableElement) {
  const rows: string[][] = [];
  for (const tr of table.querySelectorAll("tr")) {
    const cells: string[] = [];
    for (const cell of tr.querySelectorAll("th, td")) {
      cells.push(cell.textContent?.trim() || "");
    }
    rows.push(cells);
  }
  return rows;
}

function MarkdownPreviewTable({
  children,
  className,
  node: _node,
  ...props
}: {
  children?: React.ReactNode;
  className?: string;
  node?: unknown;
  [key: string]: unknown;
}) {
  void _node;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleCopy = useCallback(() => {
    const table = wrapperRef.current?.querySelector("table") as HTMLTableElement | null;
    if (!table) return;
    copyTextFallback(extractTableRows(table).map((row) => row.join("\t")).join("\n"));
    clearTimeout(timerRef.current);
    setCopied(true);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div
      ref={wrapperRef}
      className="my-4 flex flex-col space-y-2"
      data-streamdown="table-wrapper"
    >
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex min-h-8 min-w-8 cursor-pointer items-center justify-center rounded-md p-1 text-muted-foreground transition-all hover:bg-muted hover:text-foreground active:bg-muted/80"
          title="Copy table"
        >
          <HugeiconsIcon
            icon={copied ? Tick01Icon : Copy01Icon}
            className={cn("h-4 w-4", copied && "text-green-500")}
          />
        </button>
        <TableDownloadDropdown className="inline-flex min-h-8 min-w-8 cursor-pointer items-center justify-center rounded-md p-1 text-muted-foreground transition-all hover:bg-muted hover:text-foreground active:bg-muted/80">
          <HugeiconsIcon icon={Download04Icon} className="h-4 w-4" />
        </TableDownloadDropdown>
      </div>
      <div className="overflow-x-auto">
        <table
          className={cn("w-full border-collapse border border-border", className)}
          data-streamdown="table"
          {...props}
        >
          {children}
        </table>
      </div>
    </div>
  );
}

/**
 * Renders an image, falling back to the next candidate URL when the current
 * one 404s. Used for markdown asset resolution where the same `src` may live
 * in `public/`, `static/`, or directly under the working directory.
 */
function ResolvedImg({
  candidates,
  alt,
  ...rest
}: { candidates: string[]; alt: string } & Omit<
  React.ImgHTMLAttributes<HTMLImageElement>,
  "src" | "alt"
>) {
  const [idx, setIdx] = useState(0);
  // Reset on candidate list change (e.g. file switch). Use a string key so
  // freshly-allocated arrays with the same contents don't retrigger the
  // reset and clobber the onError fallback.
  const candidatesKey = candidates.join("|");
  useEffect(() => {
    setIdx(0);
  }, [candidatesKey]);

  if (!candidates.length) return null;
  const current = candidates[Math.min(idx, candidates.length - 1)];
  const isLast = idx >= candidates.length - 1;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={current}
      alt={alt}
      {...rest}
      onError={(e) => {
        if (!isLast) {
          setIdx((i) => i + 1);
        }
        rest.onError?.(e);
      }}
    />
  );
}

type ViewMode = "source" | "rendered";

type PdfLoadingTask = {
  promise: Promise<PDFDocumentProxy>;
  destroy: () => Promise<void>;
};

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
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
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

function isOffice(filePath: string): boolean {
  const ext = getExtension(filePath);
  return [".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp"].includes(ext);
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
  const { workingDirectory, previewLine } = usePanel();
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
  const isOfficeFile = isOffice(filePath);
  const isBinaryPreview = isPdfFile || isImageFile || isVideoFile || isAudioFile || isOfficeFile;
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
  }, [filePath, isBinaryPreview, workingDirectory]);

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
        ) : isOfficeFile ? (
          <OfficeRenderedView filePath={filePath} baseDir={workingDirectory} />
        ) : preview ? (
          viewMode === "rendered" && canRender ? (
            <RenderedView
              content={preview.content}
              filePath={filePath}
              contentRef={isMarkdownFile ? renderedContentRef : undefined}
              onSeekClick={isThisFileActive ? handleSeekClick : undefined}
            />
          ) : (
            <SourceView preview={preview} isDark={isDark} targetLine={previewLine} />
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
function SourceView({
  preview,
  isDark,
  targetLine,
}: {
  preview: FilePreviewType;
  isDark: boolean;
  targetLine: number | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!targetLine) return;

    const target = containerRef.current?.querySelector(`[data-line-number="${targetLine}"]`);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: "center" });
    }
  }, [preview.content, targetLine]);

  return (
    <div ref={containerRef} className="text-xs">
      <SyntaxHighlighter
        language={preview.language}
        style={isDark ? oneDark : oneLight}
        showLineNumbers
        wrapLines
        lineProps={(lineNumber) => ({
          "data-line-number": String(lineNumber),
          style: targetLine === lineNumber
            ? {
              backgroundColor: isDark ? "rgba(250, 204, 21, 0.12)" : "rgba(250, 204, 21, 0.18)",
            }
            : undefined,
        })}
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
  const { workingDirectory } = usePanel();
  const markdownComponents = useMemo(
    () => buildMarkdownComponents(filePath, workingDirectory ?? null),
    [filePath, workingDirectory],
  );

  if (isHtml(filePath)) {
    // Serve HTML via path-based URL so relative resources (CSS, JS, images)
    // resolve naturally against the file's directory.
    const previewUrl = `/api/preview${filePath}`;
    return (
      <PinchZoomContainer iframeMode resetKey={filePath}>
        <iframe
          src={previewUrl}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
          className="h-full w-full border-0"
          title="HTML Preview"
        />
      </PinchZoomContainer>
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

  if (isOffice(filePath)) {
    return <OfficeRenderedView filePath={filePath} />;
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
    <PinchZoomContainer fill={false} originAnchor="top left" resetKey={filePath}>
      <div
        ref={contentRef}
        className="px-6 py-4 overflow-x-hidden break-words"
        onClick={onSeekClick}
      >
        <Streamdown
          className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-6 [&_ol]:pl-6"
          plugins={streamdownPlugins}
          components={markdownComponents}
          remarkPlugins={markdownRemarkPlugins}
        >
          {content}
        </Streamdown>
      </div>
    </PinchZoomContainer>
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
    <PinchZoomContainer iframeMode>
      <iframe
        srcDoc={srcDoc}
        sandbox=""
        className="h-full w-full border-0"
        title="SVG Preview"
      />
    </PinchZoomContainer>
  );
}

/* ── Image Rendered View (with pinch-to-zoom & pan on mobile) ── */

function ImageRenderedView({ filePath, baseDir }: { filePath: string; baseDir?: string }) {
  const src = rawFileUrl(filePath, baseDir);
  const fileName = filePath.split("/").pop() || "image";

  return (
    <div className="h-full bg-[repeating-conic-gradient(#e0e0e0_0%_25%,transparent_0%_50%)] dark:bg-[repeating-conic-gradient(#333_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
      <PinchZoomContainer resetKey={filePath}>
        <div className="flex h-full w-full items-center justify-center p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={fileName}
            className="max-w-full max-h-full object-contain rounded select-none"
            draggable={false}
          />
        </div>
      </PinchZoomContainer>
    </div>
  );
}

/** Build the /api/files/raw URL with optional baseDir for scoped access */
function rawFileUrl(filePath: string, baseDir?: string, download = false): string {
  const params = new URLSearchParams({ path: filePath });
  if (baseDir) params.set("baseDir", baseDir);
  if (download) params.set("download", "1");
  return `/api/files/raw?${params.toString()}`;
}

function officePreviewUrl(filePath: string, baseDir?: string, version?: string | number): string {
  const params = new URLSearchParams({ path: filePath });
  if (baseDir) params.set("baseDir", baseDir);
  if (version !== undefined) params.set("v", String(version));
  return `/api/files/office-preview?${params.toString()}`;
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
  const fileName = filePath.split("/").pop() || "document.pdf";
  return (
    <PdfJsRenderedView
      sourceUrl={rawFileUrl(filePath, baseDir)}
      downloadUrl={rawFileUrl(filePath, baseDir, true)}
      fileName={fileName}
      resetKey={filePath}
      loadingLabel="Loading PDF..."
    />
  );
}

/* ── Office Rendered View (server-side LibreOffice conversion to PDF) ── */

function OfficeRenderedView({ filePath, baseDir }: { filePath: string; baseDir?: string }) {
  const fileName = filePath.split("/").pop() || "document";
  // The office-preview URL is otherwise identical no matter what the file
  // contains, so a browser that cached an earlier conversion keeps showing the
  // stale PDF after the document is edited (the server's revalidation headers
  // can't help once an entry is considered fresh). Version the URL per open so
  // reopening always fetches the current conversion. LibreOffice output stays
  // cached on disk by file mtime, so this only re-streams, never re-converts.
  const cacheBust = useMemo(() => Date.now(), [filePath]);
  return (
    <PdfJsRenderedView
      sourceUrl={officePreviewUrl(filePath, baseDir, cacheBust)}
      downloadUrl={rawFileUrl(filePath, baseDir, true)}
      fileName={fileName}
      resetKey={filePath}
      loadingLabel="Creating preview..."
      unavailableTitle="Office preview unavailable"
      unavailableFallback="This file could not be converted for preview."
    />
  );
}

function PdfJsRenderedView({
  sourceUrl,
  downloadUrl,
  fileName,
  resetKey,
  loadingLabel,
  unavailableTitle = "PDF preview unavailable",
  unavailableFallback = "This PDF could not be rendered for preview.",
}: {
  sourceUrl: string;
  downloadUrl: string;
  fileName: string;
  resetKey: string;
  loadingLabel: string;
  unavailableTitle?: string;
  unavailableFallback?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState(() =>
    typeof window === "undefined" ? 480 : Math.max(320, window.innerWidth),
  );

  useEffect(() => {
    const updateWidth = () => {
      const el = containerRef.current;
      const nextWidth = el?.clientWidth || window.innerWidth || 480;
      setContainerWidth(Math.max(320, nextWidth));
    };
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener("resize", updateWidth);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateWidth);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PdfLoadingTask | null = null;

    async function loadPdf() {
      setLoading(true);
      setError(null);
      setPdf(null);

      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.mjs",
          import.meta.url,
        ).toString();

        loadingTask = pdfjs.getDocument({
          url: sourceUrl,
          disableAutoFetch: false,
          disableStream: false,
        }) as PdfLoadingTask;

        const loadedPdf = await loadingTask.promise;
        if (!cancelled) setPdf(loadedPdf);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : unavailableFallback);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPdf();

    return () => {
      cancelled = true;
      loadingTask?.destroy().catch(() => {});
    };
  }, [sourceUrl, unavailableFallback]);

  useEffect(() => {
    return () => {
      pdf?.destroy();
    };
  }, [pdf]);

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{loadingLabel}</p>
      </div>
    );
  }

  if (error || !pdf) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="max-w-sm space-y-2">
          <p className="text-sm font-medium text-foreground">{unavailableTitle}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {error || unavailableFallback}
          </p>
        </div>
        <Button asChild variant="secondary" size="sm" className="gap-1.5">
          <a href={downloadUrl} download={fileName}>
            <HugeiconsIcon icon={Download04Icon} className="h-3.5 w-3.5" />
            Download
          </a>
        </Button>
      </div>
    );
  }

  return (
    <PinchZoomContainer iframeMode fill={false} originAnchor="top left" resetKey={resetKey}>
      <div ref={containerRef} className="min-h-full bg-muted/35 px-3 py-4">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-4">
          {Array.from({ length: pdf.numPages }, (_, idx) => (
            <PdfCanvasPage
              key={idx + 1}
              pdf={pdf}
              pageNumber={idx + 1}
              containerWidth={containerWidth}
            />
          ))}
        </div>
      </div>
    </PinchZoomContainer>
  );
}

function PdfCanvasPage({
  pdf,
  pageNumber,
  containerWidth,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  containerWidth: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const currentCanvas = canvas;

    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;

    async function renderPage() {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;

      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = containerWidth || window.innerWidth || 480;
      const targetWidth = Math.max(220, Math.min(availableWidth - 24, 980));
      const scale = targetWidth / baseViewport.width;
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const context = currentCanvas.getContext("2d");
      if (!context) return;

      currentCanvas.width = Math.floor(viewport.width * ratio);
      currentCanvas.height = Math.floor(viewport.height * ratio);
      currentCanvas.style.width = `${Math.floor(viewport.width)}px`;
      currentCanvas.style.height = `${Math.floor(viewport.height)}px`;
      setPageSize({ width: viewport.width, height: viewport.height });

      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, viewport.width, viewport.height);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, viewport.width, viewport.height);

      renderTask = page.render({
        canvasContext: context,
        viewport,
      });
      await renderTask.promise;
    }

    renderPage().catch((err) => {
      if (!cancelled && err?.name !== "RenderingCancelledException") {
        console.error("PDF page render failed:", err);
      }
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [containerWidth, pageNumber, pdf]);

  return (
    <div
      className="overflow-hidden rounded-sm bg-background shadow-sm ring-1 ring-border/70"
      style={pageSize ? { width: pageSize.width, height: pageSize.height } : undefined}
    >
      <canvas ref={canvasRef} className="block max-w-full" />
    </div>
  );
}
