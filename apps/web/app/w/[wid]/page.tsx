import { redirect } from 'next/navigation';
import { createDriveClientForUser, isGoogleDriveAuthError } from '@/lib/google/drive-auth';
import { ensureWorkspaceSystemPages } from '@/lib/drive/system-pages';
import { createClient } from '@/lib/supabase/server';
import { fetchOrderedWorkspaces } from '@/lib/workspaces/queries';
import { WorkspaceShell } from './workspace-shell';

interface WorkspacePageProps {
  params: Promise<{ wid: string }>;
  searchParams: Promise<{ page?: string }>;
}

export default async function WorkspacePage({ params, searchParams }: WorkspacePageProps) {
  const { wid } = await params;
  const { page: initialPage } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const [{ data: workspace }, { data: workspaces }] = await Promise.all([
    supabase.from('workspaces').select('id, name').eq('id', wid).single(),
    fetchOrderedWorkspaces(supabase, {
      select: 'id, name, sort_order, created_at',
      ownerId: user.id,
    }),
  ]);

  if (!workspace) redirect('/w');

  const workspaceRootId = await supabase
    .from('workspaces')
    .select('drive_folder_id')
    .eq('id', wid)
    .single()
    .then(({ data }) => data?.drive_folder_id);

  if (workspaceRootId) {
    try {
      const drive = await createDriveClientForUser(user.id);
      await ensureWorkspaceSystemPages(drive, wid, workspaceRootId);
    } catch (error) {
      if (!isGoogleDriveAuthError(error)) throw error;
    }
  }

  const { data: pages } = await supabase
    .from('pages')
    .select('slug, title, kind, zone')
    .eq('workspace_id', wid)
    .order('updated_at', { ascending: false })
    .limit(200);

  const workspaceEntries = (workspaces ?? []).map((item) => ({
    id: item.id,
    name: item.name ?? 'Untitled',
    sort_order: item.sort_order ?? undefined,
  }));

  return (
    <WorkspaceShell
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      workspaces={workspaceEntries}
      initialPages={pages ?? []}
      initialPage={initialPage ?? 'index.md'}
    />
  );
}
