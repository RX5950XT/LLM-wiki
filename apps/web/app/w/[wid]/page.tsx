import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { WorkspaceShell } from './workspace-shell';

interface WorkspacePageProps {
  params: Promise<{ wid: string }>;
}

export default async function WorkspacePage({ params }: WorkspacePageProps) {
  const { wid } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const [{ data: workspace }, { data: workspaces }, { data: pages }] = await Promise.all([
    supabase.from('workspaces').select('id, name').eq('id', wid).single(),
    supabase
      .from('workspaces')
      .select('id, name')
      .eq('owner_id', user.id)
      .order('created_at', { ascending: true }),
    supabase
      .from('pages')
      .select('slug, title, kind, zone')
      .eq('workspace_id', wid)
      .order('updated_at', { ascending: false })
      .limit(200),
  ]);

  if (!workspace) redirect('/w');

  return (
    <WorkspaceShell
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      workspaces={workspaces ?? []}
      initialPages={pages ?? []}
    />
  );
}
