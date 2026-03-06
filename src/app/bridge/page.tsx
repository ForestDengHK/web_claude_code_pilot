'use client';

import BridgeSection from '@/components/bridge/BridgeSection';
import TelegramBridgeSection from '@/components/bridge/TelegramBridgeSection';

export default function BridgePage() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/50 px-4 md:px-6 pt-4 pb-4">
        <h1 className="text-xl font-semibold">IM Bridge</h1>
        <p className="text-sm text-muted-foreground">
          Connect external messaging platforms to CodePilot
        </p>
      </div>

      <div className="flex-1 overflow-auto p-4 md:p-6 space-y-6">
        <BridgeSection />
        <TelegramBridgeSection />
      </div>
    </div>
  );
}
