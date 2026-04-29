import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createDriveClient } from '@/lib/drive/client';
import { initWorkspaceDrive } from '@/lib/drive/workspace-init';
import { getGoogleRefreshToken, saveGoogleRefreshToken } from '@/lib/google/oauth-token';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const rawNext = searchParams.get('next');
  // Accept only relative paths to prevent open-redirect
  const next = rawNext && /^\/[^/]/.test(rawNext) ? rawNext : null;

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

  const existingRefreshToken = await getGoogleRefreshToken(userId);
  const refreshToken = session.provider_refresh_token ?? existingRefreshToken;

  if (session.provider_refresh_token) {
    try {
      await saveGoogleRefreshToken(userId, session.provider_refresh_token);
    } catch (err) {
      console.error('[auth/callback] failed to store refresh token:', err);
      return NextResponse.redirect(`${origin}/login?error=token_save_failed`);
    }
  }

  if (!refreshToken) {
    return NextResponse.redirect(`${origin}/login?error=drive_access_required`);
  }

  // Check if user already has a workspace
  const { data: workspaces } = await admin
    .from('workspaces')
    .select('id')
    .eq('owner_id', userId)
    .limit(1);

  if (workspaces && workspaces.length > 0) {
    return NextResponse.redirect(`${origin}${next ?? `/w/${workspaces[0]?.id ?? ''}`}`);
  }

  // First login — auto-create default workspace + Drive folder structure
  if (!session.provider_token) {
    return NextResponse.redirect(`${origin}/w/create`);
  }

  try {
    const drive = createDriveClient(session.provider_token);
    const workspaceId = crypto.randomUUID();

    const { driveFolderId, pageFileIds } = await initWorkspaceDrive(drive, workspaceId);

    // Insert workspace
    const { error: workspaceError } = await admin.from('workspaces').insert({
      id: workspaceId,
      owner_id: userId,
      name: 'My Wiki',
      drive_folder_id: driveFolderId,
    });
    if (workspaceError) throw new Error(`Failed to create workspace record: ${workspaceError.message}`);

    // Insert seeded pages (index.md, log.md)
    const seedPages = Object.entries(pageFileIds).map(([slug, driveFileId]) => ({
      workspace_id: workspaceId,
      slug,
      kind: slug === 'index.md' ? 'index' : 'log',
      zone: 'wiki',
      drive_file_id: driveFileId,
      updated_by: 'llm',
    }));
    const { error: pagesError } = await admin.from('pages').insert(seedPages);
    if (pagesError) throw new Error(`Failed to create seed pages: ${pagesError.message}`);

    // Auto-bind user's default LLM profile
    const { data: defaultProfile } = await admin
      .from('llm_profiles')
      .select('id')
      .eq('owner_id', userId)
      .eq('is_default', true)
      .maybeSingle();

    if (defaultProfile) {
      const { error: bindError } = await admin
        .from('workspaces')
        .update({ default_profile_id: defaultProfile.id })
        .eq('id', workspaceId);
      if (bindError) throw new Error(`Failed to bind default profile: ${bindError.message}`);
    }

    return NextResponse.redirect(`${origin}/w/${workspaceId}`);
  } catch (err) {
    console.error('[auth/callback] workspace init failed:', err);
    // Fall back to manual create flow
    return NextResponse.redirect(`${origin}/w/create?error=init_failed`);
  }
}
