import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSkillFrontMatter } from './skill-front-matter';

export interface CodexSkillSymlinkInfo {
  /** Absolute path the skill directory symlink resolves to. */
  target: string;
  /** True when the target lives under ~/.claude/skills/. */
  claudeOwned: boolean;
}

export interface CodexSkillRead {
  name: string;
  description: string;
  /** Absolute path to SKILL.md. */
  path: string;
  /** Absolute path to the skill directory. */
  dir: string;
  scope: 'user' | 'repo' | 'system' | 'admin';
  content: string;
  symlinkInfo?: CodexSkillSymlinkInfo;
}

function codexSkillsRoot(): string {
  return path.join(os.homedir(), '.codex', 'skills');
}

function claudeSkillsRoot(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

/** Derive scope from a resolved skill directory path. */
function deriveScope(skillDir: string): CodexSkillRead['scope'] {
  const root = codexSkillsRoot();
  if (skillDir.startsWith(path.join(root, '.system') + path.sep)) return 'system';
  if (skillDir.startsWith(path.join(root, '.admin') + path.sep)) return 'admin';
  if (skillDir.startsWith(root + path.sep)) return 'user';
  // Anything else is conservative
  return 'user';
}

/** Resolve a symlinked skill directory and return info. Returns undefined for real dirs. */
export function detectSymlink(skillDir: string): CodexSkillSymlinkInfo | undefined {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(skillDir);
  } catch {
    return undefined;
  }
  if (!st.isSymbolicLink()) return undefined;

  // Fully resolved target (follows chains).
  let target: string;
  try {
    target = fs.realpathSync(skillDir);
  } catch {
    return undefined;
  }

  // Immediate readlink target — Codex symlinks often point at
  // ~/.claude/skills/<name> which is itself a symlink to ~/.agents/skills/<name>.
  // We treat the skill as "Claude-owned" if *any* hop in the chain lands under
  // ~/.claude/skills/, so editing on the Codex side doesn't quietly mutate
  // a file Claude considers its own.
  const claudeRoot = claudeSkillsRoot() + path.sep;
  let claudeOwned = target.startsWith(claudeRoot);
  if (!claudeOwned) {
    try {
      let cur = skillDir;
      // Walk symlink chain manually, up to a small depth to avoid loops.
      for (let i = 0; i < 8; i++) {
        const link = fs.readlinkSync(cur);
        const resolved = path.isAbsolute(link)
          ? link
          : path.resolve(path.dirname(cur), link);
        if (resolved.startsWith(claudeRoot)) {
          claudeOwned = true;
          break;
        }
        // Stop if next hop isn't itself a symlink
        let nextSt: fs.Stats;
        try {
          nextSt = fs.lstatSync(resolved);
        } catch {
          break;
        }
        if (!nextSt.isSymbolicLink()) break;
        cur = resolved;
      }
    } catch {
      // ignore
    }
  }

  return { target, claudeOwned };
}

/** Read a skill by name from ~/.codex/skills/<name>/SKILL.md. Falls back to
 *  ~/.codex/skills/.system/<name>/SKILL.md and .admin/<name> for read-only
 *  built-in skills. */
export function readSkill(name: string): CodexSkillRead | null {
  const root = codexSkillsRoot();
  const candidates = [
    path.join(root, name),
    path.join(root, '.system', name),
    path.join(root, '.admin', name),
  ];
  const dir = candidates.find((d) => fs.existsSync(path.join(d, 'SKILL.md')));
  if (!dir) return null;
  const filePath = path.join(dir, 'SKILL.md');

  const content = fs.readFileSync(filePath, 'utf-8');
  const fm = parseSkillFrontMatter(content);
  return {
    name: fm.name ?? name,
    description: fm.description ?? '',
    path: filePath,
    dir,
    scope: deriveScope(fs.realpathSync(dir)),
    content,
    symlinkInfo: detectSymlink(dir),
  };
}

/** Overwrite SKILL.md. Refuses to write to a Claude-owned symlink. */
export function writeSkill(
  name: string,
  content: string,
): { ok: true } | { ok: false; reason: string; code: number } {
  const dir = path.join(codexSkillsRoot(), name);
  const filePath = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'Skill not found', code: 404 };

  const sym = detectSymlink(dir);
  if (sym?.claudeOwned) {
    return { ok: false, reason: 'Claude-owned symlink. Edit via /api/skills.', code: 409 };
  }

  const scope = deriveScope(fs.realpathSync(dir));
  if (scope === 'system' || scope === 'admin') {
    return { ok: false, reason: `Codex ${scope} skills are read-only`, code: 403 };
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return { ok: true };
}

/**
 * Delete a skill. If it's a symlink, unlink only the link (don't touch target).
 * If it's a real directory, recursive delete of the whole skill dir.
 * Refuses system/admin.
 */
export function deleteSkill(
  name: string,
):
  | { ok: true; kind: 'symlink' | 'dir' }
  | { ok: false; reason: string; code: number } {
  const dir = path.join(codexSkillsRoot(), name);
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(dir);
  } catch {
    return { ok: false, reason: 'Skill not found', code: 404 };
  }

  const scope = deriveScope(fs.realpathSync(dir));
  if (scope === 'system' || scope === 'admin') {
    return { ok: false, reason: `Codex ${scope} skills are read-only`, code: 403 };
  }

  if (lst.isSymbolicLink()) {
    fs.unlinkSync(dir);
    return { ok: true, kind: 'symlink' };
  }
  if (lst.isDirectory()) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, kind: 'dir' };
  }
  return { ok: false, reason: 'Unexpected file type at skill path', code: 500 };
}

/** Create a new user-scope skill at ~/.codex/skills/<name>/SKILL.md. Never creates symlinks. */
export function createSkill(
  name: string,
  content: string,
): { ok: true; path: string } | { ok: false; reason: string; code: number } {
  // Validate name
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return { ok: false, reason: 'Name must be alphanumeric with _ and - only', code: 400 };
  }
  if (name.startsWith('.')) {
    return { ok: false, reason: 'Name cannot start with a dot', code: 400 };
  }

  const dir = path.join(codexSkillsRoot(), name);
  if (fs.existsSync(dir)) {
    return { ok: false, reason: 'A skill with this name already exists', code: 409 };
  }

  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'SKILL.md');
  fs.writeFileSync(filePath, content, 'utf-8');
  return { ok: true, path: filePath };
}
