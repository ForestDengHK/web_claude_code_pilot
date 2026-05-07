import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import {
  getProjectAdditionalDirectories,
  setProjectAdditionalDirectories,
} from '@/lib/db';

export async function GET(req: NextRequest) {
  const workingDirectory = req.nextUrl.searchParams.get('workingDirectory');
  if (!workingDirectory) {
    return NextResponse.json({ error: 'workingDirectory is required' }, { status: 400 });
  }
  const additionalDirectories = getProjectAdditionalDirectories(workingDirectory);
  return NextResponse.json({ workingDirectory, additionalDirectories });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { workingDirectory, additionalDirectories } = body ?? {};

    if (typeof workingDirectory !== 'string' || workingDirectory.length === 0) {
      return NextResponse.json({ error: 'workingDirectory is required' }, { status: 400 });
    }
    if (!Array.isArray(additionalDirectories)) {
      return NextResponse.json({ error: 'additionalDirectories must be an array' }, { status: 400 });
    }
    if (!additionalDirectories.every(p => typeof p === 'string')) {
      return NextResponse.json({ error: 'additionalDirectories must contain only strings' }, { status: 400 });
    }

    // Validate every entry is an existing directory
    for (const p of additionalDirectories) {
      try {
        const stat = await fs.stat(p);
        if (!stat.isDirectory()) {
          return NextResponse.json(
            { error: `Not a directory: ${p}`, code: 'NOT_A_DIRECTORY', path: p },
            { status: 400 },
          );
        }
      } catch {
        return NextResponse.json(
          { error: `Directory does not exist: ${p}`, code: 'INVALID_DIRECTORY', path: p },
          { status: 400 },
        );
      }
    }

    const stored = setProjectAdditionalDirectories(workingDirectory, additionalDirectories);
    return NextResponse.json({ workingDirectory, additionalDirectories: stored });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
