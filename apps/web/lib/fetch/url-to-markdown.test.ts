import { describe, expect, it } from 'bun:test';
import { readResponseBodyWithLimit, toPublicUrlFetchFailure } from './url-to-markdown';

describe('readResponseBodyWithLimit', () => {
  it('cancels the response as soon as the decoded body exceeds the limit', async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode(pulls === 1 ? '123' : '456'));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readResponseBodyWithLimit({ body }, 5)).rejects.toThrow('too large');
    expect(cancelled).toBe(true);
  });

  it('returns the complete body when it stays within the limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('你好'));
        controller.close();
      },
    });
    await expect(readResponseBodyWithLimit({ body }, 16)).resolves.toBe('你好');
    await expect(readResponseBodyWithLimit(new Response('ok'), 2)).resolves.toBe('ok');
  });
});

describe('toPublicUrlFetchFailure', () => {
  it('maps internal URL details to a safe public message', () => {
    const failure = toPublicUrlFetchFailure(new Error('Failed to fetch https://secret.example/?token=abc: HTTP 502'));
    expect(failure.status).toBe(422);
    expect(failure.code).toBe('SOURCE_URL_UNREADABLE');
    expect(failure.message).not.toContain('secret.example');
    expect(failure.message).not.toContain('abc');
  });

  it('keeps SSRF and size failures actionable without echoing the URL', () => {
    expect(toPublicUrlFetchFailure(new Error('URL resolves to a private address')).code).toBe('SOURCE_URL_BLOCKED');
    expect(toPublicUrlFetchFailure(new Error('Page too large to ingest (> 5 MB): https://secret.example'))).toMatchObject({
      status: 413,
      code: 'SOURCE_URL_TOO_LARGE',
    });
  });
});
