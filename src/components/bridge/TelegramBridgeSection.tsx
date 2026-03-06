'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Loading02Icon,
  FloppyDiskIcon,
} from '@hugeicons/core-free-icons';

interface TelegramSettings {
  bridge_telegram_enabled?: string;
  telegram_bot_token?: string;
  telegram_bridge_allowed_users?: string;
  bridge_telegram_image_enabled?: string;
  bridge_telegram_stream_enabled?: string;
}

export default function TelegramBridgeSection() {
  const [settings, setSettings] = useState<TelegramSettings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; message: string } | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/bridge/settings');
      if (res.ok) {
        const data = await res.json();
        const all = data.settings || {};
        setSettings({
          bridge_telegram_enabled: all.bridge_telegram_enabled,
          telegram_bot_token: all.telegram_bot_token,
          telegram_bridge_allowed_users: all.telegram_bridge_allowed_users,
          bridge_telegram_image_enabled: all.bridge_telegram_image_enabled,
          bridge_telegram_stream_enabled: all.bridge_telegram_stream_enabled,
        });
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const updateSetting = (key: keyof TelegramSettings, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const toggleSetting = (key: keyof TelegramSettings) => {
    setSettings((prev) => ({
      ...prev,
      [key]: prev[key] === 'true' ? 'false' : 'true',
    }));
  };

  const handleSave = async () => {
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

  const handleVerifyToken = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch('/api/settings/telegram/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: settings.telegram_bot_token }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setVerifyResult({ ok: true, message: data.bot?.username ? `Verified: @${data.bot.username}` : 'Token is valid' });
      } else {
        setVerifyResult({ ok: false, message: data.error || 'Invalid token' });
      }
    } catch {
      setVerifyResult({ ok: false, message: 'Failed to verify token' });
    } finally {
      setVerifying(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <HugeiconsIcon icon={Loading02Icon} className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading Telegram settings...</span>
      </div>
    );
  }

  const isMasked = settings.telegram_bot_token?.startsWith('***');

  return (
    <div className="max-w-3xl space-y-6">
      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
        <h2 className="text-sm font-medium mb-4">Telegram Bridge</h2>
        <div className="space-y-4">
          {/* Enable Telegram */}
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Enable Telegram Bridge</Label>
              <p className="text-xs text-muted-foreground">
                Connect a Telegram bot to CodePilot
              </p>
            </div>
            <Switch
              checked={settings.bridge_telegram_enabled === 'true'}
              onCheckedChange={() => toggleSetting('bridge_telegram_enabled')}
            />
          </div>

          {/* Bot token */}
          <div>
            <Label className="text-sm">Bot Token</Label>
            <p className="text-xs text-muted-foreground mb-1.5">
              Telegram bot token from @BotFather
            </p>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={tokenVisible ? 'text' : 'password'}
                  value={settings.telegram_bot_token || ''}
                  onChange={(e) => updateSetting('telegram_bot_token', e.target.value)}
                  placeholder="123456:ABC-DEF..."
                  className="text-sm pr-16"
                />
                <button
                  type="button"
                  onClick={() => setTokenVisible(!tokenVisible)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {tokenVisible ? 'Hide' : 'Show'}
                </button>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerifyToken}
                disabled={verifying || !settings.telegram_bot_token || isMasked}
                className="gap-1.5 shrink-0"
              >
                {verifying && (
                  <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin" />
                )}
                Verify
              </Button>
            </div>
            {isMasked && (
              <p className="mt-1 text-xs text-muted-foreground">
                Token is masked. Enter a new token to change it.
              </p>
            )}
            {verifyResult && (
              <p
                className={`mt-1.5 text-xs ${
                  verifyResult.ok
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-destructive'
                }`}
              >
                {verifyResult.message}
              </p>
            )}
          </div>

          {/* Allowed user IDs */}
          <div>
            <Label className="text-sm">Allowed User IDs</Label>
            <p className="text-xs text-muted-foreground mb-1.5">
              Comma-separated Telegram user IDs authorized to use the bot. Leave empty to allow all.
            </p>
            <Input
              value={settings.telegram_bridge_allowed_users || ''}
              onChange={(e) => updateSetting('telegram_bridge_allowed_users', e.target.value)}
              placeholder="123456789, 987654321"
              className="text-sm"
            />
          </div>

          {/* Image reception */}
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Image Reception</Label>
              <p className="text-xs text-muted-foreground">
                Allow receiving images from Telegram as file attachments
              </p>
            </div>
            <Switch
              checked={settings.bridge_telegram_image_enabled === 'true'}
              onCheckedChange={() => toggleSetting('bridge_telegram_image_enabled')}
            />
          </div>

          {/* Streaming preview */}
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Streaming Preview</Label>
              <p className="text-xs text-muted-foreground">
                Show real-time streaming previews of AI responses in Telegram
              </p>
            </div>
            <Switch
              checked={settings.bridge_telegram_stream_enabled === 'true'}
              onCheckedChange={() => toggleSetting('bridge_telegram_stream_enabled')}
            />
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* Save button */}
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={handleSave} disabled={saving} size="sm" className="gap-2">
            {saving ? (
              <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <HugeiconsIcon icon={FloppyDiskIcon} className="h-3.5 w-3.5" />
            )}
            {saving ? 'Saving...' : 'Save Telegram Settings'}
          </Button>
          {saveSuccess && (
            <span className="text-sm text-green-600 dark:text-green-400">
              Settings saved successfully
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
