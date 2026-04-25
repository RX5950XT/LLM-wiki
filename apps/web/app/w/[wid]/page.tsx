import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

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
    .select('id, name, description')
    .eq('id', wid)
    .single();

  if (!workspace) redirect('/w');

  return (
    <div
      className="min-h-screen p-8"
      style={{ background: 'var(--bg)', color: 'var(--fg)' }}
    >
      <h1 className="text-xl font-semibold">{workspace.name}</h1>
      {workspace.description && (
        <p className="mt-1 text-sm" style={{ color: 'var(--fg-muted)' }}>
          {workspace.description}
        </p>
      )}
      {/* TODO: split-pane workspace layout (Phase 1 Week 3) */}
    </div>
  );
}
