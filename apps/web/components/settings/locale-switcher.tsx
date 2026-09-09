'use client';

import { useTransition } from 'react';
import { useLocale } from 'next-intl';

const LOCALES = [
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
];

function writeLocaleCookie(locale: string) {
  document.cookie = `NEXT_LOCALE=${locale}; path=/; max-age=31536000; samesite=lax`;
}

export function LocaleSwitcher() {
  const current = useLocale();
  const [, startTransition] = useTransition();

  const setLocale = (locale: string) => {
    writeLocaleCookie(locale);
    startTransition(() => window.location.reload());
  };

  return (
    <div className="flex gap-2">
      {LOCALES.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => setLocale(value)}
          className="rounded-lg border px-4 py-2 text-sm transition-all"
          style={{
            borderColor: current === value ? 'var(--color-accent)' : 'var(--border)',
            color: current === value ? 'var(--color-accent)' : 'var(--fg-muted)',
            background: 'var(--bg-2)',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
