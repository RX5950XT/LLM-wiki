'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useTranslations } from 'next-intl';

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const t = useTranslations('settings');
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const options = [
    { value: 'light', Icon: Sun, label: t('themeLight') },
    { value: 'dark', Icon: Moon, label: t('themeDark') },
    { value: 'system', Icon: Monitor, label: t('themeSystem') },
  ] as const;

  return (
    <div
      className="inline-flex overflow-hidden rounded-lg border"
      style={{ borderColor: 'var(--border)' }}
    >
      {options.map(({ value, Icon, label }, idx) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className="flex items-center gap-2 px-4 py-2 text-sm transition-all duration-100 active:scale-95"
          style={{
            background: theme === value ? 'var(--color-accent-glow)' : 'var(--bg-2)',
            color: theme === value ? 'var(--color-accent)' : 'var(--fg-muted)',
            borderRight: idx < options.length - 1 ? '1px solid var(--border)' : undefined,
          }}
          title={label}
          aria-pressed={theme === value}
        >
          <Icon size={14} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
