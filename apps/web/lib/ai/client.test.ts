import { describe, expect, test } from 'bun:test';
import { fetchWithLLMTimeouts } from './client';

/** A fetch that never answers until its signal aborts, then succeeds on later calls. */
function stuckOnceFetch() {
  let calls = 0;
  const fake = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    if (calls > 1) return Promise.resolve(new Response('ok'));
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  }) as typeof fetch;
  return { fake, calls: () => calls };
}

describe('fetchWithLLMTimeouts', () => {
  test('re-sends a request whose headers never arrive', async () => {
    const { fake, calls } = stuckOnceFetch();
    const response = await fetchWithLLMTimeouts('https://x.test', {}, undefined, fake, 20);
    expect(await response.text()).toBe('ok');
    expect(calls()).toBe(2);
  });

  test('does not retry when the caller aborted', async () => {
    const { fake, calls } = stuckOnceFetch();
    const outer = new AbortController();
    const pending = fetchWithLLMTimeouts('https://x.test', {}, outer.signal, fake, 5_000);
    outer.abort();
    await expect(pending).rejects.toBeDefined();
    expect(calls()).toBe(1);
  });
});
