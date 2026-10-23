'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

interface Pending {
  handle: string;
  user_code: string;
  verification_url: string;
  interval: number;
}

interface Status {
  connected: boolean;
  profile_id?: string;
  email?: string | null;
  plan?: string | null;
  model?: string;
  models?: string[];
  error?: string;
}

async function post(body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch('/api/settings/chatgpt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

/**
 * "Sign in with ChatGPT". Signed out: device-code flow (show the code, poll until
 * approved). Signed in: the account, its plan and a model picker.
 */
export function ChatGPTLogin() {
  const t = useTranslations('settings');
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [starting, setStarting] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadStatus = useCallback(async () => {
    const res = await fetch('/api/settings/chatgpt').catch(() => null);
    const data = (await res?.json().catch(() => null)) as Status | null;
    setStatus(data && typeof data.connected === 'boolean' ? data : { connected: false });
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    const tick = async () => {
      const { ok, data }: Awaited<ReturnType<typeof post>> = await post({ action: 'poll', handle: pending.handle }).catch(() => ({
        ok: false,
        data: { error: t('chatgptFailed') },
      }));
      if (cancelled) return;
      if (!ok) {
        setError(typeof data.error === 'string' ? data.error : t('chatgptFailed'));
        setPending(null);
        return;
      }
      if (data.status === 'done') {
        setPending(null);
        void loadStatus();
        router.refresh();
        return;
      }
      timer.current = setTimeout(tick, pending.interval * 1000);
    };
    timer.current = setTimeout(tick, pending.interval * 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, [pending, router, t, loadStatus]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const { ok, data } = await post({ action: 'start' });
      if (!ok) {
        setError(typeof data.error === 'string' ? data.error : t('chatgptFailed'));
        return;
      }
      const next = data as unknown as Pending;
      setPending(next);
      window.open(next.verification_url, '_blank', 'noopener');
    } catch {
      setError(t('chatgptFailed'));
    } finally {
      setStarting(false);
    }
  };

  const changeModel = async (model: string) => {
    if (!status?.profile_id || model === status.model) return;
    setSavingModel(true);
    setError(null);
    const res = await fetch('/api/settings/profiles', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: status.profile_id, model }),
    }).catch(() => null);
    setSavingModel(false);
    if (!res?.ok) {
      setError(t('saveFailed'));
      return;
    }
    setStatus((s) => (s ? { ...s, model } : s));
    router.refresh();
  };

  return (
    <div className="space-y-2 rounded-lg border p-4" style={{ borderColor: 'var(--border)' }}>
      {pending ? (
        <div className="space-y-2">
          <p className="text-sm" style={{ color: 'var(--fg)' }}>
            {t('chatgptEnterCode')}{' '}
            <a href={pending.verification_url} target="_blank" rel="noopener noreferrer" className="underline">
              {pending.verification_url}
            </a>
          </p>
          <p className="font-mono text-2xl font-semibold tracking-widest" style={{ color: 'var(--fg)' }} aria-live="polite">
            {pending.user_code}
          </p>
          <div className="flex items-center gap-3">
            <span className="text-xs" style={{ color: 'var(--fg-muted)' }}>
              {t('chatgptWaiting')}
            </span>
            <button type="button" onClick={() => setPending(null)} className="text-xs underline" style={{ color: 'var(--fg-muted)' }}>
              {t('chatgptCancel')}
            </button>
          </div>
        </div>
      ) : status?.connected ? (
        <div className="space-y-3">
          <p className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--fg)' }}>
            <span className="inline-block size-2 rounded-full" style={{ background: 'var(--color-accent)' }} aria-hidden />
            {t('chatgptSignedInAs')}
            <span className="font-medium">{status.email ?? 'ChatGPT'}</span>
            {status.plan && (
              <span className="rounded px-1.5 py-0.5 text-xs uppercase" style={{ background: 'var(--bg-2)', color: 'var(--fg-muted)' }}>
                {status.plan}
              </span>
            )}
          </p>
          <label className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--fg-muted)' }}>
            {t('model')}
            <select
              value={status.model}
              disabled={savingModel}
              onChange={(e) => void changeModel(e.target.value)}
              className="rounded-md border px-2 py-1.5 text-sm disabled:opacity-50"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
            >
              {(status.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={start}
            disabled={starting}
            className="text-xs underline disabled:opacity-50"
            style={{ color: 'var(--fg-muted)' }}
          >
            {t('chatgptSignInAgain')}
          </button>
        </div>
      ) : status ? (
        <div className="space-y-2">
          <p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
            {status.error ? t('chatgptExpired') : t('chatgptBody')}
          </p>
          <button
            type="button"
            onClick={start}
            disabled={starting}
            className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--color-accent)', color: 'var(--on-accent)' }}
          >
            {starting ? '...' : t('chatgptSignIn')}
          </button>
        </div>
      ) : null}
      {error && (
        <p className="text-xs" style={{ color: 'oklch(65% 0.18 30)' }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
