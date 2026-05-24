/**
 * Shared loaders for Claude Code configuration that both the T2 SDK route
 * (claude-client.ts) and the T1 channels route (session-manager.ts) need to
 * consume. Keeping this in one place stops the two backends from drifting:
 * if a new MCP source or plugin manifest format shows up, fixing it here
 * lights up both tiers at once.
 *
 * All functions are sync because they only touch local config files; an
 * async wrapper would just add latency without buying anything.
 */
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import type { MCPServerConfig } from '@/types';
import os from 'os';
import fs from 'fs';
import path from 'path';

/**
 * Read installed plugins from ~/.claude/plugins/installed_plugins.json and
 * the URL-plugin registry, filtered against `enabledPlugins` in
 * ~/.claude/settings.json.
 *
 * The SDK uses the directory basename as the plugin name. Install paths end
 * with a version hash (e.g. .../document-skills/69c0b1a06741), so we create
 * symlinks under `.codepilot-links/` with the correct plugin name. That way
 * skills register as "document-skills:pdf" instead of "69c0b1a06741:pdf".
 *
 * Returns SDK plugin configs; callers wanting just paths can use
 * `loadEnabledPluginPaths()`.
 */
export function loadEnabledPlugins(): SdkPluginConfig[] {
  try {
    const installedPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
    if (!fs.existsSync(installedPath)) return [];

    const data = JSON.parse(fs.readFileSync(installedPath, 'utf-8'));
    if (!data.plugins || typeof data.plugins !== 'object') return [];

    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let enabledPlugins: Record<string, boolean> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        enabledPlugins = settings.enabledPlugins || {};
      } catch { /* ignore */ }
    }

    const linksDir = path.join(os.homedir(), '.claude', 'plugins', '.codepilot-links');
    let linksDirReady = false;

    const plugins: SdkPluginConfig[] = [];
    for (const [pluginKey, entries] of Object.entries(data.plugins)) {
      if (!enabledPlugins[pluginKey]) continue;

      const entryList = entries as Array<{ installPath?: string }>;
      if (!Array.isArray(entryList) || entryList.length === 0) continue;

      const installPath = entryList[0].installPath;
      if (!installPath || !fs.existsSync(installPath)) continue;

      const pluginName = pluginKey.split('@')[0];
      const dirBasename = path.basename(installPath);

      if (dirBasename === pluginName) {
        plugins.push({ type: 'local', path: installPath });
        continue;
      }

      if (!linksDirReady) {
        if (!fs.existsSync(linksDir)) fs.mkdirSync(linksDir, { recursive: true });
        linksDirReady = true;
      }

      const linkPath = path.join(linksDir, pluginName);
      try {
        if (fs.existsSync(linkPath) || fs.lstatSync(linkPath).isSymbolicLink()) {
          const target = fs.readlinkSync(linkPath);
          if (target !== installPath) {
            fs.unlinkSync(linkPath);
            fs.symlinkSync(installPath, linkPath);
          }
        }
      } catch {
        try { fs.symlinkSync(installPath, linkPath); } catch { /* ignore */ }
      }

      plugins.push({
        type: 'local',
        path: fs.existsSync(linkPath) ? linkPath : installPath,
      });
    }

    // URL-installed plugins (codepilot-url-plugins.json) follow the same
    // basename-mismatch pattern, so reuse the symlink trick.
    try {
      const urlRegistryPath = path.join(os.homedir(), '.claude', 'plugins', 'codepilot-url-plugins.json');
      if (fs.existsSync(urlRegistryPath)) {
        const urlReg = JSON.parse(fs.readFileSync(urlRegistryPath, 'utf-8')) as {
          plugins?: Array<{ name?: string; installPath?: string }>;
        };
        for (const entry of urlReg.plugins || []) {
          if (!entry.installPath || !entry.name || !fs.existsSync(entry.installPath)) continue;

          if (path.basename(entry.installPath) === entry.name) {
            plugins.push({ type: 'local', path: entry.installPath });
            continue;
          }

          if (!linksDirReady) {
            if (!fs.existsSync(linksDir)) fs.mkdirSync(linksDir, { recursive: true });
            linksDirReady = true;
          }
          const linkPath = path.join(linksDir, entry.name);
          try {
            if (fs.existsSync(linkPath) || fs.lstatSync(linkPath).isSymbolicLink()) {
              const target = fs.readlinkSync(linkPath);
              if (target !== entry.installPath) {
                fs.unlinkSync(linkPath);
                fs.symlinkSync(entry.installPath, linkPath);
              }
            }
          } catch {
            try { fs.symlinkSync(entry.installPath, linkPath); } catch { /* ignore */ }
          }
          plugins.push({
            type: 'local',
            path: fs.existsSync(linkPath) ? linkPath : entry.installPath,
          });
        }
      }
    } catch { /* ignore URL plugin load errors */ }

    return plugins;
  } catch {
    return [];
  }
}

/**
 * Convenience wrapper for CLI-based callers (T1) that only need plugin
 * directory paths to pass as `--plugin-dir <path>` flags.
 */
export function loadEnabledPluginPaths(): string[] {
  return loadEnabledPlugins()
    .filter((p): p is SdkPluginConfig & { path: string } => 'path' in p && typeof p.path === 'string')
    .map((p) => p.path);
}

/**
 * Merge MCP server configs from all sources Claude Code looks at:
 *
 *   1. ~/.claude.json           (user-level)
 *   2. ~/.claude/settings.json  (user settings)
 *   3. {cwd}/.mcp.json          (project)
 *   4. {cwd}/.claude/settings.json
 *   5. {cwd}/.claude/settings.local.json (project local — wins)
 *
 * Returns an empty object if nothing is found. Caller is responsible for
 * folding in any in-process MCP servers (e.g. T1's codepilot reply MCP, T2's
 * spawn-subagents MCP).
 */
export function loadMergedMcpServers(workingDirectory?: string): Record<string, MCPServerConfig> {
  let merged: Record<string, MCPServerConfig> = {};
  try {
    const userConfigPath = path.join(os.homedir(), '.claude.json');
    const userSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(userConfigPath)) {
      try {
        const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
        if (userConfig.mcpServers) merged = { ...merged, ...userConfig.mcpServers };
      } catch { /* ignore */ }
    }
    if (fs.existsSync(userSettingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(userSettingsPath, 'utf-8'));
        if (settings.mcpServers) merged = { ...merged, ...settings.mcpServers };
      } catch { /* ignore */ }
    }
    if (workingDirectory) {
      const projectMcpPath = path.join(workingDirectory, '.mcp.json');
      if (fs.existsSync(projectMcpPath)) {
        try {
          const projectMcp = JSON.parse(fs.readFileSync(projectMcpPath, 'utf-8'));
          if (projectMcp.mcpServers) merged = { ...merged, ...projectMcp.mcpServers };
        } catch { /* ignore */ }
      }
      const projectSettingsPath = path.join(workingDirectory, '.claude', 'settings.json');
      if (fs.existsSync(projectSettingsPath)) {
        try {
          const projectSettings = JSON.parse(fs.readFileSync(projectSettingsPath, 'utf-8'));
          if (projectSettings.mcpServers) merged = { ...merged, ...projectSettings.mcpServers };
        } catch { /* ignore */ }
      }
      const projectLocalSettingsPath = path.join(workingDirectory, '.claude', 'settings.local.json');
      if (fs.existsSync(projectLocalSettingsPath)) {
        try {
          const projectLocalSettings = JSON.parse(fs.readFileSync(projectLocalSettingsPath, 'utf-8'));
          if (projectLocalSettings.mcpServers) merged = { ...merged, ...projectLocalSettings.mcpServers };
        } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore config read errors
  }
  return merged;
}
