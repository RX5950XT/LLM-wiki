import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import React from 'react';
import { act } from 'react';

mock.module('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
mock.module('next/navigation', () => ({ useRouter: () => ({ refresh: mock() }) }));

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://llm-wiki.test/settings',
});
const previousGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  navigator: globalThis.navigator,
  fetch: globalThis.fetch,
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
const { renderToString } = await import('react-dom/server');
const { ProfileList } = await import('./profile-list');
const { LocaleSwitcher } = await import('./locale-switcher');

const profile = (id: string, name: string) => ({
  id,
  name,
  base_url: 'https://api.example.test/v1',
  model: 'test-model',
  is_default: false,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function renderProfiles(profiles: ReturnType<typeof profile>[]) {
  await act(async () => {
    root.render(React.createElement(ProfileList, { profiles }));
  });
}

function deleteButton(name: string): HTMLButtonElement {
  const row = [...container.querySelectorAll('li')].find((item) => item.textContent?.includes(name));
  const button = row?.querySelector<HTMLButtonElement>('button[aria-label="deleteProfile"]');
  if (!button) throw new Error(`Missing delete button for ${name}`);
  return button;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  dom.window.confirm = () => true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(() => {
  dom.window.close();
  Object.assign(globalThis, previousGlobals);
});

describe('ProfileList interactions', () => {
  test('uses the provider locale during English server rendering', () => {
    const markup = renderToString(React.createElement(LocaleSwitcher));

    expect(markup).toContain('English');
    expect(markup).toContain('var(--color-accent)');
  });

  test('renders new server props after the profile list changes', async () => {
    await renderProfiles([profile('one', 'First profile')]);
    expect(container.textContent).toContain('First profile');

    await renderProfiles([profile('two', 'Server profile')]);
    expect(container.textContent).toContain('Server profile');
    expect(container.textContent).not.toContain('First profile');
  });

  test('hides only successful deletes and keeps failed deletes visible', async () => {
    const first = profile('one', 'Delete succeeds');
    const second = profile('two', 'Delete fails');
    let resolveDelete!: (response: Response) => void;
    const deleteRequest = new Promise<Response>((resolve) => {
      resolveDelete = resolve;
    });
    globalThis.fetch = mock(() => deleteRequest) as typeof fetch;

    await renderProfiles([first, second]);
    await act(async () => {
      deleteButton(first.name).click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(first.name);

    resolveDelete(new Response(null, { status: 204 }));
    await act(async () => {
      await deleteRequest;
    });
    expect(container.textContent).not.toContain(first.name);

    globalThis.fetch = mock(async () => new Response(
      JSON.stringify({ error: 'delete failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    await act(async () => {
      deleteButton(second.name).click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(second.name);
    expect(container.textContent).toContain('delete failed');
  });
});
