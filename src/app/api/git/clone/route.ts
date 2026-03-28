import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { stat } from 'fs/promises';
import path from 'path';
import os from 'os';
import { getSetting } from '@/lib/db';

const DEFAULT_BASE_DIR = path.join(os.homedir(), 'working');
const DEFAULT_GIT_HOST = 'https://github.com';
const CLONE_TIMEOUT_MS = 120_000;

function extractRepoName(url: string, gitHost: string = DEFAULT_GIT_HOST): { name: string; cloneUrl: string } | null {
  const trimmed = url.trim();

  // Shorthand: user/repo — uses configurable git host
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    const name = trimmed.split('/')[1];
    const host = gitHost.replace(/\/+$/, '');
    return { name, cloneUrl: `${host}/${trimmed}` };
  }

  // SSH: git@github.com:user/repo.git
  const sshMatch = trimmed.match(/git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { name: sshMatch[2], cloneUrl: trimmed };
  }

  // HTTPS URL
  try {
    const u = new URL(trimmed);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return { name: parts[parts.length - 1].replace(/\.git$/, ''), cloneUrl: trimmed };
    }
  } catch { /* not a URL */ }

  return null;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function isGitRepo(p: string): Promise<boolean> {
  return dirExists(path.join(p, '.git'));
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url } = body;

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid URL' }, { status: 400 });
    }

    const baseDir = getSetting('clone_base_directory') || DEFAULT_BASE_DIR;
    const gitHost = getSetting('default_git_host') || DEFAULT_GIT_HOST;

    const parsed = extractRepoName(url, gitHost);
    if (!parsed) {
      return NextResponse.json({ error: 'Could not parse repository URL' }, { status: 400 });
    }
    const targetDir = path.join(baseDir, parsed.name);

    // Check if target already exists
    if (await dirExists(targetDir)) {
      if (await isGitRepo(targetDir)) {
        return NextResponse.json({ path: targetDir, alreadyExists: true });
      }
      return NextResponse.json(
        { error: `Directory "${parsed.name}" exists but is not a git repo` },
        { status: 409 },
      );
    }

    // Ensure base directory exists
    if (!(await dirExists(baseDir))) {
      return NextResponse.json(
        { error: `Base directory does not exist: ${baseDir}` },
        { status: 400 },
      );
    }

    // Clone the repo
    const clonedPath = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'git',
        ['clone', parsed.cloneUrl, targetDir],
        { timeout: CLONE_TIMEOUT_MS },
        (error, _stdout, stderr) => {
          if (error) {
            // Clean up stderr for a nicer message
            const msg = stderr?.trim() || error.message;
            reject(new Error(msg));
          } else {
            resolve(targetDir);
          }
        },
      );
      // Kill on timeout
      child.on('error', reject);
    });

    return NextResponse.json({ path: clonedPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Clone failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
