"use client";

import { useEffect, useMemo, useState } from "react";
import { PinchZoomContainer } from "@/components/project/PinchZoomContainer";
import { ARTIFACT_SANDBOX, withCsp } from "@/lib/artifact-sandbox";

export interface ArtifactViewProps {
  artifactId: string;
  version: number;
  onUpdate: () => void;
}

/**
 * Renders an artifact's HTML in a hardened sandboxed iframe (opaque origin,
 * scripts allowed, CSP blocks external network). The HTML is fetched as text
 * and passed via `srcDoc` — never loaded same-origin.
 */
export function ArtifactView({ artifactId, version, onUpdate }: ArtifactViewProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    fetch(`/api/artifacts/${artifactId}?version=${version}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("not found"))))
      .then((t) => {
        if (!cancelled) setHtml(t);
      })
      .catch(() => {
        if (!cancelled) setHtml("<p>Failed to load artifact.</p>");
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, version]);

  const srcDoc = useMemo(() => (html == null ? null : withCsp(html)), [html]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end gap-2 border-b px-2 py-1">
        <button
          type="button"
          onClick={onUpdate}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          更新此 Artifact
        </button>
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
