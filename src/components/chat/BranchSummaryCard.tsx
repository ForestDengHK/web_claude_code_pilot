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
    <div className="mx-auto w-full max-w-3xl min-w-0 px-4 pt-4 pb-2">
      <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-expanded={open}
            className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50"
          >
            <span className="min-w-0 flex-1 truncate font-medium">Context from previous session</span>
            <HugeiconsIcon icon={open ? ArrowUp02Icon : ArrowDown01Icon} className="h-4 w-4 shrink-0" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 min-w-0 overflow-hidden rounded-lg border border-border/30 bg-muted/20 text-sm">
            <div className="max-h-[min(58vh,34rem)] min-w-0 overflow-y-auto overscroll-contain px-4 py-3">
              <MessageResponse
                className={[
                  "min-w-0 max-w-full text-sm leading-6",
                  "[&_h1]:break-words [&_h1]:text-2xl [&_h1]:leading-tight sm:[&_h1]:text-3xl",
                  "[&_h2]:break-words [&_h2]:text-xl [&_h2]:leading-snug sm:[&_h2]:text-2xl",
                  "[&_h3]:break-words [&_h3]:text-lg [&_h3]:leading-snug",
                  "[&_li]:break-words [&_p]:break-words",
                  "[&_ol]:pl-5 [&_ul]:pl-5",
                  "[&_pre]:max-w-full [&_pre]:overflow-x-auto",
                  "[&_[data-streamdown=table-wrapper]]:max-w-full [&_[data-streamdown=table-wrapper]]:overflow-hidden",
                ].join(' ')}
              >
                {summary}
              </MessageResponse>
            </div>
            {sourceSessionId && (
              <div className="border-t border-border/30 px-4 py-2">
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
