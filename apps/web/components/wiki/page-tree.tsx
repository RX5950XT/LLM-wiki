'use client';

import { useState } from 'react';
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
  const [pages] = useState(initialPages);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ wiki: true });

  const ZONE_LABELS: Record<string, string> = {
    wiki: t('wiki.zoneWiki'),
    notes: t('wiki.zoneNotes'),
    schema: t('wiki.zoneSchema'),
  };

  const grouped = groupByZone(pages);
  const toggleZone = (zone: string) =>
    setExpanded((s) => ({ ...s, [zone]: !s[zone] }));

  return (
    <nav
      className="flex h-full flex-col overflow-y-auto py-3"
      style={{ color: 'var(--fg)' }}
    >
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
            <ul>
              {(grouped[zone] ?? []).map((page) => (
                <li key={page.slug}>
                  <button
                    onClick={() => onSelectPage(page.slug)}
                    className="flex w-full items-center gap-2 px-4 py-1.5 text-sm transition-colors"
                    style={{
                      background: activePage === page.slug ? 'var(--color-accent-glow)' : undefined,
                      color: activePage === page.slug ? 'var(--color-accent)' : 'var(--fg)',
                      borderLeft: activePage === page.slug ? '2px solid var(--color-accent)' : '2px solid transparent',
                    }}
                  >
                    <FileText size={13} style={{ opacity: 0.6 }} />
                    <span className="truncate">{page.title ?? page.slug}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </nav>
  );
}
