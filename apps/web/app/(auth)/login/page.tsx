import { getTranslations } from 'next-intl/server';
import { LoginButton } from '@/components/auth/login-button';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const t = await getTranslations('auth');
  const { error } = await searchParams;

  return (
    <div
      className="flex min-h-screen items-center justify-center"
      style={{ background: 'var(--bg)' }}
    >
      <div className="w-full max-w-sm space-y-8 px-6">
        <div className="space-y-2 text-center">
          <h1
            className="text-2xl font-semibold tracking-tight"
            style={{ color: 'var(--fg)' }}
          >
            {t('welcome')}
          </h1>
          <p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
            {t('description')}
          </p>
        </div>
        {error === 'drive_access_required' && (
          <p className="text-sm" style={{ color: 'oklch(65% 0.18 30)' }}>
            {t('driveAccessRequired')}
          </p>
        )}
        {error === 'token_save_failed' && (
          <p className="text-sm" style={{ color: 'oklch(65% 0.18 30)' }}>
            Server configuration error: ENCRYPTION_KEY may be missing or invalid. Check your environment variables.
          </p>
        )}
        <LoginButton label={t('signIn')} />
      </div>
    </div>
  );
}
