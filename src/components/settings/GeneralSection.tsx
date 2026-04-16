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
import { RefreshCw, ArrowUpCircle, Check, AlertTriangle, Loader2 } from "lucide-react";

interface ToolVersionInfo {
  name: string;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  source: "global-npm" | "local-npm" | "cli";
}

function VersionCard() {
  const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";
  const [tools, setTools] = useState<ToolVersionInfo[]>([]);
  const [checking, setChecking] = useState(false);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [upgradeResult, setUpgradeResult] = useState<{
    tool: string;
    success: boolean;
    message: string;
  } | null>(null);

  const checkVersions = useCallback(async () => {
    setChecking(true);
    setUpgradeResult(null);
    try {
      const res = await fetch("/api/versions");
      if (res.ok) {
        const data = await res.json();
        setTools(data.tools);
      }
    } catch {
      // ignore
    } finally {
      setChecking(false);
    }
  }, []);

  const handleUpgrade = async (toolName: string) => {
    setUpgrading(toolName);
    setUpgradeResult(null);
    try {
      const res = await fetch("/api/versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: toolName }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setUpgradeResult({
          tool: toolName,
          success: true,
          message: data.needsRestart
            ? "Upgraded! Restart dev server to take effect."
            : "Upgraded successfully!",
        });
        // Refresh versions
        await checkVersions();
      } else {
        setUpgradeResult({
          tool: toolName,
          success: false,
          message: data.error || "Upgrade failed",
        });
      }
    } catch (err) {
      setUpgradeResult({
        tool: toolName,
        success: false,
        message: err instanceof Error ? err.message : "Upgrade failed",
      });
    } finally {
      setUpgrading(null);
    }
  };

  const updatesAvailable = tools.filter((t) => t.updateAvailable).length;

  return (
    <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">Web Claude Code Pilot</h2>
          <p className="text-xs text-muted-foreground">
            Web App v{currentVersion}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={checkVersions}
          disabled={checking}
          className="gap-1.5"
        >
          {checking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {tools.length === 0 ? "Check Versions" : "Refresh"}
        </Button>
      </div>

      {tools.length > 0 && (
        <div className="space-y-2">
          {updatesAvailable > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
              <ArrowUpCircle className="h-3.5 w-3.5" />
              {updatesAvailable} update{updatesAvailable > 1 ? "s" : ""} available
            </div>
          )}
          <div className="divide-y divide-border/30 rounded-md border border-border/30">
            {tools.map((tool) => (
              <div
                key={tool.name}
                className="flex items-center justify-between px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">
                    {tool.name}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono">
                    {tool.current}
                    {tool.latest && tool.updateAvailable && (
                      <span className="text-blue-500 ml-1">
                        → {tool.latest}
                      </span>
                    )}
                    {tool.latest && !tool.updateAvailable && tool.current !== "unknown" && (
                      <span className="text-green-500 ml-1">
                        (latest)
                      </span>
                    )}
                  </div>
                </div>
                {tool.updateAvailable && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs gap-1 shrink-0 ml-2"
                    onClick={() => handleUpgrade(tool.name)}
                    disabled={upgrading !== null}
                  >
                    {upgrading === tool.name ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <ArrowUpCircle className="h-3 w-3" />
                    )}
                    Update
                  </Button>
                )}
              </div>
            ))}
          </div>

          {upgradeResult && (
            <div
              className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs ${
                upgradeResult.success
                  ? "bg-green-500/10 text-green-600 dark:text-green-400"
                  : "bg-red-500/10 text-red-600 dark:text-red-400"
              }`}
            >
              {upgradeResult.success ? (
                <Check className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              )}
              <span>
                <strong>{upgradeResult.tool}:</strong> {upgradeResult.message}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function GeneralSection() {
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [showSkipPermWarning, setShowSkipPermWarning] = useState(false);
  const [skipPermSaving, setSkipPermSaving] = useState(false);

  // Claude-only: show adaptive-thinking summary above each reply.
  // Ignored by Codex (which always streams its own reasoning) and by
  // Claude models without adaptive-thinking support (SDK drops silently).
  const [showThinking, setShowThinking] = useState(false);
  const [showThinkingSaving, setShowThinkingSaving] = useState(false);

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
        setShowThinking(appSettings.show_thinking_text === "true");
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

  const handleShowThinkingToggle = async (enabled: boolean) => {
    setShowThinkingSaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { show_thinking_text: enabled ? "true" : "" },
        }),
      });
      if (res.ok) {
        setShowThinking(enabled);
      }
    } catch {
      // ignore
    } finally {
      setShowThinkingSaving(false);
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

      {/* Show-thinking-text toggle (Claude only) */}
      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
        <div className="flex items-center justify-between">
          <div className="pr-4">
            <h2 className="text-sm font-medium">Show Claude&apos;s Thinking</h2>
            <p className="text-xs text-muted-foreground">
              Stream the model&apos;s summarized reasoning above each reply. Supported on Opus 4.7 and
              Sonnet 4.6+. Off by default so first-token latency stays low. Doesn&apos;t affect Codex,
              which streams its own reasoning regardless.
            </p>
          </div>
          <Switch
            checked={showThinking}
            onCheckedChange={handleShowThinkingToggle}
            disabled={showThinkingSaving}
          />
        </div>
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
              placeholder="~/working"
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
