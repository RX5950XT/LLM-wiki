import { createClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@/lib/env';

/**
 * Service-role Supabase client — bypasses RLS.
 * Only use in server-only contexts (API routes, Server Actions).
 * Never expose to the client.
 */
export function createAdminClient() {
  const url = getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL');
  const key = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
