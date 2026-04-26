import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { ProfileList } from '@/components/settings/profile-list';
import { ProfileForm } from '@/components/settings/profile-form';
import { LocaleSwitcher } from '@/components/settings/locale-switcher';

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: profiles }, { data: workspaces }] = await Promise.all([
    supabase
      .from('llm_profiles')
      .select('id, name, base_url, model, is_default, created_at')
      .eq('owner_id', user.id)
      .order('created_at', { ascending: true }),
    supabase
      .from('workspaces')
      .select('id')
      .eq('owner_id', user.id)
      .limit(1),
  ]);

  const backHref = workspaces && workspaces.length > 0 ? `/w/${workspaces[0]!.id}` : '/w';
  const t = await getTranslations();

  return (
    <div
      className="min-h-screen"
      style={{ background: 'var(--bg)', color: 'var(--fg)' }}
    >
      <div className="mx-auto max-w-2xl space-y-10 px-6 py-10">
        <div className="flex items-center gap-3">
          <Link
            href={backHref}
            className="flex items-center gap-1.5 text-sm transition-opacity hover:opacity-70"
            style={{ color: 'var(--fg-muted)' }}
          >
            <ArrowLeft size={15} />
            {t('settings.backToWorkspace')}
          </Link>
        </div>

        <h1 className="text-xl font-semibold">{t('settings.title')}</h1>

        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
            {t('settings.llmProfiles')}
          </h2>
          <ProfileList profiles={profiles ?? []} />
          <ProfileForm />
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
            {t('settings.language')}
          </h2>
          <LocaleSwitcher />
        </section>
      </div>
    </div>
  );
}
