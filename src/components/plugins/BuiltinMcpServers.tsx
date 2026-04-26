'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { HugeiconsIcon } from '@hugeicons/react';
import { GitBranchIcon, Settings02Icon } from '@hugeicons/core-free-icons';

/**
 * Read-only card listing CodePilot's built-in (in-process) MCP servers.
 *
 * These are registered programmatically via `createSdkMcpServer` rather than
 * loaded from any of the config files (~/.claude.json, .mcp.json, etc.) so
 * they don't show up in the regular McpServerList. We surface them here so
 * users can see the full set of MCP tools their sessions have access to.
 */
export function BuiltinMcpServers() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/settings/app')
      .then((r) => r.json())
      .then((data) => {
        const v = data?.settings?.enable_spawn_subagents;
        // Default ON: only the literal string "false" disables.
        setEnabled(v !== 'false');
      })
      .catch(() => setEnabled(true));
  }, []);

  return (
    <Card className="mb-4 border-fuchsia-500/20 bg-fuchsia-500/5">
      <CardContent className="p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h4 className="text-sm font-semibold">Built-in (CodePilot internal)</h4>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            in-process
          </span>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          MCP servers that CodePilot registers programmatically into every
          Claude session. These don&apos;t live in any config file and can&apos;t be
          edited here — toggle them in{' '}
          <Link href="/settings" className="underline hover:text-foreground">
            Settings → General
          </Link>
          .
        </p>

        <div className="flex items-start gap-3 rounded-md border border-border/40 bg-background/40 p-3">
          <HugeiconsIcon
            icon={GitBranchIcon}
            className="mt-0.5 h-4 w-4 shrink-0 text-fuchsia-500"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <code className="font-mono text-xs">codepilot-subagents</code>
              <Badge
                variant={enabled === false ? 'outline' : 'default'}
                className={
                  enabled === false
                    ? 'border-muted text-muted-foreground'
                    : 'bg-fuchsia-500/15 text-fuchsia-700 hover:bg-fuchsia-500/15 dark:text-fuchsia-300'
                }
              >
                {enabled === null ? '…' : enabled ? 'enabled' : 'disabled'}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Exposes <code className="font-mono">spawn_subagents</code>: spawns N parallel
              forks of the current session, each inheriting full conversation
              context, then aggregates their results back to the main agent.
              Read-only forks (Read/Glob/Grep/Web).
            </p>
          </div>
          <Link
            href="/settings"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Open Settings"
          >
            <HugeiconsIcon icon={Settings02Icon} className="h-4 w-4" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
