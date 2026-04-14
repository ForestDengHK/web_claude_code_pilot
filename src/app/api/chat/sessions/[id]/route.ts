import { NextRequest } from 'next/server';
import { deleteSession, getSession, updateSessionWorkingDirectory, updateSessionTitle, updateSessionModel, updateSessionMode, updateSessionSkipPermissions, clearSessionMessages, updateSessionBackend, updateSessionAdvisorModel, updateSessionGitBranch, updateSessionMemoryEnabled } from '@/lib/db';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }
    return Response.json({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get session';
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    const body = await request.json();

    if (body.working_directory) {
      updateSessionWorkingDirectory(id, body.working_directory);
    }
    if (body.title) {
      updateSessionTitle(id, body.title);
    }
    if (body.model) {
      updateSessionModel(id, body.model);
    }
    if (body.mode) {
      updateSessionMode(id, body.mode);
    }
    if (body.clear_messages) {
      clearSessionMessages(id);
    }
    if (body.skip_permissions !== undefined) {
      updateSessionSkipPermissions(id, !!body.skip_permissions);
    }
    if (body.backend) {
      updateSessionBackend(id, body.backend);
    }
    if (body.advisor_model !== undefined) {
      updateSessionAdvisorModel(id, body.advisor_model || null);
    }
    if (body.git_branch !== undefined) {
      updateSessionGitBranch(id, body.git_branch || null);
    }
    if (body.memory_enabled !== undefined) {
      updateSessionMemoryEnabled(id, body.memory_enabled === null ? null : !!body.memory_enabled);
    }

    const updated = getSession(id);
    return Response.json({ session: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update session';
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    deleteSession(id);
    return Response.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete session';
    return Response.json({ error: message }, { status: 500 });
  }
}
