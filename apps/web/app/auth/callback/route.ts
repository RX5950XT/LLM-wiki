import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createDriveClient } from '@/lib/drive/client';
import { initWorkspaceDrive } from '@/lib/drive/workspace-init';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.session) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  const { session } = data;
  const userId = session.user.id;
  const admin = createAdminClient();

  // Persist Google refresh token in app_metadata for server-side Drive access
  if (session.provider_refresh_token) {
    await admin.auth.admin.updateUserById(userId, {
      app_metadata: { google_refresh_token: session.provider_refresh_token },
    });
  }

  // Check if user already has a workspace
  const { data: workspaces } = await admin
    .from('workspaces')
    .select('id')
    .eq('owner_id', userId)
    .limit(1);

  if (workspaces && workspaces.length > 0) {
    return NextResponse.redirect(`${origin}/w/${workspaces[0]?.id ?? ''}`);
  }

  // First login — auto-create default workspace + Drive folder structure
  if (!session.provider_token) {
    // No access token available — redirect to create page to try again
    return NextResponse.redirect(`${origin}/w/create`);
  }

  try {
    const drive = createDriveClient(session.provider_token);
    const workspaceId = crypto.randomUUID();

    const { driveFolderId, pageFileIds } = await initWorkspaceDrive(drive, workspaceId);

    // Insert workspace
    await admin.from('workspaces').insert({
      id: workspaceId,
      owner_id: userId,
      name: 'My Wiki',
      drive_folder_id: driveFolderId,
    });

    // Insert seeded pages (index.md, log.md)
    const seedPages = Object.entries(pageFileIds).map(([slug, driveFileId]) => ({
      workspace_id: workspaceId,
      slug,
      kind: slug === 'index.md' ? 'index' : 'log',
      zone: 'wiki',
      drive_file_id: driveFileId,
      updated_by: 'llm',
    }));
    await admin.from('pages').insert(seedPages);

    return NextResponse.redirect(`${origin}/w/${workspaceId}`);
  } catch (err) {
    console.error('[auth/callback] workspace init failed:', err);
    // Fall back to manual create flow
    return NextResponse.redirect(`${origin}/w/create?error=init_failed`);
  }
}
