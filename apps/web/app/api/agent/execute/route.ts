import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';
import { findFile } from '@/lib/drive/client';
import { deletePageForWorkspace } from '@/lib/ai/tools';
import { deleteWorkspaceForUser } from '@/lib/workspaces/manage';

/**
 * Execute a destructive action the AI proposed and the user confirmed.
 * Uses the same core functions as the AI tools, so confirmed parameters
 * can't diverge from what would have been executed directly.
 */
const ExecuteSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('delete_page'),
    workspace_id: z.string().uuid(),
    slug: z.string().min(1).max(500),
  }),
  z.object({
    action: z.literal('delete_workspace'),
    workspace_id: z.string().uuid(),
  }),
]);

export async function POST(request: NextRequest) {
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = ExecuteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const input = parsed.data;

  // Ownership check applies to both actions
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, drive_folder_id')
    .eq('id', input.workspace_id)
    .eq('owner_id', user.id)
    .maybeSingle();
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  let drive: Awaited<ReturnType<typeof createDriveClientForUser>>;
  try {
    drive = await createDriveClientForUser(user.id);
  } catch (error) {
    if (isGoogleDriveAuthError(error)) {
      return NextResponse.json(
        { error: error.message || GOOGLE_DRIVE_REAUTH_MESSAGE },
        { status: 403 },
      );
    }
    throw error;
  }

  try {
    if (input.action === 'delete_workspace') {
      const result = await deleteWorkspaceForUser(drive, user.id, input.workspace_id);
      if (!result.ok) {
        const status = result.error === 'Workspace not found' ? 404 : 500;
        return NextResponse.json({ error: result.error }, { status });
      }
      return NextResponse.json({ ok: true, action: input.action });
    }

    const wikiFolderId = await findFile(
      drive,
      'wiki',
      workspace.drive_folder_id,
      'application/vnd.google-apps.folder',
    );
    if (!wikiFolderId) {
      return NextResponse.json({ error: 'Wiki folder not found' }, { status: 500 });
    }

    const result = await deletePageForWorkspace(
      { supabase, drive },
      { workspaceId: input.workspace_id, wikiFolderId },
      input.slug,
    );
    if ('error' in result) {
      const message = result.error ?? 'Action failed';
      const status = message.startsWith('Page not found') ? 404 : 400;
      return NextResponse.json({ error: message }, { status });
    }
    return NextResponse.json({ ok: true, action: input.action, slug: result.slug });
  } catch (error) {
    console.error('[POST /api/agent/execute]', error);
    return NextResponse.json({ error: 'Action failed' }, { status: 500 });
  }
}
