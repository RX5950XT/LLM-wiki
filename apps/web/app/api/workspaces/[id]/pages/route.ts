import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createDriveClientForUser, isGoogleDriveAuthError } from '@/lib/google/drive-auth';
import { ensureWorkspaceSystemPages } from '@/lib/drive/system-pages';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('drive_folder_id')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single();

  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  try {
    const drive = await createDriveClientForUser(user.id);
    await ensureWorkspaceSystemPages(drive, id, workspace.drive_folder_id);
  } catch (error) {
    if (!isGoogleDriveAuthError(error)) throw error;
  }

  const { data: pages, error } = await supabase
    .from('pages')
    .select('slug, title, kind, zone, updated_at')
    .eq('workspace_id', id)
    .order('updated_at', { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ pages });
}
