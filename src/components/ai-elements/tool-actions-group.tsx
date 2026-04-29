'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import {
  File01Icon,
  FileEditIcon,
  CommandLineIcon,
  Search01Icon,
  Wrench01Icon,
  Loading02Icon,
  CheckmarkCircle02Icon,
  CancelCircleIcon,
  Download04Icon,
  UserMultipleIcon,
  Globe02Icon,
  CheckListIcon,
  MessageQuestionIcon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { ChevronRightIcon, CopyIcon, CheckIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  type ToolCategory,
  extractFilename,
  getFilePath,
  getToolCategory,
  getToolFullText,
  getToolLabel,
  getToolSummary,
  isImagePath,
} from '@/lib/tool-display';
import type { ViewMode } from '@/types';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLongPress } from '@/hooks/useLongPress';
import { useCallback } from 'react';
import { ImageLightbox } from '@/components/chat/ImageLightbox';
import { LoadingImage } from '@/components/chat/LoadingImage';

function CopyTextButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <button type="button" className="shrink-0 rounded-sm p-0.5 text-background/60 hover:text-background" onClick={handleCopy}>
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolAction {
  id?: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
}

interface ToolActionsGroupProps {
  tools: ToolAction[];
  isStreaming?: boolean;
  streamingToolOutput?: string;
  isLatestMessage?: boolean;
  viewMode?: ViewMode;
}

function getToolIcon(category: ToolCategory): IconSvgElement {
  switch (category) {
    case 'read':   return File01Icon;
    case 'write':  return FileEditIcon;
    case 'bash':   return CommandLineIcon;
    case 'search': return Search01Icon;
    case 'skill':  return Wrench01Icon;
    case 'agent':  return UserMultipleIcon;
    case 'subagents': return GitBranchIcon;
    case 'web':    return Globe02Icon;
    case 'todo':   return CheckListIcon;
    case 'ask':    return MessageQuestionIcon;
    case 'other':  return Wrench01Icon;
  }
}

function truncatePath(path: string, maxLen = 50): string {
  if (path.length <= maxLen) return path;
  return '...' + path.slice(path.length - maxLen + 3);
}

function ImagePreview({ filePath }: { filePath: string }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const src = `/api/files/raw?path=${encodeURIComponent(filePath)}`;

  return (
    <>
      <div className="pl-6 py-1">
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          className="rounded-lg overflow-hidden hover:opacity-80 transition"
        >
          <LoadingImage src={src} alt={extractFilename(filePath)} className="max-h-32 rounded-lg" />
        </button>
      </div>
      <ImageLightbox
        images={[{ src, alt: extractFilename(filePath) }]}
        initialIndex={0}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Status indicator — running: gray, completed: green, error: red
// ---------------------------------------------------------------------------

type ToolStatus = 'running' | 'success' | 'error';

function getStatus(tool: ToolAction, isStreaming: boolean): ToolStatus {
  if (tool.result === undefined) return isStreaming ? 'running' : 'success';
  return tool.isError ? 'error' : 'success';
}

function StatusDot({ status }: { status: ToolStatus }) {
  switch (status) {
    case 'running':
      return (
        <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/50" />
      );
    case 'success':
      return <HugeiconsIcon icon={CheckmarkCircle02Icon} className="h-3.5 w-3.5 shrink-0 text-green-500" />;
    case 'error':
      return <HugeiconsIcon icon={CancelCircleIcon} className="h-3.5 w-3.5 shrink-0 text-red-500" />;
  }
}

// ---------------------------------------------------------------------------
// Compact row for a single tool action
// ---------------------------------------------------------------------------

function DownloadButton({ filePath }: { filePath: string }) {
  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = `/api/files/raw?path=${encodeURIComponent(filePath)}&download=1`;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.click();
  };

  return (
    <button
      type="button"
      onClick={handleDownload}
      className="p-0.5 rounded hover:bg-muted/60 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
      title="Download file"
    >
      <HugeiconsIcon icon={Download04Icon} className="h-3 w-3" />
    </button>
  );
}

function ToolActionRow({ tool, isStreaming }: { tool: ToolAction; isStreaming: boolean }) {
  const category = getToolCategory(tool.name);
  const icon = getToolIcon(category);
  const summary = getToolSummary(tool.name, tool.input, category);
  const fullText = getToolFullText(tool.name, tool.input, category);
  const filePath = getFilePath(tool.input);
  const status = getStatus(tool, isStreaming);
  const longPress = useLongPress();

  const label = getToolLabel(tool.name, category);

  return (
    <div className="flex items-center gap-2 px-2 py-1 min-h-[28px] text-xs hover:bg-muted/30 rounded-sm transition-colors">
      <HugeiconsIcon icon={icon} className={cn("h-3.5 w-3.5 shrink-0", category === 'skill' ? "text-blue-500" : category === 'agent' ? "text-violet-500" : category === 'subagents' ? "text-fuchsia-500" : "text-muted-foreground")} />

      {label && (
        <span className={cn("font-medium shrink-0", category === 'skill' ? "text-blue-500" : category === 'agent' ? "text-violet-500" : category === 'subagents' ? "text-fuchsia-500" : "text-muted-foreground")}>{label}</span>
      )}

      <Tooltip open={longPress.tooltipOpen}>
        <TooltipTrigger asChild>
          <span
            className={cn("font-mono truncate flex-1 select-none", category === 'skill' ? "text-blue-500/70" : category === 'agent' ? "text-violet-500/70" : category === 'subagents' ? "text-fuchsia-500/70" : "text-muted-foreground/60")}
            title={fullText}
            {...longPress.handlers}
          >
            {summary}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-[90vw] sm:max-w-md">
          <div className="flex items-start gap-2">
            <pre className="whitespace-pre-wrap break-all font-mono text-xs flex-1">{fullText}</pre>
            <CopyTextButton text={fullText} />
            <button type="button" className="shrink-0 rounded-sm p-0.5 text-background/60 hover:text-background" onClick={longPress.dismiss}>
              <XIcon className="size-3" />
            </button>
          </div>
        </TooltipContent>
      </Tooltip>

      {filePath && (category === 'read' || category === 'write') && (
        <span className="text-muted-foreground/40 text-[11px] font-mono truncate max-w-[200px] hidden sm:inline">
          {truncatePath(filePath)}
        </span>
      )}

      {category === 'write' && filePath && status !== 'running' && (
        <DownloadButton filePath={filePath} />
      )}

      <StatusDot status={status} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header summary helper — build running task description
// ---------------------------------------------------------------------------

function getRunningDescription(tools: ToolAction[]): { summary: string; fullText: string } {
  const running = tools.filter((t) => t.result === undefined);
  if (running.length === 0) return { summary: '', fullText: '' };
  const last = running[running.length - 1];
  const category = getToolCategory(last.name);
  return {
    summary: getToolSummary(last.name, last.input, category),
    fullText: getToolFullText(last.name, last.input, category),
  };
}

// ---------------------------------------------------------------------------
// Main group component
// ---------------------------------------------------------------------------

export function ToolActionsGroup({
  tools,
  isStreaming = false,
  isLatestMessage = false,
  viewMode = 'normal',
}: ToolActionsGroupProps) {
  const hasRunningTool = isStreaming && tools.some((t) => t.result === undefined);
  const hasImageWrite = tools.some((t) => {
    const cat = getToolCategory(t.name);
    const fp = getFilePath(t.input);
    return cat === 'write' && fp && isImagePath(fp) && t.result !== undefined;
  });

  // Track whether user has manually toggled and their chosen state
  const [userExpandedState, setUserExpandedState] = useState<boolean | null>(null);
  const headerLongPress = useLongPress();

  // Derived: user toggle > viewMode default > auto-expand logic
  const expanded = userExpandedState !== null
    ? userExpandedState
    : viewMode === 'verbose'
      ? true
      : (hasRunningTool || isStreaming || hasImageWrite || isLatestMessage);

  if (tools.length === 0) return null;

  const runningCount = isStreaming ? tools.filter((t) => t.result === undefined).length : 0;
  const doneCount = tools.length - runningCount;
  const { summary: runningDesc, fullText: runningFullText } = isStreaming ? getRunningDescription(tools) : { summary: '', fullText: '' };

  const handleToggle = () => {
    setUserExpandedState((prev) => prev !== null ? !prev : !expanded);
  };

  // Build summary text parts
  const summaryParts: string[] = [];
  if (runningCount > 0) summaryParts.push(`${runningCount} running`);
  if (doneCount > 0) summaryParts.push(`${doneCount} completed`);
  if (runningCount === 0 && isStreaming) summaryParts.push('generating response');
  if (summaryParts.length === 0) summaryParts.push(`${tools.length} actions`);

  return (
    <div className="w-[min(100%,48rem)]">
      {/* Header — minimal: chevron + count + gray summary */}
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 py-1 text-xs rounded-sm hover:bg-muted/30 transition-colors"
      >
        <ChevronRightIcon
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform duration-200",
            expanded && "rotate-90"
          )}
        />

        <span className="inline-flex items-center justify-center rounded bg-muted/80 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground/70 tabular-nums">
          {tools.length}
        </span>

        <span className="text-muted-foreground/60 truncate">
          {summaryParts.join(' · ')}
        </span>

        {/* Show running task description on the right */}
        {runningDesc && (
          <Tooltip open={headerLongPress.tooltipOpen}>
            <TooltipTrigger asChild>
              <span
                className="ml-auto text-muted-foreground/40 text-[11px] font-mono truncate max-w-[40%] select-none"
                title={runningFullText}
                {...headerLongPress.handlers}
                onClick={(e) => e.stopPropagation()}
              >
                {runningDesc}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" className="max-w-[90vw] sm:max-w-md">
              <div className="flex items-start gap-2">
                <pre className="whitespace-pre-wrap break-all font-mono text-xs flex-1">{runningFullText}</pre>
                <CopyTextButton text={runningFullText} />
                <button type="button" className="shrink-0 rounded-sm p-0.5 text-background/60 hover:text-background" onClick={(e) => { e.stopPropagation(); headerLongPress.dismiss(); }}>
                  <XIcon className="size-3" />
                </button>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </button>

      {/* Expanded list — left vertical line like blockquote */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{ overflow: 'hidden', transformOrigin: 'top' }}
          >
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
            >
              <div className="ml-1.5 mt-0.5 border-l-2 border-border/50 pl-2">
                {tools.map((tool, i) => {
                  const category = getToolCategory(tool.name);
                  const filePath = getFilePath(tool.input);
                  const status = getStatus(tool, isStreaming);
                  const showImage = category === 'write' && filePath && isImagePath(filePath) && status !== 'running';
                  return (
                    <div key={`${tool.id || 'tool'}-${i}`}>
                      <ToolActionRow tool={tool} isStreaming={isStreaming} />
                      {showImage && <ImagePreview filePath={filePath} />}
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
