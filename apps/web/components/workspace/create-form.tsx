'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { isDriveReconnectError, reconnectGoogleDrive } from '@/lib/google/drive-reconnect';

export function CreateWorkspaceForm() {
  const t = useTranslations('workspace');
  const tc = useTranslations('common');
  const router = useRouter();
  const [name, setName] = useState('My Wiki');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);

  const handleReauth = async () => {
    setReauthError(null);
    try {
      await reconnectGoogleDrive('/w/create');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start Google sign-in';
      setReauthError(msg);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNeedsReauth(false);

    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description }),
      });

      const raw = await res.text();
      let data: { error?: unknown; id?: string } | null = null;

      if (raw) {
        try {
          data = JSON.parse(raw) as { error?: string; id?: string };
        } catch {
          data = null;
        }
      }

      if (!res.ok) {
        const msg = typeof data?.error === 'string' ? data.error : 'Failed to create workspace';
        setError(msg);
        if (res.status === 403 && isDriveReconnectError(msg)) {
          setNeedsReauth(true);
          await handleReauth();
        }
        return;
      }

      if (!data?.id) {
        setError('Failed to create workspace');
        return;
      }

      router.push(`/w/${data.id}`);
    } catch {
      setError('Failed to create workspace');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
          {t('name')}
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
          className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-1"
          style={{
            background: 'var(--bg-2)',
            borderColor: 'var(--border)',
            color: 'var(--fg)',
          }}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
          {t('description')}
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={500}
          className="w-full resize-none rounded-md border px-3 py-2 text-sm outline-none focus:ring-1"
          style={{
            background: 'var(--bg-2)',
            borderColor: 'var(--border)',
            color: 'var(--fg)',
          }}
        />
      </div>

      {error && (
        <div className="space-y-2">
          <p className="text-sm" style={{ color: 'oklch(65% 0.18 30)' }}>{error}</p>
          {needsReauth && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={handleReauth}
                className="w-full rounded-lg px-4 py-2 text-sm font-medium"
                style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'var(--fg)' }}
              >
                Re-connect Google Drive
              </button>
              {reauthError && (
                <p className="text-xs" style={{ color: 'oklch(65% 0.18 30)' }}>
                  {reauthError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting || !name.trim()}
        className="w-full rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50"
        style={{
          background: 'var(--color-accent)',
          color: 'oklch(10% 0.015 250)',
          transitionDuration: 'var(--transition-default)',
        }}
      >
        {submitting ? tc('loading') : t('create')}
      </button>
    </form>
  );
}
