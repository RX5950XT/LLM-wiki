import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { createClient } from '@/lib/supabase/server';
import { fetchOrderedWorkspaces } from '@/lib/workspaces/queries';

export default async function WorkspacesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const { data: workspaces } = await fetchOrderedWorkspaces(supabase, {
    select: 'id, name, sort_order, created_at',
  });

  if (workspaces && workspaces.length > 0) {
    redirect(`/w/${workspaces[0]?.id ?? ''}`);
  }

  const t = await getTranslations('workspace');

  return (
    <div
      className="flex min-h-screen items-center justify-center"
      style={{ background: 'var(--bg)' }}
    >
      <div className="space-y-6 text-center">
        <p className="text-sm" style={{ color: 'var(--fg-muted)' }}>{t('noWorkspaces')}</p>
        <Link
          href="/w/create"
          className="inline-block rounded-lg px-5 py-2.5 text-sm font-medium"
          style={{
            background: 'var(--color-accent)',
            color: 'oklch(10% 0.015 250)',
          }}
        >
          {t('create')}
        </Link>
      </div>
    </div>
  );
}
