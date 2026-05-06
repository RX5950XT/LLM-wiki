import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { initWorkspaceDrive } from '@/lib/drive/workspace-init';
import { ensureWorkspaceSystemPages } from '@/lib/drive/system-pages';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';

const CreateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
});

export async function POST(request: NextRequest) {
  const { user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = CreateWorkspaceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const admin = createAdminClient();

  try {
    const drive = await createDriveClientForUser(user.id);
    const workspaceId = crypto.randomUUID();

    const { driveFolderId } = await initWorkspaceDrive(drive, workspaceId);

    const { data: lastWorkspace } = await admin
      .from('workspaces')
      .select('sort_order')
      .eq('owner_id', user.id)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { error: workspaceError } = await admin.from('workspaces').insert({
      id: workspaceId,
      owner_id: user.id,
      name: parsed.data.name,
      drive_folder_id: driveFolderId,
      sort_order: (lastWorkspace?.sort_order ?? -1) + 1,
    });
    if (workspaceError) throw new Error(`Failed to create workspace record: ${workspaceError.message}`);

    await ensureWorkspaceSystemPages(drive, workspaceId, driveFolderId);

    // Auto-bind user's default LLM profile
    const { data: defaultProfile } = await admin
      .from('llm_profiles')
      .select('id')
      .eq('owner_id', user.id)
      .eq('is_default', true)
      .maybeSingle();

    if (defaultProfile) {
      const { error: bindError } = await admin
        .from('workspaces')
        .update({ default_profile_id: defaultProfile.id })
        .eq('id', workspaceId);
      if (bindError) throw new Error(`Failed to bind default profile: ${bindError.message}`);
    }

    return NextResponse.json({ id: workspaceId }, { status: 201 });
  } catch (err) {
    if (isGoogleDriveAuthError(err)) {
      return NextResponse.json(
        { error: err.message || GOOGLE_DRIVE_REAUTH_MESSAGE },
        { status: 403 },
      );
    }
    console.error('[POST /api/workspaces]', err);
    return NextResponse.json({ error: 'Failed to create workspace' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id, name, description, created_at, sort_order')
    .eq('owner_id', user.id)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ workspaces });
}
