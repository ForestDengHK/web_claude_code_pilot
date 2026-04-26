import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import { join } from "path";

const execFileAsync = promisify(execFile);
const isMac = process.platform === "darwin";

interface ToolVersionInfo {
  name: string;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  source: "global-npm" | "local-npm" | "cli";
}

async function getVersion(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 10000 });
    return stdout.trim().replace(/[^0-9.]/g, "").replace(/^\.+|\.+$/g, "");
  } catch {
    return "unknown";
  }
}

async function getLatestNpmVersion(pkg: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("npm", ["info", pkg, "version"], {
      timeout: 15000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function getLatestBrewCaskVersion(cask: string): Promise<string | null> {
  if (!isMac) return null;
  try {
    // Refresh brew metadata first — `brew info --cask` reads from a local cache
    // that can lag the upstream cask repo by days. Without this, we'd happily
    // tell the user "you're on the latest" when there's actually a newer version.
    // Failure is non-fatal: fall through to `brew info` with whatever cache exists.
    try {
      await execFileAsync("brew", ["update", "--quiet"], { timeout: 30000 });
    } catch {
      // network down, brew misconfigured, etc. — keep going with stale cache.
    }
    const { stdout } = await execFileAsync("brew", ["info", "--cask", "--json=v2", cask], {
      timeout: 15000,
    });
    const info = JSON.parse(stdout);
    return info.casks?.[0]?.version || null;
  } catch {
    return null;
  }
}

/**
 * Get the latest Codex CLI version — try brew cask on macOS, fallback to npm.
 */
async function getLatestCodexVersion(): Promise<string | null> {
  const brewVersion = await getLatestBrewCaskVersion("codex");
  if (brewVersion) return brewVersion;
  // Fallback: check npm registry (works cross-platform)
  return getLatestNpmVersion("@openai/codex");
}

function getLocalSdkVersion(): string {
  try {
    const pkgPath = join(
      process.cwd(),
      "node_modules/@anthropic-ai/claude-agent-sdk/package.json"
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

export async function GET() {
  // Run all version checks in parallel
  const [claudeVersion, codexVersion, sdkVersion, latestClaude, latestCodex, latestSdk] =
    await Promise.all([
      getVersion("claude", ["--version"]),
      getVersion("codex", ["--version"]),
      Promise.resolve(getLocalSdkVersion()),
      getLatestNpmVersion("@anthropic-ai/claude-code"),
      getLatestCodexVersion(),
      getLatestNpmVersion("@anthropic-ai/claude-agent-sdk"),
    ]);

  const tools: ToolVersionInfo[] = [
    {
      name: "Claude Code CLI",
      current: claudeVersion,
      latest: latestClaude,
      updateAvailable: !!(latestClaude && claudeVersion !== "unknown" && latestClaude !== claudeVersion),
      source: "global-npm",
    },
    {
      name: "Codex CLI",
      current: codexVersion,
      latest: latestCodex,
      updateAvailable: !!(latestCodex && codexVersion !== "unknown" && latestCodex !== codexVersion),
      source: "cli",
    },
    {
      name: "Claude Agent SDK",
      current: sdkVersion,
      latest: latestSdk,
      updateAvailable: !!(latestSdk && sdkVersion !== "unknown" && latestSdk !== sdkVersion),
      source: "local-npm",
    },
  ];

  return NextResponse.json({ tools });
}

export async function POST(request: NextRequest) {
  const { tool } = await request.json();

  const commands: Record<string, { cmd: string; args: string[] }> = {
    "Claude Code CLI": { cmd: "npm", args: ["install", "-g", "@anthropic-ai/claude-code@latest"] },
    // macOS: prefer brew cask; Linux/Windows: use npm global install
    "Codex CLI": isMac
      ? { cmd: "brew", args: ["upgrade", "--cask", "codex"] }
      : { cmd: "npm", args: ["install", "-g", "@openai/codex@latest"] },
    "Claude Agent SDK": { cmd: "npm", args: ["install", "@anthropic-ai/claude-agent-sdk@latest"] },
  };

  const config = commands[tool];
  if (!config) {
    return NextResponse.json({ error: "Unknown tool" }, { status: 400 });
  }

  try {
    const cwd = config.cmd === "npm" && tool === "Claude Agent SDK" ? process.cwd() : undefined;
    const { stdout, stderr } = await execFileAsync(config.cmd, config.args, {
      timeout: 120000,
      cwd,
      env: { ...process.env, npm_config_loglevel: "warn" },
    });

    return NextResponse.json({
      success: true,
      output: stdout || stderr,
      needsRestart: tool === "Claude Agent SDK",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
