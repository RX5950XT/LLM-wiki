import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { generateText } from 'ai';
import { createGrokModel, encryptGrokTokens, grokTokensFromResponse, isGrokProfile } from './grok';

process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const jwt = (payload: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

describe('grok tokens', () => {
  test('reads expiry and the id token email', () => {
    const tokens = grokTokensFromResponse({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 3600,
      id_token: jwt({ email: 'a@example.com' }),
    });
    expect(tokens.refresh_token).toBe('RT');
    expect(tokens.email).toBe('a@example.com');
    expect(tokens.expires_at).toBeGreaterThan(Date.now() + 3_500_000);
  });

  test('a refresh without a new refresh token keeps the old one and the email', () => {
    const next = grokTokensFromResponse({ access_token: 'AT2', expires_in: 60 }, { access_token: 'AT', refresh_token: 'RT', expires_at: 0, email: 'a@example.com' });
    expect(next).toMatchObject({ access_token: 'AT2', refresh_token: 'RT', email: 'a@example.com' });
  });

  test('missing access token is an auth error', () => {
    expect(() => grokTokensFromResponse({})).toThrow('no access token');
  });

  test('profile detection ignores a trailing slash', () => {
    expect(isGrokProfile({ base_url: 'https://cli-chat-proxy.grok.com/v1/' })).toBe(true);
    expect(isGrokProfile({ base_url: 'https://api.x.ai/v1' })).toBe(false);
  });
});

describe('grok model', () => {
  test('sends the bearer token and the client version the proxy requires', async () => {
    const tokens = { access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 3_600_000 };
    const seen: { url: string; headers: Headers }[] = [];
    const model = createGrokModel(
      { id: 'p1', name: 'Grok', model: 'grok-4.7', api_key_encrypted: encryptGrokTokens(tokens) },
      async (input, init) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response(
          JSON.stringify({
            id: '1',
            object: 'chat.completion',
            created: 1,
            model: 'grok-4.7',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    );
    const { text } = await generateText({ model, prompt: 'hello' });
    expect(text).toBe('hi');
    expect(seen[0]!.url).toBe('https://cli-chat-proxy.grok.com/v1/chat/completions');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer AT');
    expect(seen[0]!.headers.get('x-grok-client-version')).toBeTruthy();
  });
});
