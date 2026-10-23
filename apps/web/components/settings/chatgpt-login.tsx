'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

interface Pending {
  handle: string;
  user_code: string;
  verification_url: string;
  interval: number;
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

/** Device-code "Sign in with ChatGPT": show the code, poll until the user approves it. */
export function ChatGPTLogin() {
  const t = useTranslations('settings');
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
        setDone(true);
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
  }, [pending, router, t]);

  const start = async () => {
    setStarting(true);
    setError(null);
    setDone(false);
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

  return (
    <div className="space-y-2 rounded-lg border p-4" style={{ borderColor: 'var(--border)' }}>
      <p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
        {t('chatgptBody')}
      </p>
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
      ) : (
        <button
          type="button"
          onClick={start}
          disabled={starting}
          className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
          style={{ background: 'var(--color-accent)', color: 'var(--on-accent)' }}
        >
          {starting ? '...' : t('chatgptSignIn')}
        </button>
      )}
      {done && (
        <p className="text-xs" style={{ color: 'var(--fg-muted)' }} role="status">
          {t('chatgptDone')}
        </p>
      )}
      {error && (
        <p className="text-xs" style={{ color: 'oklch(65% 0.18 30)' }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
