import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { createClient } from '@/lib/supabase/server';
import { ProfileList } from '@/components/settings/profile-list';
import { ProfileForm } from '@/components/settings/profile-form';
import { LocaleSwitcher } from '@/components/settings/locale-switcher';

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profiles } = await supabase
    .from('llm_profiles')
    .select('id, name, base_url, model, is_default, created_at')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: true });

  const t = await getTranslations('settings');

  return (
    <div
      className="min-h-screen"
      style={{ background: 'var(--bg)', color: 'var(--fg)' }}
    >
      <div className="mx-auto max-w-2xl space-y-10 px-6 py-10">
        <h1 className="text-xl font-semibold">{t('title')}</h1>

        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
            {t('llmProfiles')}
          </h2>
          <ProfileList profiles={profiles ?? []} />
          <ProfileForm />
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
            Language
          </h2>
          <LocaleSwitcher />
        </section>
      </div>
    </div>
  );
}
