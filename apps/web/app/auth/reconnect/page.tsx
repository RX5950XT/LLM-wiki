'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export default function DriveReconnectPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = new URLSearchParams(window.location.search).get('next');
    const redirectTo = next
      ? `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`
      : `${window.location.origin}/auth/callback`;

    const reconnect = async () => {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          scopes: DRIVE_SCOPE,
          queryParams: { access_type: 'offline', prompt: 'consent' },
        },
      });

      if (authError) {
        setError(authError.message);
      }
    };

    void reconnect();
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center px-6 text-center">
      <div className="space-y-3">
        <h1 className="text-lg font-semibold">Reconnecting Google Drive</h1>
        <p className="text-sm text-neutral-500">
          {error ?? 'Redirecting to Google sign-in...'}
        </p>
      </div>
    </main>
  );
}
