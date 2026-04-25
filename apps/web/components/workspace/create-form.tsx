'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

export function CreateWorkspaceForm() {
  const t = useTranslations('workspace');
  const tc = useTranslations('common');
  const router = useRouter();
  const [name, setName] = useState('My Wiki');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const res = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });

    const data = await res.json();

    if (!res.ok) {
      setError(data.error ?? 'Failed to create workspace');
      setSubmitting(false);
      return;
    }

    router.push(`/w/${data.id}`);
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
        <p className="text-sm" style={{ color: 'oklch(65% 0.18 30)' }}>
          {error}
        </p>
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
