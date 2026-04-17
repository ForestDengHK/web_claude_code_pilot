"use client";

/**
 * Two-tab section for editing CLAUDE.md memory files.
 *
 * - "User" → ~/.claude/CLAUDE.md (always available)
 * - "Project" → {workingDirectory}/CLAUDE.md (needs an active working
 *   directory; otherwise the editor shows a friendly "open a project" hint)
 *
 * `workingDirectory` comes from the global `usePanel` context, which the
 * chat sidebar/header manages. Extensions page mounts us outside of any
 * chat flow, so we read the last-used working directory.
 */

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClaudeMdEditor } from "./ClaudeMdEditor";
import { usePanel } from "@/hooks/usePanel";

type Tab = "user" | "project";

const USER_TEMPLATE = `# User-level CLAUDE.md

Personal preferences that apply to every project when using Claude Code.

## Example

- Preferred commit style, tone, language
- Tools you always want (or never want) Claude to use
`;

const PROJECT_TEMPLATE = `# CLAUDE.md

Project-specific instructions for Claude Code.

## Overview

Describe what this project does.

## Conventions

- Coding style, naming, test layout
- Release / deploy rules
`;

export function ClaudeMdSection() {
  const { workingDirectory } = usePanel();
  const [tab, setTab] = useState<Tab>("user");

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 pb-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="user">User</TabsTrigger>
            <TabsTrigger value="project">
              Project
              {workingDirectory ? "" : " (no cwd)"}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border">
        {tab === "user" ? (
          <ClaudeMdEditor scope="user" emptyTemplate={USER_TEMPLATE} />
        ) : (
          <ClaudeMdEditor
            // Re-mount when cwd changes so the editor reloads cleanly.
            key={workingDirectory || "__no_cwd__"}
            scope="project"
            cwd={workingDirectory || undefined}
            emptyTemplate={PROJECT_TEMPLATE}
          />
        )}
      </div>
    </div>
  );
}
