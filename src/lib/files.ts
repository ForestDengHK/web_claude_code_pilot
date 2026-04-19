import fs from 'fs/promises';
import path from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import type { FileTreeNode, FilePreview } from '@/types';

const execFileAsync = promisify(execFileCb);

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '__pycache__',
  '.cache',
  '.turbo',
  'coverage',
  '.output',
]);

/**
 * True for dot-prefixed entries that are considered "hidden" and thus filtered
 * out of the file tree by default. `.env*` and `.codepilot-uploads` are
 * intentionally exempt — they're either useful config or app-managed content
 * the user expects to see. Heavy build/tool dirs like `.git` and `.next` are
 * handled separately via IGNORED_DIRS (always hidden regardless of showHidden).
 */
export function isDotfileHidden(name: string): boolean {
  return name.startsWith('.') && !name.startsWith('.env') && name !== '.codepilot-uploads';
}

const LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'markdown',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'fish',
  ps1: 'powershell',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
  vue: 'vue',
  svelte: 'svelte',
  prisma: 'prisma',
  env: 'dotenv',
  lua: 'lua',
  r: 'r',
  php: 'php',
  dart: 'dart',
  zig: 'zig',
};

export function getFileLanguage(ext: string): string {
  const normalized = ext.replace(/^\./, '').toLowerCase();
  return LANGUAGE_MAP[normalized] || 'plaintext';
}

export function isPathSafe(basePath: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}

/**
 * Check if a path is a filesystem root (e.g., `/`, `C:\`, `D:\`).
 * Used to prevent using root as a baseDir for file browsing.
 */
export function isRootPath(p: string): boolean {
  const resolved = path.resolve(p);
  return resolved === path.parse(resolved).root;
}

export async function scanDirectory(
  dir: string,
  depth: number = 3,
  showHidden: boolean = false,
): Promise<FileTreeNode[]> {
  const resolvedDir = path.resolve(dir);

  try {
    await fs.access(resolvedDir);
  } catch {
    return [];
  }

  return scanDirectoryRecursive(resolvedDir, depth, showHidden);
}

async function scanDirectoryRecursive(
  dir: string,
  depth: number,
  showHidden: boolean,
): Promise<FileTreeNode[]> {
  if (depth <= 0) return [];

  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: FileTreeNode[] = [];

  // Sort: directories first, then files, both alphabetically
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    // Hidden dotfiles are filtered unless the user opts in.
    // IGNORED_DIRS (node_modules, .git, .next, …) stay hidden either way —
    // they're too heavy/noisy to ever browse usefully.
    if (!showHidden && isDotfileHidden(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;

      const children = await scanDirectoryRecursive(fullPath, depth - 1, showHidden);
      nodes.push({
        name: entry.name,
        path: fullPath,
        type: 'directory',
        children,
      });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).replace(/^\./, '');
      let size: number | undefined;
      try {
        const stat = await fs.stat(fullPath);
        size = stat.size;
      } catch {
        // Skip files we can't stat
      }

      nodes.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
        size,
        extension: ext || undefined,
      });
    }
  }

  return nodes;
}

export async function readFilePreview(filePath: string, maxLines: number = 200): Promise<FilePreview> {
  const resolvedPath = path.resolve(filePath);

  try {
    await fs.access(resolvedPath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = await fs.stat(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  // Read the file content, optionally limiting to maxLines (0 = no limit)
  const content = await fs.readFile(resolvedPath, 'utf-8');
  const lines = content.split('\n');
  const finalContent = maxLines > 0 ? lines.slice(0, maxLines).join('\n') : content;

  const ext = path.extname(resolvedPath).replace(/^\./, '');
  const language = getFileLanguage(ext);

  return {
    path: resolvedPath,
    content: finalContent,
    language,
    line_count: lines.length,
  };
}

// ==========================================
// Git Status
// ==========================================

/**
 * Parse `git status --porcelain` output into a Map of absolute paths to status codes.
 * Exported for testing.
 */
export function parseGitStatusOutput(output: string, repoRoot: string): Map<string, string> {
  const statusMap = new Map<string, string>();
  if (!output.trim()) return statusMap;

  for (const line of output.split('\n')) {
    if (!line || line.length < 4) continue;

    const xy = line.slice(0, 2);
    let filePath = line.slice(3);

    // Skip deleted files — they don't exist on disk
    if (xy[0] === 'D' || xy[1] === 'D') continue;

    // Handle renamed: "R  old -> new" — use the new path
    if (xy[0] === 'R') {
      const arrowIdx = filePath.indexOf(' -> ');
      if (arrowIdx !== -1) {
        filePath = filePath.slice(arrowIdx + 4);
      }
      statusMap.set(path.join(repoRoot, filePath), 'M');
      continue;
    }

    // Untracked
    if (xy === '??') {
      statusMap.set(path.join(repoRoot, filePath), '?');
      continue;
    }

    // Added (staged)
    if (xy[0] === 'A') {
      statusMap.set(path.join(repoRoot, filePath), 'A');
      continue;
    }

    // Modified (staged or unstaged)
    if (xy[0] === 'M' || xy[1] === 'M') {
      statusMap.set(path.join(repoRoot, filePath), 'M');
      continue;
    }
  }

  return statusMap;
}

/**
 * Run `git status` in a directory and return a Map of absolute file paths to status codes.
 * Returns empty map if not a git repo or git is unavailable.
 * Uses execFile (not exec) to prevent shell injection — same pattern as platform.ts.
 */
export async function getGitStatusMap(dir: string): Promise<Map<string, string>> {
  try {
    const { stdout: root } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
    const repoRoot = root.trim();

    const { stdout } = await execFileAsync('git', ['-C', dir, 'status', '--porcelain', '-uall']);
    return parseGitStatusOutput(stdout, repoRoot);
  } catch {
    return new Map();
  }
}

/**
 * Return the current git branch for a directory, or null when the directory is
 * not in a git repo or HEAD is detached.
 */
export async function getGitBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD']);
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * Annotate a file tree with git status. Mutates nodes in place.
 * Returns true if any descendant has a status (used for recursive propagation to parents).
 */
export function annotateTreeWithGitStatus(
  nodes: FileTreeNode[],
  statusMap: Map<string, string>,
): boolean {
  if (statusMap.size === 0) return false;

  let anyChanged = false;
  for (const node of nodes) {
    if (node.type === 'directory' && node.children) {
      const childrenChanged = annotateTreeWithGitStatus(node.children, statusMap);
      if (childrenChanged) {
        node.gitStatus = 'M';
        anyChanged = true;
      }
    } else {
      const status = statusMap.get(node.path);
      if (status) {
        node.gitStatus = status as FileTreeNode['gitStatus'];
        anyChanged = true;
      }
    }
  }
  return anyChanged;
}
