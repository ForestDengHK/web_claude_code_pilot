"use client";

import { useEffect, useState, useCallback } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Folder01Icon,
  PlusSignIcon,
  Delete02Icon,
} from "@hugeicons/core-free-icons";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FolderPicker } from "@/components/chat/FolderPicker";
import { cn } from "@/lib/utils";

interface ProjectSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workingDirectory: string;
  projectName: string;
}

export function ProjectSettingsDialog({
  open,
  onOpenChange,
  workingDirectory,
  projectName,
}: ProjectSettingsDialogProps) {
  const [dirs, setDirs] = useState<string[]>([]);
  const [originalDirs, setOriginalDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Load current settings when the dialog opens
  useEffect(() => {
    if (!open || !workingDirectory) return;
    setLoading(true);
    setError(null);
    fetch(`/api/projects/settings?workingDirectory=${encodeURIComponent(workingDirectory)}`)
      .then(res => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then(data => {
        const list: string[] = Array.isArray(data?.additionalDirectories) ? data.additionalDirectories : [];
        setDirs(list);
        setOriginalDirs(list);
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [open, workingDirectory]);

  const dirty = JSON.stringify(dirs) !== JSON.stringify(originalDirs);

  const addDir = useCallback((path: string) => {
    setDirs(prev => {
      if (prev.includes(path)) return prev;
      if (path === workingDirectory) return prev; // don't add cwd itself
      return [...prev, path];
    });
    setPickerOpen(false);
  }, [workingDirectory]);

  const removeDir = useCallback((path: string) => {
    setDirs(prev => prev.filter(p => p !== path));
  }, []);

  const handleSave = useCallback(async () => {
    if (!workingDirectory) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/projects/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDirectory, additionalDirectories: dirs }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const stored: string[] = Array.isArray(data?.additionalDirectories) ? data.additionalDirectories : dirs;
      setDirs(stored);
      setOriginalDirs(stored);
      // Notify the file tree (and any other listener) so it can refresh
      // without requiring a full page reload.
      window.dispatchEvent(new CustomEvent('project-settings-changed', {
        detail: { workingDirectory, additionalDirectories: stored },
      }));
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [workingDirectory, dirs, onOpenChange]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Project Settings</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="text-xs text-muted-foreground">
              <div className="font-medium text-foreground">{projectName || 'Project'}</div>
              <div className="truncate font-mono">{workingDirectory}</div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-sm font-medium">Additional Directories</label>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPickerOpen(true)}
                  disabled={loading || saving}
                >
                  <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
                  Add Directory
                </Button>
              </div>
              <p className="mb-2 text-xs text-muted-foreground">
                Linked folders the agent can read and write while working in this project.
                Useful for referencing related projects without leaving this session.
              </p>

              {loading ? (
                <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading…
                </div>
              ) : dirs.length === 0 ? (
                <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                  No additional directories yet.
                </div>
              ) : (
                <ScrollArea className="max-h-64 rounded-md border">
                  <ul className="divide-y">
                    {dirs.map(dir => (
                      <li
                        key={dir}
                        className="flex items-center gap-2 px-2.5 py-1.5"
                      >
                        <HugeiconsIcon
                          icon={Folder01Icon}
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={dir}>
                          {dir}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          onClick={() => removeDir(dir)}
                          disabled={saving}
                        >
                          <HugeiconsIcon icon={Delete02Icon} className="h-3.5 w-3.5" />
                          <span className="sr-only">Remove {dir}</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              )}
            </div>

            {error && (
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive">
                {error}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || loading || !dirty}
              className={cn(saving && "cursor-wait")}
            >
              {saving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving…
                </>
              ) : (
                'Save'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FolderPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={addDir}
        initialPath={workingDirectory}
      />
    </>
  );
}
