import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createDriveClient, getAccessToken, readDriveFile } from '@/lib/drive/client';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; slug: string[] }> }
) {
  const { workspaceId, slug } = await params;
  const slugStr = slug.join('/');

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await supabase
    .from('pages')
    .select('slug, title, drive_file_id, updated_by, locked_by_human, version')
    .eq('workspace_id', workspaceId)
    .eq('slug', slugStr)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const admin = createAdminClient();
  const { data: userData } = await admin.auth.admin.getUserById(user.id);
  const refreshToken = userData?.user?.app_metadata?.google_refresh_token as string | undefined;
  if (!refreshToken) return NextResponse.json({ error: 'No Drive token' }, { status: 403 });

  const accessToken = await getAccessToken(refreshToken);
  const drive = createDriveClient(accessToken);
  const content = await readDriveFile(drive, page.drive_file_id);

  return NextResponse.json({ ...page, content });
}
