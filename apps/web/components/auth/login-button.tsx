'use client';

import { createClient } from '@/lib/supabase/client';

interface LoginButtonProps {
  label: string;
}

export function LoginButton({ label }: LoginButtonProps) {
  const handleLogin = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        scopes: 'https://www.googleapis.com/auth/drive.file',
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    });
  };

  return (
    <button
      onClick={handleLogin}
      className="w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-all"
      style={{
        background: 'var(--color-accent)',
        color: 'oklch(10% 0.015 250)',
        transitionDuration: 'var(--transition-default)',
      }}
    >
      {label}
    </button>
  );
}
