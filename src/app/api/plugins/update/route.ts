import { NextRequest } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { findClaudeBinary } from '@/lib/platform';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

const PLUGIN_CACHE_DIR = path.join(os.homedir(), '.claude', 'plugins', 'cache');

interface PluginInfo {
  name: string;       // e.g. "superpowers@claude-plugins-official"
  version: string;
  scope: string;
  installPath?: string;
}

interface UpdateResult {
  name: string;
  oldVersion: string;
  newVersion: string | null;
  status: 'updated' | 'up-to-date' | 'error';
  message: string;
  cleaned?: number;  // number of orphaned dirs removed
}

/**
 * Read installed plugins from ~/.claude/plugins/installed_plugins.json
 */
function getInstalledPlugins(): PluginInfo[] {
  const installedPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(installedPath)) return [];

  try {
    const data = JSON.parse(fs.readFileSync(installedPath, 'utf-8'));
    if (!data.plugins || typeof data.plugins !== 'object') return [];

    const plugins: PluginInfo[] = [];
    for (const [key, entries] of Object.entries(data.plugins)) {
      const entry = Array.isArray(entries) ? entries[0] : entries;
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        plugins.push({
          name: key,
          version: (e.version as string) || 'unknown',
          scope: (e.scope as string) || 'user',
          installPath: (e.installPath as string) || undefined,
        });
      }
    }
    return plugins;
  } catch {
    return [];
  }
}

/**
 * Clean up orphaned version directories for a plugin after a successful update.
 *
 * The Claude CLI marks old versions with `.orphaned_at` but never deletes them.
 * This scans the plugin's cache directory and removes any version dirs that have
 * the `.orphaned_at` marker, keeping only the active version(s).
 *
 * Returns the number of directories removed.
 */
function cleanOrphanedVersions(pluginKey: string): number {
  // pluginKey is e.g. "superpowers@claude-plugins-official"
  // installPath is e.g. ~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7
  // We need to find the plugin dir: cache/<marketplace>/<plugin-name>/
  const [pluginName, marketplace] = pluginKey.split('@');
  if (!pluginName || !marketplace) return 0;

  const pluginDir = path.join(PLUGIN_CACHE_DIR, marketplace, pluginName);
  if (!fs.existsSync(pluginDir)) return 0;

  let cleaned = 0;
  try {
    const entries = fs.readdirSync(pluginDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const versionDir = path.join(pluginDir, entry.name);
      const orphanedMarker = path.join(versionDir, '.orphaned_at');
      if (fs.existsSync(orphanedMarker)) {
        try {
          fs.rmSync(versionDir, { recursive: true, force: true });
          cleaned++;
        } catch {
          // Ignore removal errors — directory may be in use
        }
      }
    }
  } catch {
    // Ignore scan errors
  }
  return cleaned;
}

/**
 * Clean up temp_git_* directories left by the Claude CLI during plugin installs.
 * These are temporary git clones that should have been cleaned up but weren't.
 */
function cleanTempGitDirs(): number {
  if (!fs.existsSync(PLUGIN_CACHE_DIR)) return 0;

  let cleaned = 0;
  try {
    const entries = fs.readdirSync(PLUGIN_CACHE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('temp_git_')) {
        try {
          fs.rmSync(path.join(PLUGIN_CACHE_DIR, entry.name), { recursive: true, force: true });
          cleaned++;
        } catch {
          // Ignore removal errors
        }
      }
    }
  } catch {
    // Ignore scan errors
  }
  return cleaned;
}

/**
 * GET /api/plugins/update
 *
 * List all installed plugins with their current versions.
 */
export async function GET() {
  const plugins = getInstalledPlugins();
  return Response.json({ plugins });
}

/**
 * POST /api/plugins/update
 * Body: { plugin?: string }
 *
 * Update plugins. If `plugin` is specified, update only that one.
 * If omitted, update all installed plugins.
 *
 * Each plugin update calls `claude plugin update <name>` non-interactively.
 * Results are streamed back as they complete.
 */
export async function POST(request: NextRequest) {
  const claudePath = findClaudeBinary();
  if (!claudePath) {
    return Response.json(
      { error: 'Claude CLI not found. Cannot update plugins.' },
      { status: 500 }
    );
  }

  let targetPlugin: string | undefined;
  try {
    const body = await request.json();
    targetPlugin = body.plugin;
  } catch {
    // No body = update all
  }

  const plugins = getInstalledPlugins();
  const toUpdate = targetPlugin
    ? plugins.filter(p => p.name === targetPlugin)
    : plugins;

  if (toUpdate.length === 0) {
    return Response.json(
      { error: targetPlugin ? `Plugin "${targetPlugin}" not found` : 'No plugins installed' },
      { status: 404 }
    );
  }

  const results: UpdateResult[] = [];

  for (const plugin of toUpdate) {
    try {
      const { stdout, stderr } = await execFileAsync(claudePath, ['plugin', 'update', plugin.name], {
        timeout: 30000,
        env: { ...process.env },
      });

      const output = stdout + stderr;

      if (output.includes('updated from')) {
        // Parse: Plugin "superpowers" updated from 5.0.2 to 5.0.5
        const match = output.match(/updated from (\S+) to (\S+)/);
        // Clean up orphaned versions left by the previous install
        const cleaned = cleanOrphanedVersions(plugin.name);
        results.push({
          name: plugin.name,
          oldVersion: plugin.version,
          newVersion: match ? match[2] : 'latest',
          status: 'updated',
          message: output.trim(),
          cleaned,
        });
      } else if (output.includes('already') || output.includes('up to date') || output.includes('up-to-date')) {
        // Even when up-to-date, clean any leftover orphans from previous updates
        const cleaned = cleanOrphanedVersions(plugin.name);
        results.push({
          name: plugin.name,
          oldVersion: plugin.version,
          newVersion: null,
          status: 'up-to-date',
          message: 'Already up to date',
          cleaned,
        });
      } else {
        results.push({
          name: plugin.name,
          oldVersion: plugin.version,
          newVersion: null,
          status: 'up-to-date',
          message: output.trim() || 'No changes',
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      results.push({
        name: plugin.name,
        oldVersion: plugin.version,
        newVersion: null,
        status: 'error',
        message: msg,
      });
    }
  }

  // Clean up stale temp_git_* directories from past installs
  const tempCleaned = cleanTempGitDirs();

  const updated = results.filter(r => r.status === 'updated').length;
  const errors = results.filter(r => r.status === 'error').length;
  const orphansCleaned = results.reduce((sum, r) => sum + (r.cleaned || 0), 0) + tempCleaned;

  return Response.json({
    summary: {
      total: results.length,
      updated,
      upToDate: results.length - updated - errors,
      errors,
      orphansCleaned,
    },
    results,
  });
}
