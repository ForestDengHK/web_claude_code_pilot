"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon } from "@hugeicons/core-free-icons";

interface PluginInfo {
  name: string;
  version: string;
  scope: string;
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
  };
  results: UpdateResult[];
}

export function PluginUpdater() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateResults, setUpdateResults] = useState<UpdateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/plugins/update");
      if (!res.ok) throw new Error("Failed to load plugins");
      const data = await res.json();
      setPlugins(data.plugins || []);
      setLoaded(true);
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

  // Auto-load on first render
  if (!loaded && !loading) {
    loadPlugins();
  }

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
                  key={plugin.name}
                  className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-accent/50 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {plugin.name.split("@")[0]}
                      </span>
                      <span className="text-[10px] text-muted-foreground/60 shrink-0">
                        {plugin.name.split("@")[1]}
                      </span>
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs shrink-0"
                    onClick={() => updateSingle(plugin.name)}
                    disabled={updating}
                  >
                    Update
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
