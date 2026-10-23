import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { generateText, streamText } from 'ai';
import { createChatGPTModel, encryptTokens, toCodexRequestBody, tokensFromResponse } from './chatgpt';

process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

function jwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

const completed = {
  id: 'resp_1',
  object: 'response',
  created_at: 1,
  model: 'gpt-6-luna',
  status: 'completed',
  output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi there', annotations: [] }] }],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
};

function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

const STREAM_EVENTS = [
  { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'hi there' },
  { type: 'response.output_item.done', output_index: 0, item: completed.output[0] },
  { type: 'response.completed', response: completed },
];

function model(captured: { body?: Record<string, unknown>; headers?: Headers }[]) {
  const tokens = { access_token: 'AT', refresh_token: 'RT', account_id: 'acct', expires_at: Date.now() + 3_600_000 };
  return createChatGPTModel({ id: 'p1', model: 'gpt-6-luna', api_key_encrypted: encryptTokens(tokens) }, async (_input, init) => {
    captured.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return sse(STREAM_EVENTS);
  });
}

describe('toCodexRequestBody', () => {
  test('moves system prompts into instructions and forces a stateless stream', () => {
    const body = toCodexRequestBody({
      model: 'm',
      max_output_tokens: 100,
      input: [
        { role: 'developer', content: 'be brief' },
        { role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      ],
    });
    expect(body.instructions).toBe('be brief');
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'q' }] }]);
    expect(body).toMatchObject({ store: false, stream: true });
    expect('max_output_tokens' in body).toBe(false);
  });
});

describe('tokensFromResponse', () => {
  test('reads the account id from the id token and keeps the old refresh token when omitted', () => {
    const idToken = jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9' } });
    const first = tokensFromResponse({ access_token: 'a', refresh_token: 'r', id_token: idToken, expires_in: 60 });
    expect(first).toMatchObject({ account_id: 'acct-9', email: 'me@example.com' });
    const next = tokensFromResponse({ access_token: 'b', expires_in: 60 }, first);
    expect(next).toMatchObject({ access_token: 'b', refresh_token: 'r', account_id: 'acct-9' });
  });
});

describe('createChatGPTModel', () => {
  test('streamText sends ChatGPT auth headers and a store:false request', async () => {
    const captured: { body?: Record<string, unknown>; headers?: Headers }[] = [];
    const result = streamText({ model: model(captured), system: 'sys', prompt: 'hello' });
    expect(await result.text).toBe('hi there');
    expect(captured[0].headers?.get('authorization')).toBe('Bearer AT');
    expect(captured[0].headers?.get('chatgpt-account-id')).toBe('acct');
    expect(captured[0].body).toMatchObject({ store: false, stream: true, instructions: 'sys' });
  });

  test('generateText (non-streaming) is served from the completed SSE event', async () => {
    const captured: { body?: Record<string, unknown>; headers?: Headers }[] = [];
    const { text } = await generateText({ model: model(captured), prompt: 'hello' });
    expect(text).toBe('hi there');
    expect(captured[0].body?.stream).toBe(true);
  });
});
