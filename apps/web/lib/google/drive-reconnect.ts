'use client';

import { createClient } from '@/lib/supabase/client';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export function isDriveReconnectError(message: string): boolean {
  return /google drive|drive token|drive access/i.test(message);
}

export async function reconnectGoogleDrive(nextPath: string): Promise<void> {
  const supabase = createClient();
  const safeNext = nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : '/w';
  const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(safeNext)}`;

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      scopes: DRIVE_SCOPE,
      queryParams: { access_type: 'offline', prompt: 'consent' },
    },
  });

  if (error) throw error;
}
