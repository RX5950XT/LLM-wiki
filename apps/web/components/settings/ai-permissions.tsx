'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';

/**
 * Toggle for whether AI destructive actions (delete page / delete workspace)
 * require an in-chat confirmation card. Stored in auth user_metadata so Web
 * and Android share the preference.
 */
export function AiPermissions({ initialConfirm }: { initialConfirm: boolean }) {
  const t = useTranslations('settings');
  const [confirm, setConfirm] = useState(initialConfirm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = async (value: boolean) => {
    const prev = confirm;
    setConfirm(value);
    setSaving(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({
        data: { ai_confirm_destructive: value },
      });
      if (updateError) {
        setConfirm(prev);
        setError(t('saveFailed'));
      }
    } catch {
      setConfirm(prev);
      setError(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const options = [
    { value: true, label: t('aiConfirmOn'), hint: t('aiConfirmOnHint') },
    { value: false, label: t('aiConfirmOff'), hint: t('aiConfirmOffHint') },
  ];

  return (
    <div className="space-y-2">
      <p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
        {t('aiPermissionsBody')}
      </p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('aiPermissions')}>
        {options.map((opt) => (
          <button
            key={String(opt.value)}
            role="radio"
            aria-checked={confirm === opt.value}
            disabled={saving}
            onClick={() => update(opt.value)}
            className="rounded-lg border px-4 py-2 text-left text-sm transition-opacity hover:opacity-80 disabled:opacity-50"
            style={{
              borderColor: confirm === opt.value ? 'var(--color-accent)' : 'var(--border)',
              background: confirm === opt.value ? 'var(--color-accent-muted)' : 'var(--bg-2)',
              color: 'var(--fg)',
            }}
          >
            <span className="block font-medium">{opt.label}</span>
            <span className="block text-xs" style={{ color: 'var(--fg-muted)' }}>
              {opt.hint}
            </span>
          </button>
        ))}
      </div>
      {error && (
        <p className="text-xs" style={{ color: 'oklch(65% 0.18 30)' }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
