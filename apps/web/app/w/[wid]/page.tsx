import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { getLocale } from 'next-intl/server';
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
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const [{ data: workspace }, { data: workspaces }, { data: pages }] = await Promise.all([
    supabase.from('workspaces').select('id, name, drive_folder_id').eq('id', wid).single(),
    fetchOrderedWorkspaces(supabase, {
      select: 'id, name, sort_order, created_at',
      ownerId: user.id,
    }),
    supabase
      .from('pages')
      .select('slug, title, kind, zone, updated_at, version')
      .eq('workspace_id', wid)
      .order('updated_at', { ascending: false })
      .limit(2000),
  ]);

  if (!workspace) redirect('/w');

  const workspaceRootId = workspace.drive_folder_id;
  if (workspaceRootId) {
    // 防禦性補齊系統頁：移出請求路徑，避免每次導覽都同步打 Google Drive
    after(async () => {
      try {
        const drive = await createDriveClientForUser(user.id);
        await ensureWorkspaceSystemPages(drive, wid, workspaceRootId, locale);
      } catch (error) {
        if (!isGoogleDriveAuthError(error)) {
          console.warn('[workspace] system pages backfill skipped', error);
        }
      }
    });
  }

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
