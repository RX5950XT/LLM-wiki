import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The owner's default LLM profile.
 *
 * Workspaces routinely carry no `*_profile_id` at all — nothing binds one when a
 * profile is created after the workspace — so any route that resolves a model must
 * fall back to this. Every route that forgot 422'd "No LLM profile configured" on a
 * perfectly valid request (/api/ingest, /api/query and /api/sources/[id]/reingest
 * each shipped that bug separately).
 */
export async function loadDefaultProfileId(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('llm_profiles')
    .select('id')
    .eq('owner_id', userId)
    .eq('is_default', true)
    .maybeSingle();
  return data?.id ?? null;
}
