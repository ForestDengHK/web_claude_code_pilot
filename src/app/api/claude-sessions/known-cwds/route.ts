import { listClaudeSessions } from '@/lib/claude-session-parser';
import { getAllWorkingDirectories } from '@/lib/db';

/**
 * Returns every cwd this server has seen — both CodePilot chat sessions and
 * Claude Code CLI sessions on disk. The upload-from-another-device flow uses
 * this to suggest a target cwd by basename match.
 */
export async function GET() {
  try {
    const codepilotCwds = getAllWorkingDirectories();
    const cliSessions = listClaudeSessions();
    const cliCwds = cliSessions.map(s => s.cwd).filter(Boolean);

    const seen = new Set<string>();
    const cwds: { cwd: string; basename: string }[] = [];

    for (const cwd of [...codepilotCwds, ...cliCwds]) {
      if (!cwd || seen.has(cwd)) continue;
      seen.add(cwd);
      const trimmed = cwd.replace(/[/\\]+$/, '');
      const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
      const basename = idx === -1 ? trimmed : trimmed.slice(idx + 1);
      cwds.push({ cwd, basename });
    }

    return Response.json({ cwds });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[GET /api/claude-sessions/known-cwds] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
