"use client";

import type { HTMLAttributes, ReactNode } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLongPress } from "@/hooks/useLongPress";
import { cn } from "@/lib/utils";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FileDiffIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MinusIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface FileTreeContextType {
  expandedPaths: Set<string>;
  togglePath: (path: string) => void;
  selectedPath?: string;
  onSelect?: (path: string) => void;
  onAdd?: (path: string, isDirectory?: boolean) => void;
  onRemove?: (path: string) => void;
  onPreview?: (path: string) => void;
  onDownload?: (path: string) => void;
  onDelete?: (path: string) => void;
  onDiff?: (path: string) => void;
  onUpload?: (dirPath: string) => void;
  onCreateFolder?: (dirPath: string) => void;
  attachedPaths?: Set<string>;
  gitStatusMap?: Map<string, string>;
  // Multi-select
  selectionMode?: boolean;
  selectedPaths?: Set<string>;
  onToggleSelect?: (path: string) => void;
}

// Default noop for context default value
// oxlint-disable-next-line eslint(no-empty-function)
const noop = () => {};

function FolderCopyButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [path]);
  return (
    <button type="button" className="shrink-0 rounded-sm p-0.5 text-background/60 hover:text-background" onClick={handleCopy}>
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </button>
  );
}

function FileCopyButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [path]);
  return (
    <button type="button" className="shrink-0 rounded-sm p-0.5 text-background/60 hover:text-background" onClick={handleCopy}>
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </button>
  );
}

const FileTreeContext = createContext<FileTreeContextType>({
  // oxlint-disable-next-line eslint-plugin-unicorn(no-new-builtin)
  expandedPaths: new Set(),
  togglePath: noop,
});

export type FileTreeProps = HTMLAttributes<HTMLDivElement> & {
  expanded?: Set<string>;
  defaultExpanded?: Set<string>;
  selectedPath?: string;
  onSelect?: (path: string) => void;
  onAdd?: (path: string, isDirectory?: boolean) => void;
  onRemove?: (path: string) => void;
  onPreview?: (path: string) => void;
  onDownload?: (path: string) => void;
  onDelete?: (path: string) => void;
  onDiff?: (path: string) => void;
  onUpload?: (dirPath: string) => void;
  onCreateFolder?: (dirPath: string) => void;
  onExpandedChange?: (expanded: Set<string>) => void;
  attachedPaths?: Set<string>;
  gitStatusMap?: Map<string, string>;
  // Multi-select
  selectionMode?: boolean;
  selectedPaths?: Set<string>;
  onToggleSelect?: (path: string) => void;
};

export const FileTree = ({
  expanded: controlledExpanded,
  defaultExpanded = new Set(),
  selectedPath,
  onSelect,
  onAdd,
  onRemove,
  onPreview,
  onDownload,
  onDelete,
  onDiff,
  onUpload,
  onCreateFolder,
  onExpandedChange,
  attachedPaths,
  gitStatusMap,
  selectionMode,
  selectedPaths,
  onToggleSelect,
  className,
  children,
  ...props
}: FileTreeProps) => {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const expandedPaths = controlledExpanded ?? internalExpanded;

  const togglePath = useCallback(
    (path: string) => {
      const newExpanded = new Set(expandedPaths);
      if (newExpanded.has(path)) {
        newExpanded.delete(path);
      } else {
        newExpanded.add(path);
      }
      setInternalExpanded(newExpanded);
      onExpandedChange?.(newExpanded);
    },
    [expandedPaths, onExpandedChange]
  );

  const contextValue = useMemo(
    () => ({ attachedPaths, expandedPaths, gitStatusMap, onAdd, onCreateFolder, onDelete, onDiff, onDownload, onPreview, onRemove, onSelect, onToggleSelect, onUpload, selectedPath, selectedPaths, selectionMode, togglePath }),
    [attachedPaths, expandedPaths, gitStatusMap, onAdd, onCreateFolder, onDelete, onDiff, onDownload, onPreview, onRemove, onSelect, onToggleSelect, onUpload, selectedPath, selectedPaths, selectionMode, togglePath]
  );

  return (
    <FileTreeContext.Provider value={contextValue}>
      <div
        className={cn(
          "rounded-lg border bg-background font-mono text-sm",
          className
        )}
        role="tree"
        {...props}
      >
        <div className="p-2">{children}</div>
      </div>
    </FileTreeContext.Provider>
  );
};

interface FileTreeFolderContextType {
  path: string;
  name: string;
  isExpanded: boolean;
}

const FileTreeFolderContext = createContext<FileTreeFolderContextType>({
  isExpanded: false,
  name: "",
  path: "",
});

export type FileTreeFolderProps = HTMLAttributes<HTMLDivElement> & {
  path: string;
  name: string;
};

export const FileTreeFolder = ({
  path,
  name,
  className,
  children,
  ...props
}: FileTreeFolderProps) => {
  const { expandedPaths, togglePath, onAdd, onRemove, onUpload, onCreateFolder, onDelete, attachedPaths, gitStatusMap, selectionMode, selectedPaths, onToggleSelect } =
    useContext(FileTreeContext);
  const isExpanded = expandedPaths.has(path);
  const isAttached = attachedPaths?.has(path) ?? false;
  const isChecked = selectedPaths?.has(path) ?? false;
  const gitStatus = gitStatusMap?.get(path);

  const handleToggle = useCallback(() => {
    togglePath(path);
  }, [togglePath, path]);

  const handleFolderClick = useCallback(() => {
    if (selectionMode) {
      onToggleSelect?.(path);
    }
  }, [selectionMode, onToggleSelect, path]);

  const handleAdd = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isAttached) {
        onRemove?.(path);
      } else {
        onAdd?.(path, true);
      }
    },
    [onAdd, onRemove, path, isAttached]
  );

  const handleUpload = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onUpload?.(path);
    },
    [onUpload, path]
  );

  const handleCreateFolder = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onCreateFolder?.(path);
    },
    [onCreateFolder, path]
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete?.(path);
    },
    [onDelete, path]
  );

  const longPress = useLongPress();

  const folderContextValue = useMemo(
    () => ({ isExpanded, name, path }),
    [isExpanded, name, path]
  );

  return (
    <FileTreeFolderContext.Provider value={folderContextValue}>
      <Collapsible onOpenChange={handleToggle} open={isExpanded}>
        <div
          className={cn("", className)}
          role="treeitem"
          tabIndex={0}
          {...props}
        >
          <Tooltip open={longPress.tooltipOpen}>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "group/folder flex w-full items-center gap-1 rounded px-2 py-1 text-left transition-colors hover:bg-muted/50 select-none",
                  selectionMode && isChecked && "bg-primary/10"
                )}
                onClick={selectionMode ? handleFolderClick : undefined}
                {...longPress.handlers}
              >
            {selectionMode ? (
              <span
                className={cn(
                  "flex size-4 items-center justify-center shrink-0 rounded border transition-colors",
                  isChecked
                    ? "bg-primary border-primary text-primary-foreground"
                    : "border-muted-foreground/40 hover:border-primary"
                )}
                onClick={(e) => { e.stopPropagation(); onToggleSelect?.(path); }}
              >
                {isChecked && <CheckIcon className="size-3" />}
              </span>
            ) : (
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 hover:bg-muted"
                onClick={(e) => e.stopPropagation()}
              >
                <ChevronRightIcon
                  className={cn(
                    "size-4 text-muted-foreground transition-transform",
                    isExpanded && "rotate-90"
                  )}
                />
              </button>
            </CollapsibleTrigger>
            )}
            {!selectionMode && gitStatus && <span className="size-1.5 rounded-full bg-yellow-500 shrink-0" />}
            <FileTreeIcon>
              {isExpanded ? (
                <FolderOpenIcon className="size-4 text-blue-500" />
              ) : (
                <FolderIcon className="size-4 text-blue-500" />
              )}
            </FileTreeIcon>
            <FileTreeName>{name}</FileTreeName>
            {(onUpload || onCreateFolder || onDelete || onAdd) && (
              <span className="ml-auto flex shrink-0 items-center">
                {(onUpload || onCreateFolder || onDelete) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="flex size-8 items-center justify-center rounded transition-opacity hover:bg-muted md:size-5 md:opacity-0 md:group-hover/folder:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                        title="More actions"
                      >
                        <EllipsisIcon className="size-4 text-muted-foreground md:size-3" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[140px]">
                      {onUpload && (
                        <DropdownMenuItem onClick={handleUpload}>
                          <UploadIcon className="size-4" />
                          Upload files
                        </DropdownMenuItem>
                      )}
                      {onCreateFolder && (
                        <DropdownMenuItem onClick={handleCreateFolder}>
                          <FolderPlusIcon className="size-4" />
                          New folder
                        </DropdownMenuItem>
                      )}
                      {onDelete && (
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={handleDelete}
                        >
                          <Trash2Icon className="size-4" />
                          Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {onAdd && (
                  <button
                    type="button"
                    className={cn(
                      "flex size-8 items-center justify-center rounded transition-opacity hover:bg-muted md:size-5",
                      isAttached ? "opacity-100" : "md:opacity-0 md:group-hover/folder:opacity-100"
                    )}
                    onClick={handleAdd}
                    title={isAttached ? "Remove folder from chat" : "Add folder to chat"}
                  >
                    {isAttached ? (
                      <MinusIcon className="size-4 text-orange-500 md:size-3" />
                    ) : (
                      <PlusIcon className="size-4 text-muted-foreground md:size-3" />
                    )}
                  </button>
                )}
              </span>
            )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="flex max-w-[min(300px,80vw)] items-center gap-2 break-all font-mono">
              <span className="min-w-0">{path}</span>
              <FolderCopyButton path={path} />
              <button
                type="button"
                className="shrink-0 rounded-sm p-0.5 text-background/60 hover:text-background"
                onClick={longPress.dismiss}
              >
                <XIcon className="size-3" />
              </button>
            </TooltipContent>
          </Tooltip>
          <CollapsibleContent>
            <div className="ml-4 border-l pl-2">{children}</div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </FileTreeFolderContext.Provider>
  );
};

interface FileTreeFileContextType {
  path: string;
  name: string;
}

const FileTreeFileContext = createContext<FileTreeFileContextType>({
  name: "",
  path: "",
});

export type FileTreeFileProps = HTMLAttributes<HTMLDivElement> & {
  path: string;
  name: string;
  icon?: ReactNode;
};

export const FileTreeFile = ({
  path,
  name,
  icon,
  className,
  children,
  ...props
}: FileTreeFileProps) => {
  const { selectedPath, onSelect, onAdd, onRemove, onDownload, onDelete, onDiff, attachedPaths, gitStatusMap, selectionMode, selectedPaths, onToggleSelect } = useContext(FileTreeContext);
  const isSelected = selectedPath === path;
  const isAttached = attachedPaths?.has(path) ?? false;
  const isChecked = selectedPaths?.has(path) ?? false;
  const gitStatus = gitStatusMap?.get(path);

  const gitDotColor = gitStatus === 'M' ? 'bg-yellow-500'
    : (gitStatus === 'A' || gitStatus === '?') ? 'bg-green-500'
    : undefined;

  const gitTextClass = gitStatus === 'M' ? 'text-yellow-600 dark:text-yellow-400'
    : (gitStatus === 'A' || gitStatus === '?') ? 'text-green-600 dark:text-green-400'
    : undefined;

  const longPress = useLongPress();

  const handleClick = useCallback(() => {
    if (longPress.cancelClick()) return;
    if (selectionMode) {
      onToggleSelect?.(path);
      return;
    }
    onSelect?.(path);
  }, [onSelect, path, longPress, selectionMode, onToggleSelect]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        onSelect?.(path);
      }
    },
    [onSelect, path]
  );

  const handleAdd = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isAttached) {
        onRemove?.(path);
      } else {
        onAdd?.(path);
      }
    },
    [onAdd, onRemove, path, isAttached]
  );

  const handleDownload = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDownload?.(path);
    },
    [onDownload, path]
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete?.(path);
    },
    [onDelete, path]
  );

  const handleDiff = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDiff?.(path);
    },
    [onDiff, path]
  );

  const fileContextValue = useMemo(() => ({ name, path }), [name, path]);

  return (
    <FileTreeFileContext.Provider value={fileContextValue}>
      <Tooltip open={longPress.tooltipOpen}>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "group/file flex cursor-pointer items-center gap-1 rounded px-2 py-1 transition-colors hover:bg-muted/50 select-none",
              isSelected && !selectionMode && "bg-muted",
              selectionMode && isChecked && "bg-primary/10",
              className
            )}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            role="treeitem"
            tabIndex={0}
            {...props}
            {...longPress.handlers}
          >
            {children ?? (
              <>
                {/* Selection checkbox (multi-select mode) */}
                {selectionMode && (
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center shrink-0 rounded border transition-colors",
                      isChecked
                        ? "bg-primary border-primary text-primary-foreground"
                        : "border-muted-foreground/40 hover:border-primary"
                    )}
                    onClick={(e) => { e.stopPropagation(); onToggleSelect?.(path); }}
                  >
                    {isChecked && <CheckIcon className="size-3" />}
                  </span>
                )}
                {/* Git status dot / alignment spacer */}
                {!selectionMode && (
                <span className="flex size-4 items-center justify-center shrink-0">
                  {gitDotColor && <span className={cn("size-1.5 rounded-full", gitDotColor)} />}
                </span>
                )}
                <FileTreeIcon>
                  {icon ?? <FileIcon className="size-4 text-muted-foreground" />}
                </FileTreeIcon>
                {/* Split name into stem + extension so the extension is always visible */}
                {(() => {
                  const dotIdx = name.lastIndexOf(".");
                  if (dotIdx <= 0) return <FileTreeName className={gitTextClass}>{name}</FileTreeName>;
                  const stem = name.slice(0, dotIdx);
                  const ext = name.slice(dotIdx);
                  return (
                    <span className="flex min-w-0 items-baseline">
                      <span className={cn("truncate", gitTextClass)}>{stem}</span>
                      <span className={cn("shrink-0", gitTextClass || "text-muted-foreground")}>{ext}</span>
                    </span>
                  );
                })()}
            {(onDownload || onDelete || onAdd || (onDiff && gitStatus)) && (
              <span className="ml-auto flex shrink-0 items-center">
                {!selectionMode && gitStatus && onDiff && (
                  <button
                    type="button"
                    className="flex size-8 items-center justify-center rounded transition-opacity hover:bg-muted md:size-5 md:opacity-0 md:group-hover/file:opacity-100"
                    onClick={handleDiff}
                    title="View diff"
                  >
                    <FileDiffIcon className="size-4 text-muted-foreground md:size-3" />
                  </button>
                )}
                <CopyNameButton name={name} />
                {(onDownload || onDelete) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="flex size-8 items-center justify-center rounded transition-opacity hover:bg-muted md:size-5 md:opacity-0 md:group-hover/file:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                        title="More actions"
                      >
                        <EllipsisIcon className="size-4 text-muted-foreground md:size-3" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[140px]">
                      {onDownload && (
                        <DropdownMenuItem onClick={handleDownload}>
                          <DownloadIcon className="size-4" />
                          Download
                        </DropdownMenuItem>
                      )}
                      {onDelete && (
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={handleDelete}
                        >
                          <Trash2Icon className="size-4" />
                          Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {onAdd && (
                  <button
                    type="button"
                    className={cn(
                      "flex size-8 items-center justify-center rounded transition-opacity hover:bg-muted md:size-5",
                      isAttached ? "opacity-100" : "md:opacity-0 md:group-hover/file:opacity-100"
                    )}
                    onClick={handleAdd}
                    title={isAttached ? "Remove from chat" : "Add to chat"}
                  >
                    {isAttached ? (
                      <MinusIcon className="size-4 text-orange-500 md:size-3" />
                    ) : (
                      <PlusIcon className="size-4 text-muted-foreground md:size-3" />
                    )}
                  </button>
                )}
              </span>
            )}
          </>
        )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="flex max-w-[min(300px,80vw)] items-center gap-2 break-all font-mono">
          <span className="min-w-0">{path}</span>
          <FileCopyButton path={path} />
          <button
            type="button"
            className="shrink-0 rounded-sm p-0.5 text-background/60 hover:text-background"
            onClick={longPress.dismiss}
          >
            <XIcon className="size-3" />
          </button>
        </TooltipContent>
      </Tooltip>
    </FileTreeFileContext.Provider>
  );
};

export type FileTreeIconProps = HTMLAttributes<HTMLSpanElement>;

export const FileTreeIcon = ({
  className,
  children,
  ...props
}: FileTreeIconProps) => (
  <span className={cn("shrink-0", className)} {...props}>
    {children}
  </span>
);

export type FileTreeNameProps = HTMLAttributes<HTMLSpanElement>;

export const FileTreeName = ({
  className,
  children,
  ...props
}: FileTreeNameProps) => (
  <span className={cn("truncate", className)} {...props}>
    {children}
  </span>
);

// Copy button — mirrors the exact pattern used by CodeBlockCopyButton (which works on mobile HTTP).
// Key: await the clipboard call, provide own execCommand fallback, show visual feedback.
function CopyNameButton({ name }: { name: string }) {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number>(0);

  useEffect(() => () => { window.clearTimeout(timeoutRef.current); }, []);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    // Fire-and-forget — the polyfill's execCommand runs synchronously inside
    // the Promise constructor, so the copy happens immediately.
    // Don't await: the promise may reject on HTTP even though the copy succeeded.
    navigator.clipboard.writeText(name).catch(() => {});
    setIsCopied(true);
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setIsCopied(false), 1500);
  }, [name]);

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <button
      type="button"
      className="flex size-8 items-center justify-center rounded transition-opacity hover:bg-muted md:size-5 md:opacity-0 md:group-hover/file:opacity-100"
      onClick={handleCopy}
      title="Copy file name"
    >
      <Icon className={cn("size-4 md:size-3", isCopied ? "text-green-500" : "text-muted-foreground")} />
    </button>
  );
}

export type FileTreeActionsProps = HTMLAttributes<HTMLDivElement>;

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

export const FileTreeActions = ({
  className,
  children,
  ...props
}: FileTreeActionsProps) => (
  // biome-ignore lint/a11y/noNoninteractiveElementInteractions: stopPropagation required for nested interactions
  // biome-ignore lint/a11y/useSemanticElements: fieldset doesn't fit this UI pattern
  <div
    className={cn("ml-auto flex items-center gap-1", className)}
    onClick={stopPropagation}
    onKeyDown={stopPropagation}
    role="group"
    {...props}
  >
    {children}
  </div>
);
