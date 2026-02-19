import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type {
  MCPServerConfig,
  MCPConfigResponse,
  ErrorResponse,
  SuccessResponse,
} from '@/types';
import { getAllWorkingDirectories } from '@/lib/db';

function getSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

// ~/.claude.json — Claude CLI stores user-scoped MCP servers here
function getUserConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * Discover project directories from multiple sources so we find all .mcp.json files.
 * Sources:
 *  - Chat sessions in the CodePilot database
 *  - ~/.claude/projects/ directory names (Claude Code encodes paths as dir names)
 */
function discoverProjectDirs(): string[] {
  const seen = new Set<string>();

  // 1. From database sessions
  for (const dir of getAllWorkingDirectories()) {
    seen.add(dir);
  }

  // 2. From ~/.claude/projects/ — dir names like "-Users-party-working-boi" → "/Users/party/working/boi"
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('-')) {
        const realPath = entry.name.replace(/-/g, path.sep);
        if (fs.existsSync(realPath)) {
          seen.add(realPath);
        }
      }
    }
  } catch {
    // ~/.claude/projects/ may not exist
  }

  return Array.from(seen);
}

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function readSettings(): Record<string, unknown> {
  return readJsonFile(getSettingsPath());
}

function writeSettings(settings: Record<string, unknown>): void {
  const settingsPath = getSettingsPath();
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

export async function GET(request: NextRequest): Promise<NextResponse<MCPConfigResponse | ErrorResponse>> {
  try {
    const userConfig = readJsonFile(getUserConfigPath());
    const settings = readSettings();

    // Merge order (later overrides earlier):
    // 1. ~/.claude.json
    // 2. ~/.claude/settings.json
    // 3. {dir}/.mcp.json (project MCP config)
    // 4. {dir}/.claude/settings.json (project settings)
    // 5. {dir}/.claude/settings.local.json (project local settings)
    const mcpServers: Record<string, MCPServerConfig> = {
      ...((userConfig.mcpServers || {}) as Record<string, MCPServerConfig>),
      ...((settings.mcpServers || {}) as Record<string, MCPServerConfig>),
    };

    // Use explicit dir param, or discover project directories from:
    // 1. Chat sessions in the database
    // 2. ~/.claude/projects/ (Claude Code per-project config dirs encode real paths)
    const explicitDir = request.nextUrl.searchParams.get('dir');
    const dirs = explicitDir ? [explicitDir] : discoverProjectDirs();
    for (const dir of dirs) {
      // Project-level .mcp.json
      const projectMcpJson = readJsonFile(path.join(dir, '.mcp.json'));
      if (projectMcpJson.mcpServers) {
        Object.assign(mcpServers, projectMcpJson.mcpServers as Record<string, MCPServerConfig>);
      }
      // Project-level .claude/settings.json
      const projectSettings = readJsonFile(path.join(dir, '.claude', 'settings.json'));
      if (projectSettings.mcpServers) {
        Object.assign(mcpServers, projectSettings.mcpServers as Record<string, MCPServerConfig>);
      }
      // Project-level .claude/settings.local.json
      const projectLocalSettings = readJsonFile(path.join(dir, '.claude', 'settings.local.json'));
      if (projectLocalSettings.mcpServers) {
        Object.assign(mcpServers, projectLocalSettings.mcpServers as Record<string, MCPServerConfig>);
      }
    }

    return NextResponse.json({ mcpServers });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read MCP config' },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest
): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  try {
    const body = await request.json();
    const { mcpServers } = body as { mcpServers: Record<string, MCPServerConfig> };

    const settings = readSettings();
    settings.mcpServers = mcpServers;
    writeSettings(settings);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update MCP config' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest
): Promise<NextResponse<SuccessResponse | ErrorResponse>> {
  try {
    const body = await request.json();
    const { name, server } = body as { name: string; server: MCPServerConfig };

    if (!name || !server || !server.command) {
      return NextResponse.json(
        { error: 'Name and server command are required' },
        { status: 400 }
      );
    }

    const settings = readSettings();
    if (!settings.mcpServers) {
      settings.mcpServers = {};
    }

    const mcpServers = settings.mcpServers as Record<string, MCPServerConfig>;
    if (mcpServers[name]) {
      return NextResponse.json(
        { error: `MCP server "${name}" already exists` },
        { status: 409 }
      );
    }

    mcpServers[name] = server;
    writeSettings(settings);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add MCP server' },
      { status: 500 }
    );
  }
}
