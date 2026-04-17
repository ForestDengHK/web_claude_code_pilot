"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon, GlobeIcon, FolderOpenIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";

export interface ScopeOption {
  value: string;
  label: string;
  description: string;
  /** Optional Hugeicon component; defaults to FolderOpenIcon if omitted. */
  icon?: typeof GlobeIcon;
}

interface CreateSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, scope: string, content: string) => Promise<void>;
  workingDirectory?: string;
  /** Custom scopes. When omitted, defaults to Claude's Project/Global. */
  scopeOptions?: ScopeOption[];
  /** Dialog title. Default: "Create New Skill". */
  title?: string;
  /** Dialog description. Default: Claude-style message. */
  description?: string;
}

const TEMPLATES: { label: string; content: string }[] = [
  { label: "Blank", content: "" },
  {
    label: "Commit Helper",
    content: `# Commit Helper

Review the staged changes and generate a concise, descriptive commit message following conventional commit format.

Rules:
- Use conventional commit prefixes: feat, fix, refactor, docs, test, chore
- Keep the first line under 72 characters
- Add a blank line and detailed description if needed
- Reference relevant issue numbers if applicable
`,
  },
  {
    label: "Code Reviewer",
    content: `# Code Reviewer

Review the provided code and give feedback on:

1. **Correctness** - Logic errors, edge cases, potential bugs
2. **Performance** - Inefficiencies, unnecessary allocations
3. **Readability** - Naming, structure, comments where needed
4. **Security** - Input validation, injection risks, data exposure

Be specific with line references. Suggest concrete improvements, not just problems.
`,
  },
];

export function CreateSkillDialog({
  open,
  onOpenChange,
  onCreate,
  workingDirectory,
  scopeOptions,
  title,
  description,
}: CreateSkillDialogProps) {
  const DEFAULT_CLAUDE_SCOPES: ScopeOption[] = [
    {
      value: "project",
      label: "Project",
      description: workingDirectory
        ? `Saved in ${workingDirectory}/.claude/skills/ (this project only)`
        : "Saved in ./.claude/skills/ (this project only)",
      icon: FolderOpenIcon,
    },
    {
      value: "global",
      label: "Global",
      description: "Saved in ~/.claude/skills/ (available everywhere)",
      icon: GlobeIcon,
    },
  ];

  const scopes = scopeOptions ?? DEFAULT_CLAUDE_SCOPES;
  const initialScope = scopes[0]?.value ?? "project";

  const [name, setName] = useState("");
  const [scope, setScope] = useState<string>(initialScope);
  const [templateIdx, setTemplateIdx] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      setError("Name can only contain letters, numbers, hyphens, and underscores");
      return;
    }

    setCreating(true);
    setError("");
    try {
      await onCreate(trimmed, scope, TEMPLATES[templateIdx].content);
      // Reset on success
      setName("");
      setScope(initialScope);
      setTemplateIdx(0);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create skill");
    } finally {
      setCreating(false);
    }
  };

  const activeScopeDescription = scopes.find((s) => s.value === scope)?.description ?? "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title ?? "Create New Skill"}</DialogTitle>
          <DialogDescription>
            {description ?? "Create a new slash command skill. It will be saved as a .md file."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Name input */}
          <div className="space-y-2">
            <Label htmlFor="skill-name">Name</Label>
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted-foreground">/</span>
              <Input
                id="skill-name"
                placeholder="my-skill"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                }}
              />
            </div>
          </div>

          {/* Scope selection */}
          <div className="space-y-2">
            <Label>Scope</Label>
            <div className="flex gap-2">
              {scopes.map((s) => {
                const active = scope === s.value;
                const Icon = s.icon ?? FolderOpenIcon;
                return (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => setScope(s.value)}
                    className={cn(
                      "flex-1 flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                      active
                        ? "border-blue-500/50 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                        : "border-border hover:bg-accent"
                    )}
                  >
                    <HugeiconsIcon icon={Icon} className="h-4 w-4" />
                    {s.label}
                  </button>
                );
              })}
            </div>
            <p
              className="text-xs text-muted-foreground truncate"
              title={activeScopeDescription}
            >
              {activeScopeDescription}
            </p>
          </div>

          {/* Template selection */}
          <div className="space-y-2">
            <Label>Template</Label>
            <div className="flex gap-2 flex-wrap">
              {TEMPLATES.map((t, i) => (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => setTemplateIdx(i)}
                  className={cn(
                    "rounded-md border px-3 py-1 text-xs transition-colors",
                    templateIdx === i
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-accent"
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={creating} className="gap-2">
            {creating && <HugeiconsIcon icon={Loading02Icon} className="h-4 w-4 animate-spin" />}
            Create Skill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
