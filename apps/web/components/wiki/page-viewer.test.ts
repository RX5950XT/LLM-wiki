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

function pageResponse(slug: string, content: string, zone = 'wiki', lockedByHuman = false): Response {
  return new Response(
    JSON.stringify({
      slug,
      title: slug,
      content,
      kind: 'concept',
       zone,
      updated_by: 'llm',
       locked_by_human: lockedByHuman,
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

async function renderViewer(
  workspaceId: string,
  slug: string | null,
  onPageLoaded: (page: { slug: string }) => void,
  refreshKey = 0,
) {
  await act(async () => {
    root.render(React.createElement(PageViewer, { workspaceId, slug, onPageLoaded, refreshKey }));
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
  dom.window.confirm = () => true;
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
  test('keeps the dirty page and draft when navigation is rejected', async () => {
    await renderViewer('dirty-reject', 'a.md', () => undefined);
    await act(async () => {
      pending.get('a.md')!.resolve(pageResponse('a.md', 'original-content', 'notes'));
      await flushReact();
    });

    const editButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.title === 'common.edit',
    );
    expect(editButton).not.toBeUndefined();
    await act(async () => {
      (editButton as HTMLButtonElement).click();
      await flushReact();
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(textarea, 'unsaved-draft');
      textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await flushReact();
    });
    expect(textarea.value).toBe('unsaved-draft');

    const confirm = mock(() => false);
    dom.window.confirm = confirm;
    await renderViewer('dirty-reject', 'b.md', () => undefined);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(pending.has('b.md')).toBe(false);
    expect(container.textContent).toContain('a.md');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('unsaved-draft');
  });

  test('discards the dirty draft after navigation is accepted', async () => {
    await renderViewer('dirty-accept', 'a.md', () => undefined);
    await act(async () => {
      pending.get('a.md')!.resolve(pageResponse('a.md', 'original-content', 'notes'));
      await flushReact();
    });

    const editButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.title === 'common.edit',
    );
    await act(async () => {
      (editButton as HTMLButtonElement).click();
      await flushReact();
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(textarea, 'unsaved-draft');
      textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await flushReact();
    });

    dom.window.confirm = mock(() => true);
    await renderViewer('dirty-accept', 'b.md', () => undefined);
    expect(pending.has('b.md')).toBe(true);
    expect(container.querySelector('textarea')).toBeNull();

    await act(async () => {
      pending.get('b.md')!.resolve(pageResponse('b.md', 'new-content', 'notes'));
      await flushReact();
    });
    expect(container.textContent).toContain('new-content');
    expect(container.textContent).not.toContain('unsaved-draft');
  });

  test('keeps a successful lock change visible while manual refresh is pending', async () => {
    await renderViewer('refresh-lock', 'a.md', () => undefined);
    await act(async () => {
      pending.get('a.md')!.resolve(pageResponse('a.md', 'content', 'notes'));
      await flushReact();
    });

    const previousFetch = globalThis.fetch;
    const patchFetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve(pageResponse('a.md', 'content', 'notes', true));
      }
      return previousFetch(input, init);
    };
    globalThis.fetch = patchFetch as typeof fetch;
    dom.window.fetch = patchFetch as typeof dom.window.fetch;

    const lockButton = container.querySelector('button[title="wiki.unlockedTitle"]') as HTMLButtonElement;
    await act(async () => {
      lockButton.click();
      await flushReact();
    });
    expect(container.querySelector('button[title="wiki.lockedTitle"]')).not.toBeNull();

    await renderViewer('refresh-lock', 'a.md', () => undefined, 1);
    const refreshButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('wiki.refresh'),
    );
    expect(refreshButton).not.toBeUndefined();
    await act(async () => {
      (refreshButton as HTMLButtonElement).click();
      await flushReact();
    });
    expect(container.querySelector('button[title="wiki.lockedTitle"]')).not.toBeNull();

    await act(async () => {
      pending.get('a.md')!.resolve(pageResponse('a.md', 'content', 'notes'));
      await flushReact();
    });
    expect(container.querySelector('button[title="wiki.unlockedTitle"]')).not.toBeNull();
  });

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
