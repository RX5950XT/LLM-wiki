import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { decryptApiKey, encryptApiKey } from '@/lib/crypto/api-key';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * "Sign in with Grok": the OAuth client the Grok CLI uses (`grok login --device-auth`),
 * so requests are billed to the user's SuperGrok / X Premium plan instead of an API key.
 * auth.x.ai is a standard OIDC issuer with RFC 8628 device codes; inference goes to the
 * CLI's chat proxy, which speaks OpenAI chat completions (tool calls included) but
 * refuses requests without a recent client version header (426).
 */
export const GROK_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const ISSUER = 'https://auth.x.ai';
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPES = 'openid profile email offline_access grok-cli:access api:access';
/** The proxy rejects clients older than its minimum; bump this when it answers 426. */
const GROK_CLIENT_VERSION = '1.0.92';
const AUTH_TIMEOUT_MS = 20_000;
const REFRESH_SKEW_MS = 5 * 60_000;

export interface GrokTokens {
  access_token: string;
  refresh_token: string;
  /** epoch ms */
  expires_at: number;
  email?: string;
}

export interface GrokDeviceCode {
  device_code: string;
  user_code: string;
  interval: number;
  verification_url: string;
}

export class GrokAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrokAuthError';
  }
}

export function isGrokProfile(profile: { base_url: string }): boolean {
  return profile.base_url.replace(/\/+$/, '') === GROK_BASE_URL;
}

function decodeJwtPayload(jwt: string | undefined): Record<string, unknown> {
  const part = jwt?.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Turn an /oauth2/token response into stored tokens; `previous` covers fields a refresh may omit. */
export function grokTokensFromResponse(json: unknown, previous?: GrokTokens): GrokTokens {
  const body = (json ?? {}) as Record<string, unknown>;
  const access = typeof body.access_token === 'string' ? body.access_token : '';
  if (!access) throw new GrokAuthError('Grok sign-in returned no access token');
  const refresh = typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refresh_token;
  if (!refresh) throw new GrokAuthError('Grok sign-in returned no refresh token');
  const exp = decodeJwtPayload(access).exp;
  const expiresAt =
    typeof body.expires_in === 'number'
      ? Date.now() + body.expires_in * 1000
      : typeof exp === 'number'
        ? exp * 1000
        : Date.now() + 60 * 60_000;
  const idEmail = decodeJwtPayload(typeof body.id_token === 'string' ? body.id_token : undefined).email;
  const email = typeof idEmail === 'string' && idEmail ? idEmail : previous?.email;
  return { access_token: access, refresh_token: refresh, expires_at: expiresAt, ...(email ? { email } : {}) };
}

async function tokenPost(params: Record<string, string>): Promise<Response> {
  return fetch(`${ISSUER}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString(),
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });
}

export async function requestGrokDeviceCode(): Promise<GrokDeviceCode> {
  const res = await fetch(`${ISSUER}/oauth2/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES }).toString(),
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });
  if (!res.ok) throw new GrokAuthError(`Grok device login unavailable (${res.status})`);
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.device_code !== 'string' || typeof json.user_code !== 'string') {
    throw new GrokAuthError('Grok device login returned an unexpected response');
  }
  const interval = Number(json.interval ?? 5);
  const url =
    typeof json.verification_uri_complete === 'string'
      ? json.verification_uri_complete
      : typeof json.verification_uri === 'string'
        ? json.verification_uri
        : 'https://accounts.x.ai/oauth2/device';
  return {
    device_code: json.device_code,
    user_code: json.user_code,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
    verification_url: url,
  };
}

/** One poll. `null` = the user has not finished signing in yet (RFC 8628 pending / slow_down). */
export async function pollGrokDeviceCode(deviceCode: string): Promise<GrokTokens | null> {
  const res = await tokenPost({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) {
    const tokens = grokTokensFromResponse(json);
    return tokens.email ? tokens : { ...tokens, ...(await userinfoEmail(tokens.access_token)) };
  }
  const code = typeof json.error === 'string' ? json.error : '';
  if (code === 'authorization_pending' || code === 'slow_down') return null;
  if (code === 'expired_token') throw new GrokAuthError('Grok sign-in code expired. Start again.');
  if (code === 'access_denied') throw new GrokAuthError('Grok sign-in was declined.');
  throw new GrokAuthError(`Grok device login failed (${res.status}${code ? ` ${code}` : ''})`);
}

/** Only when the token response carried no id token email; failure just leaves it unknown. */
async function userinfoEmail(accessToken: string): Promise<{ email?: string }> {
  try {
    const res = await fetch(`${ISSUER}/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    const json = res.ok ? ((await res.json()) as { email?: unknown }) : {};
    return typeof json.email === 'string' && json.email ? { email: json.email } : {};
  } catch {
    return {};
  }
}

async function refreshGrokTokens(previous: GrokTokens): Promise<GrokTokens> {
  const res = await tokenPost({ grant_type: 'refresh_token', refresh_token: previous.refresh_token });
  if (!res.ok) throw new GrokAuthError(`Grok sign-in expired (${res.status}). Sign in with Grok again in Settings.`);
  return grokTokensFromResponse(await res.json(), previous);
}

export function encryptGrokTokens(tokens: GrokTokens): string {
  return encryptApiKey(JSON.stringify(tokens));
}

function decryptGrokTokens(ciphertext: string): GrokTokens {
  const parsed = JSON.parse(decryptApiKey(ciphertext)) as Partial<GrokTokens>;
  if (!parsed.access_token || !parsed.refresh_token) {
    throw new GrokAuthError('Stored Grok sign-in is invalid. Sign in with Grok again in Settings.');
  }
  return { expires_at: 0, ...parsed } as GrokTokens;
}

export function grokHeaders(tokens: GrokTokens): Record<string, string> {
  return {
    Authorization: `Bearer ${tokens.access_token}`,
    'x-grok-client-version': GROK_CLIENT_VERSION,
    'x-grok-client-identifier': 'xai-grok-cli',
  };
}

/** Model ids the signed-in plan may use, in the proxy's order; empty when unreachable. */
export async function listGrokModels(tokens: GrokTokens): Promise<string[]> {
  try {
    const res = await fetch(`${GROK_BASE_URL}/models`, {
      headers: grokHeaders(tokens),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { id?: unknown }[] };
    return (json.data ?? []).filter((m) => typeof m.id === 'string').map((m) => m.id as string);
  } catch {
    return [];
  }
}

/** Per-instance in-flight refresh, so concurrent requests do not burn a rotating refresh token twice. */
const refreshing = new Map<string, Promise<GrokTokens>>();

async function freshGrokTokens(profileId: string, current: GrokTokens): Promise<GrokTokens> {
  if (current.expires_at - REFRESH_SKEW_MS > Date.now()) return current;
  const pending = refreshing.get(profileId);
  if (pending) return pending;
  const run = (async () => {
    const admin = createAdminClient();
    // Another instance may already have rotated the refresh token.
    const { data } = await admin.from('llm_profiles').select('api_key_encrypted').eq('id', profileId).maybeSingle();
    const stored = data?.api_key_encrypted ? decryptGrokTokens(data.api_key_encrypted as string) : current;
    if (stored.expires_at - REFRESH_SKEW_MS > Date.now()) return stored;
    const next = await refreshGrokTokens(stored);
    const { error } = await admin.from('llm_profiles').update({ api_key_encrypted: encryptGrokTokens(next) }).eq('id', profileId);
    if (error) console.error('[grok] failed to persist refreshed token', { profileId, message: error.message });
    return next;
  })().finally(() => refreshing.delete(profileId));
  refreshing.set(profileId, run);
  return run;
}

export interface GrokAccount {
  email: string | null;
  models: string[];
}

/** Who is signed in and which models their plan offers (refreshes the token if needed). */
export async function getGrokAccount(profile: { id: string; api_key_encrypted: string }): Promise<GrokAccount> {
  const tokens = await freshGrokTokens(profile.id, decryptGrokTokens(profile.api_key_encrypted));
  return { email: tokens.email ?? null, models: await listGrokModels(tokens) };
}

export function createGrokModel(
  profile: { id: string; name: string; model: string; api_key_encrypted: string },
  timedFetch: (input: RequestInfo | URL, init: RequestInit | undefined) => Promise<Response>,
): LanguageModel {
  let tokens = decryptGrokTokens(profile.api_key_encrypted);
  const provider = createOpenAICompatible({
    name: profile.name,
    baseURL: GROK_BASE_URL,
    fetch: async (input, init) => {
      tokens = await freshGrokTokens(profile.id, tokens);
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(grokHeaders(tokens))) headers.set(k, v);
      return timedFetch(input, { ...init, headers });
    },
  });
  return provider.chatModel(profile.model);
}
