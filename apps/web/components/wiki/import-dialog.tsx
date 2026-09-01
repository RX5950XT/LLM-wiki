'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Clock3,
  FileUp,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { isDriveReconnectError, reconnectGoogleDrive } from '@/lib/google/drive-reconnect';
import {
  isActiveIngestStatus,
  ingestFileMimeForUpload,
  isSupportedIngestFile,
  mergeIngestQueueJobs,
  parseIngestJobsResponse,
  parseIngestQueueJob,
  parseIngestStartResponse,
  type IngestQueueJob,
  type IngestQueueStatus,
} from './ingest-queue';
import { useDialogFocus } from './dialog-focus';

const MAX_INGEST_FILE_BYTES = 2 * 1024 * 1024;
const INGEST_POLL_MS = 4000;
const INGEST_JOB_STORAGE_KEY = 'llm-wiki:ingest-job-ids';
const INGEST_FILE_ACCEPT = '.txt,.md,.pdf,.docx,.pptx,.epub,.png,.jpg,.jpeg,.webp,.gif';

function isUrl(text: string): boolean {
  try {
    const u = new URL(text.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function extractTitle(text: string, fallbackTitle: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? fallbackTitle;
  return line.replace(/^#+\s*/, '').trim().slice(0, 80);
}

interface UploadItem {
  name: string;
  status: 'pending' | 'uploading' | 'queued' | 'error';
  jobId?: string;
  error?: string;
}

interface ImportDialogProps {
  workspaceId: string;
  workspaceName: string;
  profileId: string | null;
  onClose: () => void;
  onSourceAdded?: () => void;
  /** Auto-routing may create a workspace — the switcher needs to hear about it */
  onWorkspaceCreated?: () => void;
}

interface SubmittedJobMeta {
  sourceTitle: string;
  sourceMimeType: string;
  workspaceName?: string;
}

class ApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

function apiErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.error === 'string') return body.error;
  if (body.error && typeof body.error === 'object' && !Array.isArray(body.error)) {
    const error = body.error as Record<string, unknown>;
    if (typeof error.message === 'string') return error.message;
  }
  return null;
}

async function readJsonResponse(response: Response, fallback: string): Promise<unknown> {
  const raw = await response.text();
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    throw new ApiResponseError(raw.trim() || fallback, response.status);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ApiResponseError(fallback, response.status);
  }
  if (!response.ok) {
    throw new ApiResponseError(apiErrorMessage(value) ?? fallback, response.status);
  }
  return value;
}

function readStoredJobIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(INGEST_JOB_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === 'string').slice(0, 50);
  } catch {
    return [];
  }
}

function writeStoredJobIds(ids: readonly string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(INGEST_JOB_STORAGE_KEY, JSON.stringify([...new Set(ids)].slice(0, 50)));
  } catch {
    /* Private browsing can deny storage; the server remains the source of truth. */
  }
}

function rememberJobId(jobId: string): void {
  writeStoredJobIds([jobId, ...readStoredJobIds()]);
}

function statusLabel(t: ReturnType<typeof useTranslations>, status: IngestQueueStatus): string {
  switch (status) {
    case 'pending':
      return t('ingest.statusPending');
    case 'running':
      return t('ingest.statusRunning');
    case 'paused':
      return t('ingest.statusPaused');
    case 'done':
      return t('ingest.statusDone');
    case 'failed':
      return t('ingest.statusFailed');
  }
}

function phaseLabel(t: ReturnType<typeof useTranslations>, phase: IngestQueueJob['phase']): string {
  switch (phase) {
    case 'analysis':
      return t('ingest.phaseAnalysis');
    case 'writing':
      return t('ingest.phaseWriting');
    case 'review':
      return t('ingest.phaseReview');
    case 'done':
      return t('ingest.phaseDone');
  }
}

function statusColor(status: IngestQueueStatus): string {
  if (status === 'done') return 'oklch(65% 0.22 145)';
  if (status === 'failed') return 'oklch(65% 0.18 30)';
  if (status === 'paused') return 'oklch(75% 0.16 80)';
  return 'var(--color-accent)';
}

function prepareFileForUpload(file: File): File {
  const mime = ingestFileMimeForUpload(file.name, file.type);
  if (mime === file.type) return file;
  return new File([file], file.name, { type: mime, lastModified: file.lastModified });
}

/**
 * Unified import entry. Submitted jobs are persisted server-side; this dialog
 * only keeps a short local ID list to rediscover jobs routed to another workspace.
 */
export function ImportDialog({
  workspaceId,
  workspaceName,
  profileId,
  onClose,
  onSourceAdded,
  onWorkspaceCreated,
}: ImportDialogProps) {
  const t = useTranslations();
  const locale = useLocale();
  const [input, setInput] = useState('');
  const [target, setTarget] = useState<'auto' | 'current'>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [jobs, setJobs] = useState<IngestQueueJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const loadingJobsRef = useRef(false);
  const submittedMetaRef = useRef(new Map<string, SubmittedJobMeta>());
  const previousJobStatusesRef = useRef(new Map<string, IngestQueueStatus>());
  const dialogRef = useDialogFocus<HTMLDivElement>();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const withSubmittedMeta = useCallback((job: IngestQueueJob): IngestQueueJob => {
    const meta = submittedMetaRef.current.get(job.id);
    return {
      ...job,
      source_title: job.source_title ?? meta?.sourceTitle ?? null,
      source_mime_type: job.source_mime_type ?? meta?.sourceMimeType ?? null,
      workspace_name: job.workspace_name ?? meta?.workspaceName,
    };
  }, []);

  const fetchJobDetail = useCallback(
    async (jobId: string): Promise<IngestQueueJob | null> => {
      const response = await fetch(`/api/ingest?job_id=${encodeURIComponent(jobId)}`);
      if (response.status === 404) return null;
      const value = await readJsonResponse(response, t('ingest.jobsLoadFailed'));
      const job = parseIngestQueueJob(value);
      if (!job) throw new Error(t('ingest.invalidJobResponse'));
      return job;
    },
    [t],
  );

  const loadJobs = useCallback(
    async (quiet = false) => {
      if (loadingJobsRef.current) return;
      loadingJobsRef.current = true;
      if (!quiet) {
        setJobsLoading(true);
        setJobsError(null);
      }
      try {
        const listResponse = await fetch(`/api/ingest?workspace_id=${encodeURIComponent(workspaceId)}`);
        const listValue = await readJsonResponse(listResponse, t('ingest.jobsLoadFailed'));
        const listed = parseIngestJobsResponse(listValue, workspaceId);
        if (!listed) throw new Error(t('ingest.invalidJobsResponse'));

        const baseJobs = listed.map(withSubmittedMeta);
        const storedIds = readStoredJobIds();
        const detailIds = [
          ...new Set([
            ...baseJobs.filter((job) => isActiveIngestStatus(job.status)).map((job) => job.id),
            ...storedIds,
          ]),
        ];
        const detailResults = await Promise.allSettled(detailIds.map((jobId) => fetchJobDetail(jobId)));
        const detailJobs: IngestQueueJob[] = [];
        const missingIds = new Set<string>();
        detailResults.forEach((entry, index) => {
          if (entry.status === 'fulfilled') {
            if (entry.value) detailJobs.push(withSubmittedMeta(entry.value));
            else if (detailIds[index]) missingIds.add(detailIds[index]);
          }
        });

        const merged = mergeIngestQueueJobs(baseJobs, detailJobs).map(withSubmittedMeta);
        setJobs(merged);
        const mergedById = new Map(merged.map((job) => [job.id, job]));
        writeStoredJobIds([
          ...storedIds.filter((id) => {
            if (missingIds.has(id)) return false;
            const knownJob = mergedById.get(id);
            return !knownJob || isActiveIngestStatus(knownJob.status);
          }),
          ...merged.filter((job) => isActiveIngestStatus(job.status)).map((job) => job.id),
        ]);
        setJobsError(null);
      } catch (caught) {
        setJobsError(caught instanceof Error ? caught.message : t('ingest.jobsLoadFailed'));
      } finally {
        loadingJobsRef.current = false;
        setJobsLoading(false);
      }
    },
    [fetchJobDetail, t, withSubmittedMeta, workspaceId],
  );

  useEffect(() => {
    setJobs([]);
    setJobsError(null);
    previousJobStatusesRef.current.clear();
    void loadJobs();
    const timer = window.setInterval(() => void loadJobs(true), INGEST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadJobs]);

  useEffect(() => {
    const previous = previousJobStatusesRef.current;
    if (jobs.some((job) => job.status === 'done' && previous.get(job.id) && previous.get(job.id) !== 'done')) {
      onSourceAdded?.();
    }
    previousJobStatusesRef.current = new Map(jobs.map((job) => [job.id, job.status]));
  }, [jobs, onSourceAdded]);

  const handleRequestError = useCallback(
    async (caught: unknown): Promise<string> => {
      if (caught instanceof ApiResponseError && caught.status === 403 && isDriveReconnectError(caught.message)) {
        try {
          await reconnectGoogleDrive(`/w/${workspaceId}`);
        } catch {
          /* Keep the server message visible when reauthorization cannot start. */
        }
      }
      return caught instanceof Error ? caught.message : t('ingest.failedGeneric');
    },
    [t, workspaceId],
  );

  const submitIngest = useCallback(
    async (
      payload:
        | { kind: 'url'; url: string }
        | { kind: 'text'; title: string; content: string }
        | { file: File },
    ) => {
      const targetFields =
        target === 'auto'
          ? { auto_route: true, fallback_workspace_id: workspaceId }
          : { workspace_id: workspaceId };
      const headers = { 'x-llm-wiki-locale': locale };
      let response: Response;
      let sourceTitle = 'Imported source';
      let sourceMimeType = 'text/plain';

      if ('file' in payload) {
        const uploadFile = prepareFileForUpload(payload.file);
        const form = new FormData();
        form.append('file', uploadFile, uploadFile.name);
        for (const [key, value] of Object.entries(targetFields)) form.append(key, String(value));
        if (profileId) form.append('profile_id', profileId);
        response = await fetch('/api/ingest', { method: 'POST', headers, body: form });
        sourceTitle = uploadFile.name;
        sourceMimeType = uploadFile.type || 'application/octet-stream';
      } else {
        response = await fetch('/api/ingest', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, ...targetFields, profile_id: profileId }),
        });
        sourceTitle = payload.kind === 'text' ? payload.title : payload.url;
        sourceMimeType = payload.kind === 'url' ? 'text/markdown' : 'text/plain';
      }

      const value = await readJsonResponse(response, t('ingest.failedGeneric'));
      const started = parseIngestStartResponse(value);
      if (!started) throw new Error(t('ingest.invalidStartResponse'));

      submittedMetaRef.current.set(started.jobId, {
        sourceTitle,
        sourceMimeType,
        ...(started.routed_workspace_name ? { workspaceName: started.routed_workspace_name } : {}),
      });
      rememberJobId(started.jobId);
      const placeholder: IngestQueueJob = {
        id: started.jobId,
        workspace_id: started.routed_workspace_id ?? workspaceId,
        source_id: '',
        status: started.status,
        phase: started.status === 'done' ? 'done' : 'analysis',
        result: started.result,
        error: null,
        touched_pages: [],
        attempt_count: 0,
        started_at: null,
        finished_at: null,
        updated_at: new Date().toISOString(),
        source_title: sourceTitle,
        source_mime_type: sourceMimeType,
        workspace_name: started.routed_workspace_name,
      };
      setJobs((previous) => mergeIngestQueueJobs([withSubmittedMeta(placeholder)], previous));
      if (started.routed_workspace_created === true) onWorkspaceCreated?.();
      return started;
    },
    [locale, onWorkspaceCreated, profileId, t, target, withSubmittedMeta, workspaceId],
  );

  const describeQueued = useCallback(
    (started: {
      status: IngestQueueStatus;
      result: 'updated' | 'unchanged' | null;
      routed_workspace_name?: string;
      routed_workspace_created?: boolean;
    }) => {
      const state = started.result === 'unchanged' ? t('ingest.resultUnchanged') : t('ingest.queuedStatus');
      if (!started.routed_workspace_name) return state;
      const where = started.routed_workspace_created
        ? t('ingest.routedToNew', { name: started.routed_workspace_name })
        : t('ingest.routedTo', { name: started.routed_workspace_name });
      return `${where} — ${state}`;
    },
    [t],
  );

  const handleSubmitText = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const payload = isUrl(trimmed)
        ? { kind: 'url' as const, url: trimmed }
        : { kind: 'text' as const, title: extractTitle(trimmed, t('common.untitled')), content: trimmed };
      const started = await submitIngest(payload);
      setInput('');
      setResult(describeQueued(started));
      onSourceAdded?.();
    } catch (caught) {
      setError(await handleRequestError(caught));
    } finally {
      setBusy(false);
    }
  }, [busy, describeQueued, handleRequestError, input, onSourceAdded, submitIngest, t]);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0 || busy) return;
      const entries = Array.from(files);
      setQueue(
        entries.map((file) => ({
          name: file.name,
          status: isSupportedIngestFile(file.name, file.type) && file.size <= MAX_INGEST_FILE_BYTES ? 'pending' : 'error',
          error:
            file.size > MAX_INGEST_FILE_BYTES
              ? t('ingest.fileTooLarge')
              : !isSupportedIngestFile(file.name, file.type)
                ? t('ingest.unsupportedType')
                : undefined,
        })),
      );
      setBusy(true);
      setError(null);
      setResult(null);
      let accepted = 0;
      let lastStarted: Awaited<ReturnType<typeof submitIngest>> | null = null;

      for (const [index, file] of entries.entries()) {
        if (!isSupportedIngestFile(file.name, file.type) || file.size > MAX_INGEST_FILE_BYTES) continue;
        setQueue((previous) => previous.map((item, itemIndex) => (itemIndex === index ? { ...item, status: 'uploading' } : item)));
        try {
          const started = await submitIngest({ file });
          lastStarted = started;
          accepted += 1;
          setQueue((previous) =>
            previous.map((item, itemIndex) =>
              itemIndex === index ? { ...item, status: 'queued', jobId: started.jobId } : item,
            ),
          );
        } catch (caught) {
          const message = await handleRequestError(caught);
          setQueue((previous) =>
            previous.map((item, itemIndex) =>
              itemIndex === index
                ? { ...item, status: 'error', error: message }
                : item,
            ),
          );
        }
      }

      if (accepted > 0) {
        onSourceAdded?.();
        setResult(accepted === 1 && lastStarted ? describeQueued(lastStarted) : t('ingest.batchQueued', { count: accepted }));
      }
      setBusy(false);
    },
    [busy, describeQueued, handleRequestError, onSourceAdded, submitIngest, t],
  );

  const updateJob = useCallback(
    async (job: IngestQueueJob, action: 'pause' | 'resume' | 'retry') => {
      const key = `${job.id}:${action}`;
      setActionKey(key);
      setActionErrors((previous) => ({ ...previous, [job.id]: '' }));
      try {
        const response = await fetch('/api/ingest', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-llm-wiki-locale': locale },
          body: JSON.stringify({ job_id: job.id, action }),
        });
        const value = await readJsonResponse(response, t('ingest.jobActionFailed'));
        const updated = parseIngestQueueJob(value);
        if (!updated) throw new Error(t('ingest.invalidJobResponse'));
        rememberJobId(updated.id);
        setJobs((previous) => mergeIngestQueueJobs(previous, [withSubmittedMeta(updated)]));
      } catch (caught) {
        setActionErrors((previous) => ({
          ...previous,
          [job.id]: caught instanceof Error ? caught.message : t('ingest.jobActionFailed'),
        }));
      } finally {
        setActionKey(null);
      }
    },
    [locale, t, withSubmittedMeta],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-dialog-title"
      aria-busy={busy || jobsLoading}
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
        className="relative flex max-h-[90vh] w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-xl border p-5 shadow-2xl"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="import-dialog-title" className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>
            {t('ingest.dialogTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ color: 'var(--fg-muted)' }}
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t('ingest.target')}>
          {[
            { value: 'auto' as const, label: t('ingest.targetAuto') },
            { value: 'current' as const, label: t('ingest.targetCurrent', { name: workspaceName }) },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={target === option.value}
              disabled={busy}
              onClick={() => setTarget(option.value)}
              className="min-h-11 rounded-full border px-3 py-1 text-xs transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
              style={{
                borderColor: target === option.value ? 'var(--color-accent)' : 'var(--border)',
                background: target === option.value ? 'var(--color-accent-muted)' : 'var(--bg-2)',
                color: 'var(--fg)',
              }}
            >
              {option.label}
            </button>
          ))}
        </div>

        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void handleFiles(event.dataTransfer.files);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void handleSubmitText();
          }}
          placeholder={dragging ? t('ingest.dropHere') : t('ingest.placeholder')}
          rows={5}
          autoFocus
          className="w-full resize-none rounded-md border px-3 py-2 text-sm outline-none transition-all duration-150 focus-visible:ring-1"
          style={{
            background: dragging ? 'var(--color-accent-glow)' : 'var(--bg-2)',
            borderColor: dragging ? 'var(--color-accent)' : 'var(--border)',
            color: 'var(--fg)',
          }}
          disabled={busy}
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            className="flex min-h-11 cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-opacity hover:opacity-70 focus-within:outline-2 focus-within:outline-offset-2"
            style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
          >
            <Upload size={14} />
            {t('ingest.uploadFile')}
            <input
              type="file"
              accept={INGEST_FILE_ACCEPT}
              multiple
              className="sr-only"
              onChange={(event) => {
                void handleFiles(event.target.files);
                event.target.value = '';
              }}
              disabled={busy}
            />
          </label>
          <button
            type="button"
            onClick={() => void handleSubmitText()}
            disabled={busy || !input.trim()}
            className="flex min-h-11 items-center justify-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-medium transition-all duration-100 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
            style={{ background: 'var(--color-accent)', color: 'oklch(10% 0.015 250)' }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : t('ingest.button')}
          </button>
        </div>

        <p className="text-[11px]" style={{ color: 'var(--fg-muted)' }}>
          {t('ingest.supportedFiles')}
        </p>

        {error && (
          <p className="rounded-md px-2.5 py-2 text-xs" style={{ background: 'var(--bg-2)', color: 'oklch(65% 0.18 30)' }} role="alert">
            {error}
          </p>
        )}
        {result && (
          <p className="rounded-md px-2.5 py-2 text-xs" style={{ background: 'var(--color-accent-glow)', color: 'var(--color-accent)' }} role="status">
            {result}
          </p>
        )}

        {queue.length > 0 && (
          <div className="space-y-1.5" aria-live="polite" aria-label={t('ingest.uploadQueue')}>
            {queue.map((item, index) => (
              <div
                key={`${item.name}-${index}`}
                className="flex min-h-11 items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
                style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
              >
                <FileUp size={14} style={{ color: 'var(--fg-muted)' }} />
                <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--fg)' }}>{item.name}</span>
                {item.status === 'pending' && <span style={{ color: 'var(--fg-muted)' }}>{t('ingest.queuePending')}</span>}
                {item.status === 'uploading' && <Loader2 size={14} className="animate-spin" style={{ color: 'var(--color-accent)' }} />}
                {item.status === 'queued' && <span style={{ color: 'var(--color-accent)' }}>{t('ingest.queueQueued')}</span>}
                {item.status === 'error' && <span className="truncate" style={{ color: 'oklch(65% 0.18 30)' }}>{item.error ?? t('ingest.failed')}</span>}
              </div>
            ))}
          </div>
        )}

        <section className="border-t pt-3" style={{ borderColor: 'var(--border)' }} aria-labelledby="ingest-jobs-title">
          <div className="flex items-center justify-between gap-2">
            <h3 id="ingest-jobs-title" className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>
              {t('ingest.queueTitle')}
            </h3>
            <button
              type="button"
              onClick={() => void loadJobs()}
              disabled={jobsLoading}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-md transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
              style={{ color: 'var(--fg-muted)' }}
              aria-label={t('ingest.refreshQueue')}
            >
              <RefreshCw size={15} className={jobsLoading ? 'animate-spin' : undefined} />
            </button>
          </div>

          {jobsError && (
            <div className="mt-2 flex items-center gap-2 rounded-md px-2.5 py-2 text-xs" style={{ background: 'var(--bg-2)', color: 'oklch(65% 0.18 30)' }} role="alert">
              <AlertCircle size={14} className="shrink-0" />
              <span className="min-w-0 flex-1">{jobsError}</span>
              <button type="button" onClick={() => void loadJobs()} className="min-h-11 rounded-md px-2 font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2">{t('ingest.retry')}</button>
            </div>
          )}

          {jobsLoading && jobs.length === 0 ? (
            <div className="flex justify-center py-6" role="status" aria-label={t('common.loading')}>
              <Loader2 size={18} className="animate-spin" style={{ color: 'var(--fg-muted)' }} />
            </div>
          ) : jobs.length === 0 ? (
            <p className="py-5 text-center text-xs" style={{ color: 'var(--fg-muted)' }}>{t('ingest.queueEmpty')}</p>
          ) : (
            <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto">
              {jobs.map((job) => {
                const action = job.status === 'paused' ? 'resume' : job.status === 'failed' ? 'retry' : 'pause';
                const actionLabel = action === 'pause' ? t('ingest.pause') : action === 'resume' ? t('ingest.resume') : t('ingest.retry');
                const actionIcon = action === 'pause' ? <Pause size={13} /> : action === 'resume' ? <Play size={13} /> : <RotateCcw size={13} />;
                const actionBusy = actionKey === `${job.id}:${action}`;
                const actionError = actionErrors[job.id];
                return (
                  <li key={job.id} className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}>
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0" style={{ color: statusColor(job.status) }}>
                        {job.status === 'done' ? <CheckCircle size={14} /> : job.status === 'failed' ? <AlertCircle size={14} /> : job.status === 'paused' ? <Pause size={14} /> : <Clock3 size={14} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium" style={{ color: 'var(--fg)' }}>{job.source_title || t('common.untitled')}</p>
                        <p className="mt-0.5 truncate text-[10px]" style={{ color: 'var(--fg-muted)' }}>
                          {statusLabel(t, job.status)} · {phaseLabel(t, job.phase)} · {t('ingest.touchedPages', { count: job.touched_pages.length })}
                          {job.result === 'unchanged' ? ` · ${t('ingest.resultUnchanged')}` : job.result === 'updated' ? ` · ${t('ingest.resultUpdated')}` : ''}
                        </p>
                        {job.workspace_id !== workspaceId && (
                          <p className="mt-0.5 truncate text-[10px]" style={{ color: 'var(--color-accent)' }}>
                            {job.workspace_name ? t('ingest.routedTo', { name: job.workspace_name }) : t('ingest.otherWorkspace')}
                          </p>
                        )}
                        {job.status === 'failed' && job.error && (
                          <p className="mt-1 truncate text-[10px]" style={{ color: 'oklch(65% 0.18 30)' }} title={job.error}>{job.error}</p>
                        )}
                        {actionError && <p className="mt-1 truncate text-[10px]" style={{ color: 'oklch(65% 0.18 30)' }} role="alert">{actionError}</p>}
                      </div>
                      {job.status !== 'done' && (
                        <button
                          type="button"
                          onClick={() => void updateJob(job, action)}
                          disabled={actionKey !== null}
                          className="flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-[10px] transition-opacity hover:opacity-75 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
                          style={{ color: statusColor(job.status) }}
                          aria-label={actionLabel}
                        >
                          {actionBusy ? <Loader2 size={13} className="animate-spin" /> : actionIcon}
                          <span className="hidden sm:inline">{actionLabel}</span>
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
