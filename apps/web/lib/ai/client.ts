import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { decryptApiKey } from '@/lib/crypto/api-key';
import type { LLMProfile } from '@llm-wiki/shared-types';

/**
 * No single provider request may outlive this. Without it a hung upstream call
 * holds the invocation until Vercel kills it — the query answers nothing and an
 * ingest/maintenance job is left "running" until the stale sweep minutes later.
 */
export const LLM_REQUEST_TIMEOUT_MS = 150_000;

/**
 * Normal time-to-headers is 2–15s (measured against OpenRouter). A request that has
 * not answered by this point is stuck, not slow — send it again instead of waiting
 * out the whole budget. The AI SDK never retries a request we abort ourselves.
 */
export const LLM_HEADERS_TIMEOUT_MS = 35_000;
const LLM_HEADER_ATTEMPTS = 2;

interface LLMClientOptions {
  /** Whole-invocation deadline: aborts every request made after it fires. */
  signal?: AbortSignal;
}

class HeadersTimeoutError extends Error {}

/**
 * fetch with a whole-request timeout plus a time-to-headers timeout that retries
 * once. Exported for tests; `baseFetch` is injectable for the same reason.
 */
export async function fetchWithLLMTimeouts(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  outer: AbortSignal | undefined,
  baseFetch: typeof fetch = fetch,
  headersTimeoutMs = LLM_HEADERS_TIMEOUT_MS,
): Promise<Response> {
  const whole = AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS);
  for (let attempt = 1; ; attempt += 1) {
    const headersGate = new AbortController();
    const timer = setTimeout(() => headersGate.abort(new HeadersTimeoutError()), headersTimeoutMs);
    const signals = [whole, headersGate.signal];
    if (init?.signal) signals.push(init.signal);
    if (outer) signals.push(outer);
    const startedAt = Date.now();
    try {
      const response = await baseFetch(input, { ...init, signal: AbortSignal.any(signals) });
      const waitedMs = Date.now() - startedAt;
      if (waitedMs > 15_000) console.warn('[llm] slow response headers', { waitedMs, status: response.status, attempt });
      return response;
    } catch (error) {
      const stuck = headersGate.signal.aborted && !whole.aborted && !outer?.aborted && !init?.signal?.aborted;
      if (!stuck || attempt >= LLM_HEADER_ATTEMPTS) throw error;
      console.warn('[llm] no response headers, retrying', { waitedMs: Date.now() - startedAt, attempt });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build an AI SDK LanguageModel from a stored LLM profile.
 * The api_key_encrypted field holds the AES-256-GCM ciphertext (\\x hex format).
 */
export function createLLMClient(profile: LLMProfile, options: LLMClientOptions = {}): LanguageModel {
  const apiKey = decryptApiKey(profile.api_key_encrypted);

  // Encrypted column wins; the legacy plaintext jsonb only serves rows
  // created before migration 0013.
  let headers = profile.extra_headers as Record<string, string> | undefined;
  if (profile.extra_headers_encrypted) {
    headers = JSON.parse(decryptApiKey(profile.extra_headers_encrypted));
  }

  const provider = createOpenAICompatible({
    name: profile.name,
    baseURL: profile.base_url,
    apiKey,
    headers,
    fetch: (input, init) => fetchWithLLMTimeouts(input, init, options.signal),
  });

  return provider.chatModel(profile.model);
}
