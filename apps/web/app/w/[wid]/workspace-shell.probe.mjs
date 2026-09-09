import { mock } from 'bun:test';
import { JSDOM } from 'jsdom';
import React from 'react';
import { act } from 'react';

const mode = process.argv[2];
const router = { prefetch() {}, push() {} };
const translate = (key, values) => values ? `${key}:${JSON.stringify(values)}` : key;
const Icon = () => React.createElement('span');
const iconNames = [
  'PanelLeft', 'PanelRight', 'GitFork', 'ChevronDown', 'LogOut', 'Plus', 'Settings', 'Search',
  'Loader2', 'HelpCircle', 'Pencil', 'Trash2', 'GripVertical', 'Library', 'Wrench',
  'CheckCircle2', 'AlertCircle', 'X',
];

mock.module('next/link', () => ({
  default: (props) => {
    const { href, children, ...anchorProps } = props;
    delete anchorProps.prefetch;
    return React.createElement('a', { href, ...anchorProps }, children);
  },
}));
mock.module('next/navigation', () => ({ useRouter: () => router }));
mock.module('next-intl', () => ({
  useLocale: () => 'zh-TW',
  useTranslations: () => translate,
}));
mock.module('lucide-react', () => Object.fromEntries(iconNames.map((name) => [name, Icon])));
mock.module('@/components/wiki/page-tree', () => ({
  PageTree: () => React.createElement('div', { 'data-testid': 'page-tree' }, 'page-tree'),
}));
mock.module('@/components/wiki/page-viewer', () => ({
  PageViewer: () => React.createElement('div', { 'data-testid': 'page-viewer' }, 'page-viewer'),
}));
mock.module('@/components/wiki/conversation-panel', () => ({
  ConversationPanel: () => React.createElement('div', { 'data-testid': 'conversation-panel' }, 'conversation-panel'),
}));
mock.module('@/components/wiki/graph-view', () => ({ GraphView: () => null }));
mock.module('@/components/wiki/help-dialog', () => ({ HelpDialog: () => null }));
mock.module('@/components/wiki/sources-dialog', () => ({ SourcesDialog: () => null }));
mock.module('@/components/wiki/ingest-queue', () => ({ parseIngestJobsResponse: () => [] }));
mock.module('@/lib/sync/realtime', () => ({ useRealtimePages: () => undefined }));
mock.module('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signOut: async () => ({ error: null }) } }),
}));

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://llm-wiki.test/w/workspace',
});
const mediaValues = new Map([
  ['(max-width: 767px)', mode === 'responsive'],
  ['(max-width: 1023px)', mode === 'responsive'],
  ['(prefers-reduced-motion: reduce)', false],
]);
dom.window.matchMedia = (query) => ({
  matches: mediaValues.get(query) ?? false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});
const previousGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
};
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const searchRequests = [];
let organizePollCalls = 0;
const fetchStub = (input) => {
  const url = String(input);
  if (url.includes('/api/search')) {
    const query = new URL(url, dom.window.location.origin).searchParams.get('q') ?? '';
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    searchRequests.push({ query, resolve });
    return promise;
  }
  if (url.includes('/api/organize?job_id=')) {
    organizePollCalls += 1;
    return Promise.resolve(jsonResponse({ status: 'running', progress: [] }));
  }
  if (url.includes('/api/ingest?')) return Promise.resolve(jsonResponse([]));
  if (url.includes('/api/workspaces/') && url.endsWith('/pages')) return Promise.resolve(jsonResponse({ pages: [] }));
  if (url.endsWith('/api/workspaces')) return Promise.resolve(jsonResponse({ workspaces: [] }));
  return Promise.resolve(jsonResponse({}));
};
globalThis.fetch = fetchStub;
dom.window.fetch = fetchStub;

const { createRoot } = await import('react-dom/client');
const { WorkspaceShell } = await import('./workspace-shell.tsx');
const props = {
  workspaceId: 'workspace',
  workspaceName: 'Workspace',
  workspaces: [{ id: 'workspace', name: 'Workspace' }],
  initialPages: [{ slug: 'index.md', title: 'Index', kind: 'wiki', zone: 'wiki' }],
  initialPage: 'index.md',
};
const container = document.createElement('div');
document.body.append(container);
const root = createRoot(container);

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderShell() {
  await act(async () => root.render(React.createElement(WorkspaceShell, props)));
  await settle();
}

function resultButton(slug) {
  return [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(slug));
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

if (mode === 'responsive') {
  await renderShell();
  const leftInitiallyOpen = Boolean(container.querySelector('[data-testid="page-tree"]'));
  const rightInitiallyOpen = Boolean(container.querySelector('[data-testid="conversation-panel"]'));
  const leftToggle = container.querySelector('button[aria-label="workspace.toggleSidebar"]');
  await act(async () => leftToggle.click());
  emit({
    leftInitiallyOpen,
    rightInitiallyOpen,
    leftAfterManualToggle: Boolean(container.querySelector('[data-testid="page-tree"]')),
  });
} else if (mode === 'search') {
  await renderShell();
  const searchToggle = container.querySelector('button[aria-label="common.search"]');
  await act(async () => searchToggle.click());
  const input = container.querySelector('input[placeholder="query.searchWiki"]');
  await act(async () => {
    setInputValue(input, 'ab');
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await settle();
  searchRequests[0].resolve(jsonResponse({ pages: [
    { slug: 'first.md', title: 'First', kind: 'wiki' },
    { slug: 'second.md', title: 'Second', kind: 'wiki' },
  ] }));
  await settle();
  await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  const selectedBeforeNewQuery = resultButton('second.md')?.textContent?.includes('second.md')
    ? 'second.md'
    : 'unexpected';
  const beforeStyle = resultButton('second.md')?.getAttribute('style') ?? '';
  await act(async () => {
    setInputValue(input, 'abc');
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await settle();
  searchRequests[1].resolve(jsonResponse({ pages: [
    { slug: 'only.md', title: 'Only', kind: 'wiki' },
    { slug: 'other.md', title: 'Other', kind: 'wiki' },
  ] }));
  await settle();
  const afterStyle = resultButton('only.md')?.getAttribute('style') ?? '';
  emit({
    requests: searchRequests.map((request) => request.query),
    selectedBeforeNewQuery: beforeStyle.includes('color-accent-glow') ? selectedBeforeNewQuery : 'unexpected',
    selectedAfterNewQuery: afterStyle.includes('color-accent-glow') ? 'only.md' : 'unexpected',
  });
} else if (mode === 'maintenance') {
  localStorage.setItem('llmwiki:maintenance', JSON.stringify({ jobId: 'job-1', pass: 1, carried: 0 }));
  await renderShell();
  await settle();
  emit({ organizePollCalls });
}

await act(async () => root.unmount());
container.remove();
dom.window.close();
Object.assign(globalThis, previousGlobals);
