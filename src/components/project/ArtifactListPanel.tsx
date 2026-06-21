"use client";

import { useEffect, useState } from "react";
import { usePanel } from "@/hooks/usePanel";
import { cn } from "@/lib/utils";

interface ArtifactListItem {
  id: string;
  title: string;
  favicon: string | null;
  currentVersion: number;
  updatedAt: string;
}

export function ArtifactListPanel() {
  const { workingDirectory, artifactPreview, setArtifactPreview, setPreviewFile, setDiffTarget } = usePanel();
  const [state, setState] = useState<{ projectId: string; artifacts: ArtifactListItem[]; loaded: boolean }>({
    projectId: workingDirectory,
    artifacts: [],
    loaded: false,
  });

  useEffect(() => {
    let cancelled = false;
    const projectId = workingDirectory;

    fetch(`/api/artifacts?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d) => {
        if (!cancelled) {
          setState({ projectId, artifacts: d.artifacts ?? [], loaded: true });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ projectId, artifacts: [], loaded: true });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [workingDirectory]);

  const rawArtifacts = state.projectId === workingDirectory ? state.artifacts : [];
  // Pin the project dashboard (deterministic id prefix) to the top; keep the
  // rest in their server order (newest-updated first).
  const artifacts = [...rawArtifacts].sort((a, b) => {
    const da = a.id.startsWith("project-dashboard-") ? 0 : 1;
    const db = b.id.startsWith("project-dashboard-") ? 0 : 1;
    return da - db;
  });
  const loaded = state.projectId === workingDirectory && state.loaded;

  if (!loaded) {
    return <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-sm text-muted-foreground">Loading...</div>;
  }

  if (artifacts.length === 0) {
    return <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-sm text-muted-foreground">No artifacts yet.</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex flex-col py-2">
        {artifacts.map((artifact) => {
          const active = artifactPreview?.id === artifact.id;
          const isDashboard = artifact.id.startsWith("project-dashboard-");
          return (
            <button
              key={artifact.id}
              type="button"
              className={cn(
                "flex items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent/50",
                active && "bg-accent text-accent-foreground"
              )}
              onClick={() => {
                setDiffTarget(null);
                setPreviewFile(null);
                setArtifactPreview({ id: artifact.id, version: artifact.currentVersion });
              }}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border/40 text-sm">
                {artifact.favicon || "A"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{artifact.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {isDashboard ? `Dashboard · v${artifact.currentVersion}` : `v${artifact.currentVersion}`}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
