"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { usePanel } from "@/hooks/usePanel";
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { FileTreeNode } from "@/types";
import {
  FileTree as AIFileTree,
  FileTreeFolder,
  FileTreeFile,
} from "@/components/ai-elements/file-tree";
import { EllipsisIcon, UploadIcon, FolderPlusIcon } from "lucide-react";
import { BranchSelector } from "@/components/project/BranchSelector";
import type { ReactNode } from "react";

const SHOW_HIDDEN_STORAGE_KEY = "codepilot:fileTree:showHidden";

/**
 * Matches the server-side `isDotfileHidden` in `src/lib/files.ts`. Inlined here
 * because `@/lib/files` imports `fs` and can't be bundled client-side. If you
 * change this rule, update the other copy too.
 */
function isDotfileHidden(name: string): boolean {
  return name.startsWith(".") && !name.startsWith(".env") && name !== ".codepilot-uploads";
}

const PREVIEWABLE_EXTENSIONS = new Set([
  // Markup & data
  "md", "mdx", "html", "htm", "json", "yaml", "yml", "toml", "csv", "tsv", "svg", "xml",
  // Images
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico",
  // Video (browser-playable formats)
  "mp4", "webm", "mov", "m4v",
  // Audio
  "mp3", "wav", "ogg", "aac", "flac",
  // Office documents (converted to PDF for preview when LibreOffice is available)
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
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
  sessionId?: string | null;
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

function getDirectoryLabel(dir: string): string {
  if (!dir) return "No directory selected";
  const normalized = dir.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || dir;
}

function RenderTreeNodes({ nodes, searchQuery }: { nodes: FileTreeNode[]; searchQuery: string }) {
  const filtered = searchQuery ? filterTree(nodes, searchQuery) : nodes;

  return (
    <>
      {filtered.map((node) => {
        // Dim entries that are normally hidden so the user can tell them apart
        // from regular files even when "Show hidden files" is enabled.
        const mutedClass = isDotfileHidden(node.name) ? "opacity-60" : undefined;
        if (node.type === "directory") {
          return (
            <FileTreeFolder
              key={node.path}
              path={node.path}
              name={node.name}
              className={mutedClass}
            >
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
            className={mutedClass}
          />
        );
      })}
    </>
  );
}

export function FileTree({ workingDirectory, sessionId, onFileSelect, onFileAdd, onFileRemove, onFilePreview }: FileTreeProps) {
  // Per-root tree storage. The cwd is always a root; additional roots come
  // from project settings. Paths are absolute, so other state (gitStatus,
  // expanded, attached, selected) can stay global without collisions.
  const [treesByRoot, setTreesByRoot] = useState<Record<string, FileTreeNode[]>>({});
  const [additionalDirectories, setAdditionalDirectories] = useState<string[]>([]);
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Branch per root. Primary cwd's branch drives the top-header selector;
  // additional roots get their own selector inside the section header.
  const [gitBranchByRoot, setGitBranchByRoot] = useState<Record<string, string | null>>({});
  const gitBranch = gitBranchByRoot[workingDirectory] ?? null;
  const [attachedPaths, setAttachedPaths] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [gitStatusMap, setGitStatusMap] = useState<Map<string, string>>(new Map());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  // Multi-select
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false);

  // Roots in render order: primary cwd first, then additional dirs (deduped,
  // and additional roots that are subpaths of cwd are dropped to avoid
  // visual duplication).
  const roots = useMemo<string[]>(() => {
    const out: string[] = [];
    if (workingDirectory) out.push(workingDirectory);
    for (const d of additionalDirectories) {
      if (!d) continue;
      if (out.includes(d)) continue;
      if (workingDirectory && (d === workingDirectory || d.startsWith(workingDirectory + '/'))) continue;
      out.push(d);
    }
    return out;
  }, [workingDirectory, additionalDirectories]);

  // Pick the root that contains a given absolute path. Longest-match wins so
  // a file inside a nested additional dir resolves to that dir, not the cwd.
  const findBaseDirForPath = useCallback((absolutePath: string): string => {
    let best = workingDirectory;
    let bestLen = workingDirectory && absolutePath.startsWith(workingDirectory + '/') ? workingDirectory.length : -1;
    for (const r of roots) {
      if (absolutePath === r || absolutePath.startsWith(r + '/')) {
        if (r.length > bestLen) {
          best = r;
          bestLen = r.length;
        }
      }
    }
    return best;
  }, [workingDirectory, roots]);

  // Show/hide dotfiles (persisted per-browser, global across projects)
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    try {
      return typeof window !== "undefined"
        && window.localStorage.getItem(SHOW_HIDDEN_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const toggleShowHidden = useCallback(() => {
    setShowHidden((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SHOW_HIDDEN_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // localStorage may be disabled (private mode, etc.) — silently ignore
      }
      return next;
    });
  }, []);

  // Folder operations — upload
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);
  // Folder operations — new folder dialog
  const [createFolderTarget, setCreateFolderTarget] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Note: folder deletion reuses the existing deleteTarget/handleDeleteConfirm flow

  const { setDiffTarget } = usePanel();

  const handleDiff = useCallback((absolutePath: string) => {
    // Diff is anchored to the cwd's repo. Files under additional roots belong
    // to other repos; emit the absolute path so the diff view can decide.
    const inCwd = workingDirectory && absolutePath.startsWith(workingDirectory);
    const relative = inCwd
      ? absolutePath.slice(workingDirectory.length).replace(/^\//, '')
      : absolutePath;
    setDiffTarget({ file: relative });
  }, [workingDirectory, setDiffTarget]);

  const abortRef = useRef<AbortController | null>(null);
  const lazyLoadingRef = useRef<Set<string>>(new Set());
  const directoryLabel = getDirectoryLabel(workingDirectory);

  // Lazy-load children for directories that were truncated by depth limit
  const lazyLoadChildren = useCallback(async (dirPath: string) => {
    if (lazyLoadingRef.current.has(dirPath)) return; // already loading
    const baseDir = findBaseDirForPath(dirPath);
    if (!baseDir) return;
    lazyLoadingRef.current.add(dirPath);
    try {
      const hiddenParam = showHidden ? "&hidden=1" : "";
      const res = await fetch(
        `/api/files?dir=${encodeURIComponent(dirPath)}&baseDir=${encodeURIComponent(baseDir)}&depth=3${hiddenParam}`
      );
      if (!res.ok) return;
      const data = await res.json();
      const children: FileTreeNode[] = data.tree || [];
      if (children.length === 0) return;

      // Merge children into the matching root's tree
      setTreesByRoot(prev => {
        const cur = prev[baseDir];
        if (!cur) return prev;
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
        return { ...prev, [baseDir]: mergeAt(cur) };
      });
      // Update git status for new nodes, and propagate 'M' up through the
      // lazy-loaded dir's ancestors. Server-side annotation only runs over the
      // newly-fetched subtree, so ancestor dirs that had empty children at
      // initial scan won't have their status set otherwise — files would show
      // a dot but every folder above them wouldn't.
      setGitStatusMap(prev => {
        const newMap = new Map(prev);
        let anyStatus = false;
        function walkNewNodes(ns: FileTreeNode[]) {
          for (const n of ns) {
            if (n.gitStatus) {
              newMap.set(n.path, n.gitStatus);
              anyStatus = true;
            }
            if (n.children) walkNewNodes(n.children);
          }
        }
        walkNewNodes(children);
        if (anyStatus) {
          // Mark the lazy-loaded dir and walk up to (but not past) baseDir.
          let current = dirPath;
          while (current.length >= baseDir.length) {
            if (!newMap.has(current)) newMap.set(current, 'M');
            if (current === baseDir) break;
            const slash = current.lastIndexOf('/');
            if (slash <= 0) break;
            current = current.slice(0, slash);
          }
        }
        return newMap;
      });
    } finally {
      lazyLoadingRef.current.delete(dirPath);
    }
  }, [findBaseDirForPath, showHidden]);

  // Find empty directories in expanded set and lazy-load them. Searches all
  // roots since the path could belong to any of them.
  const lazyLoadEmptyDirs = useCallback((newExpanded: Set<string>, currentTrees: Record<string, FileTreeNode[]>) => {
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
      let node: FileTreeNode | null = null;
      for (const tree of Object.values(currentTrees)) {
        node = findNode(tree, p);
        if (node) break;
      }
      if (node && node.type === 'directory' && node.children && node.children.length === 0) {
        lazyLoadChildren(p);
      }
    }
  }, [lazyLoadChildren]);

  // Handle expand change from tree toggle: update state + lazy load
  const handleExpandedChange = useCallback((newExpanded: Set<string>) => {
    setExpandedPaths(newExpanded);
    lazyLoadEmptyDirs(newExpanded, treesByRoot);
  }, [treesByRoot, lazyLoadEmptyDirs]);

  const fetchTree = useCallback(async () => {
    // Abort any in-flight request to prevent stale responses
    // from overwriting fresher data (race condition on directory switch)
    abortRef.current?.abort();

    if (roots.length === 0) {
      setTreesByRoot({});
      setGitStatusMap(new Map());
      setGitBranchByRoot({});
      setExpandedPaths(new Set());
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const hiddenParam = showHidden ? "&hidden=1" : "";
      // Fetch all roots in parallel.
      const results = await Promise.all(
        roots.map(async (root) => {
          try {
            const res = await fetch(
              `/api/files?dir=${encodeURIComponent(root)}&baseDir=${encodeURIComponent(root)}&depth=4${hiddenParam}`,
              { signal: controller.signal }
            );
            if (!res.ok) return { root, tree: [] as FileTreeNode[], gitBranch: null as string | null };
            const data = await res.json();
            return {
              root,
              tree: (data.tree || []) as FileTreeNode[],
              gitBranch: typeof data.gitBranch === 'string' && data.gitBranch.length > 0 ? data.gitBranch : null,
            };
          } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') throw e;
            return { root, tree: [] as FileTreeNode[], gitBranch: null as string | null };
          }
        })
      );

      const next: Record<string, FileTreeNode[]> = {};
      const combinedGitMap = new Map<string, string>();
      const branchMap: Record<string, string | null> = {};
      for (const { root, tree, gitBranch: rb } of results) {
        next[root] = tree;
        branchMap[root] = rb;
        for (const [k, v] of buildGitStatusMap(tree)) combinedGitMap.set(k, v);
      }
      setTreesByRoot(next);
      setGitStatusMap(combinedGitMap);
      setGitBranchByRoot(branchMap);
      setExpandedPaths(prev => prev.size === 0 ? new Set() : prev);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setTreesByRoot({});
      setGitStatusMap(new Map());
      setGitBranchByRoot({});
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [roots, showHidden]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  // Auto-refresh when AI finishes streaming
  useEffect(() => {
    const handler = () => fetchTree();
    window.addEventListener('refresh-file-tree', handler);
    return () => window.removeEventListener('refresh-file-tree', handler);
  }, [fetchTree]);

  // Load project-level additional directories for the current cwd.
  useEffect(() => {
    if (!workingDirectory) {
      setAdditionalDirectories([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/projects/settings?workingDirectory=${encodeURIComponent(workingDirectory)}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (cancelled || !data) return;
        const list: string[] = Array.isArray(data.additionalDirectories) ? data.additionalDirectories : [];
        setAdditionalDirectories(list);
      })
      .catch(() => { /* keep current state on error */ });
    return () => { cancelled = true; };
  }, [workingDirectory]);

  // Refresh additional dirs when ProjectSettingsDialog saves a change.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ workingDirectory: string; additionalDirectories: string[] }>).detail;
      if (!detail) return;
      if (detail.workingDirectory !== workingDirectory) return;
      setAdditionalDirectories(Array.isArray(detail.additionalDirectories) ? detail.additionalDirectories : []);
    };
    window.addEventListener('project-settings-changed', handler);
    return () => window.removeEventListener('project-settings-changed', handler);
  }, [workingDirectory]);

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
    if (!deleteTarget) return;
    const baseDir = findBaseDirForPath(deleteTarget);
    if (!baseDir) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/files?path=${encodeURIComponent(deleteTarget)}&baseDir=${encodeURIComponent(baseDir)}`,
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
  }, [deleteTarget, findBaseDirForPath, fetchTree]);

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

  // Find a node in a tree by path (recursive within one root's tree)
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

  // Find a node across all roots — paths are absolute so unique.
  const findNodeAcrossRoots = useCallback((targetPath: string): FileTreeNode | null => {
    for (const tree of Object.values(treesByRoot)) {
      const found = findNode(tree, targetPath);
      if (found) return found;
    }
    return null;
  }, [treesByRoot, findNode]);

  // Toggle selection of a path (and all children if it's a folder)
  const handleToggleSelect = useCallback((targetPath: string) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      const node = findNodeAcrossRoots(targetPath);
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
  }, [findNodeAcrossRoots, collectAllPaths]);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedPaths(new Set());
  }, []);

  // Batch delete: delete all selected paths sequentially
  const handleBatchDeleteConfirm = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    setDeleting(true);
    try {
      // Sort by path length descending so children are deleted before parents
      const sorted = [...selectedPaths].sort((a, b) => b.length - a.length);
      for (const p of sorted) {
        const baseDir = findBaseDirForPath(p);
        if (!baseDir) continue;
        try {
          await fetch(
            `/api/files?path=${encodeURIComponent(p)}&baseDir=${encodeURIComponent(baseDir)}`,
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
  }, [selectedPaths, findBaseDirForPath, fetchTree, exitSelectionMode]);

  // --- Folder operations ---

  const handleUpload = useCallback((dirPath: string) => {
    uploadTargetRef.current = dirPath;
    // Reset the input so onChange fires even if the same file is re-selected
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    }
  }, []);

  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    const targetDir = uploadTargetRef.current;
    if (!files || files.length === 0 || !targetDir) return;
    const baseDir = findBaseDirForPath(targetDir);
    if (!baseDir) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('targetDir', targetDir);
      formData.append('baseDir', baseDir);
      for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
      }

      const res = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        const data = await res.json();
        const overwritten = data.files?.filter((f: { overwritten: boolean }) => f.overwritten).length ?? 0;
        const total = data.files?.length ?? 0;

        // Auto-expand the target folder
        setExpandedPaths(prev => {
          const next = new Set(prev);
          next.add(targetDir);
          return next;
        });

        // Refresh tree directly (equivalent to dispatching refresh-file-tree,
        // but more direct since fetchTree is in the same component)
        fetchTree();

        // Log feedback (no toast library in project; user-visible feedback
        // is deferred — the tree refresh itself shows the result immediately)
        if (overwritten > 0) {
          console.log(`Uploaded ${total} file(s), replaced ${overwritten} existing`);
        }
      } else {
        const data = await res.json().catch(() => null);
        console.error('Upload failed:', data?.error || res.statusText);
      }
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setUploading(false);
      uploadTargetRef.current = null;
    }
  }, [workingDirectory, fetchTree]);

  const handleCreateFolder = useCallback((dirPath: string) => {
    setCreateFolderTarget(dirPath);
    setNewFolderName("");
    setCreateError(null);
  }, []);

  const handleCreateFolderConfirm = useCallback(async () => {
    if (!createFolderTarget) return;
    const baseDir = findBaseDirForPath(createFolderTarget);
    if (!baseDir) return;

    const trimmed = newFolderName.trim();
    if (!trimmed) {
      setCreateError("Name cannot be empty");
      return;
    }

    // Client-side validation matching the server regex
    if (/[/\\:*?"<>|\0]|\.\./.test(trimmed)) {
      setCreateError("Name contains invalid characters");
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/files/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentDir: createFolderTarget,
          name: trimmed,
          baseDir,
        }),
      });

      if (res.ok) {
        // Auto-expand the parent folder
        setExpandedPaths(prev => {
          const next = new Set(prev);
          next.add(createFolderTarget);
          return next;
        });
        fetchTree();
        setCreateFolderTarget(null);
      } else if (res.status === 409) {
        setCreateError("A folder with this name already exists");
      } else {
        const data = await res.json().catch(() => null);
        setCreateError(data?.error || "Failed to create folder");
      }
    } catch {
      setCreateError("Network error");
    } finally {
      setCreating(false);
    }
  }, [createFolderTarget, newFolderName, findBaseDirForPath, fetchTree]);

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

  // Across-roots variants for the global header buttons.
  const getAllDirectoryPathsAcrossRoots = useCallback((): string[] => {
    const out: string[] = [];
    for (const tree of Object.values(treesByRoot)) {
      out.push(...getAllDirectoryPaths(tree));
    }
    return out;
  }, [treesByRoot, getAllDirectoryPaths]);

  const totalNodes = useMemo(
    () => Object.values(treesByRoot).reduce((sum, t) => sum + t.length, 0),
    [treesByRoot]
  );

  const toggleRootCollapsed = useCallback((root: string) => {
    setCollapsedRoots(prev => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-start gap-2 px-4 py-2 shrink-0">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground" title={workingDirectory}>
            {directoryLabel}
          </p>
          {workingDirectory && (
            <div
              className="mt-0.5 overflow-x-auto whitespace-nowrap text-[11px] text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              title={workingDirectory}
            >
              {workingDirectory}
            </div>
          )}
          {gitBranch && (
            <div className="mt-1 flex items-center gap-2">
              <BranchSelector
                workingDirectory={workingDirectory}
                gitBranch={gitBranch}
                sessionId={sessionId}
                onBranchChanged={(newBranch) => {
                  setGitBranchByRoot(prev => ({ ...prev, [workingDirectory]: newBranch }));
                  fetchTree();
                }}
              />
            </div>
          )}
        </div>
        {totalNodes > 0 && (
          <>
            {!selectionMode && (
              <button
                className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors px-1.5 py-0.5 rounded shrink-0"
                onClick={() => {
                  const allDirs = getAllDirectoryPathsAcrossRoots();
                  const allExpanded = allDirs.length > 0 && allDirs.every(p => expandedPaths.has(p));
                  if (allExpanded) {
                    setExpandedPaths(new Set());
                  } else {
                    const newExpanded = new Set(allDirs);
                    setExpandedPaths(newExpanded);
                    lazyLoadEmptyDirs(newExpanded, treesByRoot);
                  }
                }}
              >
                {(() => {
                  const allDirs = getAllDirectoryPathsAcrossRoots();
                  return allDirs.length > 0 && allDirs.every(p => expandedPaths.has(p)) ? 'Collapse' : 'Expand';
                })()}
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
        {workingDirectory && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="h-8 w-8 shrink-0" title="More actions">
                <EllipsisIcon className="h-4 w-4" />
                <span className="sr-only">More actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuItem onClick={() => handleUpload(workingDirectory)}>
                <UploadIcon className="size-4" />
                Upload files here
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleCreateFolder(workingDirectory)}>
                <FolderPlusIcon className="size-4" />
                New folder here
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={showHidden}
                onCheckedChange={toggleShowHidden}
                // Prevent the menu from closing so a mobile user can flip the
                // toggle and immediately see it take effect behind the menu.
                onSelect={(e) => e.preventDefault()}
              >
                Show hidden files
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
        {(() => {
          if (loading && totalNodes === 0) {
            return (
              <div className="flex items-center justify-center py-8">
                <HugeiconsIcon icon={RefreshIcon} className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            );
          }
          if (totalNodes === 0) {
            return (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {workingDirectory ? 'No files found' : 'Select a project folder to view files'}
              </p>
            );
          }

          const renderTree = (nodes: FileTreeNode[]) => (
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
              onDownloadFolder={(dirPath: string) => {
                const baseDir = findBaseDirForPath(dirPath);
                const params = new URLSearchParams({ path: dirPath });
                if (baseDir) params.set("baseDir", baseDir);
                const a = document.createElement("a");
                a.href = `/api/files/archive?${params.toString()}`;
                a.download = `${dirPath.split("/").pop() || "download"}.zip`;
                document.body.appendChild(a);
                a.click();
                a.remove();
              }}
              onDelete={(filePath: string) => setDeleteTarget(filePath)}
              onDiff={handleDiff}
              onUpload={handleUpload}
              onCreateFolder={handleCreateFolder}
              selectionMode={selectionMode}
              selectedPaths={selectedPaths}
              onToggleSelect={handleToggleSelect}
              className="border-0 rounded-none"
            >
              <RenderTreeNodes nodes={nodes} searchQuery={searchQuery} />
            </AIFileTree>
          );

          // Single-root: render exactly as before, no section header.
          if (roots.length <= 1) {
            return renderTree(treesByRoot[roots[0] ?? ''] || []);
          }

          // Multi-root: collapsible section per root, primary first.
          return (
            <div className="flex flex-col">
              {roots.map((root) => {
                const isPrimary = root === workingDirectory;
                const collapsed = collapsedRoots.has(root);
                const rootTree = treesByRoot[root] || [];
                const rootBranch = gitBranchByRoot[root] ?? null;
                return (
                  <div key={root} className="border-b last:border-b-0">
                    <div
                      className={cn(
                        "flex w-full items-center gap-1.5 px-3 py-1.5",
                        "hover:bg-accent/40 transition-colors"
                      )}
                      title={root}
                    >
                      <button
                        type="button"
                        onClick={() => toggleRootCollapsed(root)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      >
                        <span
                          className={cn(
                            "inline-block w-3 text-[10px] text-muted-foreground transition-transform",
                            collapsed ? "rotate-0" : "rotate-90"
                          )}
                        >
                          ▶
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {getDirectoryLabel(root)}
                        </span>
                      </button>
                      {!isPrimary && (
                        <span className="rounded border border-border/60 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground shrink-0">
                          linked
                        </span>
                      )}
                      {!isPrimary && rootBranch && (
                        <BranchSelector
                          workingDirectory={root}
                          gitBranch={rootBranch}
                          onBranchChanged={(newBranch) => {
                            setGitBranchByRoot(prev => ({ ...prev, [root]: newBranch }));
                            fetchTree();
                          }}
                        />
                      )}
                    </div>
                    {!collapsed && (
                      rootTree.length === 0 ? (
                        <p className="px-4 py-2 text-[11px] text-muted-foreground/70">
                          {loading ? 'Loading…' : 'Empty'}
                        </p>
                      ) : (
                        renderTree(rootTree)
                      )
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}
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
            <AlertDialogTitle className="text-base">
              {deleteTarget && findNodeAcrossRoots(deleteTarget)?.type === 'directory'
                ? 'Delete folder'
                : 'Delete file'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {deleteTarget && findNodeAcrossRoots(deleteTarget)?.type === 'directory'
                    ? 'This will permanently delete the folder and all its contents:'
                    : 'This will permanently delete:'}
                </p>
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

      {/* Hidden file input for folder upload */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="*/*"
        className="hidden"
        onChange={handleFileInputChange}
      />

      {/* New folder dialog */}
      <AlertDialog open={!!createFolderTarget} onOpenChange={(open) => { if (!open) setCreateFolderTarget(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">New folder</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>Create a new folder in:</p>
                <p className="rounded bg-muted px-2 py-1 font-mono text-xs text-foreground break-all">
                  {createFolderTarget?.split("/").pop()}
                </p>
                <Input
                  placeholder="Folder name"
                  value={newFolderName}
                  onChange={(e) => { setNewFolderName(e.target.value); setCreateError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolderConfirm(); }}
                  autoFocus
                  className="h-8 text-sm"
                />
                {createError && (
                  <p className="text-xs text-destructive">{createError}</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" disabled={creating}>Cancel</AlertDialogCancel>
            <Button
              size="sm"
              onClick={handleCreateFolderConfirm}
              disabled={creating || !newFolderName.trim()}
            >
              {creating ? "Creating..." : "Create"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
