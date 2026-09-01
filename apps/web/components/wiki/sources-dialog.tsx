'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link2, FileText, Type, Loader2, RotateCw, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { isDriveReconnectError, reconnectGoogleDrive } from '@/lib/google/drive-reconnect';
import { parseIngestQueueJob, parseIngestStartResponse } from './ingest-queue';
import { isSafeHttpUrl, useDialogFocus } from './dialog-focus';

interface SourceEntry {
  id: string;
  kind: 'url' | 'file' | 'text';
  title: string | null;
  url: string | null;
  created_at: string;
  ingested_at: string | null;
  jobStatus?: string;
  jobPhase?: string;
  jobResult?: 'updated' | 'unchanged' | null;
  jobError?: string | null;
  touchedCount?: number;
}

class SourceApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function readJsonBody(response: Response, fallback: string): Promise<unknown> {
  const raw = await response.text();
  if (!(response.headers.get('content-type')?.toLowerCase().includes('application/json') ?? false)) {
    throw new SourceApiError(raw.trim() || fallback, response.status);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new SourceApiError(fallback, response.status);
  }
}

function apiError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && !Array.isArray(error) && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as Record<string, unknown>).message as string;
  }
  return null;
}

function sourceJobStatusLabel(
  t: ReturnType<typeof useTranslations>,
  status: string | undefined,
): string {
  if (status === 'pending') return t('ingest.statusPending');
  if (status === 'running') return t('ingest.statusRunning');
  if (status === 'paused') return t('ingest.statusPaused');
  if (status === 'done') return t('ingest.statusDone');
  if (status === 'failed') return t('ingest.statusFailed');
  return t('ingest.statusPending');
}

function sourceJobPhaseLabel(
  t: ReturnType<typeof useTranslations>,
  phase: string | undefined,
): string | null {
  if (phase === 'analysis') return t('ingest.phaseAnalysis');
  if (phase === 'writing') return t('ingest.phaseWriting');
  if (phase === 'review') return t('ingest.phaseReview');
  if (phase === 'done') return t('ingest.phaseDone');
  return null;
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
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const loadSources = useCallback(async () => {
    setSourcesError(null);
    try {
      const supabase = createClient();
      const [sourcesResult, jobsResult] = await Promise.all([
        supabase
          .from('sources')
          .select('id, kind, title, url, created_at, ingested_at')
          .eq('workspace_id', workspaceId)
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('ingest_jobs')
          .select('source_id, status, phase, result, error, touched_pages, updated_at')
          .eq('workspace_id', workspaceId)
          .order('updated_at', { ascending: false }),
      ]);
      if (sourcesResult.error || jobsResult.error) throw new Error(t('sources.loadFailed'));

      const latestJob = new Map<string, { status: string; phase: string; result: 'updated' | 'unchanged' | null; error: string | null; touched: number }>();
      for (const job of jobsResult.data ?? []) {
        if (!latestJob.has(job.source_id)) {
          latestJob.set(job.source_id, {
            status: job.status,
            phase: job.phase,
            result: job.result === 'updated' || job.result === 'unchanged' ? job.result : null,
            error: job.error,
            touched: (job.touched_pages as string[] | null)?.length ?? 0,
          });
        }
      }
      setSources(
        (sourcesResult.data ?? []).map((row) => {
          const job = latestJob.get(row.id);
          return {
            ...row,
            jobStatus: job?.status,
            jobPhase: job?.phase,
            jobResult: job?.result ?? null,
            jobError: job?.error ?? null,
            touchedCount: job?.touched ?? 0,
          } as SourceEntry;
        }),
      );
    } catch (error) {
      setSourcesError(error instanceof Error ? error.message : t('sources.loadFailed'));
    }
  }, [t, workspaceId]);

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
        const value = await readJsonBody(res, t('sources.reingestFailed'));
        if (!res.ok) {
          const message = apiError(value) ?? t('sources.reingestFailed');
          if (res.status === 403 && isDriveReconnectError(message)) {
            try {
              await reconnectGoogleDrive(`/w/${workspaceId}`);
            } catch {
              /* Keep the server message visible when reauthorization cannot start. */
            }
          }
          throw new Error(message);
        }
        const data = parseIngestStartResponse(value);
        if (!data) throw new Error(t('sources.invalidReingestResponse'));
        const jobId = data.jobId;
        if (data.status === 'done') {
          await loadSources();
          return;
        }
        const deadline = Date.now() + 6 * 60 * 1000;
        for (; Date.now() < deadline;) {
          await new Promise((r) => setTimeout(r, 3000));
          const poll = await fetch(`/api/ingest?job_id=${jobId}`);
          const pollValue = await readJsonBody(poll, t('sources.reingestFailed'));
          if (!poll.ok) throw new Error(apiError(pollValue) ?? t('sources.reingestFailed'));
          const job = parseIngestQueueJob(pollValue);
          if (!job) throw new Error(t('sources.invalidReingestResponse'));
          if (job.status === 'done' || job.status === 'failed' || job.status === 'paused') break;
        }
        await loadSources();
      } catch (err) {
        if (err instanceof SourceApiError && err.status === 403 && isDriveReconnectError(err.message)) {
          try {
            await reconnectGoogleDrive(`/w/${workspaceId}`);
          } catch {
            /* Keep the server message visible when reauthorization cannot start. */
          }
        }
        setReingestError(err instanceof Error ? err.message : t('sources.reingestFailed'));
      } finally {
        setReingestingId(null);
      }
    },
    [loadSources, t, workspaceId],
  );

  const kindIcon = (kind: SourceEntry['kind']) =>
    kind === 'url' ? <Link2 size={14} /> : kind === 'file' ? <FileText size={14} /> : <Type size={14} />;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sources-title"
      aria-busy={sources === null}
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
        ref={dialogRef}
        tabIndex={-1}
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
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md transition-all duration-100 hover:opacity-70 active:scale-90 focus-visible:outline-2 focus-visible:outline-offset-2"
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
        {sourcesError && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-md px-2 py-1 text-[11px]" style={{ background: 'var(--bg-2)', color: 'oklch(65% 0.18 30)' }} role="alert">
            <span className="min-w-0 flex-1">{sourcesError}</span>
            <button type="button" onClick={() => void loadSources()} className="min-h-11 shrink-0 rounded-md px-2 font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2">{t('sources.retry')}</button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-3">
          {sourcesError && sources === null ? (
            <p className="py-8 text-center text-xs" style={{ color: 'var(--fg-muted)' }}>{t('sources.loadFailed')}</p>
          ) : sources === null ? (
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
                  {isSafeHttpUrl(source.url) && (
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
                            {sourceJobStatusLabel(t, source.jobStatus)}
                            {source.jobError ? ` — ${source.jobError}` : ''}
                          </span>
                        ) : source.jobResult === 'unchanged' ? (
                          <span style={{ color: 'var(--fg-muted)' }}>{sourceJobStatusLabel(t, source.jobStatus)} · {t('ingest.resultUnchanged')}</span>
                        ) : source.jobStatus ? (
                          <span style={{ color: source.jobStatus === 'done' ? 'var(--color-accent)' : 'var(--fg-muted)' }}>
                            {sourceJobStatusLabel(t, source.jobStatus)}{sourceJobPhaseLabel(t, source.jobPhase) ? ` · ${sourceJobPhaseLabel(t, source.jobPhase)}` : ''} · {t('ingest.touchedPages', { count: source.touchedCount ?? 0 })}
                          </span>
                        ) : source.ingested_at ? (
                          <span style={{ color: 'var(--color-accent)' }}>
                            {t('sources.statusDone', { count: source.touchedCount ?? 0 })}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--fg-muted)' }}>{t('ingest.statusPending')}</span>
                        )}
                    </p>
                    <button
                      type="button"
                      onClick={() => reingest(source.id)}
                      disabled={reingestingId !== null}
                      className="flex min-h-11 shrink-0 items-center gap-1 rounded px-2 text-[10px] transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
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
