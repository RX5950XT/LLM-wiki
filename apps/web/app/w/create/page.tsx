import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { CreateWorkspaceForm } from '@/components/workspace/create-form';

export default async function CreateWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { error } = await searchParams;
  const t = await getTranslations('workspace');
  const tc = await getTranslations('common');

  return (
    <div
      className="flex min-h-screen items-center justify-center"
      style={{ background: 'var(--bg)' }}
    >
      <div className="w-full max-w-md space-y-6 px-6">
        <Link
          href="/w"
          className="inline-flex items-center gap-1.5 text-sm transition-opacity hover:opacity-70"
          style={{ color: 'var(--fg-muted)' }}
        >
          <ArrowLeft size={15} />
          {tc('back')}
        </Link>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold" style={{ color: 'var(--fg)' }}>
            {t('create')}
          </h1>
          {error === 'init_failed' && (
            <p className="text-sm" style={{ color: 'oklch(65% 0.18 30)' }}>
              {t('initFailed')}
            </p>
          )}
        </div>
        <CreateWorkspaceForm />
      </div>
    </div>
  );
}
