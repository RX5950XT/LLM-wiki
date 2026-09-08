import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import React from 'react';
import { act } from 'react';

const routerPush = mock();

mock.module('next/navigation', () => ({ useRouter: () => ({ push: routerPush }) }));
mock.module('next-intl', () => ({ useTranslations: () => (key: string) => key }));
mock.module('@/lib/google/drive-reconnect', () => ({ reconnectGoogleDrive: mock(async () => undefined) }));
mock.module('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: async () => ({ data: [] }) }),
      }),
    }),
  }),
}));

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://llm-wiki.test/w/workspace',
});
const previousGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  navigator: globalThis.navigator,
};
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import('react-dom/client');
const { PageViewer } = await import('./page-viewer');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pageResponse(slug: string, content: string): Response {
  return new Response(
    JSON.stringify({
      slug,
      title: slug,
      content,
      kind: 'concept',
      zone: 'wiki',
      updated_by: 'llm',
      locked_by_human: false,
      version: 1,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function movedResponse(): Response {
  return new Response(
    JSON.stringify({ error: { code: 'PAGE_MOVED_WORKSPACE', workspace_id: 'other', slug: 'a.md' } }),
    { status: 404, headers: { 'Content-Type': 'application/json' } },
  );
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let pending: Map<string, Deferred<Response>>;

function installFetchStub() {
  pending = new Map();
  const fetchStub = (input: RequestInfo | URL) => {
    const slug = decodeURIComponent(String(input).split('/').at(-1) ?? '');
    const request = deferred<Response>();
    pending.set(slug, request);
    return request.promise;
  };
  globalThis.fetch = fetchStub as typeof fetch;
  dom.window.fetch = fetchStub as typeof dom.window.fetch;
}

async function renderViewer(workspaceId: string, slug: string | null, onPageLoaded: (page: { slug: string }) => void) {
  await act(async () => {
    root.render(React.createElement(PageViewer, { workspaceId, slug, onPageLoaded }));
  });
}

async function flushReact() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  routerPush.mockClear();
  installFetchStub();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(() => {
  dom.window.close();
  Object.assign(globalThis, previousGlobals);
});

describe('PageViewer request ordering', () => {
  test('keeps the newest page when an older response arrives late', async () => {
    const loaded: { slug: string }[] = [];
    await renderViewer('race-a', 'a.md', (page) => loaded.push(page));
    await renderViewer('race-a', 'b.md', (page) => loaded.push(page));

    await act(async () => {
      pending.get('a.md')!.resolve(pageResponse('a.md', 'old-only-content'));
      await flushReact();
    });
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(container.textContent).not.toContain('old-only-content');
    expect(loaded).toHaveLength(0);

    await act(async () => {
      pending.get('b.md')!.resolve(pageResponse('b.md', 'new-only-content'));
      await flushReact();
    });
    expect(container.textContent).toContain('new-only-content');
    expect(container.textContent).toContain('b.md');
    expect(container.textContent).not.toContain('old-only-content');
    expect(loaded.map((page) => page.slug)).toEqual(['b.md']);
  });

  test('does not follow an old PAGE_MOVED response', async () => {
    const loaded: { slug: string }[] = [];
    await renderViewer('race-b', 'a.md', (page) => loaded.push(page));
    await renderViewer('race-b', 'b.md', (page) => loaded.push(page));

    await act(async () => {
      pending.get('a.md')!.resolve(movedResponse());
      await flushReact();
    });
    expect(routerPush).not.toHaveBeenCalled();
    expect(container.querySelector('.animate-spin')).not.toBeNull();

    await act(async () => {
      pending.get('b.md')!.resolve(pageResponse('b.md', 'new-only-content'));
      await flushReact();
    });
    expect(loaded.map((page) => page.slug)).toEqual(['b.md']);
  });

  test('does not show an old fetch error or stop the current loading state', async () => {
    const loaded: { slug: string }[] = [];
    await renderViewer('race-error', 'a.md', (page) => loaded.push(page));
    await renderViewer('race-error', 'b.md', (page) => loaded.push(page));

    await act(async () => {
      pending.get('a.md')!.reject(new Error('old-fetch-error'));
      await flushReact();
    });
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(container.textContent).not.toContain('old-fetch-error');

    await act(async () => {
      pending.get('b.md')!.resolve(pageResponse('b.md', 'new-only-content'));
      await flushReact();
    });
    expect(container.textContent).toContain('new-only-content');
    expect(loaded.map((page) => page.slug)).toEqual(['b.md']);
  });

  test('invalidates a pending response on null slug and unmount', async () => {
    const loaded: { slug: string }[] = [];
    await renderViewer('race-c', 'a.md', (page) => loaded.push(page));
    await renderViewer('race-c', null, (page) => loaded.push(page));
    await act(async () => {
      pending.get('a.md')!.resolve(pageResponse('a.md', 'old-only-content'));
      await flushReact();
    });
    expect(container.textContent).toContain('wiki.selectPage');
    expect(loaded).toHaveLength(0);

    await renderViewer('race-c', 'b.md', (page) => loaded.push(page));
    await act(async () => root.unmount());
    await act(async () => {
      pending.get('b.md')!.resolve(pageResponse('b.md', 'new-only-content'));
      await flushReact();
    });
    expect(loaded).toHaveLength(0);
  });
});
