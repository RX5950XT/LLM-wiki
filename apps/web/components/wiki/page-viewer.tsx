'use client';

import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { Pencil, Lock, Unlock, RefreshCw, AlertTriangle, Check, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { reconnectGoogleDrive } from '@/lib/google/drive-reconnect';

function stripFrontmatterAndWikilinks(content: string): string {
  let result = content;
  if (result.startsWith('---')) {
    const end = result.indexOf('\n---', 3);
    if (end !== -1) result = result.slice(end + 4).trimStart();
  }
  // Convert [[slug]] and [[slug#anchor]] to markdown links that our custom renderer intercepts.
  result = result.replace(/\[\[([^\]]+)\]\]/g, (_, target: string) => {
    const [slug = '', anchor] = target.split('#');
    const encodedSlug = encodeURIComponent(slug);
    const encodedAnchor = anchor ? `#${encodeURIComponent(anchor)}` : '';
    return `[${target}](wiki://${encodedSlug}${encodedAnchor})`;
  });
  return result;
}

function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function getTextContent(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(getTextContent).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return getTextContent((children as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

function parseInternalHref(href: string): { slug: string; anchor?: string } | null {
  if (href.startsWith('wiki://') || href.startsWith('wiki:')) {
    const withoutScheme = href.replace(/^wiki:(\/\/)?/, '');
    const [rawSlug = '', rawAnchor] = withoutScheme.split('#');
    return {
      slug: normalizeWikiSlug(decodeURIComponent(rawSlug)),
      anchor: rawAnchor ? decodeURIComponent(rawAnchor) : undefined,
    };
  }

  if (href.startsWith('#')) return null;

  const resolved = parseWorkspaceRouteHref(href);
  if (resolved) return resolved;

  if (/^(https?:|mailto:|tel:)/i.test(href)) return null;

  const [slug = '', anchor] = href.replace(/^\//, '').split('#');
  return {
    slug: normalizeWikiSlug(slug),
    anchor: anchor ? decodeURIComponent(anchor) : undefined,
  };
}

function parseWorkspaceRouteHref(href: string): { slug: string; anchor?: string } | null {
  const base = typeof window !== 'undefined' ? window.location.origin : 'https://llm-wiki.local';
  const url = runSafeUrl(href, base);
  if (!url || !/^\/w\/[^/]+$/i.test(url.pathname)) return null;

  const params = url.searchParams;
  const rawPage = params.get('page');
  if (!rawPage) return null;

  return {
    slug: normalizeWikiSlug(decodeURIComponent(rawPage)),
    anchor: url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined,
  };
}

function runSafeUrl(href: string, base: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

function normalizeWikiSlug(slug: string): string {
  const trimmed = slug.trim().replace(/^\//, '');
  if (!trimmed) return trimmed;
  return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
}

function encodeSlugPath(slug: string): string {
  return slug.split('/').map(encodeURIComponent).join('/');
}

type EditorAction = {
  id: string;
  label: string;
  apply: (input: HTMLTextAreaElement) => string;
};

function replaceSelection(
  input: HTMLTextAreaElement,
  before: string,
  after = before,
  placeholder = '',
): string {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? 0;
  const selected = input.value.slice(start, end) || placeholder;
  return `${input.value.slice(0, start)}${before}${selected}${after}${input.value.slice(end)}`;
}

function prefixSelectedLines(input: HTMLTextAreaElement, prefix: string, placeholder: string): string {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? 0;
  const value = input.value;
  const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const lineEnd = value.indexOf('\n', end);
  const sliceEnd = lineEnd === -1 ? value.length : lineEnd;
  const selected = value.slice(lineStart, sliceEnd) || placeholder;
  const updated = selected
    .split('\n')
    .map((line) => `${prefix}${line || placeholder}`)
    .join('\n');
  return `${value.slice(0, lineStart)}${updated}${value.slice(sliceEnd)}`;
}

interface PageViewerProps {
  workspaceId: string;
  slug: string | null;
  anchor?: string | null;
  onWikiLinkClick?: (slug: string, anchor?: string) => void;
  onPageSaved?: () => void;
  onPageLoaded?: (page: PageData) => void;
  /** Increment to force re-fetch (e.g. on Realtime update) */
  refreshKey?: number;
}

interface PageData {
  slug: string;
  title: string | null;
  content: string;
  kind: string;
  zone: string;
  updated_by: 'llm' | 'human';
  locked_by_human: boolean;
  version: number;
}

export function PageViewer({
  workspaceId,
  slug,
  anchor,
  onWikiLinkClick,
  onPageSaved,
  onPageLoaded,
  refreshKey,
}: PageViewerProps) {
  const t = useTranslations();
  const [page, setPage] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [lockPending, setLockPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [savePending, setSavePending] = useState(false);
  const [reconnectPending, setReconnectPending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const fetchPage = useCallback(
    (forceSlug?: string) => {
      const target = forceSlug ?? slug;
      if (!target) return;
      setLoading(true);
      setError(null);
      setStale(false);

      fetch(`/api/pages/${workspaceId}/${encodeSlugPath(target)}`)
        .then(async (response) => {
          const data = await response.json().catch(() => null) as
            | {
              content?: unknown;
              error?: { code?: string; message?: string; requestId?: string };
            }
            | null;
          if (!response.ok) {
            const code = data?.error?.code ?? 'UNKNOWN';
            const message = data?.error?.message ?? response.statusText;
            const requestId = data?.error?.requestId;
            throw new Error(`[${code}] ${message}${requestId ? ` (req: ${requestId})` : ''}`);
          }
          if (!data || typeof data.content !== 'string') {
            throw new Error('Invalid page response');
          }
          return data as PageData;
        })
        .then((data: PageData) => {
          setPage(data);
          setDraft(data.content);
          setEditing(false);
          onPageLoaded?.(data);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    },
    [onPageLoaded, workspaceId, slug],
  );

  // Fetch on slug change
  useEffect(() => {
    setPage(null);
    fetchPage();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, workspaceId]);

  // When refreshKey increments (Realtime update), mark as stale instead of
  // auto-reloading to preserve scroll position.
  useEffect(() => {
    if (refreshKey === undefined || refreshKey === 0) return;
    setStale(true);
  }, [refreshKey]);

  useEffect(() => {
    if (!page || !anchor) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [anchor, page]);

  const isEditable = page?.zone === 'notes' || page?.zone === 'schema';

  const toggleLock = useCallback(async () => {
    if (!page) return;
    setLockPending(true);
    try {
      await fetch(
        `/api/pages/${workspaceId}/${encodeSlugPath(page.slug)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locked_by_human: !page.locked_by_human }),
        },
      );
      setPage((prev) =>
        prev ? { ...prev, locked_by_human: !prev.locked_by_human } : prev,
      );
    } finally {
      setLockPending(false);
    }
  }, [page, workspaceId]);

  const savePage = useCallback(async () => {
    if (!page) return;
    setSavePending(true);
    setError(null);
    try {
      const res = await fetch(`/api/pages/${workspaceId}/${encodeSlugPath(page.slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draft }),
      });
      const data = await res.json().catch(() => null) as PageData & { error?: string } | null;
      if (!res.ok || !data) {
        throw new Error(data?.error ?? 'Failed to save page');
      }
      setPage(data);
      setDraft(data.content);
      setEditing(false);
      setStale(false);
      onPageLoaded?.(data);
      onPageSaved?.();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save page');
    } finally {
      setSavePending(false);
    }
  }, [draft, onPageLoaded, onPageSaved, page, workspaceId]);

  const editorActions: EditorAction[] = [
    { id: 'h1', label: t('wiki.editorHeading'), apply: (input) => prefixSelectedLines(input, '# ', 'Heading') },
    { id: 'bold', label: t('wiki.editorBold'), apply: (input) => replaceSelection(input, '**', '**', 'bold') },
    { id: 'italic', label: t('wiki.editorItalic'), apply: (input) => replaceSelection(input, '_', '_', 'italic') },
    { id: 'bullet', label: t('wiki.editorBullet'), apply: (input) => prefixSelectedLines(input, '- ', 'list item') },
    { id: 'task', label: t('wiki.editorTask'), apply: (input) => prefixSelectedLines(input, '- [ ] ', 'task') },
    { id: 'quote', label: t('wiki.editorQuote'), apply: (input) => prefixSelectedLines(input, '> ', 'quote') },
    { id: 'code', label: t('wiki.editorCode'), apply: (input) => replaceSelection(input, '```\n', '\n```', 'code') },
    { id: 'link', label: t('wiki.editorLink'), apply: (input) => replaceSelection(input, '[', '](https://example.com)', 'label') },
  ];

  const applyEditorAction = useCallback((action: EditorAction) => {
    const input = textareaRef.current;
    if (!input) return;
    const nextValue = action.apply(input);
    setDraft(nextValue);
    window.requestAnimationFrame(() => {
      input.focus();
    });
  }, []);

  if (!slug) {
    return (
      <div
        className="flex h-full items-center justify-center"
        style={{ color: 'var(--fg-muted)' }}
      >
        <p className="text-sm">{t('wiki.selectPage')}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div
          className="h-4 w-4 animate-spin rounded-full border-2"
          style={{
            borderColor: 'var(--color-accent)',
            borderTopColor: 'transparent',
          }}
        />
      </div>
    );
  }

  if (error || !page) {
    const reconnectRequired = Boolean(error?.includes('DRIVE_RECONNECT_REQUIRED'));
    return (
      <div
        className="flex h-full items-center justify-center px-6"
        style={{ color: 'var(--fg-muted)' }}
      >
        <div className="space-y-3 text-center">
          <p className="text-sm">{error ?? t('wiki.pageNotFound')}</p>
          {reconnectRequired && (
            <button
              type="button"
              onClick={async () => {
                setReconnectPending(true);
                try {
                  const target = `/w/${workspaceId}?page=${encodeURIComponent(slug)}`;
                  await reconnectGoogleDrive(target);
                } finally {
                  setReconnectPending(false);
                }
              }}
              disabled={reconnectPending}
              className="rounded-lg px-3 py-2 text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
              style={{ background: 'var(--color-accent)', color: 'oklch(10% 0.015 250)' }}
            >
              {reconnectPending ? t('common.reconnectingDrive') : t('auth.driveAccessRequired')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Staleness banner */}
      {stale && (
        <div
          className="flex items-center justify-between px-4 py-2 text-xs"
          style={{
            background: 'oklch(30% 0.05 295 / 0.4)',
            borderBottom: '1px solid var(--border)',
            color: 'var(--color-accent)',
          }}
        >
          <span className="flex items-center gap-1.5">
            <AlertTriangle size={12} /> {t('wiki.pageUpdated')}
          </span>
          <button
            onClick={() => fetchPage()}
            className="flex items-center gap-1 transition-opacity hover:opacity-70"
          >
            <RefreshCw size={12} /> {t('wiki.refresh')}
          </button>
        </div>
      )}

      {/* Header */}
      <div
        className="flex items-center justify-between border-b px-6 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-2">
          {page.updated_by === 'llm' ? (
            <span
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium"
              style={{
                background: 'var(--color-accent-glow)',
                color: 'var(--color-accent)',
              }}
            >
              AI
            </span>
          ) : (
            <span
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium"
              style={{ background: 'var(--bg-2)', color: 'var(--fg-muted)' }}
            >
              <Pencil size={10} /> {t('wiki.human')}
            </span>
          )}

          {/* Lock toggle */}
          <button
            onClick={toggleLock}
            disabled={lockPending}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs transition-opacity hover:opacity-70 disabled:opacity-40"
            style={{ color: page.locked_by_human ? 'var(--color-accent)' : 'var(--fg-muted)' }}
            title={
              page.locked_by_human
                ? t('wiki.lockedTitle')
                : t('wiki.unlockedTitle')
            }
          >
            {page.locked_by_human ? <Lock size={12} /> : <Unlock size={12} />}
          </button>

          {isEditable && (
            editing ? (
              <>
                <button
                  onClick={savePage}
                  disabled={savePending}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-opacity hover:opacity-70 disabled:opacity-40"
                  style={{ color: 'var(--color-accent)' }}
                  title={t('common.save')}
                >
                  {savePending ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />}
                  {t('common.save')}
                </button>
                <button
                  onClick={() => {
                    setDraft(page.content);
                    setEditing(false);
                  }}
                  disabled={savePending}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-opacity hover:opacity-70 disabled:opacity-40"
                  style={{ color: 'var(--fg-muted)' }}
                  title={t('common.cancel')}
                >
                  <X size={12} />
                  {t('common.cancel')}
                </button>
              </>
            ) : (
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-opacity hover:opacity-70"
                style={{ color: 'var(--fg-muted)' }}
                title={t('common.edit')}
              >
                <Pencil size={12} />
                {t('common.edit')}
              </button>
            )
          )}
        </div>
        <span className="text-xs" style={{ color: 'var(--fg-muted)' }}>
          v{page.version} · {page.slug}
        </span>
      </div>

      {/* Markdown content */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {editing ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {editorActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => applyEditorAction(action)}
                  className="rounded-lg border px-2.5 py-1 text-xs transition-opacity hover:opacity-70"
                  style={{
                    background: 'var(--bg-2)',
                    borderColor: 'var(--border)',
                    color: 'var(--fg)',
                  }}
                  title={action.label}
                  aria-label={action.label}
                >
                  {action.label}
                </button>
              ))}
            </div>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-[60vh] w-full rounded-xl border px-4 py-3 font-mono text-sm outline-none"
              style={{
                background: 'var(--bg-2)',
                borderColor: 'var(--border)',
                color: 'var(--fg)',
              }}
            />
          </div>
        ) : (
          <article className="wiki-prose max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => {
                  const id = slugifyHeading(getTextContent(children));
                  return <h1 id={id}>{children}</h1>;
                },
                h2: ({ children }) => {
                  const id = slugifyHeading(getTextContent(children));
                  return <h2 id={id}>{children}</h2>;
                },
                h3: ({ children }) => {
                  const id = slugifyHeading(getTextContent(children));
                  return <h3 id={id}>{children}</h3>;
                },
                h4: ({ children }) => {
                  const id = slugifyHeading(getTextContent(children));
                  return <h4 id={id}>{children}</h4>;
                },
                h5: ({ children }) => {
                  const id = slugifyHeading(getTextContent(children));
                  return <h5 id={id}>{children}</h5>;
                },
                h6: ({ children }) => {
                  const id = slugifyHeading(getTextContent(children));
                  return <h6 id={id}>{children}</h6>;
                },
                a: ({ href, children }) => {
                  if (!href) return <a>{children}</a>;

                  if (href.startsWith('#')) {
                    return (
                      <a
                        href={href}
                        onClick={(e) => {
                          e.preventDefault();
                          const targetId = decodeURIComponent(href.slice(1));
                          document.getElementById(targetId)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                          window.history.replaceState(null, '', `#${encodeURIComponent(targetId)}`);
                        }}
                        style={{ color: 'var(--color-accent)' }}
                      >
                        {children}
                      </a>
                    );
                  }

                  const internalTarget = parseInternalHref(href);
                  if (internalTarget && onWikiLinkClick) {
                    const internalHref = `/w/${workspaceId}?page=${encodeURIComponent(internalTarget.slug)}${
                      internalTarget.anchor ? `#${encodeURIComponent(internalTarget.anchor)}` : ''
                    }`;
                    return (
                      <a
                        href={internalHref}
                        onClick={(e) => {
                          e.preventDefault();
                          onWikiLinkClick(internalTarget.slug, internalTarget.anchor);
                        }}
                        style={{ color: 'var(--color-accent)' }}
                      >
                        {children}
                      </a>
                    );
                  }

                  return <a href={href}>{children}</a>;
                },
              }}
            >
              {stripFrontmatterAndWikilinks(page.content)}
            </ReactMarkdown>
          </article>
        )}
      </div>
    </div>
  );
}
