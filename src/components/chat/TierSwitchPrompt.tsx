'use client';

import type { Tier } from '@/lib/channels/tiers';
import { tierLabel } from '@/lib/channels/tiers';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

interface TierSwitchPromptProps {
  from: Tier;
  to: Tier;
  onConfirm: () => void;
  onCancel: () => void;
}

export function TierSwitchPrompt({ from: _from, to, onConfirm, onCancel }: TierSwitchPromptProps) {
  return (
    <Alert className="flex flex-col gap-2">
      <AlertDescription className="inline font-medium text-foreground">
        当前额度已用完
      </AlertDescription>
      <AlertDescription>
        切换到 {tierLabel(to)} 继续？
      </AlertDescription>
      <div className="flex items-center justify-end gap-2 self-end">
        <Button
          variant="outline"
          className="h-10 min-w-[4rem] px-4 text-sm"
          type="button"
          onClick={onCancel}
        >
          取消
        </Button>
        <Button
          variant="default"
          className="h-10 min-w-[4rem] px-4 text-sm"
          type="button"
          onClick={onConfirm}
        >
          切换
        </Button>
      </div>
    </Alert>
  );
}
