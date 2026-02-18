"use client";

import { useState, useEffect, useMemo } from "react";
import { useTheme } from "next-themes";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Copy01Icon, Tick01Icon, Loading02Icon, ArrowExpandIcon, ArrowShrinkIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Light as SyntaxHighlighter } from "react-syntax-highlighter";
import { atomOneDark } from "react-syntax-highlighter/dist/esm/styles/hljs";
import { atomOneLight } from "react-syntax-highlighter/dist/esm/styles/hljs";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { usePanel } from "@/hooks/usePanel";
import type { FilePreview as FilePreviewType } from "@/types";

const streamdownPlugins = { cjk, code, math, mermaid };

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
]);

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

  useEffect(() => {
    let cancelled = false;

    async function loadPreview() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/files/preview?path=${encodeURIComponent(filePath)}&maxLines=500${workingDirectory ? `&baseDir=${encodeURIComponent(workingDirectory)}` : ''}`
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
  }, [filePath]);

  const handleCopyContent = async () => {
    const text = preview?.content || filePath;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
        "fixed inset-0 z-50",
        expanded
          ? ""
          : "md:static md:inset-auto md:z-auto md:h-full md:shrink-0 md:border-l md:border-border/40"
      )}
      style={expanded ? undefined : { width }}
    >
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{fileName}</p>
        </div>

        {canRender && (
          <ViewModeToggle value={viewMode} onChange={onViewModeChange} />
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
        {loading ? (
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
        ) : preview ? (
          viewMode === "rendered" && canRender ? (
            <RenderedView content={preview.content} filePath={filePath} />
          ) : (
            <SourceView preview={preview} isDark={isDark} />
          )
        ) : null}
      </div>
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
        style={isDark ? atomOneDark : atomOneLight}
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
}: {
  content: string;
  filePath: string;
}) {
  if (isHtml(filePath)) {
    return (
      <iframe
        srcDoc={content}
        sandbox="allow-scripts"
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
    <div className="px-6 py-4 overflow-x-hidden break-words">
      <Streamdown
        className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-6 [&_ol]:pl-6"
        plugins={streamdownPlugins}
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
