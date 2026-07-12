import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { decryptApiKey } from '@/lib/crypto/api-key';
import type { LLMProfile } from '@llm-wiki/shared-types';

/**
 * Build an AI SDK LanguageModel from a stored LLM profile.
 * The api_key_encrypted field holds the AES-256-GCM ciphertext (\\x hex format).
 */
export function createLLMClient(profile: LLMProfile): LanguageModel {
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
  });

  return provider.chatModel(profile.model);
}
