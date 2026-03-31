# File Tree Folder Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Commit policy:** Do NOT commit without user consent. All "Commit" steps should stage files and wait for user approval before running `git commit`.

**Goal:** Add folder-level operations (upload files, create subdirectory, delete directory) to the file tree panel via a per-folder ⋯ dropdown menu.

**Architecture:** Two new API endpoints (`POST /api/files/upload`, `POST /api/files/mkdir`) following the existing security validation pattern (`isRootPath` + `isPathSafe`). The existing `DELETE /api/files` already handles directory deletion. Frontend changes add a `DropdownMenu` to `FileTreeFolder` (mirroring `FileTreeFile`), with orchestration logic (hidden file input, dialogs) in `FileTree.tsx`.

**Tech Stack:** Next.js App Router, `fs/promises`, existing `DropdownMenu`/`AlertDialog` UI components

**Spec:** `docs/superpowers/specs/2026-03-31-file-tree-folder-operations-design.md`

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `src/app/api/files/upload/route.ts` | POST endpoint: multipart/form-data → write files to target directory |
| `src/app/api/files/mkdir/route.ts` | POST endpoint: JSON body → create subdirectory |
| `src/__tests__/unit/folder-operations.test.ts` | Unit tests for mkdir name validation + upload/mkdir API security |

### Modified files
| File | Change |
|------|--------|
| `src/components/ai-elements/file-tree.tsx` | Add ⋯ `DropdownMenu` to `FileTreeFolder`, extend `FileTreeContext` with `onUpload`/`onCreateFolder`, consume `onDelete` in folder |
| `src/components/project/FileTree.tsx` | Add upload handler (hidden file input + FormData + fetch), mkdir handler (dialog + fetch), delete-folder handler (dialog + existing DELETE API) |

---

## Chunk 1: Backend — mkdir endpoint

### Task 1: Create the mkdir API route

**Files:**
- Create: `src/app/api/files/mkdir/route.ts`

- [ ] **Step 1: Create the mkdir route file**

Create `src/app/api/files/mkdir/route.ts`. This follows the same security pattern as the existing `src/app/api/files/write/route.ts` (read that file for reference: `isRootPath` + `isPathSafe` + `baseDir` fallback to `os.homedir()`).

```typescript
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { isPathSafe, isRootPath } from '@/lib/files';
import type { ErrorResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Characters/sequences forbidden in folder names
const INVALID_NAME_PATTERN = /[/\\:*?"<>|\0]|\.\./;

export async function POST(request: NextRequest) {
  try {
    const { parentDir, name, baseDir } = await request.json();

    if (!parentDir || !name || typeof name !== 'string') {
      return NextResponse.json<ErrorResponse>(
        { error: 'Missing parentDir or name parameter' },
        { status: 400 }
      );
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Folder name cannot be empty' },
        { status: 400 }
      );
    }

    if (INVALID_NAME_PATTERN.test(trimmedName)) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Folder name contains invalid characters' },
        { status: 400 }
      );
    }

    const resolvedParent = path.resolve(parentDir);
    const homeDir = os.homedir();

    // Security: same pattern as write/route.ts
    if (baseDir) {
      const resolvedBase = path.resolve(baseDir);
      if (isRootPath(resolvedBase)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'Cannot use filesystem root as base directory' },
          { status: 403 }
        );
      }
      if (!isPathSafe(resolvedBase, resolvedParent)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'Directory is outside the project scope' },
          { status: 403 }
        );
      }
    } else {
      if (!isPathSafe(homeDir, resolvedParent)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'Directory is outside the allowed scope' },
          { status: 403 }
        );
      }
    }

    const newDirPath = path.join(resolvedParent, trimmedName);

    // Check if already exists
    try {
      await fs.stat(newDirPath);
      // If stat succeeds, something exists at this path
      return NextResponse.json<ErrorResponse>(
        { error: 'A file or folder with this name already exists' },
        { status: 409 }
      );
    } catch {
      // Does not exist — good, proceed
    }

    await fs.mkdir(newDirPath);

    return NextResponse.json({ success: true, path: newDirPath });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to create folder' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Manually test the mkdir endpoint**

Start the dev server (if not running) and test with curl:

```bash
# Should succeed — creates a test folder
curl -s -X POST http://localhost:4000/api/files/mkdir \
  -H 'Content-Type: application/json' \
  -d '{"parentDir":"/tmp","name":"codepilot-test-mkdir","baseDir":"/tmp"}' | jq .

# Should return 409 — already exists
curl -s -X POST http://localhost:4000/api/files/mkdir \
  -H 'Content-Type: application/json' \
  -d '{"parentDir":"/tmp","name":"codepilot-test-mkdir","baseDir":"/tmp"}' | jq .

# Should return 400 — invalid name
curl -s -X POST http://localhost:4000/api/files/mkdir \
  -H 'Content-Type: application/json' \
  -d '{"parentDir":"/tmp","name":"bad..name","baseDir":"/tmp"}' | jq .

# Should return 403 — path traversal attempt
curl -s -X POST http://localhost:4000/api/files/mkdir \
  -H 'Content-Type: application/json' \
  -d '{"parentDir":"/etc","name":"hacked","baseDir":"/tmp"}' | jq .

# Cleanup
rm -rf /tmp/codepilot-test-mkdir
```

Expected: 200 → 409 → 400 → 403

- [ ] **Step 3: Commit**

```bash
git add src/app/api/files/mkdir/route.ts
```
Wait for user approval before committing.

---

## Chunk 2: Backend — upload endpoint

### Task 2: Create the upload API route

**Files:**
- Create: `src/app/api/files/upload/route.ts`

- [ ] **Step 1: Create the upload route file**

Create `src/app/api/files/upload/route.ts`. This endpoint uses the Web API `request.formData()` to parse multipart uploads (no extra library needed in Next.js App Router).

```typescript
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { isPathSafe, isRootPath } from '@/lib/files';
import type { ErrorResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const targetDir = formData.get('targetDir') as string | null;
    const baseDir = formData.get('baseDir') as string | null;

    if (!targetDir) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Missing targetDir parameter' },
        { status: 400 }
      );
    }

    const resolvedTarget = path.resolve(targetDir);
    const homeDir = os.homedir();

    // Security: same pattern as other file endpoints
    if (baseDir) {
      const resolvedBase = path.resolve(baseDir);
      if (isRootPath(resolvedBase)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'Cannot use filesystem root as base directory' },
          { status: 403 }
        );
      }
      if (!isPathSafe(resolvedBase, resolvedTarget)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'Directory is outside the project scope' },
          { status: 403 }
        );
      }
    } else {
      if (!isPathSafe(homeDir, resolvedTarget)) {
        return NextResponse.json<ErrorResponse>(
          { error: 'Directory is outside the allowed scope' },
          { status: 403 }
        );
      }
    }

    // Validate targetDir exists and is a directory
    let stat;
    try {
      stat = await fs.stat(resolvedTarget);
    } catch {
      return NextResponse.json<ErrorResponse>(
        { error: 'Target directory does not exist' },
        { status: 404 }
      );
    }
    if (!stat.isDirectory()) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Target path is not a directory' },
        { status: 400 }
      );
    }

    // Collect all File entries from the form data
    const files: File[] = [];
    for (const [, value] of formData.entries()) {
      if (value instanceof File) {
        files.push(value);
      }
    }

    if (files.length === 0) {
      return NextResponse.json<ErrorResponse>(
        { error: 'No files provided' },
        { status: 400 }
      );
    }

    // Write each file
    const results: { name: string; path: string; size: number; overwritten: boolean }[] = [];
    for (const file of files) {
      const filePath = path.join(resolvedTarget, file.name);

      // Check if file already exists
      let overwritten = false;
      try {
        await fs.stat(filePath);
        overwritten = true;
      } catch {
        // Does not exist — fine
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(filePath, buffer);

      results.push({
        name: file.name,
        path: filePath,
        size: buffer.length,
        overwritten,
      });
    }

    return NextResponse.json({ success: true, files: results });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to upload files' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Manually test the upload endpoint**

**Note on upload size limits:** App Router `formData()` does not enforce a body size limit by default (the constraint is Node.js heap memory). No configuration needed. If large uploads (>50 MB) fail in the future, add `experimental.serverActions.bodySizeLimit` to `next.config.mjs`.

```bash
# Create a test directory
mkdir -p /tmp/codepilot-test-upload

# Create a test file
echo "hello world" > /tmp/test-upload-file.txt

# Should succeed
curl -s -X POST http://localhost:4000/api/files/upload \
  -F "targetDir=/tmp/codepilot-test-upload" \
  -F "baseDir=/tmp" \
  -F "files=@/tmp/test-upload-file.txt" | jq .

# Upload again — should show overwritten: true
curl -s -X POST http://localhost:4000/api/files/upload \
  -F "targetDir=/tmp/codepilot-test-upload" \
  -F "baseDir=/tmp" \
  -F "files=@/tmp/test-upload-file.txt" | jq .

# Should return 403 — path traversal
curl -s -X POST http://localhost:4000/api/files/upload \
  -F "targetDir=/etc" \
  -F "baseDir=/tmp" \
  -F "files=@/tmp/test-upload-file.txt" | jq .

# Cleanup
rm -rf /tmp/codepilot-test-upload /tmp/test-upload-file.txt
```

Expected: 200 (overwritten:false) → 200 (overwritten:true) → 403

- [ ] **Step 3: Commit**

```bash
git add src/app/api/files/upload/route.ts
```
Wait for user approval before committing.

---

## Chunk 3: Backend — unit tests

### Task 3: Write unit tests for folder operations security

**Note on test ordering:** These tests validate the `INVALID_NAME_PATTERN` regex and the existing `isPathSafe`/`isRootPath` utilities — not the API endpoints themselves (which are tested manually via curl above). Writing them after the endpoints is acceptable here since the tests cover shared validation logic, not endpoint behavior.

**Files:**
- Create: `src/__tests__/unit/folder-operations.test.ts`

The existing test file `src/__tests__/unit/files-security.test.ts` uses `node:test` + `node:assert/strict` (not Jest). Follow the same pattern.

- [ ] **Step 1: Create the test file**

```typescript
/**
 * Unit tests for folder operations (mkdir + upload) security.
 *
 * Run with: npx tsx src/__tests__/unit/folder-operations.test.ts
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';

import { isPathSafe, isRootPath } from '../../lib/files';

// Regex duplicated from mkdir/route.ts — tests validate its behavior
const INVALID_NAME_PATTERN = /[/\\:*?"<>|\0]|\.\./;

describe('Folder name validation', () => {
  it('should allow simple alphanumeric names', () => {
    assert.equal(INVALID_NAME_PATTERN.test('my-folder'), false);
    assert.equal(INVALID_NAME_PATTERN.test('src'), false);
    assert.equal(INVALID_NAME_PATTERN.test('components_v2'), false);
  });

  it('should allow dot-prefixed names (hidden folders)', () => {
    assert.equal(INVALID_NAME_PATTERN.test('.hidden'), false);
    assert.equal(INVALID_NAME_PATTERN.test('.config'), false);
    assert.equal(INVALID_NAME_PATTERN.test('.github'), false);
  });

  it('should reject names with path separators', () => {
    assert.equal(INVALID_NAME_PATTERN.test('foo/bar'), true);
    assert.equal(INVALID_NAME_PATTERN.test('foo\\bar'), true);
  });

  it('should reject names containing .. substring', () => {
    assert.equal(INVALID_NAME_PATTERN.test('..'), true);
    assert.equal(INVALID_NAME_PATTERN.test('...'), true);
    assert.equal(INVALID_NAME_PATTERN.test('foo..bar'), true);
  });

  it('should reject names with special characters', () => {
    assert.equal(INVALID_NAME_PATTERN.test('file:name'), true);
    assert.equal(INVALID_NAME_PATTERN.test('file*name'), true);
    assert.equal(INVALID_NAME_PATTERN.test('file?name'), true);
    assert.equal(INVALID_NAME_PATTERN.test('file"name'), true);
    assert.equal(INVALID_NAME_PATTERN.test('file<name'), true);
    assert.equal(INVALID_NAME_PATTERN.test('file>name'), true);
    assert.equal(INVALID_NAME_PATTERN.test('file|name'), true);
  });

  it('should allow names with spaces and dashes', () => {
    assert.equal(INVALID_NAME_PATTERN.test('my folder'), false);
    assert.equal(INVALID_NAME_PATTERN.test('my-folder'), false);
    assert.equal(INVALID_NAME_PATTERN.test('My Folder (2)'), false);
  });
});

describe('Mkdir path safety', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-mkdir-test-'));
  const projectDir = path.join(tmpDir, 'myproject');

  fs.mkdirSync(projectDir, { recursive: true });

  it('should allow creating folders inside the project', () => {
    const newDir = path.join(projectDir, 'newfolder');
    assert.equal(isPathSafe(projectDir, newDir), true);
  });

  it('should allow creating nested folders inside the project', () => {
    const newDir = path.join(projectDir, 'src', 'components');
    assert.equal(isPathSafe(projectDir, newDir), true);
  });

  it('should block creating folders outside the project', () => {
    const outsideDir = path.join(tmpDir, 'outside');
    assert.equal(isPathSafe(projectDir, outsideDir), false);
  });

  it('should block creating folders via path traversal', () => {
    const traversal = path.resolve(projectDir, '..', 'evil');
    assert.equal(isPathSafe(projectDir, traversal), false);
  });

  it('should reject filesystem root as baseDir', () => {
    assert.equal(isRootPath('/'), true);
    if (process.platform === 'win32') {
      assert.equal(isRootPath('C:\\'), true);
    }
    assert.equal(isRootPath(projectDir), false);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
cd /Users/party/working/CodePilot && npx tsx src/__tests__/unit/folder-operations.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/unit/folder-operations.test.ts
```
Wait for user approval before committing.

---

## Chunk 4: Frontend — FileTreeContext + FileTreeFolder ⋯ menu

### Task 4: Extend FileTreeContext and add ⋯ menu to FileTreeFolder

**Files:**
- Modify: `src/components/ai-elements/file-tree.tsx`

This is the largest single change. Refer to the existing `FileTreeFile` component (lines ~352-548 in the same file) as the template — it already has a `DropdownMenu` with Download/Delete items. We're adding a similar menu to `FileTreeFolder`.

- [ ] **Step 1: Extend `FileTreeContextType` interface**

In `src/components/ai-elements/file-tree.tsx`, find the `FileTreeContextType` interface (around line 43) and add two new callbacks:

```typescript
// Find this interface:
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
  attachedPaths?: Set<string>;
  gitStatusMap?: Map<string, string>;
  // Multi-select
  selectionMode?: boolean;
  selectedPaths?: Set<string>;
  onToggleSelect?: (path: string) => void;
}

// Add these two lines after onDelete:
  onUpload?: (dirPath: string) => void;
  onCreateFolder?: (dirPath: string) => void;
```

- [ ] **Step 2: Extend `FileTreeProps` type**

Find `FileTreeProps` (around line 101) and add the two new optional props:

```typescript
// Add after onDelete:
  onUpload?: (dirPath: string) => void;
  onCreateFolder?: (dirPath: string) => void;
```

- [ ] **Step 3: Pass new props through the FileTree component**

In the `FileTree` component (around line 120), destructure the two new props and include them in the context value:

In the destructuring (around line 130):
```typescript
  onUpload,
  onCreateFolder,
```

In the `contextValue` useMemo (around line 157-159), add `onUpload` and `onCreateFolder` to both the object and the dependency array.

- [ ] **Step 4: Add lucide icons import**

At the top of the file, add `UploadIcon` and `FolderPlusIcon` to the existing lucide-react import (around line 22):

```typescript
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,  // NEW
  MinusIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,      // NEW
  XIcon,
} from "lucide-react";
```

- [ ] **Step 5: Modify FileTreeFolder to consume new context values and add ⋯ menu**

In the `FileTreeFolder` component (around line 195-334), make these changes:

**5a. Destructure new values from context:**

Change line ~202 from:
```typescript
const { expandedPaths, togglePath, onAdd, onRemove, attachedPaths, gitStatusMap, selectionMode, selectedPaths, onToggleSelect } =
    useContext(FileTreeContext);
```
to:
```typescript
const { expandedPaths, togglePath, onAdd, onRemove, onUpload, onCreateFolder, onDelete, attachedPaths, gitStatusMap, selectionMode, selectedPaths, onToggleSelect } =
    useContext(FileTreeContext);
```

**5b. Add handler callbacks (after `handleAdd`, around line 229):**

```typescript
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
```

**5c. Add ⋯ dropdown menu inside the folder action area.**

Find the existing `{onAdd && (` block (around line 294-312) which renders the +/- attach button. Replace the entire block with:

```tsx
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
```

- [ ] **Step 6: Verify it compiles**

Check the dev server terminal for compilation errors. The page should load without errors. The ⋯ menu won't do anything yet (no handlers wired in `FileTree.tsx`), but it should render and open on click.

- [ ] **Step 7: Commit**

```bash
git add src/components/ai-elements/file-tree.tsx
```
Wait for user approval before committing.

---

## Chunk 5: Frontend — FileTree.tsx orchestration

### Task 5: Add upload, mkdir, and delete-folder handlers to FileTree.tsx

**Files:**
- Modify: `src/components/project/FileTree.tsx`

This is the orchestration layer. It owns the hidden file input, the "New folder" dialog, and the delete-folder dialog. It passes callbacks down via the `AIFileTree` component props.

- [ ] **Step 1: Add state variables and refs**

Near the top of the `FileTree` component function (after the existing state declarations, around line 162), add:

```typescript
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
  // (both files and folders go through the same onDelete → setDeleteTarget path)
```

- [ ] **Step 2: Add the upload handler**

After the existing handler callbacks (around line 400, after `handleBatchDeleteConfirm`), add:

```typescript
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
    if (!files || files.length === 0 || !targetDir || !workingDirectory) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('targetDir', targetDir);
      formData.append('baseDir', workingDirectory);
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
```

- [ ] **Step 3: Add the create-folder handler**

```typescript
  const handleCreateFolder = useCallback((dirPath: string) => {
    setCreateFolderTarget(dirPath);
    setNewFolderName("");
    setCreateError(null);
  }, []);

  const handleCreateFolderConfirm = useCallback(async () => {
    if (!createFolderTarget || !workingDirectory) return;

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
          baseDir: workingDirectory,
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
  }, [createFolderTarget, newFolderName, workingDirectory, fetchTree]);
```

- [ ] **Step 4: Pass callbacks to AIFileTree**

Find the `<AIFileTree` JSX (around line 494) and add the two new props. **No separate delete handler needed** — folder deletion reuses the existing `onDelete={(filePath: string) => setDeleteTarget(filePath)}` which is already passed. Since `FileTreeFolder` now also consumes `onDelete` from context (see Chunk 4), both file and folder deletes flow through the same `deleteTarget` state → `handleDeleteConfirm` path. We'll update the dialog text to distinguish files vs folders in the next step.

Add these two props to `<AIFileTree`:


```tsx
            onUpload={handleUpload}
            onCreateFolder={handleCreateFolder}
```

- [ ] **Step 5: Update the single-item delete dialog to handle folders**

Find the delete confirmation `AlertDialog` (around line 555-580). Update it to show different text for folders vs files:

Replace the dialog description:
```tsx
<AlertDialogDescription asChild>
  <div className="space-y-2">
    <p>This will permanently delete:</p>
    <p className="rounded bg-muted px-2 py-1 font-mono text-xs text-foreground break-all">
      {deleteTarget?.split("/").pop()}
    </p>
  </div>
</AlertDialogDescription>
```

With:
```tsx
<AlertDialogDescription asChild>
  <div className="space-y-2">
    <p>
      {deleteTarget && findNode(tree, deleteTarget)?.type === 'directory'
        ? 'This will permanently delete the folder and all its contents:'
        : 'This will permanently delete:'}
    </p>
    <p className="rounded bg-muted px-2 py-1 font-mono text-xs text-foreground break-all">
      {deleteTarget?.split("/").pop()}
    </p>
  </div>
</AlertDialogDescription>
```

Also update the dialog title:
```tsx
<AlertDialogTitle className="text-base">
  {deleteTarget && findNode(tree, deleteTarget)?.type === 'directory'
    ? 'Delete folder'
    : 'Delete file'}
</AlertDialogTitle>
```

- [ ] **Step 6: Add the hidden file input and the "New folder" dialog**

**Note:** The "New folder" dialog uses `Button` (not `AlertDialogAction`) for the Create button, because `AlertDialogAction` auto-closes the dialog on click — which would clear state before the async fetch runs and prevent error messages from displaying. `Button` is already imported in `FileTree.tsx` (check the existing imports at the top of the file).

At the end of the component's return JSX (before the final `</div>`), after the existing AlertDialogs, add:

```tsx
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
            {/* Use Button instead of AlertDialogAction here. AlertDialogAction
                auto-closes the dialog on click, which would clear createFolderTarget
                before the async fetch runs and prevent error messages from showing. */}
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
```

- [ ] **Step 7: Verify it compiles and works end-to-end**

Check the dev server terminal for compilation errors. Then open the file tree panel in the browser:

1. Hover over a folder → ⋯ button should appear
2. Click ⋯ → dropdown should show "Upload files", "New folder", "Delete"
3. Test "New folder" → dialog should appear, type a name, click Create → folder appears in tree
4. Test "Upload files" → system file picker should open, select a file → file appears in tree
5. Test "Delete" → confirmation dialog should appear, confirm → folder removed from tree

- [ ] **Step 8: Commit**

```bash
git add src/components/ai-elements/file-tree.tsx src/components/project/FileTree.tsx
```
Wait for user approval before committing.

---

## Chunk 6: Polish & edge cases

### Task 6: Handle edge cases and final polish

**Files:**
- Modify: `src/components/project/FileTree.tsx`

- [ ] **Step 1: Add FileTreeNode type import for findNode return type**

Verify that `FileTreeNode` is already imported (it should be — it's used for `tree` state). The `findNode` function (already defined around line 337) returns `FileTreeNode | null`, which we now use in the delete dialog to check `type === 'directory'`.

No code change needed if already imported — just verify.

- [ ] **Step 2: Test edge cases manually**

Using the browser:

1. **Create folder with existing name** → Should show "A folder with this name already exists" error in dialog
2. **Create folder with invalid characters** (e.g., `bad..name`) → Should show "Name contains invalid characters" error in dialog
3. **Upload file that already exists** → Should silently overwrite; check console for "replaced N existing" log
4. **Delete non-empty folder** → Dialog should say "folder and all its contents"
5. **Delete empty folder** → Same dialog, should work
6. **Try all operations on mobile** (via Tailscale) → Verify buttons are tappable, file picker works, dialogs are usable

- [ ] **Step 3: Final commit**

```bash
git add src/components/project/FileTree.tsx
```
Wait for user approval before committing.

---

## Known Deferred Items

These are conscious gaps noted during plan review, to be addressed in future iterations:

- **Per-folder loading spinner during upload**: The spec calls for a spinner replacing the folder icon during upload. The `uploading` state is tracked but not passed to the `FileTreeFolder` component. To implement: add a `loadingPaths: Set<string>` to context, populate during upload, render spinner in `FileTreeFolder` when loading. Deferred because the tree refresh itself provides immediate visual feedback.
- **User-visible toast/notification**: The project has no toast library. Upload/mkdir feedback currently goes to `console.log`. The tree refresh shows results immediately, which is sufficient for now. When a toast system is added to the project, these operations should use it.
