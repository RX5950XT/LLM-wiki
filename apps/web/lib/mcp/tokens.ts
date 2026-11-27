import { createHash, randomBytes } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Personal MCP tokens. `llmw_` + 32 random bytes: unguessable, so the lookup by
 * hash needs no rate limit; only the SHA-256 is stored, the token is shown once.
 */
const TOKEN_PREFIX = 'llmw_';
export const MAX_MCP_TOKENS = 20;
/** Skip the last_used_at write when it was stamped this recently. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

export function generateMcpToken(): { token: string; hash: string; prefix: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashMcpToken(token), prefix: token.slice(0, TOKEN_PREFIX.length + 6) };
}

export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function bearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];
  return token && token.startsWith(TOKEN_PREFIX) && token.length <= 200 ? token : null;
}

/** The owner of a live token, or null. */
export async function resolveMcpTokenOwner(token: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('mcp_tokens')
    .select('id, owner_id, last_used_at')
    .eq('token_hash', hashMcpToken(token))
    .maybeSingle();
  if (error) {
    console.error('[mcp] token lookup failed', error.message);
    return null;
  }
  if (!data) return null;
  const last = data.last_used_at ? Date.parse(data.last_used_at as string) : 0;
  if (Date.now() - last > TOUCH_INTERVAL_MS) {
    const { error: touchError } = await admin
      .from('mcp_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id);
    if (touchError) console.warn('[mcp] last_used_at update failed', touchError.message);
  }
  return data.owner_id as string;
}
