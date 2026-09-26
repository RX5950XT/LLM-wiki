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

interface LLMClientOptions {
  /** Whole-invocation deadline: aborts every request made after it fires. */
  signal?: AbortSignal;
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
    fetch: (input, init) => {
      const signals = [AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS)];
      if (init?.signal) signals.push(init.signal);
      if (options.signal) signals.push(options.signal);
      return fetch(input, { ...init, signal: AbortSignal.any(signals) });
    },
  });

  return provider.chatModel(profile.model);
}
