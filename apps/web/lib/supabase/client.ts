import { createBrowserClient } from '@supabase/ssr';

function getRequiredPublicEnv(name: string, value: string | undefined): string {
  const normalized = value?.trim().replace(/\\n/g, '');
  if (!normalized) {
    throw new Error(`Missing ${name} environment variable`);
  }
  return normalized;
}

export function createClient() {
  // NEXT_PUBLIC_* envs must be referenced statically so Next.js can inline them
  // into the browser bundle. Dynamic process.env[name] lookups are undefined.
  const supabaseUrl = getRequiredPublicEnv(
    'NEXT_PUBLIC_SUPABASE_URL',
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
  const supabaseAnonKey = getRequiredPublicEnv(
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

  return createBrowserClient(
    supabaseUrl,
    supabaseAnonKey,
  );
}
