'use client';

import { useState, useEffect, useTransition } from 'react';

const LOCALES = [
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
];

export function LocaleSwitcher() {
  const [current, setCurrent] = useState('zh-TW');
  const [, startTransition] = useTransition();

  useEffect(() => {
    const match = document.cookie.match(/NEXT_LOCALE=([^;]+)/)?.[1];
    if (match) setCurrent(match);
  }, []);

  const setLocale = (locale: string) => {
    document.cookie = `NEXT_LOCALE=${locale}; path=/; max-age=31536000; samesite=lax`;
    setCurrent(locale);
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
