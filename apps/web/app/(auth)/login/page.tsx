import { getTranslations } from 'next-intl/server';
import { LoginButton } from '@/components/auth/login-button';

export default async function LoginPage() {
  const t = await getTranslations('auth');

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
        <LoginButton label={t('signIn')} />
      </div>
    </div>
  );
}
