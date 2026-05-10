"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon, Link01Icon, Delete02Icon } from "@hugeicons/core-free-icons";

interface PluginInfo {
  name: string;
  version: string;
  scope: string;
  source?: "marketplace" | "url";
  url?: string;
}

interface UpdateResult {
  name: string;
  oldVersion: string;
  newVersion: string | null;
  status: "updated" | "up-to-date" | "error";
  message: string;
}

interface UpdateResponse {
  summary: {
    total: number;
    updated: number;
    upToDate: number;
    errors: number;
    orphansCleaned?: number;
  };
  results: UpdateResult[];
}

export function PluginUpdater() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateResults, setUpdateResults] = useState<UpdateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [installUrl, setInstallUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [removingUrl, setRemovingUrl] = useState<string | null>(null);

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/plugins/update");
      if (!res.ok) throw new Error("Failed to load plugins");
      const data = await res.json();
      setPlugins(data.plugins || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load plugins");
    } finally {
      setLoading(false);
    }
  }, []);

  const updateAll = useCallback(async () => {
    setUpdating(true);
    setError(null);
    setUpdateResults(null);
    try {
      const res = await fetch("/api/plugins/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Update failed");
      }
      const data: UpdateResponse = await res.json();
      setUpdateResults(data);
      // Reload plugin list to get new versions
      loadPlugins();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setUpdating(false);
    }
  }, [loadPlugins]);

  const updateSingle = useCallback(async (pluginName: string) => {
    setUpdating(true);
    setError(null);
    try {
      const res = await fetch("/api/plugins/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugin: pluginName }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Update failed");
      }
      const data: UpdateResponse = await res.json();
      setUpdateResults((prev) => {
        if (!prev) return data;
        // Merge new results
        const existing = prev.results.filter((r) => r.name !== pluginName);
        return {
          summary: {
            total: existing.length + data.results.length,
            updated: existing.filter((r) => r.status === "updated").length + data.summary.updated,
            upToDate: existing.filter((r) => r.status === "up-to-date").length + data.summary.upToDate,
            errors: existing.filter((r) => r.status === "error").length + data.summary.errors,
            orphansCleaned: (prev.summary.orphansCleaned ?? 0) + (data.summary.orphansCleaned ?? 0),
          },
          results: [...existing, ...data.results],
        };
      });
      loadPlugins();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setUpdating(false);
    }
  }, [loadPlugins]);

  const installFromUrl = useCallback(async () => {
    const url = installUrl.trim();
    if (!url) {
      setInstallError("Please enter a URL");
      return;
    }
    setInstalling(true);
    setInstallError(null);
    try {
      const res = await fetch("/api/plugins/install-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Install failed");
      setInstallDialogOpen(false);
      setInstallUrl("");
      loadPlugins();
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : "Install failed");
    } finally {
      setInstalling(false);
    }
  }, [installUrl, loadPlugins]);

  const removeUrlPlugin = useCallback(async (url: string) => {
    setRemovingUrl(url);
    try {
      const res = await fetch("/api/plugins/install-url", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Remove failed");
      }
      loadPlugins();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setRemovingUrl(null);
    }
  }, [loadPlugins]);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  const getResultForPlugin = (name: string) =>
    updateResults?.results.find((r) => r.name === name);

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {plugins.length} plugin{plugins.length !== 1 ? "s" : ""} installed
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setInstallError(null);
              setInstallDialogOpen(true);
            }}
          >
            <HugeiconsIcon icon={Link01Icon} className="h-3.5 w-3.5 mr-1" />
            Install from URL
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={loadPlugins}
            disabled={loading}
          >
            {loading ? (
              <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : null}
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={updateAll}
            disabled={updating || plugins.length === 0}
          >
            {updating ? (
              <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : null}
            Update All
          </Button>
        </div>
      </div>

      {/* Summary banner */}
      {updateResults && !updating && (
        <div className={`text-xs px-3 py-2 rounded-md ${
          updateResults.summary.errors > 0
            ? "bg-red-500/10 text-red-600 dark:text-red-400"
            : updateResults.summary.updated > 0
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-muted text-muted-foreground"
        }`}>
          {updateResults.summary.updated > 0
            ? `✓ ${updateResults.summary.updated} updated`
            : "All plugins up to date"}
          {updateResults.summary.errors > 0 && ` · ${updateResults.summary.errors} failed`}
          {(updateResults.summary.orphansCleaned ?? 0) > 0 && ` · ${updateResults.summary.orphansCleaned} stale cache${updateResults.summary.orphansCleaned === 1 ? '' : 's'} cleaned`}
        </div>
      )}

      {error && (
        <div className="text-xs px-3 py-2 rounded-md bg-red-500/10 text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Plugin list */}
      <div className="flex-1 overflow-y-auto min-h-0 pb-16 md:pb-0">
        {loading && plugins.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : plugins.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No plugins installed
          </p>
        ) : (
          <div className="space-y-1">
            {plugins.map((plugin) => {
              const result = getResultForPlugin(plugin.name);
              return (
                <div
                  key={`${plugin.source ?? 'marketplace'}:${plugin.name}`}
                  className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-accent/50 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {plugin.name.split("@")[0]}
                      </span>
                      {plugin.source === "url" ? (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-700 dark:text-blue-300 shrink-0"
                          title={plugin.url}
                        >
                          URL
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground/60 shrink-0">
                          {plugin.name.split("@")[1]}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-muted-foreground">
                        v{plugin.version}
                      </span>
                      {result && (
                        <span className={`text-[10px] ${
                          result.status === "updated"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : result.status === "error"
                              ? "text-red-500"
                              : "text-muted-foreground"
                        }`}>
                          {result.status === "updated"
                            ? `→ v${result.newVersion}`
                            : result.status === "error"
                              ? "update failed"
                              : "✓ up to date"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => updateSingle(plugin.name)}
                      disabled={updating}
                    >
                      Update
                    </Button>
                    {plugin.source === "url" && plugin.url && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="h-7 w-7 text-muted-foreground hover:text-red-500"
                        onClick={() => removeUrlPlugin(plugin.url!)}
                        disabled={removingUrl === plugin.url}
                        title="Remove URL plugin"
                      >
                        {removingUrl === plugin.url ? (
                          <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <HugeiconsIcon icon={Delete02Icon} className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Install plugin from URL</DialogTitle>
            <DialogDescription>
              Paste a link to a plugin <code>.zip</code> archive. The archive must
              contain a <code>plugin.json</code> at its root or inside a single
              top-level folder.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Input
              placeholder="https://example.com/my-plugin.zip"
              value={installUrl}
              onChange={(e) => setInstallUrl(e.target.value)}
              disabled={installing}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !installing) installFromUrl();
              }}
              autoFocus
            />
            {installError && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {installError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setInstallDialogOpen(false)}
              disabled={installing}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={installFromUrl} disabled={installing}>
              {installing && (
                <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin mr-1" />
              )}
              Install
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
