import { NextRequest, NextResponse } from 'next/server';
import { createDriveClientForUser } from '@/lib/google/drive-auth';
import { ensureWorkspaceSystemPages } from '@/lib/drive/system-pages';
import { getRequestUser } from '@/lib/supabase/request';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { supabase, user } = await getRequestUser(_request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: workspace, error } = await supabase
    .from('workspaces')
    .select('drive_folder_id')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const drive = await createDriveClientForUser(user.id);
  await ensureWorkspaceSystemPages(drive, id, workspace.drive_folder_id);
  return NextResponse.json({ ok: true });
}
