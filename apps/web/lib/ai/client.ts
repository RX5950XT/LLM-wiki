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
 * A streaming request that has produced no `data:` event by now is stalled, not
 * thinking: with reasoning on, the reasoning itself streams within seconds.
 * Measured against OpenRouter / gemini-3.8-flash with the real query prompt and
 * tool set: healthy first steps finish in 3–9s, stalled ones send headers and
 * then nothing at all for 90s+. Nothing has reached the caller yet at that
 * point, so the request is simply sent again. The AI SDK never retries a
 * request we abort ourselves. Non-streaming calls are exempt — their body only
 * arrives when the whole answer is done, which can legitimately take minutes.
 */
export const LLM_FIRST_DATA_TIMEOUT_MS = 35_000;
const LLM_STREAM_ATTEMPTS = 2;

/**
 * gemini-3.8-flash via OpenRouter stalls reproducibly at reasoning effort "high"
 * and intermittently at the provider default; "medium" was stable in every run.
 * Applied only when the request does not choose an effort itself.
 */
const OPENROUTER_DEFAULT_REASONING = { effort: 'medium' } as const;

interface LLMClientOptions {
  /** Whole-invocation deadline: aborts every request made after it fires. */
  signal?: AbortSignal;
}

class FirstDataTimeoutError extends Error {}

function isStreamingRequest(init: RequestInit | undefined): boolean {
  return typeof init?.body === 'string' && /"stream"\s*:\s*true/.test(init.body);
}

/** Re-wrap a partially read body: replay what was held back, then pipe the rest. */
function resumeBody(held: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of held) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * fetch with a whole-request timeout and, for streaming requests, a
 * time-to-first-data timeout that re-sends once. Exported for tests;
 * `baseFetch` is injectable for the same reason.
 */
export async function fetchWithLLMTimeouts(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  outer: AbortSignal | undefined,
  baseFetch: typeof fetch = fetch,
  firstDataTimeoutMs = LLM_FIRST_DATA_TIMEOUT_MS,
): Promise<Response> {
  const whole = AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS);
  const baseSignals = [whole, ...(init?.signal ? [init.signal] : []), ...(outer ? [outer] : [])];
  if (!isStreamingRequest(init)) {
    return baseFetch(input, { ...init, signal: AbortSignal.any(baseSignals) });
  }

  for (let attempt = 1; ; attempt += 1) {
    const gate = new AbortController();
    const timer = setTimeout(() => gate.abort(new FirstDataTimeoutError()), firstDataTimeoutMs);
    const startedAt = Date.now();
    try {
      const response = await baseFetch(input, { ...init, signal: AbortSignal.any([...baseSignals, gate.signal]) });
      if (!response.ok || !response.body) return response;
      // Hold everything back until the first data event: SSE comments such as
      // OpenRouter's ": OPENROUTER PROCESSING" keep-alives do not count.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const held: Uint8Array[] = [];
      let seen = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        held.push(value);
        seen += decoder.decode(value, { stream: true });
        if (/^data:/m.test(seen)) break;
      }
      const waitedMs = Date.now() - startedAt;
      if (waitedMs > 15_000) console.warn('[llm] slow first data', { waitedMs, attempt });
      return new Response(resumeBody(held, reader), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      const stalled = gate.signal.aborted && !baseSignals.some((signal) => signal.aborted);
      if (!stalled || attempt >= LLM_STREAM_ATTEMPTS) throw error;
      console.warn('[llm] stream produced no data, re-sending', { waitedMs: Date.now() - startedAt, attempt });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Add OpenRouter's default reasoning effort unless the request already sets one. */
export function withOpenRouterDefaults(init: RequestInit | undefined): RequestInit | undefined {
  if (typeof init?.body !== 'string') return init;
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (body.reasoning !== undefined || body.reasoning_effort !== undefined) return init;
    return { ...init, body: JSON.stringify({ ...body, reasoning: OPENROUTER_DEFAULT_REASONING }) };
  } catch {
    return init;
  }
}

function isOpenRouter(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith('openrouter.ai');
  } catch {
    return false;
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

  const openRouter = isOpenRouter(profile.base_url);
  const provider = createOpenAICompatible({
    name: profile.name,
    baseURL: profile.base_url,
    apiKey,
    headers,
    fetch: (input, init) =>
      fetchWithLLMTimeouts(input, openRouter ? withOpenRouterDefaults(init) : init, options.signal),
  });

  return provider.chatModel(profile.model);
}
