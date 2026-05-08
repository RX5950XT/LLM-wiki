import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { ProfileList } from '@/components/settings/profile-list';
import { ProfileForm } from '@/components/settings/profile-form';
import { LocaleSwitcher } from '@/components/settings/locale-switcher';
import { RulesPanel } from '@/components/settings/rules-panel';
import { ThemeSwitcher } from '@/components/settings/theme-switcher';
import { fetchOrderedWorkspaces } from '@/lib/workspaces/queries';

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
    fetchOrderedWorkspaces(supabase, {
      select: 'id, sort_order, created_at',
      ownerId: user.id,
      limit: 1,
    }),
  ]);

  const backHref = workspaces && workspaces.length > 0 ? `/w/${workspaces[0]!.id}` : '/w';
  const workspaceId = workspaces?.[0]?.id;
  const { data: rulePages } = workspaceId
    ? await supabase
        .from('pages')
        .select('slug, title')
        .eq('workspace_id', workspaceId)
        .eq('zone', 'schema')
        .order('slug', { ascending: true })
    : { data: [] };
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

        {/* Profile */}
        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
            {t('settings.profile')}
          </h2>
          <div className="flex items-center gap-4">
            {user.user_metadata?.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.user_metadata.avatar_url as string}
                alt=""
                referrerPolicy="no-referrer"
                className="h-12 w-12 rounded-full"
              />
            ) : (
              <div
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-lg font-semibold"
                style={{ background: 'var(--color-accent-glow)', color: 'var(--color-accent)' }}
              >
                {((user.user_metadata?.full_name as string | undefined) ?? user.email ?? 'U').charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 space-y-0.5">
              {user.user_metadata?.full_name && (
                <p className="truncate text-sm font-medium">{user.user_metadata.full_name as string}</p>
              )}
              <p className="truncate text-sm" style={{ color: 'var(--fg-muted)' }}>{user.email}</p>
              <p className="truncate font-mono text-xs" style={{ color: 'var(--fg-muted)', opacity: 0.5 }}>{user.id}</p>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
            {t('settings.llmProfiles')}
          </h2>
          <ProfileList profiles={profiles ?? []} />
          <ProfileForm />
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
            {t('settings.theme')}
          </h2>
          <ThemeSwitcher />
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
            {t('settings.language')}
          </h2>
          <LocaleSwitcher />
        </section>

        {workspaceId && (
          <section className="space-y-4">
            <h2 className="text-sm font-medium uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
              {t('settings.rules')}
            </h2>
            <RulesPanel workspaceId={workspaceId} pages={rulePages ?? []} />
          </section>
        )}
      </div>
    </div>
  );
}
