"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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

function VersionCard() {
  const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";

  return (
    <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">Web Claude Code Pilot</h2>
          <p className="text-xs text-muted-foreground">Version {currentVersion}</p>
        </div>
      </div>
    </div>
  );
}

export function GeneralSection() {
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [showSkipPermWarning, setShowSkipPermWarning] = useState(false);
  const [skipPermSaving, setSkipPermSaving] = useState(false);

  // Git clone settings
  const [cloneBaseDir, setCloneBaseDir] = useState('');
  const [defaultGitHost, setDefaultGitHost] = useState('');
  const [gitSettingsSaving, setGitSettingsSaving] = useState(false);
  const [gitSettingsSaved, setGitSettingsSaved] = useState(false);

  const fetchAppSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/app");
      if (res.ok) {
        const data = await res.json();
        const appSettings = data.settings || {};
        setSkipPermissions(appSettings.dangerously_skip_permissions === "true");
        setCloneBaseDir(appSettings.clone_base_directory || '');
        setDefaultGitHost(appSettings.default_git_host || '');
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchAppSettings();
  }, [fetchAppSettings]);

  const handleSkipPermToggle = (checked: boolean) => {
    if (checked) {
      setShowSkipPermWarning(true);
    } else {
      saveSkipPermissions(false);
    }
  };

  const saveSkipPermissions = async (enabled: boolean) => {
    setSkipPermSaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { dangerously_skip_permissions: enabled ? "true" : "" },
        }),
      });
      if (res.ok) {
        setSkipPermissions(enabled);
      }
    } catch {
      // ignore
    } finally {
      setSkipPermSaving(false);
      setShowSkipPermWarning(false);
    }
  };

  const saveGitSettings = async () => {
    setGitSettingsSaving(true);
    setGitSettingsSaved(false);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            clone_base_directory: cloneBaseDir.trim(),
            default_git_host: defaultGitHost.trim(),
          },
        }),
      });
      if (res.ok) {
        setGitSettingsSaved(true);
        setTimeout(() => setGitSettingsSaved(false), 2000);
      }
    } catch {
      // ignore
    } finally {
      setGitSettingsSaving(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <VersionCard />

      {/* Auto-approve toggle */}
      <div className={`rounded-lg border p-4 transition-shadow hover:shadow-sm ${skipPermissions ? "border-orange-500/50 bg-orange-500/5" : "border-border/50"}`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">Auto-approve All Actions</h2>
            <p className="text-xs text-muted-foreground">
              Skip all permission checks and auto-approve every tool action.
              This is dangerous and should only be used for trusted tasks.
            </p>
          </div>
          <Switch
            checked={skipPermissions}
            onCheckedChange={handleSkipPermToggle}
            disabled={skipPermSaving}
          />
        </div>
        {skipPermissions && (
          <div className="mt-3 flex items-center gap-2 rounded-md bg-orange-500/10 px-3 py-2 text-xs text-orange-600 dark:text-orange-400">
            <span className="h-2 w-2 shrink-0 rounded-full bg-orange-500" />
            All tool actions will be auto-approved without confirmation. Use with caution.
          </div>
        )}
      </div>

      {/* Skip-permissions warning dialog */}
      <AlertDialog open={showSkipPermWarning} onOpenChange={setShowSkipPermWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable Auto-approve All Actions?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This will bypass all permission checks. Claude will be able to
                  execute any tool action without asking for your confirmation,
                  including:
                </p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Running arbitrary shell commands</li>
                  <li>Reading, writing, and deleting files</li>
                  <li>Making network requests</li>
                </ul>
                <p className="font-medium text-orange-600 dark:text-orange-400">
                  Only enable this if you fully trust the task at hand. This
                  setting applies to all new chat sessions.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => saveSkipPermissions(true)}
              className="bg-orange-600 hover:bg-orange-700 text-white"
            >
              Enable Auto-approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Git Clone Settings */}
      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm space-y-4">
        <div>
          <h2 className="text-sm font-medium">Git Clone Settings</h2>
          <p className="text-xs text-muted-foreground">
            Configure where cloned repos are saved and the default git host for shorthand URLs (e.g. user/repo).
          </p>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Clone Base Directory</label>
            <Input
              value={cloneBaseDir}
              onChange={(e) => setCloneBaseDir(e.target.value)}
              placeholder="/Users/party/working"
              className="font-mono text-sm"
            />
            <p className="text-[11px] text-muted-foreground">
              Repos will be cloned into this directory. Leave empty for default.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Default Git Host</label>
            <Input
              value={defaultGitHost}
              onChange={(e) => setDefaultGitHost(e.target.value)}
              placeholder="https://github.com"
              className="font-mono text-sm"
            />
            <p className="text-[11px] text-muted-foreground">
              When you type <code className="rounded bg-muted px-1">user/repo</code>, it expands to this host. Leave empty for GitHub.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={saveGitSettings}
              disabled={gitSettingsSaving}
            >
              {gitSettingsSaving ? "Saving..." : "Save"}
            </Button>
            {gitSettingsSaved && (
              <span className="text-xs text-green-600 dark:text-green-400">Saved!</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
