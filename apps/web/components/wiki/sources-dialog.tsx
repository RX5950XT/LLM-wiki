'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link2, FileText, Type, Loader2, RotateCw, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

interface SourceEntry {
  id: string;
  kind: 'url' | 'file' | 'text';
  title: string | null;
  url: string | null;
  created_at: string;
  ingested_at: string | null;
  jobStatus?: string;
  jobError?: string | null;
  touchedCount?: number;
}

/**
 * Read-only list of ingested sources (Karpathy principle: sources are
 * immutable after ingest — this is visibility, not editing).
 */
export function SourcesDialog({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [sources, setSources] = useState<SourceEntry[] | null>(null);
  const [reingestingId, setReingestingId] = useState<string | null>(null);
  const [reingestError, setReingestError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const loadSources = useCallback(async () => {
    const supabase = createClient();
    const [{ data: rows }, { data: jobs }] = await Promise.all([
      supabase
        .from('sources')
        .select('id, kind, title, url, created_at, ingested_at')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('ingest_jobs')
        .select('source_id, status, error, touched_pages, started_at')
        .eq('workspace_id', workspaceId)
        .order('started_at', { ascending: false }),
    ]);
    const latestJob = new Map<string, { status: string; error: string | null; touched: number }>();
    for (const job of jobs ?? []) {
      if (!latestJob.has(job.source_id)) {
        latestJob.set(job.source_id, {
          status: job.status,
          error: job.error,
          touched: (job.touched_pages as string[] | null)?.length ?? 0,
        });
      }
    }
    setSources(
      (rows ?? []).map((row) => {
        const job = latestJob.get(row.id);
        return {
          ...row,
          jobStatus: job?.status,
          jobError: job?.error ?? null,
          touchedCount: job?.touched ?? 0,
        } as SourceEntry;
      }),
    );
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadSources();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSources]);

  const reingest = useCallback(
    async (sourceId: string) => {
      setReingestError(null);
      setReingestingId(sourceId);
      try {
        const res = await fetch(`/api/sources/${sourceId}/reingest`, { method: 'POST' });
        const data = (await res.json().catch(() => null)) as { jobId?: string; error?: string } | null;
        if (!res.ok || !data?.jobId) {
          throw new Error(data?.error ?? t('sources.reingestFailed'));
        }
        // Poll the shared ingest job protocol until it settles
        const jobId = data.jobId;
        for (;;) {
          await new Promise((r) => setTimeout(r, 3000));
          const poll = await fetch(`/api/ingest?job_id=${jobId}`);
          const job = (await poll.json().catch(() => null)) as { status?: string } | null;
          if (!job || job.status === 'done' || job.status === 'failed') break;
        }
        await loadSources();
      } catch (err) {
        setReingestError(err instanceof Error ? err.message : t('sources.reingestFailed'));
      } finally {
        setReingestingId(null);
      }
    },
    [loadSources, t],
  );

  const kindIcon = (kind: SourceEntry['kind']) =>
    kind === 'url' ? <Link2 size={14} /> : kind === 'file' ? <FileText size={14} /> : <Type size={14} />;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sources-title"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        style={{ background: 'oklch(8% 0.01 250 / 0.55)' }}
        onClick={onClose}
        aria-hidden="true"
        tabIndex={-1}
      />
      <div
        className="relative flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border shadow-lg"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
      >
        <div
          className="flex items-center justify-between border-b px-4 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <h2 id="sources-title" className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>
            {t('sources.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 transition-all duration-100 hover:opacity-70 active:scale-90"
            style={{ color: 'var(--fg-muted)' }}
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>
        <p className="px-4 pt-2 text-xs" style={{ color: 'var(--fg-muted)' }}>
          {t('sources.immutableHint')}
        </p>
        {reingestError && (
          <p className="mx-4 mt-2 rounded px-2 py-1 text-[11px]" style={{ background: 'var(--bg-2)', color: 'oklch(65% 0.18 30)' }} role="alert">
            {reingestError}
          </p>
        )}
        <div className="flex-1 overflow-y-auto p-3">
          {sources === null ? (
            <div className="flex justify-center py-8">
              <Loader2 size={18} className="animate-spin" style={{ color: 'var(--fg-muted)' }} />
            </div>
          ) : sources.length === 0 ? (
            <p className="py-8 text-center text-xs" style={{ color: 'var(--fg-muted)' }}>
              {t('sources.empty')}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {sources.map((source) => (
                <li
                  key={source.id}
                  className="rounded-md border px-3 py-2"
                  style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
                >
                  <div className="flex items-center gap-2">
                    <span style={{ color: 'var(--fg-muted)' }}>{kindIcon(source.kind)}</span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium" style={{ color: 'var(--fg)' }}>
                      {source.title || source.url || t('common.untitled')}
                    </span>
                    <span className="shrink-0 text-[10px]" style={{ color: 'var(--fg-muted)' }}>
                      {new Date(source.created_at).toLocaleDateString(locale)}
                    </span>
                  </div>
                  {source.url && (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-0.5 block truncate text-[10px] underline-offset-2 hover:underline"
                      style={{ color: 'var(--fg-muted)' }}
                    >
                      {source.url}
                    </a>
                  )}
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate text-[10px]">
                      {reingestingId === source.id ? (
                        <span style={{ color: 'var(--color-accent)' }}>{t('sources.reingesting')}</span>
                      ) : source.jobStatus === 'failed' ? (
                        <span style={{ color: 'oklch(65% 0.18 30)' }}>
                          {t('sources.statusFailed')}
                          {source.jobError ? ` — ${source.jobError}` : ''}
                        </span>
                      ) : source.ingested_at ? (
                        <span style={{ color: 'var(--color-accent)' }}>
                          {t('sources.statusDone', { count: source.touchedCount ?? 0 })}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--fg-muted)' }}>{t('sources.statusRunning')}</span>
                      )}
                    </p>
                    <button
                      type="button"
                      onClick={() => reingest(source.id)}
                      disabled={reingestingId !== null}
                      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-opacity hover:opacity-70 disabled:opacity-40"
                      style={{
                        color: source.jobStatus === 'failed' ? 'var(--color-accent)' : 'var(--fg-muted)',
                      }}
                      title={t('sources.reingest')}
                      aria-label={t('sources.reingest')}
                    >
                      <RotateCw
                        size={11}
                        className={reingestingId === source.id ? 'animate-spin' : undefined}
                      />
                      {t('sources.reingest')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
