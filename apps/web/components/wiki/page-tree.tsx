'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface PageEntry {
  slug: string;
  title: string | null;
  kind: string;
  zone: string;
}

interface PageTreeProps {
  initialPages: PageEntry[];
  activePage: string | null;
  onSelectPage: (slug: string) => void;
}

const PINNED_SLUGS = ['index.md', 'log.md'];

export function PageTree({ initialPages, activePage, onSelectPage }: PageTreeProps) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(true);

  const PINNED_LABELS: Record<string, string> = {
    'index.md': t('wiki.index'),
    'log.md': t('wiki.log'),
  };

  const pages = useMemo(() => initialPages, [initialPages]);
  const pinnedPages = PINNED_SLUGS
    .map((s) => pages.find((p) => p.slug === s))
    .filter((p): p is PageEntry => p != null);

  // Notes UI was removed (chat-first workflow); notes/schema pages stay in
  // Drive & DB but are no longer surfaced in the tree.
  const wikiPages = pages.filter((p) => !PINNED_SLUGS.includes(p.slug) && p.zone === 'wiki');

  const renderPageItem = (page: PageEntry, label?: string) => (
    <div
      key={page.slug}
      style={{
        background: activePage === page.slug ? 'var(--color-accent-glow)' : undefined,
        color: activePage === page.slug ? 'var(--color-accent)' : 'var(--fg)',
        borderLeft: activePage === page.slug ? '2px solid var(--color-accent)' : '2px solid transparent',
      }}
      className="flex items-center gap-1 pr-2"
    >
      <button
        onClick={() => onSelectPage(page.slug)}
        className="flex min-w-0 flex-1 items-center px-4 py-1.5 text-left text-sm transition-colors"
      >
        <span className="truncate">{label ?? page.title ?? page.slug}</span>
      </button>
    </div>
  );

  return (
    <nav
      className="flex h-full flex-col overflow-y-auto py-3"
      style={{ color: 'var(--fg)' }}
    >
      {/* Pinned: index.md + log.md always at top */}
      {pinnedPages.length > 0 && (
        <>
          {pinnedPages.map((page) => renderPageItem(page, PINNED_LABELS[page.slug]))}
          <div
            className="mx-3 my-2 border-t"
            style={{ borderColor: 'var(--border)' }}
          />
        </>
      )}

      {/* Wiki zone */}
      <div>
        <div className="flex items-center justify-between px-3 py-1.5">
          <button
            onClick={() => setExpanded((s) => !s)}
            className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider transition-opacity hover:opacity-70"
            style={{ color: 'var(--fg-muted)' }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {t('wiki.zoneWiki')}
          </button>
        </div>

        {expanded && (
          <>
            <ul>
              {wikiPages.map((page) => (
                <li key={page.slug}>{renderPageItem(page)}</li>
              ))}
            </ul>
            {wikiPages.length === 0 && (
              <p className="px-4 py-2 text-xs" style={{ color: 'var(--fg-muted)' }}>
                {t('wiki.zoneEmpty')}
              </p>
            )}
          </>
        )}
      </div>
    </nav>
  );
}
