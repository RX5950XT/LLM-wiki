import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { createClient } from '@/lib/supabase/server';

export default async function WorkspacesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const { data: workspaces } = await supabase
    .from('workspaces')
    .select('id, name')
    .order('created_at', { ascending: true });

  if (workspaces && workspaces.length > 0) {
    redirect(`/w/${workspaces[0]?.id ?? ''}`);
  }

  const t = await getTranslations('workspace');

  return (
    <div
      className="flex min-h-screen items-center justify-center"
      style={{ background: 'var(--bg)' }}
    >
      <div className="space-y-4 text-center">
        <p style={{ color: 'var(--fg-muted)' }}>{t('noWorkspaces')}</p>
        {/* TODO: create-workspace form (Phase 1 Week 1) */}
      </div>
    </div>
  );
}
