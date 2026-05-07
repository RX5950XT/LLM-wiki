'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, ChevronDown, ChevronRight } from 'lucide-react';

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

function groupByZone(pages: PageEntry[]) {
  const groups: Record<string, PageEntry[]> = {};
  for (const page of pages) {
    if (!groups[page.zone]) groups[page.zone] = [];
    groups[page.zone]!.push(page);
  }
  return groups;
}

export function PageTree({ initialPages, activePage, onSelectPage }: PageTreeProps) {
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
    schema: t('wiki.zoneSchema'),
  };

  const ZONE_HINTS: Record<string, string> = {
    wiki: t('wiki.zoneWikiHint'),
    notes: t('wiki.zoneNotesHint'),
    schema: t('wiki.zoneSchemaHint'),
  };

  const pages = useMemo(() => initialPages, [initialPages]);
  const pinnedPages = PINNED_SLUGS
    .map((s) => pages.find((p) => p.slug === s))
    .filter((p): p is PageEntry => p != null);

  const otherPages = pages.filter((p) => !PINNED_SLUGS.includes(p.slug));
  const grouped = groupByZone(otherPages);

  const toggleZone = (zone: string) =>
    setExpanded((s) => ({ ...s, [zone]: !s[zone] }));

  const renderPageItem = (page: PageEntry, label?: string) => (
    <button
      key={page.slug}
      onClick={() => onSelectPage(page.slug)}
      className="flex w-full items-center gap-2 px-4 py-1.5 text-sm transition-colors"
      style={{
        background: activePage === page.slug ? 'var(--color-accent-glow)' : undefined,
        color: activePage === page.slug ? 'var(--color-accent)' : 'var(--fg)',
        borderLeft: activePage === page.slug ? '2px solid var(--color-accent)' : '2px solid transparent',
      }}
    >
      <FileText size={13} style={{ opacity: 0.6 }} />
      <span className="truncate">{label ?? SYSTEM_LABELS[page.slug] ?? page.title ?? page.slug}</span>
    </button>
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
          <button
            onClick={() => toggleZone(zone)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-opacity hover:opacity-70"
            style={{ color: 'var(--fg-muted)' }}
          >
            {expanded[zone] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {label}
          </button>

          {expanded[zone] && (
            <>
              <p className="px-4 pb-1 text-[11px] leading-5" style={{ color: 'var(--fg-muted)' }}>
                {ZONE_HINTS[zone]}
              </p>
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
