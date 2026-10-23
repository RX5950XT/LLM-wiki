import { createOpenAI } from '@ai-sdk/openai';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { decryptApiKey, encryptApiKey } from '@/lib/crypto/api-key';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * "Sign in with ChatGPT": the same OAuth client and backend the Codex CLI uses, so
 * requests are billed to the user's ChatGPT plan instead of an API key. A Vercel app
 * cannot receive Codex's fixed localhost redirect, so login uses the device-code flow
 * (the one behind `codex login --device-auth`). Endpoints mirror openai/codex
 * `codex-rs/login`.
 */
export const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const ISSUER = 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_TIMEOUT_MS = 20_000;
/** Refresh this long before the access token actually expires. */
const REFRESH_SKEW_MS = 5 * 60_000;

export interface ChatGPTTokens {
  access_token: string;
  refresh_token: string;
  account_id: string;
  /** epoch ms */
  expires_at: number;
  /** Signed-in ChatGPT account, from the id token (older rows: read from the access token). */
  email?: string;
}

export interface DeviceCode {
  device_auth_id: string;
  user_code: string;
  interval: number;
  verification_url: string;
}

export class ChatGPTAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatGPTAuthError';
  }
}

export function isChatGPTProfile(profile: { base_url: string }): boolean {
  return profile.base_url.replace(/\/+$/, '') === CHATGPT_BASE_URL;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Codex reads the workspace id from the `https://api.openai.com/auth` claim of either token. */
function accountIdFrom(...jwts: (string | undefined)[]): string | null {
  for (const jwt of jwts) {
    if (!jwt) continue;
    const auth = decodeJwtPayload(jwt)['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    if (typeof auth?.chatgpt_account_id === 'string') return auth.chatgpt_account_id;
  }
  return null;
}

/** Codex reads the email from the top-level claim, then the `https://api.openai.com/profile` claim. */
function emailFrom(...jwts: (string | undefined)[]): string | undefined {
  for (const jwt of jwts) {
    if (!jwt) continue;
    const claims = decodeJwtPayload(jwt);
    const profile = claims['https://api.openai.com/profile'] as Record<string, unknown> | undefined;
    const email = typeof claims.email === 'string' ? claims.email : profile?.email;
    if (typeof email === 'string' && email) return email;
  }
  return undefined;
}

/** Turn an /oauth/token response into stored tokens; `previous` covers fields a refresh may omit. */
export function tokensFromResponse(json: unknown, previous?: ChatGPTTokens): ChatGPTTokens {
  const body = (json ?? {}) as Record<string, unknown>;
  const access = typeof body.access_token === 'string' ? body.access_token : '';
  if (!access) throw new ChatGPTAuthError('ChatGPT sign-in returned no access token');
  const refresh = typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refresh_token;
  if (!refresh) throw new ChatGPTAuthError('ChatGPT sign-in returned no refresh token');
  const idToken = typeof body.id_token === 'string' ? body.id_token : undefined;
  const accountId = accountIdFrom(idToken, access) ?? previous?.account_id;
  if (!accountId) throw new ChatGPTAuthError('ChatGPT token has no account id');
  const exp = decodeJwtPayload(access).exp;
  const expiresAt =
    typeof body.expires_in === 'number'
      ? Date.now() + body.expires_in * 1000
      : typeof exp === 'number'
        ? exp * 1000
        : Date.now() + 60 * 60_000;
  const email = emailFrom(idToken, access) ?? previous?.email;
  return { access_token: access, refresh_token: refresh, account_id: accountId, expires_at: expiresAt, ...(email ? { email } : {}) };
}

async function authPost(path: string, body: string, contentType: string): Promise<Response> {
  return fetch(`${ISSUER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });
}

export async function requestDeviceCode(): Promise<DeviceCode> {
  const res = await authPost('/api/accounts/deviceauth/usercode', JSON.stringify({ client_id: CLIENT_ID }), 'application/json');
  if (!res.ok) throw new ChatGPTAuthError(`ChatGPT device login unavailable (${res.status})`);
  const json = (await res.json()) as Record<string, unknown>;
  const userCode = json.user_code ?? json.usercode;
  if (typeof json.device_auth_id !== 'string' || typeof userCode !== 'string') {
    throw new ChatGPTAuthError('ChatGPT device login returned an unexpected response');
  }
  const interval = Number.parseInt(String(json.interval ?? '5'), 10);
  return {
    device_auth_id: json.device_auth_id,
    user_code: userCode,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
    verification_url: `${ISSUER}/codex/device`,
  };
}

/** One poll. `null` = the user has not finished signing in yet. */
export async function pollDeviceCode(deviceAuthId: string, userCode: string): Promise<ChatGPTTokens | null> {
  const res = await authPost(
    '/api/accounts/deviceauth/token',
    JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    'application/json',
  );
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new ChatGPTAuthError(`ChatGPT device login failed (${res.status})`);
  const code = (await res.json()) as Record<string, unknown>;
  if (typeof code.authorization_code !== 'string' || typeof code.code_verifier !== 'string') {
    throw new ChatGPTAuthError('ChatGPT device login returned an unexpected response');
  }
  const exchange = await authPost(
    '/oauth/token',
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: code.authorization_code,
      redirect_uri: `${ISSUER}/deviceauth/callback`,
      client_id: CLIENT_ID,
      code_verifier: code.code_verifier,
    }).toString(),
    'application/x-www-form-urlencoded',
  );
  if (!exchange.ok) throw new ChatGPTAuthError(`ChatGPT token exchange failed (${exchange.status})`);
  return tokensFromResponse(await exchange.json());
}

async function refreshTokens(previous: ChatGPTTokens): Promise<ChatGPTTokens> {
  const res = await authPost(
    '/oauth/token',
    JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: previous.refresh_token }),
    'application/json',
  );
  if (!res.ok) {
    throw new ChatGPTAuthError(`ChatGPT sign-in expired (${res.status}). Sign in with ChatGPT again in Settings.`);
  }
  return tokensFromResponse(await res.json(), previous);
}

export function encryptTokens(tokens: ChatGPTTokens): string {
  return encryptApiKey(JSON.stringify(tokens));
}

function decryptTokens(ciphertext: string): ChatGPTTokens {
  const parsed = JSON.parse(decryptApiKey(ciphertext)) as Partial<ChatGPTTokens>;
  if (!parsed.access_token || !parsed.refresh_token || !parsed.account_id) {
    throw new ChatGPTAuthError('Stored ChatGPT sign-in is invalid. Sign in with ChatGPT again in Settings.');
  }
  return { expires_at: 0, ...parsed } as ChatGPTTokens;
}

/** Model slugs this ChatGPT plan may use, best first; empty when the catalog is unreachable. */
export async function listChatGPTModels(tokens: ChatGPTTokens): Promise<string[]> {
  try {
    const res = await fetch(`${CHATGPT_BASE_URL}/models?client_version=1.0.0`, {
      headers: chatgptHeaders(tokens),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { models?: { slug?: unknown; visibility?: unknown }[] };
    return (json.models ?? [])
      .filter((m) => typeof m.slug === 'string' && m.visibility !== 'hide')
      .map((m) => m.slug as string);
  } catch {
    return [];
  }
}

function chatgptHeaders(tokens: ChatGPTTokens): Record<string, string> {
  return {
    Authorization: `Bearer ${tokens.access_token}`,
    'ChatGPT-Account-ID': tokens.account_id,
    originator: 'codex_cli_rs',
  };
}

type InputItem = { role?: string; content?: unknown };

function itemText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .join('');
}

/**
 * The Codex backend only accepts stateless streamed requests: `instructions` is
 * required (system prompts may not sit in `input`), `store` must be false, and
 * output-token caps are rejected.
 */
export function toCodexRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const input = Array.isArray(body.input) ? (body.input as InputItem[]) : [];
  const isSystem = (item: InputItem) => item.role === 'system' || item.role === 'developer';
  const instructions = [typeof body.instructions === 'string' ? body.instructions : '', ...input.filter(isSystem).map((i) => itemText(i.content))]
    .filter(Boolean)
    .join('\n\n');
  const { max_output_tokens: _max, ...rest } = body;
  return {
    ...rest,
    instructions: instructions || 'You are a helpful assistant.',
    input: input.filter((item) => !isSystem(item)),
    store: false,
    stream: true,
  };
}

/** Non-streaming callers (generateText/generateObject) get the final response object as JSON. */
export async function sseToJsonResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const text = await response.text();
  for (const line of text.split('\n').reverse()) {
    if (!line.startsWith('data:')) continue;
    try {
      const event = JSON.parse(line.slice(5).trim()) as { type?: string; response?: unknown };
      if (event.type === 'response.completed' || event.type === 'response.done') {
        return new Response(JSON.stringify(event.response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    } catch {
      // not JSON (e.g. [DONE]) — keep scanning
    }
  }
  return new Response(JSON.stringify({ error: { message: 'ChatGPT returned no completed response' } }), {
    status: 502,
    headers: { 'content-type': 'application/json' },
  });
}

/** Per-instance in-flight refresh, so concurrent requests do not burn the rotating refresh token twice. */
const refreshing = new Map<string, Promise<ChatGPTTokens>>();

async function freshTokens(profileId: string, current: ChatGPTTokens): Promise<ChatGPTTokens> {
  if (current.expires_at - REFRESH_SKEW_MS > Date.now()) return current;
  const pending = refreshing.get(profileId);
  if (pending) return pending;
  const run = (async () => {
    const admin = createAdminClient();
    // Another instance may already have rotated the refresh token.
    const { data } = await admin.from('llm_profiles').select('api_key_encrypted').eq('id', profileId).maybeSingle();
    const stored = data?.api_key_encrypted ? decryptTokens(data.api_key_encrypted as string) : current;
    if (stored.expires_at - REFRESH_SKEW_MS > Date.now()) return stored;
    const next = await refreshTokens(stored);
    const { error } = await admin.from('llm_profiles').update({ api_key_encrypted: encryptTokens(next) }).eq('id', profileId);
    if (error) console.error('[chatgpt] failed to persist refreshed token', { profileId, message: error.message });
    return next;
  })().finally(() => refreshing.delete(profileId));
  refreshing.set(profileId, run);
  return run;
}

export interface ChatGPTAccount {
  email: string | null;
  /** e.g. "plus", "pro" — from the token's auth claim */
  plan: string | null;
  models: string[];
}

/** Who is signed in and which models their plan offers (refreshes the token if needed). */
export async function getChatGPTAccount(profile: { id: string; api_key_encrypted: string }): Promise<ChatGPTAccount> {
  const tokens = await freshTokens(profile.id, decryptTokens(profile.api_key_encrypted));
  const auth = decodeJwtPayload(tokens.access_token)['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  return {
    email: tokens.email ?? emailFrom(tokens.access_token) ?? null,
    plan: typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : null,
    models: await listChatGPTModels(tokens),
  };
}

export function createChatGPTModel(
  profile: { id: string; model: string; api_key_encrypted: string },
  timedFetch: (input: RequestInfo | URL, init: RequestInit | undefined) => Promise<Response>,
): LanguageModel {
  let tokens = decryptTokens(profile.api_key_encrypted);
  const provider = createOpenAI({
    baseURL: CHATGPT_BASE_URL,
    apiKey: 'chatgpt-oauth', // replaced per request below
    fetch: async (input, init) => {
      tokens = await freshTokens(profile.id, tokens);
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(chatgptHeaders(tokens))) headers.set(k, v);
      if (typeof init?.body !== 'string') return timedFetch(input, { ...init, headers });
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const response = await timedFetch(input, { ...init, headers, body: JSON.stringify(toCodexRequestBody(body)) });
      return body.stream === true ? response : sseToJsonResponse(response);
    },
  });
  return wrapLanguageModel({
    model: provider.responses(profile.model),
    middleware: {
      specificationVersion: 'v3',
      // store:false keeps the SDK from sending item_reference ids the backend never stored;
      // encrypted reasoning lets multi-step tool loops carry reasoning across steps.
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: {
          ...params.providerOptions,
          openai: { ...params.providerOptions?.openai, store: false, include: ['reasoning.encrypted_content'] },
        },
      }),
    },
  });
}
