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

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, name')
    .eq('id', wid)
    .single();

  if (!workspace) redirect('/w');

  const { data: pages } = await supabase
    .from('pages')
    .select('slug, title, kind, zone')
    .eq('workspace_id', wid)
    .order('updated_at', { ascending: false })
    .limit(200);

  return (
    <WorkspaceShell
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      initialPages={pages ?? []}
    />
  );
}
