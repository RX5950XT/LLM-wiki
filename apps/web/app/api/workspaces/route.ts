import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createDriveClient, getAccessToken } from '@/lib/drive/client';
import { initWorkspaceDrive } from '@/lib/drive/workspace-init';
import { getGoogleRefreshToken } from '@/lib/google/oauth-token';

const CreateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = CreateWorkspaceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const admin = createAdminClient();

  const refreshToken = await getGoogleRefreshToken(user.id);
  if (!refreshToken) {
    return NextResponse.json(
      { error: 'Google Drive access not available. Please sign in again.' },
      { status: 403 }
    );
  }

  try {
    const accessToken = await getAccessToken(refreshToken);
    const drive = createDriveClient(accessToken);
    const workspaceId = crypto.randomUUID();

    const { driveFolderId, pageFileIds } = await initWorkspaceDrive(drive, workspaceId);

    await admin.from('workspaces').insert({
      id: workspaceId,
      owner_id: user.id,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      drive_folder_id: driveFolderId,
    });

    const seedPages = Object.entries(pageFileIds).map(([slug, driveFileId]) => ({
      workspace_id: workspaceId,
      slug,
      kind: slug === 'index.md' ? 'index' : 'log',
      zone: 'wiki',
      drive_file_id: driveFileId,
      updated_by: 'llm',
    }));
    await admin.from('pages').insert(seedPages);

    // Auto-bind user's default LLM profile
    const { data: defaultProfile } = await admin
      .from('llm_profiles')
      .select('id')
      .eq('owner_id', user.id)
      .eq('is_default', true)
      .single();

    if (defaultProfile) {
      await admin
        .from('workspaces')
        .update({ default_profile_id: defaultProfile.id })
        .eq('id', workspaceId);
    }

    return NextResponse.json({ id: workspaceId }, { status: 201 });
  } catch (err) {
    console.error('[POST /api/workspaces]', err);
    return NextResponse.json({ error: 'Failed to create workspace' }, { status: 500 });
  }
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id, name, description, created_at')
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ workspaces });
}
