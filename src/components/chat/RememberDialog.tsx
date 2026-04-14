"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import {
  fetchModelCatalog,
  getDefaultEffortForModel,
  getEffortOptionsForModel,
  normalizeEffortForModel,
  type ModelOption,
  type ClaudeModelEffortInfo,
  type CodexModelInfo,
} from "@/lib/model-selection";

interface RememberDialogProps {
  open: boolean;
  onClose: () => void;
  defaultContent: string;
  sourceSessionId: string;
  workingDirectory: string;
  /** When true, AI Extract analyzes the entire session instead of defaultContent */
  sessionMode?: boolean;
}

export function RememberDialog({
  open,
  onClose,
  defaultContent,
  sourceSessionId,
  workingDirectory,
  sessionMode = false,
}: RememberDialogProps) {
  const [scope, setScope] = useState<"user" | "project">(
    workingDirectory ? "project" : "user"
  );
  const [type, setType] = useState<"memory" | "skill">("memory");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [summarizingAction, setSummarizingAction] = useState<"extract" | "generate" | null>(null);
  const [summarizeError, setSummarizeError] = useState<string | null>(null);
  const [summaryBackend, setSummaryBackend] = useState<"claude" | "codex">("claude");
  const [summaryModel, setSummaryModel] = useState("");
  const [summaryEffort, setSummaryEffort] = useState("");
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [claudeEffortInfo, setClaudeEffortInfo] = useState<Map<string, ClaudeModelEffortInfo>>(new Map());
  const [codexModelInfo, setCodexModelInfo] = useState<Map<string, CodexModelInfo>>(new Map());
  const [modelsLoading, setModelsLoading] = useState(false);

  useEffect(() => {
    if (!open) return;

    setContent("");
    setSaved(false);
    setSummarizeError(null);
    setSummarizingAction(null);

    let cancelled = false;
    setModelsLoading(true);

    Promise.all([
      fetch(`/api/chat/sessions/${sourceSessionId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetchModelCatalog().catch(() => ({ models: [], claudeEffortInfo: new Map(), codexModelInfo: new Map() })),
    ]).then(([sessionData, catalog]) => {
      if (cancelled) return;

      const nextModels = catalog.models || [];
      const sessionBackend = sessionData?.session?.backend === "codex" ? "codex" : "claude";
      const sessionModel = typeof sessionData?.session?.model === "string" ? sessionData.session.model : "";
      const backendModels = nextModels.filter((model) => model.group === sessionBackend);
      const hasSessionModel = backendModels.some((model) => model.value === sessionModel);
      const nextModel = hasSessionModel ? sessionModel : (backendModels[0]?.value || "");

      setAvailableModels(nextModels);
      setClaudeEffortInfo(catalog.claudeEffortInfo);
      setCodexModelInfo(catalog.codexModelInfo);
      setSummaryBackend(sessionBackend);
      setSummaryModel(nextModel);
      setSummaryEffort(
        getDefaultEffortForModel(nextModel, catalog.claudeEffortInfo, catalog.codexModelInfo) || ""
      );
    }).finally(() => {
      if (!cancelled) setModelsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [open, sourceSessionId]);

  useEffect(() => {
    const backendModels = availableModels.filter((model) => model.group === summaryBackend);
    if (backendModels.length === 0) {
      if (summaryModel) setSummaryModel("");
      return;
    }

    if (!backendModels.some((model) => model.value === summaryModel)) {
      setSummaryModel(backendModels[0]?.value || "");
    }
  }, [availableModels, summaryBackend, summaryModel]);

  useEffect(() => {
    const normalizedEffort = normalizeEffortForModel(
      summaryModel,
      summaryEffort,
      claudeEffortInfo,
      codexModelInfo,
    );
    if (normalizedEffort !== summaryEffort) {
      setSummaryEffort(normalizedEffort);
    }
  }, [summaryModel, summaryEffort, claudeEffortInfo, codexModelInfo]);

  const currentEffortOptions = getEffortOptionsForModel(
    summaryModel,
    claudeEffortInfo,
    codexModelInfo,
  );

  const handleSummarize = async (action: "extract" | "generate") => {
    setSummarizingAction(action);
    setSummarizeError(null);
    try {
      const isGenerate = action === "generate";
      const res = await fetch("/api/memory/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isGenerate
            ? { content, mode: type, action: "generate" as const }
            : sessionMode
              ? { session_id: sourceSessionId, mode: `session-${type}` as const, action: "extract" as const }
              : { content: defaultContent, mode: type, action: "extract" as const }),
          backend: summaryBackend,
          model: summaryModel || undefined,
          effort: summaryEffort || undefined,
          working_directory: workingDirectory || undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.summary) setContent(data.summary);
      } else {
        const data = await res.json().catch(() => ({}));
        setSummarizeError(data.error || `Failed (${res.status})`);
      }
    } catch {
      setSummarizeError("Network error");
    } finally {
      setSummarizingAction(null);
    }
  };

  const handleSave = async () => {
    if (!content.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope,
          type,
          content: content.trim(),
          scope_key: scope === "project" ? workingDirectory : undefined,
          source_session_id: sourceSessionId,
          // For skills, extract name and description from frontmatter
          description: type === "skill" ? extractSkillDescription(content) : undefined,
        }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => onClose(), 800);
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>{sessionMode ? 'Summarize Session' : 'Remember This'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 overflow-y-auto min-h-0 flex-1 pr-1">
          {/* Type toggle — prominent, drives the AI prompt */}
          <div className="flex gap-1 rounded-lg border border-border/50 p-1">
            <button
              type="button"
              onClick={() => setType("memory")}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                type === "memory"
                  ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Memory
              <span className="block text-[10px] font-normal opacity-70">Facts & preferences</span>
            </button>
            <button
              type="button"
              onClick={() => setType("skill")}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                type === "skill"
                  ? "bg-purple-500/15 text-purple-600 dark:text-purple-400"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Skill
              <span className="block text-[10px] font-normal opacity-70">Reusable procedure</span>
            </button>
          </div>

          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Scope</label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as "user" | "project")}
                className="w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-sm"
              >
                <option value="user">User (global)</option>
                {workingDirectory && (
                  <option value="project">
                    Project ({workingDirectory.split("/").pop()})
                  </option>
                )}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Backend</label>
              <select
                value={summaryBackend}
                onChange={(e) => setSummaryBackend(e.target.value as "claude" | "codex")}
                className="w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-sm"
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Model</label>
              <select
                value={summaryModel}
                onChange={(e) => setSummaryModel(e.target.value)}
                disabled={modelsLoading || availableModels.filter((model) => model.group === summaryBackend).length === 0}
                className="w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-sm"
              >
                {modelsLoading && <option value="">Loading models...</option>}
                {!modelsLoading && availableModels.filter((model) => model.group === summaryBackend).length === 0 && (
                  <option value="">No models available</option>
                )}
                {!modelsLoading && availableModels
                  .filter((model) => model.group === summaryBackend)
                  .map((model) => (
                    <option key={`${model.group}:${model.value}`} value={model.value}>
                      {model.label || model.value}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Reasoning Effort</label>
            <select
              value={summaryEffort}
              onChange={(e) => setSummaryEffort(e.target.value)}
              disabled={currentEffortOptions.length <= 1}
              className="w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-sm disabled:opacity-60"
            >
              {currentEffortOptions.length <= 1 ? (
                <option value={summaryEffort || ""}>
                  {summaryEffort || "Default"}
                </option>
              ) : (
                currentEffortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">
                {type === "memory" ? "Facts to remember" : "Procedure to save"}
              </label>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[11px] gap-1.5 px-2"
                  onClick={() => handleSummarize("extract")}
                  disabled={summarizingAction !== null || (!sessionMode && !defaultContent.trim())}
                >
                  {summarizingAction === "extract" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <span>AI Extract</span>
                  )}
                  {summarizingAction !== "extract" && <span>✨</span>}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[11px] gap-1.5 px-2"
                  onClick={() => handleSummarize("generate")}
                  disabled={summarizingAction !== null || !content.trim()}
                >
                  {summarizingAction === "generate" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <span>AI Generate</span>
                  )}
                  {summarizingAction !== "generate" && <span>✨</span>}
                </Button>
              </div>
            </div>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={type === "skill" ? 12 : 6}
              placeholder={
                type === "memory"
                  ? "- User prefers English for all code\n- This project uses Next.js standalone mode\n- Dev server on port 4000, prod on port 4001"
                  : "---\nname: deploy-production\ndescription: Deploy to production via rebuild script\n---\n\n# Deploy to Production\n\n## When to Use\n...\n\n## Procedure\n1. ...\n\n## Pitfalls\n- ...\n\n## Verification\n..."
              }
              className="text-sm font-mono"
            />
            {summarizeError && (
              <p className="text-[11px] text-red-500">{summarizeError}</p>
            )}
            <p className="text-[11px] text-muted-foreground">
              {sessionMode
                ? `Click "AI Extract" to analyze the entire conversation and extract ${type === 'memory' ? 'key facts' : 'reusable procedures'}.`
                : type === "memory"
                  ? 'Click "AI Extract" to auto-extract key facts, or write manually. One fact per line.'
                  : 'Click "AI Extract" to auto-generate a skill with When/Procedure/Pitfalls/Verification sections.'}
            </p>
            <p className="text-[11px] text-muted-foreground">
              `AI Generate` rewrites your draft notes into the final {type === "memory" ? "memory" : "skill"} format.
            </p>
            <p className="text-[11px] text-muted-foreground">
              Summary runs through {summaryBackend === "codex" ? "Codex app-server" : "the Claude backend"}{summaryModel ? ` using ${summaryModel}.` : "."}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Effort: {summaryEffort || "default"}.
            </p>
          </div>
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !content.trim() || saved}
          >
            {saved ? "Saved!" : saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Extract the description field from SKILL.md frontmatter */
function extractSkillDescription(content: string): string | undefined {
  const match = content.match(/^---\r?\n[\s\S]+?\r?\n---/);
  if (!match) return undefined;
  const descMatch = match[0].match(/description:\s*(.+)/);
  return descMatch?.[1]?.trim();
}
