import { describe, expect, test } from 'bun:test';
import { fetchWithLLMTimeouts, withOpenRouterDefaults } from './client';

const STREAM_INIT = { method: 'POST', body: JSON.stringify({ model: 'm', stream: true }) };

/** Answers headers, then only keep-alive comments until aborted. */
function stalledStream(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(': OPENROUTER PROCESSING\n\n'));
      signal?.addEventListener('abort', () => controller.error(signal.reason));
    },
  });
  return new Response(body);
}

function fakeFetch(first: (init?: RequestInit) => Promise<Response>) {
  let calls = 0;
  const fake = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) return first(init);
    return Promise.resolve(new Response('data: {"ok":true}\n\ndata: [DONE]\n\n'));
  }) as typeof fetch;
  return { fake, calls: () => calls };
}

describe('fetchWithLLMTimeouts', () => {
  test('re-sends a stream that answers headers but never any data', async () => {
    const { fake, calls } = fakeFetch(async (init) => stalledStream(init?.signal));
    const response = await fetchWithLLMTimeouts('https://x.test', STREAM_INIT, undefined, fake, 30);
    expect(await response.text()).toContain('data: {"ok":true}');
    expect(calls()).toBe(2);
  });

  test('passes a healthy stream through intact, held-back bytes included', async () => {
    const payload = ': keep-alive\n\ndata: {"a":1}\n\ndata: {"b":2}\n\n';
    const fake = (async () => new Response(payload)) as unknown as typeof fetch;
    const response = await fetchWithLLMTimeouts('https://x.test', STREAM_INIT, undefined, fake, 1_000);
    expect(await response.text()).toBe(payload);
  });

  test('never cuts a non-streaming call short', async () => {
    const { fake, calls } = fakeFetch(
      () => new Promise((resolve) => setTimeout(() => resolve(new Response('{"done":true}')), 60)),
    );
    const response = await fetchWithLLMTimeouts('https://x.test', { body: '{"stream":false}' }, undefined, fake, 10);
    expect(await response.text()).toBe('{"done":true}');
    expect(calls()).toBe(1);
  });

  test('does not re-send when the caller aborted', async () => {
    const { fake, calls } = fakeFetch(async (init) => stalledStream(init?.signal));
    const outer = new AbortController();
    const pending = fetchWithLLMTimeouts('https://x.test', STREAM_INIT, outer.signal, fake, 5_000);
    setTimeout(() => outer.abort(), 10);
    await expect(pending).rejects.toBeDefined();
    expect(calls()).toBe(1);
  });
});

describe('withOpenRouterDefaults', () => {
  test('adds a reasoning effort only when the request has none', () => {
    const added = withOpenRouterDefaults({ body: '{"model":"m"}' });
    expect(JSON.parse(String(added?.body)).reasoning).toEqual({ effort: 'medium' });
    const kept = withOpenRouterDefaults({ body: '{"model":"m","reasoning":{"effort":"low"}}' });
    expect(JSON.parse(String(kept?.body)).reasoning).toEqual({ effort: 'low' });
  });
});
