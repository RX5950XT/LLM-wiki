'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FileText, Settings, ChevronDown, ChevronRight } from 'lucide-react';

interface PageEntry {
  slug: string;
  title: string | null;
  kind: string;
  zone: string;
}

interface PageTreeProps {
  workspaceId: string;
  initialPages: PageEntry[];
  activePage: string | null;
  onSelectPage: (slug: string) => void;
}

const ZONE_LABELS: Record<string, string> = {
  wiki: 'Wiki',
  notes: 'Notes',
  schema: 'Schema',
};

function groupByZoneAndKind(pages: PageEntry[]) {
  const groups: Record<string, PageEntry[]> = {};
  for (const page of pages) {
    const key = page.zone;
    if (!groups[key]) groups[key] = [];
    groups[key].push(page);
  }
  return groups;
}

export function PageTree({ workspaceId, initialPages, activePage, onSelectPage }: PageTreeProps) {
  const [pages, setPages] = useState(initialPages);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ wiki: true });

  const grouped = groupByZoneAndKind(pages);

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

      <div className="mt-auto border-t px-3 py-3" style={{ borderColor: 'var(--border)' }}>
        <Link
          href="/settings"
          className="flex items-center gap-2 text-xs transition-opacity hover:opacity-70"
          style={{ color: 'var(--fg-muted)' }}
        >
          <Settings size={13} />
          Settings
        </Link>
      </div>
    </nav>
  );
}
