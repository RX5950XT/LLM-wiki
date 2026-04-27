'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface Profile {
  id: string;
  name: string;
  base_url: string;
  model: string;
  is_default: boolean;
}

export function ProfileList({ profiles }: { profiles: Profile[] }) {
  const t = useTranslations('settings');
  const [list, setList] = useState(profiles);

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/settings/profiles?id=${id}`, { method: 'DELETE' });
    if (res.ok) setList((prev) => prev.filter((p) => p.id !== id));
  };

  if (list.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
        {t('noProfiles')}
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {list.map((p) => (
        <li
          key={p.id}
          className="flex items-center justify-between rounded-lg border px-4 py-3"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
        >
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
                {p.name}
              </span>
              {p.is_default && (
                <span
                  className="rounded px-1.5 py-0.5 text-xs font-medium"
                  style={{ background: 'var(--color-accent-muted)', color: 'var(--color-accent)' }}
                >
                  {t('default')}
                </span>
              )}
            </div>
            <p className="text-xs" style={{ color: 'var(--fg-muted)' }}>
              {p.model} · {p.base_url}
            </p>
          </div>
          <button
            onClick={() => handleDelete(p.id)}
            className="rounded p-1.5 transition-opacity hover:opacity-70"
            style={{ color: 'var(--fg-muted)' }}
            aria-label={t('deleteProfile')}
          >
            <Trash2 size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}
