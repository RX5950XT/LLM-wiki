import { createAdminClient } from '@/lib/supabase/admin';
import { decryptApiKey, encryptApiKey } from '@/lib/crypto/api-key';

export async function saveGoogleRefreshToken(userId: string, refreshToken: string): Promise<void> {
  const admin = createAdminClient();
  const encrypted = encryptApiKey(refreshToken);
  const { error } = await admin
    .from('google_oauth_tokens')
    .upsert({ user_id: userId, refresh_token_encrypted: encrypted });

  if (error) throw new Error(`Failed to save Google refresh token: ${error.message}`);
}

export async function getGoogleRefreshToken(userId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('google_oauth_tokens')
    .select('refresh_token_encrypted')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load Google refresh token: ${error.message}`);
  if (!data?.refresh_token_encrypted) return null;

  return decryptApiKey(data.refresh_token_encrypted);
}
