import { NextRequest, NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';

const BRIDGE_SETTINGS_KEYS = [
  'remote_bridge_enabled',
  'bridge_telegram_enabled',
  'bridge_auto_start',
  'bridge_default_work_dir',
  'bridge_default_model',
  'bridge_default_provider_id',
  'telegram_bot_token',
  'telegram_bridge_allowed_users',
  'bridge_telegram_image_enabled',
  'bridge_telegram_stream_enabled',
] as const;

const MASKED_KEYS = ['telegram_bot_token'] as const;

function maskValue(key: string, value: string): string {
  if ((MASKED_KEYS as readonly string[]).includes(key) && value.length > 4) {
    return '***' + value.slice(-4);
  }
  return value;
}

// GET /api/bridge/settings — get bridge-related settings
export async function GET() {
  try {
    const result: Record<string, string> = {};
    for (const key of BRIDGE_SETTINGS_KEYS) {
      const value = getSetting(key);
      if (value !== undefined) {
        result[key] = maskValue(key, value);
      }
    }
    return NextResponse.json({ settings: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read bridge settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PUT /api/bridge/settings — update bridge settings
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { settings } = body;

    if (!settings || typeof settings !== 'object') {
      return NextResponse.json({ error: 'Invalid settings data' }, { status: 400 });
    }

    const allowedSet = new Set<string>(BRIDGE_SETTINGS_KEYS);

    for (const [key, value] of Object.entries(settings)) {
      if (!allowedSet.has(key)) continue;

      const strValue = String(value ?? '').trim();

      // Don't overwrite token if user sent the masked version back
      if (key === 'telegram_bot_token' && strValue.startsWith('***')) {
        continue;
      }

      if (strValue) {
        setSetting(key, strValue);
      } else {
        // Empty value = clear the setting
        setSetting(key, '');
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save bridge settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
