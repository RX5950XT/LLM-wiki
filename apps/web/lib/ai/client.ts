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

  const provider = createOpenAICompatible({
    name: profile.name,
    baseURL: profile.base_url,
    apiKey,
    headers: profile.extra_headers as Record<string, string>,
  });

  return provider.chatModel(profile.model);
}
