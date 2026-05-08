'use client';

import { useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PageViewer } from '@/components/wiki/page-viewer';

interface RulePage {
  slug: string;
  title: string | null;
}

interface RulesPanelProps {
  workspaceId: string;
  pages: RulePage[];
}

export function RulesPanel({ workspaceId, pages }: RulesPanelProps) {
  const t = useTranslations();
  const orderedPages = useMemo(() => pages, [pages]);
  const [activeSlug, setActiveSlug] = useState<string | null>(orderedPages[0]?.slug ?? null);

  if (orderedPages.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
        {t('wiki.zoneEmpty')}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {orderedPages.map((page) => {
          const selected = page.slug === activeSlug;
          return (
            <button
              key={page.slug}
              type="button"
              onClick={() => setActiveSlug(page.slug)}
              className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-opacity hover:opacity-80"
              style={{
                borderColor: selected ? 'var(--color-accent)' : 'var(--border)',
                background: selected ? 'var(--color-accent-glow)' : 'var(--bg-2)',
                color: selected ? 'var(--color-accent)' : 'var(--fg)',
              }}
            >
              <FileText size={14} />
              <span>{page.title ?? page.slug}</span>
            </button>
          );
        })}
      </div>

      {activeSlug && (
        <div
          className="overflow-hidden rounded-2xl border"
          style={{ borderColor: 'var(--border)', minHeight: 420 }}
        >
          <PageViewer workspaceId={workspaceId} slug={activeSlug} />
        </div>
      )}
    </div>
  );
}
