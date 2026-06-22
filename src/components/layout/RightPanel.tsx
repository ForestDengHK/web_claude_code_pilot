"use client";

import { useCallback } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { StructureFolderIcon, PanelRightCloseIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePanel } from "@/hooks/usePanel";
import { FileTree } from "@/components/project/FileTree";
import { HistoryPanel } from "@/components/project/HistoryPanel";
import { ArtifactListPanel } from "@/components/project/ArtifactListPanel";
import CanvasListPanel from "@/components/canvas/CanvasListPanel";

interface RightPanelProps {
  width?: number;
}

export function RightPanel({ width }: RightPanelProps) {
  const { panelOpen, setPanelOpen, panelContent, setPanelContent, workingDirectory, sessionId, previewFile, setPreviewFile, setPreviewLine, setPreviewViewMode } = usePanel();

  const handleFileAdd = useCallback((path: string, isDirectory?: boolean) => {
    window.dispatchEvent(new CustomEvent('attach-file-to-chat', { detail: { path, isDirectory: isDirectory ?? false } }));
  }, []);

  const handleFileRemove = useCallback((path: string) => {
    window.dispatchEvent(new CustomEvent('detach-file-from-chat', { detail: { path } }));
  }, []);

  const handleFileSelect = useCallback((path: string) => {
    // Only open preview for text-based files and images, skip videos/binaries
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const NON_PREVIEWABLE = new Set([
      "avi", "mkv", "flv", "wmv",           // unsupported video (no browser playback)
      "wma",                                  // unsupported audio
      "zip", "tar", "gz", "rar", "7z", "bz2",
      "doc", "docx", "xls", "xlsx", "ppt", "pptx",
      "exe", "dll", "so", "dylib", "bin", "dmg", "iso",
      "woff", "woff2", "ttf", "otf", "eot",
    ]);
    if (NON_PREVIEWABLE.has(ext)) return;

    // Toggle: clicking the same file closes the preview
    if (previewFile === path) {
      setPreviewFile(null);
    } else {
      setPreviewLine(null);
      setPreviewFile(path);
    }
  }, [previewFile, setPreviewFile, setPreviewLine]);

  const handleFilePreview = useCallback((path: string) => {
    setPreviewLine(null);
    setPreviewFile(path);
    setPreviewViewMode("rendered");
  }, [setPreviewFile, setPreviewLine, setPreviewViewMode]);

  const tabs = [
    { value: "files" as const, label: "Files" },
    { value: "canvas" as const, label: "Canvas" },
    { value: "artifacts" as const, label: "Artifacts" },
    { value: "history" as const, label: "History" },
  ];

  if (!panelOpen) {
    return (
      <div className="hidden flex-col items-center gap-2 bg-background p-2 md:flex">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPanelOpen(true)}
            >
              <HugeiconsIcon icon={StructureFolderIcon} className="h-4 w-4" />
              <span className="sr-only">Open panel</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Open panel</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <aside
      data-mobile-overlay=""
      className={cn(
        "flex flex-col overflow-hidden bg-background",
        "fixed inset-x-0 top-0 bottom-14 z-50",
        "md:static md:inset-auto md:z-auto md:h-full md:shrink-0"
      )}
      style={{ width: width ?? 288 }}
    >
      {/* Mobile header with close */}
      <div className="flex h-12 shrink-0 items-center justify-between px-4 md:hidden">
        <div className="flex items-center gap-3">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={cn(
                "text-[11px] font-semibold uppercase tracking-wider transition-colors",
                panelContent === tab.value ? "text-foreground" : "text-muted-foreground"
              )}
              onClick={() => setPanelContent(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setPanelOpen(false)}
        >
          <HugeiconsIcon icon={Cancel01Icon} className="h-4 w-4" />
          <span className="sr-only">Close panel</span>
        </Button>
      </div>
      {/* Desktop header */}
      <div className="hidden h-12 shrink-0 items-center justify-between px-4 md:flex">
        <div className="flex items-center gap-3">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={cn(
                "text-[11px] font-semibold uppercase tracking-wider transition-colors",
                panelContent === tab.value ? "text-foreground" : "text-muted-foreground"
              )}
              onClick={() => setPanelContent(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPanelOpen(false)}
            >
              <HugeiconsIcon icon={PanelRightCloseIcon} className="h-4 w-4" />
              <span className="sr-only">Close panel</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Close panel</TooltipContent>
        </Tooltip>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
        {panelContent === "files" && (
          <FileTree
            workingDirectory={workingDirectory}
            sessionId={sessionId}
            onFileSelect={handleFileSelect}
            onFileAdd={handleFileAdd}
            onFileRemove={handleFileRemove}
            onFilePreview={handleFilePreview}
          />
        )}
        {panelContent === "history" && (
          <HistoryPanel workingDirectory={workingDirectory} />
        )}
        {panelContent === "artifacts" && <ArtifactListPanel />}
        {panelContent === "canvas" && <CanvasListPanel sessionId={sessionId} />}
      </div>
    </aside>
  );
}
