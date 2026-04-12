'use client';

import { useState } from 'react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, ArrowUp02Icon } from '@hugeicons/core-free-icons';
import { MessageResponse } from '@/components/ai-elements/message';

interface BranchSummaryCardProps {
  summary: string;
  sourceSessionId?: string | null;
}

export function BranchSummaryCard({ summary, sourceSessionId }: BranchSummaryCardProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mx-auto max-w-3xl px-4 pt-4 pb-2">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            className="flex w-full items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-4 py-2.5 text-left text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
          >
            <span className="flex-1 font-medium">Context from previous session</span>
            <HugeiconsIcon icon={open ? ArrowUp02Icon : ArrowDown01Icon} className="h-4 w-4 shrink-0" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 rounded-lg border border-border/30 bg-muted/20 px-4 py-3 text-sm">
            <MessageResponse>{summary}</MessageResponse>
            {sourceSessionId && (
              <div className="mt-3 border-t border-border/30 pt-2">
                <a
                  href={`/chat/${sourceSessionId}`}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  View original session &rarr;
                </a>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
