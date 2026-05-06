import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';
import { isMissingSortOrderError } from '@/lib/workspaces/queries';

const UpdateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
});

type RouteContext = {
  params: Promise<{ id: string }>;
};

type WorkspaceUpdateRow = {
  id: string;
  name: string;
  description: string | null;
  drive_folder_id: string;
  default_profile_id: string | null;
  sort_order?: number | null;
  created_at: string;
};

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const workspaceId = z.string().uuid().safeParse(id);
  if (!workspaceId.success) {
    return NextResponse.json({ error: 'Invalid workspace id' }, { status: 400 });
  }

  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = UpdateWorkspaceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = await supabase
    .from('workspaces')
    .update({ name: parsed.data.name.trim(), updated_at: new Date().toISOString() })
    .eq('id', workspaceId.data)
    .eq('owner_id', user.id)
    .select('id, name, description, drive_folder_id, default_profile_id, sort_order, created_at')
    .maybeSingle();
  let workspace = updated.data as WorkspaceUpdateRow | null;
  let error = updated.error;

  if (isMissingSortOrderError(error)) {
    const retry = await supabase
      .from('workspaces')
      .update({ name: parsed.data.name.trim(), updated_at: new Date().toISOString() })
      .eq('id', workspaceId.data)
      .eq('owner_id', user.id)
      .select('id, name, description, drive_folder_id, default_profile_id, created_at')
      .maybeSingle();
    workspace = retry.data as WorkspaceUpdateRow | null;
    error = retry.error;
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  return NextResponse.json({ workspace });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const workspaceId = z.string().uuid().safeParse(id);
  if (!workspaceId.success) {
    return NextResponse.json({ error: 'Invalid workspace id' }, { status: 400 });
  }

  const { user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminClient();
  const { data: workspace, error: lookupError } = await admin
    .from('workspaces')
    .select('id, drive_folder_id')
    .eq('id', workspaceId.data)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 });
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  try {
    const drive = await createDriveClientForUser(user.id);
    await drive.files.update({
      fileId: workspace.drive_folder_id,
      requestBody: { trashed: true },
      fields: 'id',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to trash Drive folder';
    const status = isGoogleDriveAuthError(error) ? 403 : 409;
    return NextResponse.json(
      {
        error: message,
      },
      { status },
    );
  }

  const { error: deleteError } = await admin
    .from('workspaces')
    .delete()
    .eq('id', workspace.id)
    .eq('owner_id', user.id);

  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
