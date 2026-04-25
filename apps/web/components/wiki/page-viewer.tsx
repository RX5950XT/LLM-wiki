'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Pencil, Lock, CheckCircle } from 'lucide-react';

interface PageViewerProps {
  workspaceId: string;
  slug: string | null;
  onWikiLinkClick?: (slug: string) => void;
}

interface PageData {
  slug: string;
  title: string | null;
  content: string;
  updated_by: 'llm' | 'human';
  locked_by_human: boolean;
  version: number;
}

export function PageViewer({ workspaceId, slug, onWikiLinkClick }: PageViewerProps) {
  const [page, setPage] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setError(null);

    fetch(`/api/pages/${workspaceId}/${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((data) => setPage(data))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [workspaceId, slug]);

  if (!slug) {
    return (
      <div
        className="flex h-full items-center justify-center"
        style={{ color: 'var(--fg-muted)' }}
      >
        <p className="text-sm">Select a page from the sidebar</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-4 w-4 animate-spin rounded-full border-2" style={{ borderColor: 'var(--color-accent)', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  if (error || !page) {
    return (
      <div className="flex h-full items-center justify-center" style={{ color: 'var(--fg-muted)' }}>
        <p className="text-sm">{error ?? 'Page not found'}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div
        className="flex items-center justify-between border-b px-6 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-2">
          {page.updated_by === 'llm' ? (
            <span
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium"
              style={{ background: 'var(--color-accent-glow)', color: 'var(--color-accent)' }}
            >
              AI
            </span>
          ) : (
            <span
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium"
              style={{ background: 'var(--bg-2)', color: 'var(--fg-muted)' }}
            >
              <Pencil size={10} /> Human
            </span>
          )}
          {page.locked_by_human && (
            <Lock size={12} style={{ color: 'var(--fg-muted)' }} aria-label="Locked by human — LLM will not overwrite" />
          )}
        </div>
        <span className="text-xs" style={{ color: 'var(--fg-muted)' }}>
          v{page.version} · {page.slug}
        </span>
      </div>

      {/* Markdown content */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <article
          className="wiki-prose max-w-none"
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children, ...props }) => {
                // Handle wikilinks [[page]] → internal navigation
                if (href?.startsWith('wiki://')) {
                  const target = href.slice(7);
                  return (
                    <button
                      onClick={() => onWikiLinkClick?.(target)}
                      className="text-sm font-medium underline"
                      style={{ color: 'var(--color-accent)' }}
                    >
                      {children}
                    </button>
                  );
                }
                return (
                  <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                    {children}
                  </a>
                );
              },
            }}
          >
            {page.content}
          </ReactMarkdown>
        </article>
      </div>
    </div>
  );
}
