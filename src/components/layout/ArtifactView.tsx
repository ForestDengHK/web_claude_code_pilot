"use client";

import { useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PinchZoomContainer } from "@/components/project/PinchZoomContainer";
import { ARTIFACT_SANDBOX, withCsp } from "@/lib/artifact-sandbox";

interface VersionMeta {
  version: number;
  label: string | null;
}

export interface ArtifactViewProps {
  artifactId: string;
  /** The version to show initially; bumps when a new version is published. */
  version: number;
  width: number;
  onVersionChange: (version: number) => void;
  onUpdate: () => void;
  onClose: () => void;
}

/**
 * Right-hand panel that renders an artifact's HTML in a hardened sandboxed
 * iframe (opaque origin, scripts allowed, CSP blocks external network). The
 * HTML is fetched as text and passed via `srcDoc` — never loaded same-origin.
 * Mirrors DocPreview's responsive shell (mobile overlay / desktop side panel).
 */
export function ArtifactView({ artifactId, version, width, onVersionChange, onUpdate, onClose }: ArtifactViewProps) {
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [title, setTitle] = useState("Artifact");
  const [htmlState, setHtmlState] = useState<{ key: string; html: string } | null>(null);
  const htmlKey = `${artifactId}:${version}`;

  // Load metadata (title + version list for the picker); refetch on new publish.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/artifacts/${artifactId}?meta=1`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("not found"))))
      .then((d) => {
        if (cancelled) return;
        setVersions(d.versions ?? []);
        if (d.meta?.title) setTitle(d.meta.title);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [artifactId, version]);

  // Load the selected version's HTML.
  useEffect(() => {
    let cancelled = false;
    const requestKey = `${artifactId}:${version}`;
    fetch(`/api/artifacts/${artifactId}?version=${version}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("not found"))))
      .then((t) => {
        if (!cancelled) setHtmlState({ key: requestKey, html: t });
      })
      .catch(() => {
        if (!cancelled) setHtmlState({ key: requestKey, html: "<p>Failed to load artifact.</p>" });
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, version]);

  const html = htmlState?.key === htmlKey ? htmlState.html : null;
  const srcDoc = useMemo(() => (html == null ? null : withCsp(html)), [html]);

  return (
    <div
      data-mobile-overlay=""
      className={cn(
        "flex flex-col overflow-hidden bg-background",
        "fixed inset-0 z-[60]",
        "md:static md:inset-auto md:z-auto md:h-full md:shrink-0 md:border-l md:border-border/40"
      )}
      style={{ width }}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>

        {versions.length > 1 && (
          <select
            value={version}
            onChange={(e) => onVersionChange(parseInt(e.target.value, 10))}
            className="h-6 rounded border border-border/40 bg-background px-1 text-xs"
            aria-label="Artifact version"
          >
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                {v.label ? `v${v.version} · ${v.label}` : `v${v.version}`}
              </option>
            ))}
          </select>
        )}

        <Button variant="ghost" size="sm" onClick={onUpdate} className="h-6 px-2 text-xs">
          更新
        </Button>

        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <HugeiconsIcon icon={Cancel01Icon} className="h-3.5 w-3.5" />
          <span className="sr-only">Close artifact</span>
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        {srcDoc == null ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : (
          <PinchZoomContainer iframeMode resetKey={`${artifactId}:${version}`}>
            <iframe
              srcDoc={srcDoc}
              sandbox={ARTIFACT_SANDBOX}
              className="h-full w-full border-0 bg-white"
              title="Artifact"
            />
          </PinchZoomContainer>
        )}
      </div>
    </div>
  );
}
