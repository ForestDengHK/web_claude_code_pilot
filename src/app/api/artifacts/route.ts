import { NextRequest, NextResponse } from 'next/server';
import { listArtifacts } from '@/lib/artifacts';

// List artifacts for a project (the working directory is the project key).
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('projectId') ?? '';
  return NextResponse.json({ artifacts: listArtifacts(projectId) });
}
