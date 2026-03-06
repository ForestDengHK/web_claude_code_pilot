'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Loading02Icon,
  FloppyDiskIcon,
} from '@hugeicons/core-free-icons';
import type { BridgeStatus, ChannelBinding } from '@/lib/bridge/types';

interface BridgeSettings {
  remote_bridge_enabled?: string;
  bridge_auto_start?: string;
  bridge_default_work_dir?: string;
  bridge_default_model?: string;
}

interface ModelOption {
  id: string;
  name: string;
}

export default function BridgeSection() {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [settings, setSettings] = useState<BridgeSettings>({});
  const [channels, setChannels] = useState<ChannelBinding[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/bridge');
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/bridge/settings');
      if (res.ok) {
        const data = await res.json();
        setSettings(data.settings || {});
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetch('/api/bridge/channels');
      if (res.ok) {
        const data = await res.json();
        setChannels(data.bindings || []);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models');
      if (res.ok) {
        const data = await res.json();
        setModels(data.models || []);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchStatus(), fetchSettings(), fetchChannels(), fetchModels()]).finally(() =>
      setLoading(false)
    );
  }, [fetchStatus, fetchSettings, fetchChannels, fetchModels]);

  const handleBridgeAction = async (action: 'start' | 'stop') => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Failed to ${action} bridge`);
      } else {
        await fetchStatus();
      }
    } catch {
      setError(`Failed to ${action} bridge`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/bridge/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      if (res.ok) {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to save settings');
      }
    } catch {
      setError('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const updateSetting = (key: keyof BridgeSettings, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const toggleSetting = (key: keyof BridgeSettings) => {
    setSettings((prev) => ({
      ...prev,
      [key]: prev[key] === 'true' ? 'false' : 'true',
    }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading bridge settings...</span>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* Bridge Status */}
      <div
        className={`rounded-lg border p-4 transition-shadow hover:shadow-sm ${
          status?.running ? 'border-green-500/50 bg-green-500/5' : 'border-border/50'
        }`}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">Bridge Status</h2>
            <div className="mt-1 flex items-center gap-2">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  status?.running ? 'bg-green-500' : 'bg-muted-foreground/50'
                }`}
              />
              <span className="text-xs text-muted-foreground">
                {status?.running ? 'Running' : 'Stopped'}
                {status?.startedAt && ` since ${new Date(status.startedAt).toLocaleString()}`}
              </span>
            </div>
            {/* Adapter statuses */}
            {status?.adapters && status.adapters.length > 0 && (
              <div className="mt-2 space-y-1">
                {status.adapters.map((adapter) => (
                  <div key={adapter.channelType} className="flex items-center gap-2">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        adapter.running ? 'bg-green-500' : adapter.error ? 'bg-red-500' : 'bg-muted-foreground/50'
                      }`}
                    />
                    <span className="text-xs text-muted-foreground capitalize">
                      {adapter.channelType}
                      {adapter.error && ` - ${adapter.error}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <Button
            variant={status?.running ? 'outline' : 'default'}
            size="sm"
            onClick={() => handleBridgeAction(status?.running ? 'stop' : 'start')}
            disabled={actionLoading}
            className="gap-2"
          >
            {actionLoading && (
              <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin" />
            )}
            {status?.running ? 'Stop Bridge' : 'Start Bridge'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* General Settings */}
      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
        <h2 className="text-sm font-medium mb-4">General Settings</h2>
        <div className="space-y-4">
          {/* Enable Remote Bridge */}
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Enable Remote Bridge</Label>
              <p className="text-xs text-muted-foreground">
                Allow external IM platforms to connect to CodePilot
              </p>
            </div>
            <Switch
              checked={settings.remote_bridge_enabled === 'true'}
              onCheckedChange={() => toggleSetting('remote_bridge_enabled')}
            />
          </div>

          {/* Auto-start bridge */}
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Auto-start Bridge</Label>
              <p className="text-xs text-muted-foreground">
                Automatically start the bridge when CodePilot launches
              </p>
            </div>
            <Switch
              checked={settings.bridge_auto_start === 'true'}
              onCheckedChange={() => toggleSetting('bridge_auto_start')}
            />
          </div>

          {/* Default working directory */}
          <div>
            <Label className="text-sm">Default Working Directory</Label>
            <p className="text-xs text-muted-foreground mb-1.5">
              Default working directory for new bridge sessions
            </p>
            <Input
              value={settings.bridge_default_work_dir || ''}
              onChange={(e) => updateSetting('bridge_default_work_dir', e.target.value)}
              placeholder="~/projects"
              className="text-sm"
            />
          </div>

          {/* Default model */}
          <div>
            <Label className="text-sm">Default Model</Label>
            <p className="text-xs text-muted-foreground mb-1.5">
              Default AI model for bridge sessions
            </p>
            {models.length > 0 ? (
              <Select
                value={settings.bridge_default_model || ''}
                onValueChange={(value) => updateSetting('bridge_default_model', value)}
              >
                <SelectTrigger className="w-full text-sm">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name || model.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={settings.bridge_default_model || ''}
                onChange={(e) => updateSetting('bridge_default_model', e.target.value)}
                placeholder="claude-sonnet-4-20250514"
                className="text-sm"
              />
            )}
          </div>
        </div>

        {/* Save button */}
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={handleSaveSettings} disabled={saving} size="sm" className="gap-2">
            {saving ? (
              <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <HugeiconsIcon icon={FloppyDiskIcon} className="h-3.5 w-3.5" />
            )}
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
          {saveSuccess && (
            <span className="text-sm text-green-600 dark:text-green-400">
              Settings saved successfully
            </span>
          )}
        </div>
      </div>

      {/* Active Channels */}
      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
        <h2 className="text-sm font-medium mb-3">Active Channels</h2>
        {channels.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No active channel bindings. Start a conversation from an IM platform to create one.
          </p>
        ) : (
          <div className="space-y-2">
            {channels.map((ch) => (
              <div
                key={ch.id}
                className="flex items-center justify-between rounded-md border border-border/30 bg-accent/30 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        ch.active ? 'bg-green-500' : 'bg-muted-foreground/50'
                      }`}
                    />
                    <span className="text-sm font-medium capitalize truncate">
                      {ch.channelType}
                    </span>
                    <span className="text-xs text-muted-foreground">#{ch.chatId}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground truncate">
                    Model: {ch.model} | Mode: {ch.mode} | Dir: {ch.workingDirectory}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
