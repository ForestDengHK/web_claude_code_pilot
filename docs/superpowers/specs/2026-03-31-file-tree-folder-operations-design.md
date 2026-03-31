# File Tree Folder Operations

**Date**: 2026-03-31
**Status**: Approved

## Summary

Add folder-level operations to the file tree panel: upload files into a directory, create new subdirectories, and delete directories. All three actions are accessed through a ⋯ dropdown menu on each folder row, mirroring the existing pattern on file rows.

## Motivation

The file tree currently supports full operations on files (download, delete, attach to chat) but folders only have the +/- attach-to-chat button. Users need to manage project files directly — uploading assets, creating directory structure, removing unused folders — without leaving the app or relying on Claude to do it via CLI.

## Scope

**In scope:**
- Upload one or more files to a specific directory
- Create a new subdirectory inside a folder
- Delete a folder (with recursive confirmation)
- ⋯ dropdown menu on folder rows

**Out of scope:**
- Upload progress bar (spinner is sufficient for typical project files)
- Drag-and-drop upload (not usable on mobile, which is the primary access method)
- Folder upload / directory upload (mobile file pickers don't support this)
- Root-level toolbar buttons (all operations go through folder ⋯ menu)

## Design

### Interaction Model

Each folder row in the file tree gains a ⋯ button to the left of the existing +/- (attach) button:

```
📁 components          [⋯] [+]
```

Desktop: ⋯ button appears on hover (matching file row behavior via `md:opacity-0 md:group-hover:opacity-100`).
Mobile: ⋯ button always visible (matching file row behavior).

The ⋯ dropdown menu contains:

| Menu Item | Icon | Action |
|-----------|------|--------|
| Upload files | UploadIcon | Opens system file picker, uploads selected files to this directory |
| New folder | FolderPlusIcon | Opens a dialog to name and create a subdirectory |
| Delete | Trash2Icon | Opens confirmation dialog, then recursively deletes the directory |

### Backend API

#### `POST /api/files/upload`

Uploads one or more files to a target directory.

**Request:** `multipart/form-data`
- `targetDir` (string) — absolute path of the target directory
- `baseDir` (string) — working directory for security scoping
- `files` (File[]) — one or more files

**Processing:**
1. Validate `targetDir` is within `baseDir` using existing `isPathSafe()`
2. Validate `targetDir` exists and is a directory
3. Write each file with its original filename (no timestamp prefix)
4. If a file with the same name already exists, overwrite it silently

**Response:**
```json
{
  "success": true,
  "files": [
    { "name": "logo.png", "path": "/abs/path/to/logo.png", "size": 12345 }
  ]
}
```

**Errors:**
- 400: missing parameters, targetDir is not a directory
- 403: path outside baseDir scope
- 500: write failure

#### `POST /api/files/mkdir`

Creates a new subdirectory.

**Request:** `application/json`
```json
{
  "parentDir": "/abs/path/to/parent",
  "name": "new-folder",
  "baseDir": "/abs/path/to/workdir"
}
```

**Processing:**
1. Validate `parentDir` is within `baseDir` using `isPathSafe()`
2. Validate `name` contains no illegal characters (`/`, `\`, `..`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, null bytes)
3. Validate `name` is not empty and not just whitespace
4. `fs.mkdir()` — single level, not recursive
5. If directory already exists, return 409

**Response:**
```json
{
  "success": true,
  "path": "/abs/path/to/parent/new-folder"
}
```

**Errors:**
- 400: missing parameters, invalid name
- 403: path outside baseDir scope
- 409: directory already exists
- 500: mkdir failure

#### Delete Directory

No new API needed. The existing `DELETE /api/files` already supports recursive directory deletion via `fs.rm(resolvedPath, { recursive: true })`.

### Frontend Components

#### `FileTreeContext` Extension

Add two new callbacks to the context interface:

```typescript
onUpload?: (dirPath: string) => void;
onCreateFolder?: (dirPath: string) => void;
// onDelete already exists
```

#### `FileTreeFolder` Changes (ai-elements/file-tree.tsx)

Add a `DropdownMenu` (reusing the existing component from file rows) with three menu items: Upload files, New folder, Delete.

The ⋯ button sits between the folder name and the +/- attach button, within the `ml-auto` action area. Visibility follows the same hover pattern as file rows.

"Upload files" triggers a hidden `<input type="file" multiple accept="*/*">` element's click. The input's `onChange` handler calls the `onUpload` context callback.

#### `FileTree.tsx` Orchestration Changes

Implements the three operations:

**Upload handler:**
1. Receives `dirPath` from context callback
2. Triggers hidden file input click
3. On file selection, builds `FormData` with `targetDir`, `baseDir`, and files
4. `POST /api/files/upload`
5. On success: dispatches `refresh-file-tree`, auto-expands the target folder
6. On failure: shows toast error
7. During upload: sets loading state on the folder (spinner replaces folder icon)

**Create folder handler:**
1. Receives `dirPath` from context callback
2. Opens a dialog (reusing AlertDialog) with an Input for folder name
3. Client-side validation: non-empty, no illegal characters
4. `POST /api/files/mkdir`
5. On success: dispatches `refresh-file-tree`, auto-expands parent folder
6. On 409: toast "Folder already exists"
7. On failure: toast error

**Delete folder handler:**
1. Receives `dirPath` from context callback
2. Opens AlertDialog with warning: "This will permanently delete the folder and all its contents"
3. Shows folder name in monospace block
4. On confirm: `DELETE /api/files?path=...&baseDir=...`
5. On success: dispatches `refresh-file-tree`

### Data Flow

```
Upload:
  User clicks folder ⋯ → "Upload files"
    → hidden <input type="file" multiple> triggered
    → user selects files → onChange fires
    → FormData { targetDir, baseDir, files[] }
    → POST /api/files/upload
    → server: isPathSafe → fs.writeFile per file
    → response { success, files[] }
    → dispatch('refresh-file-tree') + expand folder

Create folder:
  User clicks folder ⋯ → "New folder"
    → AlertDialog opens with Input
    → user types name → clicks Create
    → POST /api/files/mkdir { parentDir, name, baseDir }
    → server: isPathSafe + validate name → fs.mkdir
    → response { success, path }
    → dispatch('refresh-file-tree') + expand folder

Delete folder:
  User clicks folder ⋯ → "Delete"
    → AlertDialog with recursive-delete warning
    → user confirms
    → DELETE /api/files?path=...&baseDir=...
    → server: isPathSafe → fs.rm(recursive)
    → response { success }
    → dispatch('refresh-file-tree')
```

### Edge Cases

| Situation | Handling |
|-----------|----------|
| Upload file with same name as existing | Silent overwrite (matches VS Code / GitHub) |
| Create folder with existing name | 409 → toast "Folder already exists" |
| Illegal characters in folder name | Client-side validation blocks request |
| Empty file selection | Ignored, no request sent |
| Network failure | Toast error, no side effects |
| Delete non-empty folder | Dialog warns "folder and all its contents" |
| Upload during directory switch | Request completes, refresh-file-tree updates current view (harmless) |

### Files Changed

| File | Change |
|------|--------|
| `src/app/api/files/upload/route.ts` | **New** — multipart upload endpoint |
| `src/app/api/files/mkdir/route.ts` | **New** — create directory endpoint |
| `src/components/ai-elements/file-tree.tsx` | **Modify** — add ⋯ menu to FileTreeFolder, extend context with onUpload/onCreateFolder |
| `src/components/project/FileTree.tsx` | **Modify** — implement upload/mkdir/delete-folder handlers, dialogs, hidden file input |
