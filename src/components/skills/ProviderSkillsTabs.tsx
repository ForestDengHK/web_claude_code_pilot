'use client';

import React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { HugeiconsIcon } from '@hugeicons/react';
import { Loading02Icon } from '@hugeicons/core-free-icons';
import {
  useAvailableSkillProviders,
  type SkillProvider,
} from '@/lib/skill-providers';

/**
 * Isolates rendering failures in one provider's list from other tabs.
 * Keeping this inline (rather than a generic ErrorBoundary export) makes
 * its single responsibility obvious.
 */
class ProviderErrorBoundary extends React.Component<
  { providerLabel: string; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm">
          <p className="text-destructive">
            The {this.props.providerLabel} skills panel crashed.
          </p>
          <p className="text-muted-foreground text-xs max-w-md text-center break-words">
            {this.state.error.message}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

function ProviderPanel({ provider }: { provider: SkillProvider }) {
  const ListComponent = provider.ListComponent;
  return (
    <ProviderErrorBoundary providerLabel={provider.label}>
      <ListComponent />
    </ProviderErrorBoundary>
  );
}

export function ProviderSkillsTabs() {
  const { providers, loading } = useAvailableSkillProviders();
  const [active, setActive] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!active && providers.length > 0) {
      setActive(providers[0].id);
    }
  }, [active, providers]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <HugeiconsIcon
          icon={Loading02Icon}
          className="h-5 w-5 animate-spin text-muted-foreground"
        />
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        No skill providers available.
      </div>
    );
  }

  return (
    <Tabs
      value={active ?? providers[0].id}
      onValueChange={setActive}
      className="flex h-full flex-col"
    >
      <TabsList className="w-fit">
        {providers.map((p) => (
          <TabsTrigger key={p.id} value={p.id} className="text-xs">
            {p.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {providers.map((p) => (
        <TabsContent
          key={p.id}
          value={p.id}
          className="flex-1 min-h-0 overflow-hidden mt-3"
        >
          <ProviderPanel provider={p} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
