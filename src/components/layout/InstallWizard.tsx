"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CheckIcon,
  XIcon,
  MinusIcon,
  LoaderIcon,
  CircleIcon,
  CopyIcon,
} from "lucide-react";

interface InstallProgress {
  status: "idle" | "running" | "success" | "failed" | "cancelled";
  currentStep: string | null;
  steps: Array<{
    id: string;
    label: string;
    status: "pending" | "running" | "success" | "failed" | "skipped";
    error?: string;
  }>;
  logs: string[];
}

interface InstallWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstallComplete?: () => void;
}

type WizardPhase =
  | "checking"
  | "already-installed"
  | "installing"
  | "success"
  | "failed";

function getInstallAPI() {
  if (typeof window !== "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (window as any).electronAPI?.install as
      | {
          checkPrerequisites: () => Promise<{
            hasNode: boolean;
            nodeVersion?: string;
            hasClaude: boolean;
            claudeVersion?: string;
          }>;
          start: (options?: { includeNode?: boolean }) => Promise<void>;
          cancel: () => Promise<void>;
          getLogs: () => Promise<string[]>;
          onProgress: (
            callback: (progress: InstallProgress) => void
          ) => () => void;
        }
      | undefined;
  }
  return undefined;
}

function StepIcon({ status }: { status: string }) {
  switch (status) {
    case "success":
      return <CheckIcon className="size-4 text-emerald-500" />;
    case "running":
      return <LoaderIcon className="size-4 text-blue-500 animate-spin" />;
    case "failed":
      return <XIcon className="size-4 text-red-500" />;
    case "skipped":
      return <MinusIcon className="size-4 text-muted-foreground" />;
    default:
      return <CircleIcon className="size-3.5 text-muted-foreground/40" />;
  }
}

export function InstallWizard({
  open,
  onOpenChange,
  onInstallComplete,
}: InstallWizardProps) {
  const [phase, setPhase] = useState<WizardPhase>("checking");
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const scrollToBottom = useCallback(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [logs, scrollToBottom]);

  const startInstall = useCallback(async (options?: { includeNode?: boolean }) => {
    const api = getInstallAPI();
    if (!api) return;

    setPhase("installing");

    // Subscribe to progress updates
    if (cleanupRef.current) cleanupRef.current();
    cleanupRef.current = api.onProgress((p) => {
      setProgress(p);
      setLogs(p.logs);

      if (p.status === "success") {
        setPhase("success");
      } else if (p.status === "failed" || p.status === "cancelled") {
        setPhase("failed");
      }
    });

    try {
      await api.start(options);
    } catch (err: unknown) {
      setPhase("failed");
      const msg = err instanceof Error ? err.message : String(err);
      setLogs((prev) => [...prev, `Installation error: ${msg}`]);
    }
  }, []);

  const checkPrereqs = useCallback(async () => {
    const api = getInstallAPI();
    if (!api) return;

    setPhase("checking");
    setLogs(["Checking environment..."]);
    setProgress(null);

    try {
      const result = await api.checkPrerequisites();

      if (result.hasClaude) {
        setLogs((prev) => [
          ...prev,
          `Node.js ${result.nodeVersion} found.`,
          `Claude Code ${result.claudeVersion} already installed.`,
        ]);
        setPhase("already-installed");
        return;
      }

      if (!result.hasNode) {
        setLogs((prev) => [
          ...prev,
          "Node.js not found. Will attempt to install Node.js and Claude Code...",
        ]);
        startInstall({ includeNode: true });
      } else {
        setLogs((prev) => [
          ...prev,
          `Node.js ${result.nodeVersion} found.`,
          "Claude Code not found. Starting installation...",
        ]);
        startInstall();
      }
    } catch (err: unknown) {
      setPhase("failed");
      const msg = err instanceof Error ? err.message : String(err);
      setLogs((prev) => [...prev, `Error checking prerequisites: ${msg}`]);
    }
  }, [startInstall]);

  const handleCancel = useCallback(async () => {
    const api = getInstallAPI();
    if (!api) return;
    try {
      await api.cancel();
    } catch {
      // ignore cancel errors
    }
  }, []);

  const handleCopyLogs = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(logs.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  }, [logs]);

  const handleDone = useCallback(() => {
    onOpenChange(false);
    onInstallComplete?.();
  }, [onOpenChange, onInstallComplete]);

  // Auto-check when dialog opens
  useEffect(() => {
    if (open) {
      setPhase("checking"); // eslint-disable-line react-hooks/set-state-in-effect -- reset state before async check
      setLogs([]); // eslint-disable-line react-hooks/set-state-in-effect
      setProgress(null); // eslint-disable-line react-hooks/set-state-in-effect
      setCopied(false); // eslint-disable-line react-hooks/set-state-in-effect
      checkPrereqs();
    }
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [open, checkPrereqs]);

  const steps = progress?.steps ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install Claude Code</DialogTitle>
          <DialogDescription>
            Automatically install Claude Code CLI
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Step list */}
          {steps.length > 0 && (
            <div className="space-y-2">
              {steps.map((step) => (
                <div
                  key={step.id}
                  className="flex items-center gap-2.5 text-sm"
                >
                  <StepIcon status={step.status} />
                  <span
                    className={cn(
                      step.status === "pending" && "text-muted-foreground",
                      step.status === "running" && "text-foreground font-medium",
                      step.status === "success" && "text-emerald-700 dark:text-emerald-400",
                      step.status === "failed" && "text-red-700 dark:text-red-400",
                      step.status === "skipped" && "text-muted-foreground"
                    )}
                  >
                    {step.label}
                  </span>
                  {step.error && (
                    <span className="text-xs text-red-500 ml-auto truncate max-w-[200px]">
                      {step.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Phase-specific messages */}
          {phase === "checking" && steps.length === 0 && (
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              <span>Checking environment...</span>
            </div>
          )}

          {phase === "already-installed" && (
            <div className="flex items-center gap-3 rounded-lg bg-emerald-500/10 px-4 py-3">
              <CheckIcon className="size-5 text-emerald-500 shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-emerald-700 dark:text-emerald-400">
                  Already installed
                </p>
                <p className="text-muted-foreground text-xs">
                  Claude Code is already available.
                </p>
              </div>
            </div>
          )}

          {phase === "success" && (
            <div className="flex items-center gap-3 rounded-lg bg-emerald-500/10 px-4 py-3">
              <CheckIcon className="size-5 text-emerald-500 shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-emerald-700 dark:text-emerald-400">
                  Installation complete
                </p>
                <p className="text-muted-foreground text-xs">
                  Claude Code CLI has been installed successfully.
                </p>
              </div>
            </div>
          )}

          {/* Log output */}
          {logs.length > 0 && (
            <div className="rounded-md bg-zinc-950 dark:bg-zinc-900 border border-zinc-800 max-h-48 overflow-y-auto">
              <div className="p-3 font-mono text-xs text-zinc-300 space-y-0.5">
                {logs.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">
                    {line}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyLogs}
            disabled={logs.length === 0}
          >
            <CopyIcon />
            {copied ? "Copied" : "Copy Logs"}
          </Button>

          {phase === "installing" && (
            <Button variant="destructive" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
          )}

          {phase === "failed" && (
            <Button size="sm" onClick={checkPrereqs}>
              Retry
            </Button>
          )}

          {(phase === "success" || phase === "already-installed") && (
            <Button size="sm" onClick={handleDone}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
