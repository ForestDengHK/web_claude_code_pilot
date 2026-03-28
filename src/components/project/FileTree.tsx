"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { RefreshIcon, Search01Icon, SourceCodeIcon, CodeIcon, File01Icon, CheckListIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { cn } from "@/lib/utils";
import type { FileTreeNode } from "@/types";
import {
  FileTree as AIFileTree,
  FileTreeFolder,
  FileTreeFile,
} from "@/components/ai-elements/file-tree";
import type { ReactNode } from "react";

const PREVIEWABLE_EXTENSIONS = new Set([
  // Markup & data
  "md", "mdx", "html", "htm", "json", "yaml", "yml", "toml", "csv", "tsv", "svg", "xml",
  // Images
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico",
  // Code
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cpp", "h", "hpp", "cs",
  "php", "dart", "lua", "zig", "vue", "svelte",
  // Config & scripting
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "sql", "graphql", "gql", "prisma",
  "css", "scss", "less", "sass",
  "dockerfile", "makefile", "cmake",
  "ini", "cfg", "conf", "env", "properties",
  "txt", "log", "gitignore", "editorconfig",
]);

interface FileTreeProps {
  workingDirectory: string;
  onFileSelect: (path: string) => void;
  onFileAdd?: (path: string, isDirectory?: boolean) => void;
  onFileRemove?: (path: string) => void;
  onFilePreview?: (path: string) => void;
}

function getFileIcon(extension?: string): ReactNode {
  switch (extension) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "py":
    case "rb":
    case "rs":
    case "go":
    case "java":
    case "c":
    case "cpp":
    case "h":
    case "hpp":
    case "cs":
    case "swift":
    case "kt":
    case "dart":
    case "lua":
    case "php":
    case "zig":
      return <HugeiconsIcon icon={SourceCodeIcon} className="size-4 text-muted-foreground" />;
    case "json":
    case "yaml":
    case "yml":
    case "toml":
      return <HugeiconsIcon icon={CodeIcon} className="size-4 text-muted-foreground" />;
    case "md":
    case "mdx":
    case "txt":
    case "csv":
      return <HugeiconsIcon icon={File01Icon} className="size-4 text-muted-foreground" />;
    default:
      return <HugeiconsIcon icon={File01Icon} className="size-4 text-muted-foreground" />;
  }
}

function containsMatch(node: FileTreeNode, query: string): boolean {
  const q = query.toLowerCase();
  if (node.name.toLowerCase().includes(q)) return true;
  if (node.children) {
    return node.children.some((child) => containsMatch(child, q));
  }
  return false;
}

function filterTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  if (!query) return nodes;
  return nodes
    .filter((node) => containsMatch(node, query))
    .map((node) => ({
      ...node,
      children: node.children ? filterTree(node.children, query) : undefined,
    }));
}

function buildGitStatusMap(nodes: FileTreeNode[]): Map<string, string> {
  const map = new Map<string, string>();
  function walk(ns: FileTreeNode[]) {
    for (const n of ns) {
      if (n.gitStatus) map.set(n.path, n.gitStatus);
      if (n.children) walk(n.children);
    }
  }
  walk(nodes);
  return map;
}

function RenderTreeNodes({ nodes, searchQuery }: { nodes: FileTreeNode[]; searchQuery: string }) {
  const filtered = searchQuery ? filterTree(nodes, searchQuery) : nodes;

  return (
    <>
      {filtered.map((node) => {
        if (node.type === "directory") {
          return (
            <FileTreeFolder key={node.path} path={node.path} name={node.name}>
              {node.children && (
                <RenderTreeNodes nodes={node.children} searchQuery={searchQuery} />
              )}
            </FileTreeFolder>
          );
        }
        return (
          <FileTreeFile
            key={node.path}
            path={node.path}
            name={node.name}
            icon={getFileIcon(node.extension)}
          />
        );
      })}
    </>
  );
}

export function FileTree({ workingDirectory, onFileSelect, onFileAdd, onFileRemove, onFilePreview }: FileTreeProps) {
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [attachedPaths, setAttachedPaths] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [gitStatusMap, setGitStatusMap] = useState<Map<string, string>>(new Map());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  // Multi-select
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const lazyLoadingRef = useRef<Set<string>>(new Set());

  // Lazy-load children for directories that were truncated by depth limit
  const lazyLoadChildren = useCallback(async (dirPath: string) => {
    if (lazyLoadingRef.current.has(dirPath)) return; // already loading
    lazyLoadingRef.current.add(dirPath);
    try {
      const res = await fetch(
        `/api/files?dir=${encodeURIComponent(dirPath)}&baseDir=${encodeURIComponent(workingDirectory)}&depth=3`
      );
      if (!res.ok) return;
      const data = await res.json();
      const children: FileTreeNode[] = data.tree || [];
      if (children.length === 0) return;

      // Merge children into the tree
      setTree(prev => {
        function mergeAt(nodes: FileTreeNode[]): FileTreeNode[] {
          return nodes.map(node => {
            if (node.path === dirPath && node.type === 'directory') {
              return { ...node, children };
            }
            if (node.children) {
              return { ...node, children: mergeAt(node.children) };
            }
            return node;
          });
        }
        return mergeAt(prev);
      });
      // Update git status for new nodes
      setGitStatusMap(prev => {
        const newMap = new Map(prev);
        function walkNewNodes(ns: FileTreeNode[]) {
          for (const n of ns) {
            if (n.gitStatus) newMap.set(n.path, n.gitStatus);
            if (n.children) walkNewNodes(n.children);
          }
        }
        walkNewNodes(children);
        return newMap;
      });
    } finally {
      lazyLoadingRef.current.delete(dirPath);
    }
  }, [workingDirectory]);

  // Find empty directories in expanded set and lazy-load them
  const lazyLoadEmptyDirs = useCallback((newExpanded: Set<string>, currentTree: FileTreeNode[]) => {
    function findNode(nodes: FileTreeNode[], targetPath: string): FileTreeNode | null {
      for (const n of nodes) {
        if (n.path === targetPath) return n;
        if (n.children) {
          const found = findNode(n.children, targetPath);
          if (found) return found;
        }
      }
      return null;
    }

    for (const p of newExpanded) {
      const node = findNode(currentTree, p);
      if (node && node.type === 'directory' && node.children && node.children.length === 0) {
        lazyLoadChildren(p);
      }
    }
  }, [lazyLoadChildren]);

  // Handle expand change from tree toggle: update state + lazy load
  const handleExpandedChange = useCallback((newExpanded: Set<string>) => {
    setExpandedPaths(newExpanded);
    lazyLoadEmptyDirs(newExpanded, tree);
  }, [tree, lazyLoadEmptyDirs]);

  const fetchTree = useCallback(async () => {
    // Abort any in-flight request to prevent stale responses
    // from overwriting fresher data (race condition on directory switch)
    abortRef.current?.abort();

    if (!workingDirectory) {
      setTree([]);
      setGitStatusMap(new Map());
      setExpandedPaths(new Set());
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const res = await fetch(
        `/api/files?dir=${encodeURIComponent(workingDirectory)}&baseDir=${encodeURIComponent(workingDirectory)}&depth=4`,
        { signal: controller.signal }
      );
      if (res.ok) {
        const data = await res.json();
        const newTree = data.tree || [];
        setTree(newTree);
        setGitStatusMap(buildGitStatusMap(newTree));
        // Start collapsed on fresh load — user can expand as needed
        setExpandedPaths(prev => prev.size === 0 ? new Set() : prev);
      } else {
        setTree([]);
        setGitStatusMap(new Map());
      }
    } catch (e) {
      // Silently ignore aborted requests
      if (e instanceof DOMException && e.name === "AbortError") return;
      setTree([]);
      setGitStatusMap(new Map());
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [workingDirectory]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  // Auto-refresh when AI finishes streaming
  useEffect(() => {
    const handler = () => fetchTree();
    window.addEventListener('refresh-file-tree', handler);
    return () => window.removeEventListener('refresh-file-tree', handler);
  }, [fetchTree]);

  // Track attached file paths from chat input
  useEffect(() => {
    const handler = (e: Event) => {
      const paths = (e as CustomEvent<Set<string>>).detail;
      setAttachedPaths(paths);
    };
    window.addEventListener('attached-files-changed', handler);
    return () => window.removeEventListener('attached-files-changed', handler);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget || !workingDirectory) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/files?path=${encodeURIComponent(deleteTarget)}&baseDir=${encodeURIComponent(workingDirectory)}`,
        { method: 'DELETE' }
      );
      if (res.ok) {
        fetchTree();
      }
    } catch {
      // silently fail
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, workingDirectory, fetchTree]);

  // Collect all file/folder paths under a node (for folder selection)
  const collectAllPaths = useCallback((nodes: FileTreeNode[]): string[] => {
    const paths: string[] = [];
    function walk(ns: FileTreeNode[]) {
      for (const n of ns) {
        paths.push(n.path);
        if (n.children) walk(n.children);
      }
    }
    walk(nodes);
    return paths;
  }, []);

  // Find a node in the tree by path
  const findNode = useCallback((nodes: FileTreeNode[], targetPath: string): FileTreeNode | null => {
    for (const n of nodes) {
      if (n.path === targetPath) return n;
      if (n.children) {
        const found = findNode(n.children, targetPath);
        if (found) return found;
      }
    }
    return null;
  }, []);

  // Toggle selection of a path (and all children if it's a folder)
  const handleToggleSelect = useCallback((targetPath: string) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      const node = findNode(tree, targetPath);
      if (next.has(targetPath)) {
        // Deselect this path and all descendants
        next.delete(targetPath);
        if (node?.children) {
          for (const p of collectAllPaths(node.children)) {
            next.delete(p);
          }
        }
      } else {
        // Select this path and all descendants
        next.add(targetPath);
        if (node?.children) {
          for (const p of collectAllPaths(node.children)) {
            next.add(p);
          }
        }
      }
      return next;
    });
  }, [tree, findNode, collectAllPaths]);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedPaths(new Set());
  }, []);

  // Batch delete: delete all selected paths sequentially
  const handleBatchDeleteConfirm = useCallback(async () => {
    if (selectedPaths.size === 0 || !workingDirectory) return;
    setDeleting(true);
    try {
      // Sort by path length descending so children are deleted before parents
      const sorted = [...selectedPaths].sort((a, b) => b.length - a.length);
      for (const p of sorted) {
        try {
          await fetch(
            `/api/files?path=${encodeURIComponent(p)}&baseDir=${encodeURIComponent(workingDirectory)}`,
            { method: 'DELETE' }
          );
        } catch {
          // Continue deleting remaining files
        }
      }
      fetchTree();
    } finally {
      setDeleting(false);
      setBatchDeleteConfirm(false);
      exitSelectionMode();
    }
  }, [selectedPaths, workingDirectory, fetchTree, exitSelectionMode]);

  // Get all directory paths in the tree for expand/collapse all
  const getAllDirectoryPaths = useCallback((nodes: FileTreeNode[]): string[] => {
    const paths: string[] = [];
    function walk(ns: FileTreeNode[]) {
      for (const n of ns) {
        if (n.type === 'directory') {
          paths.push(n.path);
          if (n.children) walk(n.children);
        }
      }
    }
    walk(nodes);
    return paths;
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 shrink-0">
        <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={workingDirectory}>
          {workingDirectory || 'No directory selected'}
        </p>
        {tree.length > 0 && (
          <>
            {!selectionMode && (
              <button
                className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors px-1.5 py-0.5 rounded shrink-0"
                onClick={() => {
                  const allDirs = getAllDirectoryPaths(tree);
                  const allExpanded = allDirs.every(p => expandedPaths.has(p));
                  if (allExpanded) {
                    setExpandedPaths(new Set());
                  } else {
                    const newExpanded = new Set(allDirs);
                    setExpandedPaths(newExpanded);
                    lazyLoadEmptyDirs(newExpanded, tree);
                  }
                }}
              >
                {tree.length > 0 && getAllDirectoryPaths(tree).every(p => expandedPaths.has(p)) ? 'Collapse' : 'Expand'}
              </button>
            )}
            <Button
              variant={selectionMode ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => selectionMode ? exitSelectionMode() : setSelectionMode(true)}
              className={cn("h-8 w-8 shrink-0", selectionMode && "text-primary")}
              title={selectionMode ? "Exit select mode" : "Select files"}
            >
              <HugeiconsIcon icon={CheckListIcon} className="h-4 w-4" />
              <span className="sr-only">{selectionMode ? "Exit select" : "Select"}</span>
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={fetchTree}
          disabled={loading}
          className="h-8 w-8 shrink-0"
        >
          <HugeiconsIcon icon={RefreshIcon} className={cn("h-4 w-4", loading && "animate-spin")} />
          <span className="sr-only">Refresh</span>
        </Button>
      </div>

      {/* Search */}
      <div className="px-4 pb-2 shrink-0">
        <div className="relative">
          <HugeiconsIcon icon={Search01Icon} className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Filter files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-auto">
        {loading && tree.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <HugeiconsIcon icon={RefreshIcon} className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : tree.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {workingDirectory ? 'No files found' : 'Select a project folder to view files'}
          </p>
        ) : (
          <AIFileTree
            expanded={expandedPaths}
            onExpandedChange={handleExpandedChange}
            gitStatusMap={gitStatusMap}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI Elements FileTree onSelect type conflicts with HTMLAttributes.onSelect
            onSelect={onFileSelect as any}
            onAdd={onFileAdd}
            onRemove={onFileRemove}
            attachedPaths={attachedPaths}
            onPreview={onFilePreview ? (path: string) => {
              const ext = path.split(".").pop()?.toLowerCase() || "";
              if (PREVIEWABLE_EXTENSIONS.has(ext)) onFilePreview(path);
            } : undefined}
            onDownload={(filePath: string) => {
              const url = `/api/files/raw?path=${encodeURIComponent(filePath)}&download=1`;
              const a = document.createElement("a");
              a.href = url;
              a.download = filePath.split("/").pop() || "file";
              document.body.appendChild(a);
              a.click();
              a.remove();
            }}
            onDelete={(filePath: string) => setDeleteTarget(filePath)}
            selectionMode={selectionMode}
            selectedPaths={selectedPaths}
            onToggleSelect={handleToggleSelect}
            className="border-0 rounded-none"
          >
            <RenderTreeNodes nodes={tree} searchQuery={searchQuery} />
          </AIFileTree>
        )}
      </div>

      {/* Floating action bar for multi-select */}
      {selectionMode && selectedPaths.size > 0 && (
        <div className="shrink-0 border-t bg-background/95 backdrop-blur-sm px-3 py-2 flex items-center gap-2">
          <span className="text-xs text-muted-foreground min-w-0 truncate">
            {selectedPaths.size} selected
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={exitSelectionMode}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setBatchDeleteConfirm(true)}
            >
              Delete {selectedPaths.size}
            </Button>
          </div>
        </div>
      )}

      {/* Single file delete confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">Delete file</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>This will permanently delete:</p>
                <p className="rounded bg-muted px-2 py-1 font-mono text-xs text-foreground break-all">
                  {deleteTarget?.split("/").pop()}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Batch delete confirmation dialog */}
      <AlertDialog open={batchDeleteConfirm} onOpenChange={(open) => { if (!open) setBatchDeleteConfirm(false); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">Delete {selectedPaths.size} items</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>This will permanently delete {selectedPaths.size} {selectedPaths.size === 1 ? 'item' : 'items'}:</p>
                <div className="max-h-32 overflow-auto rounded bg-muted px-2 py-1 font-mono text-xs text-foreground space-y-0.5">
                  {[...selectedPaths].slice(0, 10).map(p => (
                    <p key={p} className="break-all">{p.split("/").pop()}</p>
                  ))}
                  {selectedPaths.size > 10 && (
                    <p className="text-muted-foreground">...and {selectedPaths.size - 10} more</p>
                  )}
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              onClick={handleBatchDeleteConfirm}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : `Delete ${selectedPaths.size}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
