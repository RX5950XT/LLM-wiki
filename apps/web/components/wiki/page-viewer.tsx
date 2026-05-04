'use client';

import { useEffect, useState, useCallback } from 'react';
import { Pencil, Lock, Unlock, RefreshCw, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function stripFrontmatterAndWikilinks(content: string): string {
  let result = content;
  if (result.startsWith('---')) {
    const end = result.indexOf('\n---', 3);
    if (end !== -1) result = result.slice(end + 4).trimStart();
  }
  // Convert [[slug]] to markdown links that our custom renderer intercepts
  result = result.replace(/\[\[([^\]]+)\]\]/g, (_, slug: string) => `[${slug}](wiki://${encodeURIComponent(slug)})`);
  return result;
}

interface PageViewerProps {
  workspaceId: string;
  slug: string | null;
  onWikiLinkClick?: (slug: string) => void;
  /** Increment to force re-fetch (e.g. on Realtime update) */
  refreshKey?: number;
}

interface PageData {
  slug: string;
  title: string | null;
  content: string;
  updated_by: 'llm' | 'human';
  locked_by_human: boolean;
  version: number;
}

export function PageViewer({ workspaceId, slug, onWikiLinkClick, refreshKey }: PageViewerProps) {
  const t = useTranslations();
  const [page, setPage] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [lockPending, setLockPending] = useState(false);

  const fetchPage = useCallback(
    (forceSlug?: string) => {
      const target = forceSlug ?? slug;
      if (!target) return;
      setLoading(true);
      setError(null);
      setStale(false);

      fetch(`/api/pages/${workspaceId}/${encodeURIComponent(target)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
        .then((data: PageData) => setPage(data))
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false));
    },
    [workspaceId, slug],
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

  const toggleLock = useCallback(async () => {
    if (!page) return;
    setLockPending(true);
    try {
      await fetch(
        `/api/pages/${workspaceId}/${encodeURIComponent(page.slug)}`,
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
    return (
      <div
        className="flex h-full items-center justify-center"
        style={{ color: 'var(--fg-muted)' }}
      >
        <p className="text-sm">{error ?? t('wiki.pageNotFound')}</p>
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
        </div>
        <span className="text-xs" style={{ color: 'var(--fg-muted)' }}>
          v{page.version} · {page.slug}
        </span>
      </div>

      {/* Markdown content */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <article className="wiki-prose max-w-none">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => {
                if (href?.startsWith('wiki://') && onWikiLinkClick) {
                  const slug = decodeURIComponent(href.slice(7));
                  return (
                    <a
                      href="#"
                      onClick={(e) => { e.preventDefault(); onWikiLinkClick(slug); }}
                      style={{ color: 'var(--color-accent)' }}
                    >
                      {children}
                    </a>
                  );
                }
                return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
              },
            }}
          >
            {stripFrontmatterAndWikilinks(page.content)}
          </ReactMarkdown>
        </article>
      </div>
    </div>
  );
}
