'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, ChevronDown, ChevronRight, PlusSquare, Pencil, Trash2 } from 'lucide-react';

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
  onCreateNote?: () => void;
  onRenameNote?: (page: PageEntry) => void;
  onDeleteNote?: (page: PageEntry) => void;
}

const PINNED_SLUGS = ['index.md', 'log.md'];

function groupByZone(pages: PageEntry[]) {
  const groups: Record<string, PageEntry[]> = {};
  for (const page of pages) {
    if (!groups[page.zone]) groups[page.zone] = [];
    groups[page.zone]!.push(page);
  }
  return groups;
}

export function PageTree({
  initialPages,
  activePage,
  onSelectPage,
  onCreateNote,
  onRenameNote,
  onDeleteNote,
}: PageTreeProps) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ wiki: true });

  const PINNED_LABELS: Record<string, string> = {
    'index.md': t('wiki.index'),
    'log.md': t('wiki.log'),
  };

  const SYSTEM_LABELS: Record<string, string> = {
    'notes/guide.md': t('wiki.notesGuide'),
    '_schema/ingest.md': t('wiki.schemaIngest'),
    '_schema/query.md': t('wiki.schemaQuery'),
    '_schema/lint.md': t('wiki.schemaLint'),
  };

  const ZONE_LABELS: Record<string, string> = {
    wiki: t('wiki.zoneWiki'),
    notes: t('wiki.zoneNotes'),
  };

  const pages = useMemo(() => initialPages, [initialPages]);
  const pinnedPages = PINNED_SLUGS
    .map((s) => pages.find((p) => p.slug === s))
    .filter((p): p is PageEntry => p != null);

  const otherPages = pages.filter((p) => !PINNED_SLUGS.includes(p.slug) && p.zone !== 'schema');
  const grouped = groupByZone(otherPages);

  const toggleZone = (zone: string) =>
    setExpanded((s) => ({ ...s, [zone]: !s[zone] }));

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
        className="flex min-w-0 flex-1 items-center gap-2 px-4 py-1.5 text-left text-sm transition-colors"
      >
        <FileText size={13} style={{ opacity: 0.6 }} />
        <span className="truncate">{label ?? SYSTEM_LABELS[page.slug] ?? page.title ?? page.slug}</span>
      </button>
      {page.zone === 'notes' && page.slug !== 'notes/guide.md' && (
        <>
          <button
            type="button"
            onClick={() => onRenameNote?.(page)}
            className="rounded p-1 transition-opacity hover:opacity-70"
            style={{ color: 'var(--fg-muted)' }}
            aria-label={t('wiki.renameNote')}
            title={t('wiki.renameNote')}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            onClick={() => onDeleteNote?.(page)}
            className="rounded p-1 transition-opacity hover:opacity-70"
            style={{ color: 'oklch(65% 0.18 30)' }}
            aria-label={t('wiki.deleteNote')}
            title={t('wiki.deleteNote')}
          >
            <Trash2 size={12} />
          </button>
        </>
      )}
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

      {/* Zone sections */}
      {Object.entries(ZONE_LABELS).map(([zone, label]) => (
        <div key={zone}>
          <div className="flex items-center justify-between px-3 py-1.5">
            <button
              onClick={() => toggleZone(zone)}
              className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider transition-opacity hover:opacity-70"
              style={{ color: 'var(--fg-muted)' }}
            >
              {expanded[zone] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {label}
            </button>
            {zone === 'notes' && onCreateNote && (
              <button
                type="button"
                onClick={onCreateNote}
                className="rounded p-1 transition-opacity hover:opacity-70"
                style={{ color: 'var(--fg-muted)' }}
                aria-label={t('wiki.createNote')}
                title={t('wiki.createNote')}
              >
                <PlusSquare size={14} />
              </button>
            )}
          </div>

          {expanded[zone] && (
            <>
              <ul>
                {(grouped[zone] ?? []).map((page) => (
                  <li key={page.slug}>
                    {renderPageItem(page)}
                  </li>
                ))}
              </ul>
              {(grouped[zone] ?? []).length === 0 && (
                <p className="px-4 py-2 text-xs" style={{ color: 'var(--fg-muted)' }}>
                  {t('wiki.zoneEmpty')}
                </p>
              )}
            </>
          )}
        </div>
      ))}
    </nav>
  );
}
