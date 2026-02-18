import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

interface SkillFile {
  name: string;
  description: string;
  content: string;
  source: "global" | "project" | "plugin" | "installed";
  installedSource?: "agents" | "claude";
  filePath: string;
}

type InstalledSource = "agents" | "claude";
type InstalledSkill = SkillFile & { installedSource: InstalledSource; contentHash: string };

function getGlobalSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

function getProjectSkillsDir(cwd?: string): string {
  return path.join(cwd || process.cwd(), ".claude", "skills");
}

interface PluginCommandDir {
  dir: string;
  pluginName: string;
}

function getPluginCommandsDirs(): PluginCommandDir[] {
  const dirs: PluginCommandDir[] = [];
  const marketplacesDir = path.join(os.homedir(), ".claude", "plugins", "marketplaces");
  if (!fs.existsSync(marketplacesDir)) return dirs;

  try {
    // Scan marketplaces -> each marketplace -> plugins -> each plugin -> commands
    const marketplaces = fs.readdirSync(marketplacesDir);
    for (const marketplace of marketplaces) {
      const pluginsDir = path.join(marketplacesDir, marketplace, "plugins");
      if (!fs.existsSync(pluginsDir)) continue;
      const plugins = fs.readdirSync(pluginsDir);
      for (const plugin of plugins) {
        const commandsDir = path.join(pluginsDir, plugin, "commands");
        if (fs.existsSync(commandsDir)) {
          dirs.push({ dir: commandsDir, pluginName: plugin });
        }
      }
    }
  } catch {
    // ignore
  }
  return dirs;
}

/**
 * Scan the plugins cache directory for skills (SKILL.md) and commands (*.md).
 * Structure: cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
 * Structure: cache/<marketplace>/<plugin>/<version>/commands/*.md
 * Names are prefixed with plugin name: <plugin>:<skill-name>
 */
function scanCachedPlugins(): SkillFile[] {
  const skills: SkillFile[] = [];
  const cacheDir = path.join(os.homedir(), ".claude", "plugins", "cache");
  if (!fs.existsSync(cacheDir)) return skills;

  try {
    const marketplaces = fs.readdirSync(cacheDir, { withFileTypes: true });
    for (const mp of marketplaces) {
      if (!mp.isDirectory() || mp.name.startsWith(".")) continue;
      const mpDir = path.join(cacheDir, mp.name);

      let pluginEntries;
      try {
        pluginEntries = fs.readdirSync(mpDir, { withFileTypes: true });
      } catch { continue; }

      for (const plugin of pluginEntries) {
        if (!plugin.isDirectory() || plugin.name.startsWith(".")) continue;
        const pluginDir = path.join(mpDir, plugin.name);

        // Find latest version directory (sort alphabetically, take last)
        let versions;
        try {
          versions = fs.readdirSync(pluginDir, { withFileTypes: true })
            .filter(v => v.isDirectory() && !v.name.startsWith("."))
            .map(v => v.name)
            .sort();
        } catch { continue; }
        if (versions.length === 0) continue;

        const latestVersionDir = path.join(pluginDir, versions[versions.length - 1]);

        // Scan skills/ subdirectory (SKILL.md format)
        const skillsDir = path.join(latestVersionDir, "skills");
        if (fs.existsSync(skillsDir)) {
          try {
            const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
            for (const entry of skillEntries) {
              if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
              const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
              if (!fs.existsSync(skillMdPath)) continue;

              const content = fs.readFileSync(skillMdPath, "utf-8");
              const meta = parseSkillFrontMatter(content);
              const skillName = meta.name || entry.name;
              const fullName = `${plugin.name}:${skillName}`;
              const description = meta.description || `Plugin skill: /${fullName}`;

              skills.push({
                name: fullName,
                description,
                content,
                source: "plugin",
                filePath: skillMdPath,
              });
            }
          } catch {
            // ignore individual skill read errors
          }
        }

        // Scan commands/ subdirectory (*.md format)
        const commandsDir = path.join(latestVersionDir, "commands");
        if (fs.existsSync(commandsDir)) {
          skills.push(...scanDirectory(commandsDir, "plugin", plugin.name));
        }
      }
    }
  } catch {
    // ignore
  }

  return skills;
}

/**
 * Scan marketplace directories for plugin-level skills (SKILL.md).
 * Structure: marketplaces/<mp>/plugins/<plugin>/skills/<name>/SKILL.md
 */
function scanMarketplacePluginSkills(): SkillFile[] {
  const skills: SkillFile[] = [];
  const marketplacesDir = path.join(os.homedir(), ".claude", "plugins", "marketplaces");
  if (!fs.existsSync(marketplacesDir)) return skills;

  try {
    const marketplaces = fs.readdirSync(marketplacesDir, { withFileTypes: true });
    for (const mp of marketplaces) {
      if (!mp.isDirectory() || mp.name.startsWith(".")) continue;
      const pluginsDir = path.join(marketplacesDir, mp.name, "plugins");
      if (!fs.existsSync(pluginsDir)) continue;

      let plugins;
      try {
        plugins = fs.readdirSync(pluginsDir, { withFileTypes: true });
      } catch { continue; }

      for (const plugin of plugins) {
        if (!plugin.isDirectory() || plugin.name.startsWith(".")) continue;
        const pluginSkillsDir = path.join(pluginsDir, plugin.name, "skills");
        if (!fs.existsSync(pluginSkillsDir)) continue;

        try {
          const skillEntries = fs.readdirSync(pluginSkillsDir, { withFileTypes: true });
          for (const entry of skillEntries) {
            if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
            const skillMdPath = path.join(pluginSkillsDir, entry.name, "SKILL.md");
            if (!fs.existsSync(skillMdPath)) continue;

            const content = fs.readFileSync(skillMdPath, "utf-8");
            const meta = parseSkillFrontMatter(content);
            const skillName = meta.name || entry.name;
            const fullName = `${plugin.name}:${skillName}`;
            const description = meta.description || `Plugin skill: /${fullName}`;

            skills.push({
              name: fullName,
              description,
              content,
              source: "plugin",
              filePath: skillMdPath,
            });
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  return skills;
}

function getInstalledSkillsDir(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

function getClaudeSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

function computeContentHash(content: string): string {
  return crypto.createHash("sha1").update(content, "utf8").digest("hex");
}

/**
 * Parse YAML front matter from SKILL.md content.
 * Extracts `name` and `description` fields from the --- delimited block.
 */
function parseSkillFrontMatter(content: string): { name?: string; description?: string } {
  // Extract front matter between --- delimiters
  const fmMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (!fmMatch) return {};

  const frontMatter = fmMatch[1];
  const lines = frontMatter.split(/\r?\n/);
  const result: { name?: string; description?: string } = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match name: value
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch) {
      result.name = nameMatch[1].trim();
      continue;
    }

    // Match description: | (multi-line YAML block scalar) — check FIRST
    if (/^description:\s*\|/.test(line)) {
      const descLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+/.test(lines[j])) {
          descLines.push(lines[j].trim());
        } else {
          break;
        }
      }
      if (descLines.length > 0) {
        result.description = descLines.filter(Boolean).join(" ");
      }
      continue;
    }

    // Match description: value (single-line)
    const descMatch = line.match(/^description:\s+(.+)/);
    if (descMatch) {
      result.description = descMatch[1].trim();
    }
  }
  return result;
}

/**
 * Scan a directory for installed skills.
 * Each skill is a subdirectory containing a SKILL.md with YAML front matter.
 * Used for both ~/.agents/skills/ and ~/.claude/skills/.
 */
function scanInstalledSkills(
  dir: string,
  installedSource: InstalledSource
): InstalledSkill[] {
  const skills: InstalledSkill[] = [];
  if (!fs.existsSync(dir)) return skills;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillMdPath = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      const content = fs.readFileSync(skillMdPath, "utf-8");
      const meta = parseSkillFrontMatter(content);
      const name = meta.name || entry.name;
      const description = meta.description || `Installed skill: /${name}`;
      const contentHash = computeContentHash(content);

      skills.push({
        name,
        description,
        content,
        source: "installed",
        installedSource,
        contentHash,
        filePath: skillMdPath,
      });
    }
  } catch {
    // ignore read errors
  }
  return skills;
}

function resolveInstalledSkills(
  agentsSkills: InstalledSkill[],
  claudeSkills: InstalledSkill[],
  preferredSource: InstalledSource
): SkillFile[] {
  const all = [...agentsSkills, ...claudeSkills];
  const byName = new Map<string, InstalledSkill[]>();
  for (const skill of all) {
    const existing = byName.get(skill.name);
    if (existing) {
      existing.push(skill);
    } else {
      byName.set(skill.name, [skill]);
    }
  }

  const resolved: InstalledSkill[] = [];
  for (const group of byName.values()) {
    if (group.length === 1) {
      resolved.push(group[0]);
      continue;
    }

    const uniqueHashes = new Set(group.map((s) => s.contentHash));
    if (uniqueHashes.size === 1) {
      const preferred =
        group.find((s) => s.installedSource === preferredSource) || group[0];
      resolved.push(preferred);
      continue;
    }

    resolved.push(...group);
  }

  return resolved.map(({ contentHash: _contentHash, ...rest }) => rest);
}

function scanDirectory(
  dir: string,
  source: "global" | "project" | "plugin",
  prefix = ""
): SkillFile[] {
  const skills: SkillFile[] = [];
  if (!fs.existsSync(dir)) return skills;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recurse into subdirectories (e.g. ~/.claude/commands/review/pr.md)
        const subPrefix = prefix ? `${prefix}:${entry.name}` : entry.name;
        skills.push(...scanDirectory(fullPath, source, subPrefix));
        continue;
      }

      if (!entry.name.endsWith(".md")) continue;
      const baseName = entry.name.replace(/\.md$/, "");
      const name = prefix ? `${prefix}:${baseName}` : baseName;
      const filePath = fullPath;
      const content = fs.readFileSync(filePath, "utf-8");
      const firstLine = content.split("\n")[0]?.trim() || "";
      const description = firstLine.startsWith("#")
        ? firstLine.replace(/^#+\s*/, "")
        : firstLine || `Skill: /${name}`;
      skills.push({ name, description, content, source, filePath });
    }
  } catch {
    // ignore read errors
  }
  return skills;
}

export async function GET(request: NextRequest) {
  try {
    // Accept optional cwd query param for project-level skills
    const cwd = request.nextUrl.searchParams.get("cwd") || undefined;
    const globalDir = getGlobalSkillsDir();
    const projectDir = getProjectSkillsDir(cwd);

    console.log(`[skills] Scanning global: ${globalDir} (exists: ${fs.existsSync(globalDir)})`);
    console.log(`[skills] Scanning project: ${projectDir} (exists: ${fs.existsSync(projectDir)})`);
    console.log(`[skills] HOME=${process.env.HOME}, homedir=${os.homedir()}`);

    const globalSkills = scanDirectory(globalDir, "global");
    const projectSkills = scanDirectory(projectDir, "project");

    const agentsSkillsDir = getInstalledSkillsDir();
    const claudeSkillsDir = getClaudeSkillsDir();
    console.log(`[skills] Scanning installed: ${agentsSkillsDir} (exists: ${fs.existsSync(agentsSkillsDir)})`);
    console.log(`[skills] Scanning installed: ${claudeSkillsDir} (exists: ${fs.existsSync(claudeSkillsDir)})`);
    const agentsSkills = scanInstalledSkills(agentsSkillsDir, "agents");
    const claudeSkills = scanInstalledSkills(claudeSkillsDir, "claude");
    const preferredInstalledSource: InstalledSource =
      agentsSkills.length === claudeSkills.length
        ? "claude"
        : agentsSkills.length > claudeSkills.length
          ? "agents"
          : "claude";
    console.log(
      `[skills] Installed counts: agents=${agentsSkills.length}, claude=${claudeSkills.length}, preferred=${preferredInstalledSource}`
    );
    const installedSkills = resolveInstalledSkills(
      agentsSkills,
      claudeSkills,
      preferredInstalledSource
    );

    // Scan plugin skills from multiple sources
    const pluginSkills: SkillFile[] = [];

    // 1. Cached plugins (authoritative installed versions with correct prefixes)
    const cachedSkills = scanCachedPlugins();
    pluginSkills.push(...cachedSkills);

    // 2. Marketplace plugin commands (commands/*.md in marketplace plugins dir)
    for (const { dir, pluginName } of getPluginCommandsDirs()) {
      pluginSkills.push(...scanDirectory(dir, "plugin", pluginName));
    }

    // 3. Marketplace plugin-level skills (skills/<name>/SKILL.md in marketplace plugins dir)
    pluginSkills.push(...scanMarketplacePluginSkills());

    // De-duplicate by skill name (cache versions take priority since they're added first)
    const seen = new Set<string>();
    const dedupedPluginSkills: SkillFile[] = [];
    for (const skill of pluginSkills) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        dedupedPluginSkills.push(skill);
      }
    }

    const all = [...globalSkills, ...projectSkills, ...installedSkills, ...dedupedPluginSkills];
    console.log(`[skills] Found: global=${globalSkills.length}, project=${projectSkills.length}, installed=${installedSkills.length}, plugin=${dedupedPluginSkills.length} (cache=${cachedSkills.length})`);

    return NextResponse.json({ skills: all });
  } catch (error) {
    console.error('[skills] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load skills" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, content, scope, cwd } = body as {
      name: string;
      content: string;
      scope: "global" | "project";
      cwd?: string;
    };

    if (!name || typeof name !== "string") {
      return NextResponse.json(
        { error: "Skill name is required" },
        { status: 400 }
      );
    }

    // Sanitize name: only allow alphanumeric, hyphens, underscores
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!safeName) {
      return NextResponse.json(
        { error: "Invalid skill name" },
        { status: 400 }
      );
    }

    const dir =
      scope === "project" ? getProjectSkillsDir(cwd) : getGlobalSkillsDir();

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const filePath = path.join(dir, `${safeName}.md`);
    if (fs.existsSync(filePath)) {
      return NextResponse.json(
        { error: "A skill with this name already exists" },
        { status: 409 }
      );
    }

    fs.writeFileSync(filePath, content || "", "utf-8");

    const firstLine = (content || "").split("\n")[0]?.trim() || "";
    const description = firstLine.startsWith("#")
      ? firstLine.replace(/^#+\s*/, "")
      : firstLine || `Skill: /${safeName}`;

    return NextResponse.json(
      {
        skill: {
          name: safeName,
          description,
          content: content || "",
          source: scope || "global",
          filePath,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create skill" },
      { status: 500 }
    );
  }
}
