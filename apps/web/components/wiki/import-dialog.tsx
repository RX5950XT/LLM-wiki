'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, Loader2, Upload, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { isDriveReconnectError, reconnectGoogleDrive } from '@/lib/google/drive-reconnect';

const MAX_INGEST_FILE_BYTES = 2 * 1024 * 1024;

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
  status: 'pending' | 'uploading' | 'done' | 'error';
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

/**
 * Unified import entry: paste text/URL/markdown, drag files, or pick files.
 * Target defaults to "auto" — the server routes content to the best-fitting
 * workspace via a small LLM call (creating one when nothing fits), falling back
 * to the current workspace.
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
  const [progress, setProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [queue, setQueue] = useState<UploadItem[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pollIngestJob = useCallback(
    async (jobId: string): Promise<{ ok: boolean; error?: string; touched?: number }> => {
      const deadline = Date.now() + 6 * 60 * 1000;
      let consecutiveFailures = 0;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          const res = await fetch(`/api/ingest?job_id=${encodeURIComponent(jobId)}`);
          if (!res.ok) {
            if (++consecutiveFailures >= 3) return { ok: false, error: t('ingest.failedGeneric') };
            continue;
          }
          consecutiveFailures = 0;
          const data = (await res.json()) as { status?: string; error?: string; touched_pages?: string[] };
          if (data.status === 'done') return { ok: true, touched: data.touched_pages?.length ?? 0 };
          if (data.status === 'failed') {
            return { ok: false, error: data.error ?? t('ingest.failedGeneric') };
          }
          if (data.touched_pages && data.touched_pages.length > 0) {
            setProgress(data.touched_pages.length);
          }
        } catch {
          if (++consecutiveFailures >= 3) return { ok: false, error: t('ingest.failedGeneric') };
        }
      }
      return { ok: false, error: t('ingest.failedGeneric') };
    },
    [t],
  );

  const submitIngest = useCallback(
    async (
      payload: Record<string, unknown>,
    ): Promise<{
      ok: boolean;
      error?: string;
      touched?: number;
      routedName?: string;
      routedCreated?: boolean;
    }> => {
      const targetFields =
        target === 'auto'
          ? { auto_route: true, fallback_workspace_id: workspaceId }
          : { workspace_id: workspaceId };
      try {
        const res = await fetch('/api/ingest', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-llm-wiki-locale': locale,
          },
          body: JSON.stringify({ ...payload, ...targetFields, profile_id: profileId }),
        });
        const raw = await res.text();
        let message = t('ingest.failedGeneric');
        let parsedBody: {
          error?: unknown;
          jobId?: string;
          status?: string;
          routed_workspace_name?: string;
          routed_workspace_created?: boolean;
        } = {};
        if (raw) {
          try {
            parsedBody = JSON.parse(raw) as typeof parsedBody;
            message = typeof parsedBody.error === 'string' ? parsedBody.error : message;
          } catch {
            message = raw;
          }
        }

        if (!res.ok) {
          if (res.status === 403 && isDriveReconnectError(message)) {
            try {
              await reconnectGoogleDrive(`/w/${workspaceId}`);
            } catch {
              /* fall through to the error message */
            }
          }
          return { ok: false, error: message };
        }

        const routedName = parsedBody.routed_workspace_name;
        const routedCreated = parsedBody.routed_workspace_created === true;
        if (routedCreated) onWorkspaceCreated?.();
        if (parsedBody.jobId && parsedBody.status !== 'done') {
          const polled = await pollIngestJob(parsedBody.jobId);
          return { ...polled, routedName, routedCreated };
        }
        return { ok: true, routedName, routedCreated };
      } catch {
        return { ok: false, error: t('ingest.failedGeneric') };
      }
    },
    [locale, workspaceId, profileId, target, pollIngestJob, onWorkspaceCreated, t],
  );

  const describeSuccess = useCallback(
    (touched: number | undefined, routedName: string | undefined, routedCreated?: boolean) => {
      const base = touched
        ? t('ingest.touchedPages', { count: touched })
        : t('ingest.doneStatus', { status: 'done' });
      if (!routedName) return base;
      const where = routedCreated
        ? t('ingest.routedToNew', { name: routedName })
        : t('ingest.routedTo', { name: routedName });
      return `${where} — ${base}`;
    },
    [t],
  );

  const handleSubmitText = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress(null);

    const payload = isUrl(trimmed)
      ? { kind: 'url' as const, url: trimmed }
      : { kind: 'text' as const, title: extractTitle(trimmed, t('common.untitled')), content: trimmed };

    const res = await submitIngest(payload);
    if (res.ok) {
      setInput('');
      setResult(describeSuccess(res.touched, res.routedName, res.routedCreated));
      onSourceAdded?.();
    } else {
      setError(res.error ?? t('ingest.failedGeneric'));
    }
    setBusy(false);
    setProgress(null);
  }, [input, busy, submitIngest, describeSuccess, onSourceAdded, t]);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0 || busy) return;
      const validFiles = Array.from(files).filter(
        (file) =>
          (file.name.endsWith('.md') || file.name.endsWith('.txt') || file.type.startsWith('text/')) &&
          file.size <= MAX_INGEST_FILE_BYTES,
      );
      if (validFiles.length === 0) {
        setError(t('ingest.unsupportedType'));
        return;
      }

      setQueue(validFiles.map((f) => ({ name: f.name, status: 'pending' })));
      setBusy(true);
      setError(null);
      setResult(null);

      let idx = 0;
      let lastRoutedName: string | undefined;
      let lastRoutedCreated = false;
      let anyOk = false;
      for (const file of validFiles) {
        const current = idx;
        setQueue((prev) => prev.map((item, i) => (i === current ? { ...item, status: 'uploading' } : item)));
        try {
          const text = await file.text();
          const res = await submitIngest({
            kind: 'text' as const,
            title: extractTitle(text, file.name.replace(/\.(md|txt)$/i, '')),
            content: text,
          });
          setQueue((prev) =>
            prev.map((item, i) =>
              i === current
                ? {
                    ...item,
                    status: res.ok ? 'done' : 'error',
                    error: res.ok ? undefined : res.error ?? t('ingest.failedGeneric'),
                  }
                : item,
            ),
          );
          if (res.ok) {
            anyOk = true;
            if (res.routedName) {
              lastRoutedName = res.routedName;
              lastRoutedCreated = res.routedCreated === true;
            }
          }
        } catch {
          setQueue((prev) =>
            prev.map((item, i) => (i === current ? { ...item, status: 'error', error: t('ingest.fileReadError') } : item)),
          );
        }
        idx++;
      }

      if (anyOk) {
        onSourceAdded?.();
        if (lastRoutedName) {
          setResult(
            lastRoutedCreated
              ? t('ingest.routedToNew', { name: lastRoutedName })
              : t('ingest.routedTo', { name: lastRoutedName }),
          );
        }
      }
      setBusy(false);
      setProgress(null);
    },
    [busy, submitIngest, onSourceAdded, t],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-dialog-title"
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
        className="relative flex w-full max-w-lg flex-col gap-4 rounded-xl border p-5 shadow-2xl"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
      >
        <div className="flex items-center justify-between">
          <h2 id="import-dialog-title" className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>
            {t('ingest.dialogTitle')}
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 transition-opacity hover:opacity-70"
            style={{ color: 'var(--fg-muted)' }}
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        {/* Target workspace */}
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t('ingest.target')}>
          {[
            { value: 'auto' as const, label: t('ingest.targetAuto') },
            { value: 'current' as const, label: t('ingest.targetCurrent', { name: workspaceName }) },
          ].map((opt) => (
            <button
              key={opt.value}
              role="radio"
              aria-checked={target === opt.value}
              disabled={busy}
              onClick={() => setTarget(opt.value)}
              className="rounded-full border px-3 py-1 text-xs transition-opacity hover:opacity-80 disabled:opacity-50"
              style={{
                borderColor: target === opt.value ? 'var(--color-accent)' : 'var(--border)',
                background: target === opt.value ? 'var(--color-accent-muted)' : 'var(--bg-2)',
                color: 'var(--fg)',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void handleFiles(e.dataTransfer.files);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void handleSubmitText();
          }}
          placeholder={dragging ? t('ingest.dropHere') : t('ingest.placeholder')}
          rows={6}
          autoFocus
          className="w-full resize-none rounded-md border px-3 py-2 text-sm outline-none transition-all duration-150"
          style={{
            background: dragging ? 'var(--color-accent-glow)' : 'var(--bg-2)',
            borderColor: dragging ? 'var(--color-accent)' : 'var(--border)',
            color: 'var(--fg)',
          }}
          disabled={busy}
        />

        <div className="flex items-center justify-between gap-2">
          <label
            className="flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-opacity hover:opacity-70"
            style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
          >
            <Upload size={13} />
            {t('ingest.uploadFile')}
            <input
              type="file"
              accept=".md,.txt,text/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void handleFiles(e.target.files);
                e.target.value = '';
              }}
              disabled={busy}
            />
          </label>
          <button
            onClick={() => void handleSubmitText()}
            disabled={busy || !input.trim()}
            className="rounded-md px-4 py-1.5 text-xs font-medium transition-all duration-100 active:scale-95 disabled:opacity-50"
            style={{ background: 'var(--color-accent)', color: 'oklch(10% 0.015 250)' }}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : t('ingest.button')}
          </button>
        </div>

        {error && (
          <p className="text-xs" style={{ color: 'oklch(65% 0.18 30)' }} role="alert">
            {error}
          </p>
        )}
        {result && (
          <p className="text-xs" style={{ color: 'var(--color-accent)' }}>
            {result}
          </p>
        )}
        {busy && (
          <div
            className="flex items-center gap-2 rounded-md px-2.5 py-2 text-xs"
            style={{ background: 'var(--color-accent-glow)', color: 'var(--color-accent)' }}
          >
            <Loader2 size={12} className="animate-spin" />
            <span>
              {progress ? t('ingest.runningProgress', { count: progress }) : t('ingest.running')}
            </span>
          </div>
        )}
        {queue.length > 0 && (
          <div className="max-h-32 space-y-1 overflow-y-auto">
            {queue.map((item, idx) => (
              <div key={idx} className="flex items-center gap-2 text-xs">
                <span className="truncate" style={{ color: 'var(--fg-muted)' }}>
                  {item.name}
                </span>
                {item.status === 'pending' && (
                  <span style={{ color: 'var(--fg-muted)' }}>{t('ingest.queuePending')}</span>
                )}
                {item.status === 'uploading' && (
                  <Loader2 size={10} className="animate-spin" style={{ color: 'var(--color-accent)' }} />
                )}
                {item.status === 'done' && <CheckCircle size={10} style={{ color: 'oklch(65% 0.22 145)' }} />}
                {item.status === 'error' && (
                  <span style={{ color: 'oklch(65% 0.18 30)' }}>{item.error ?? t('ingest.failed')}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
