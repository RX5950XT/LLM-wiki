'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

const PROVIDER_PRESETS = [
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-4-7' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1/', model: 'claude-opus-4-7-20251101' },
  { label: 'Google AI', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-pro' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
];

export interface EditableProfile {
  id: string;
  name: string;
  base_url: string;
  model: string;
  is_default: boolean;
}

export function ProfileForm({
  profile,
  onDone,
}: {
  profile?: EditableProfile;
  onDone?: () => void;
} = {}) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const isEdit = Boolean(profile);
  const [open, setOpen] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fields, setFields] = useState({
    name: profile?.name ?? '',
    base_url: profile?.base_url ?? 'https://openrouter.ai/api/v1',
    api_key: '',
    model: profile?.model ?? 'anthropic/claude-opus-4-7',
    is_default: profile?.is_default ?? false,
  });

  const applyPreset = (preset: (typeof PROVIDER_PRESETS)[number]) => {
    setFields((f) => ({ ...f, name: preset.label, base_url: preset.baseUrl, model: preset.model }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const payload: Record<string, unknown> = { ...fields };
      if (isEdit) {
        payload.id = profile!.id;
        if (!fields.api_key) delete payload.api_key;
      }
      const res = await fetch('/api/settings/profiles', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const raw = await res.text();
      let data: { error?: unknown } | null = null;

      if (raw) {
        try {
          data = JSON.parse(raw) as { error?: string };
        } catch {
          data = null;
        }
      }

      if (!res.ok) {
        setError(typeof data?.error === 'string' ? data.error : t('saveFailed'));
        return;
      }

      setOpen(false);
      if (!isEdit) {
        setFields({ name: '', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: '', is_default: false });
      }
      onDone?.();
      router.refresh();
    } catch {
      setError(t('saveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const field = (key: keyof typeof fields) => ({
    value: String(fields[key]),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setFields((f) => ({ ...f, [key]: e.target.value })),
  });

  const close = () => {
    setOpen(false);
    onDone?.();
  };

  return (
    <div>
      {!open ? (
        !isEdit && (
          <button
            onClick={() => setOpen(true)}
            className="rounded-lg border px-4 py-2 text-sm font-medium transition-opacity hover:opacity-70"
            style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
          >
            + {t('addProfile')}
          </button>
        )
      ) : (
        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-lg border p-5"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
        >
          <h3 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>
            {isEdit ? t('editProfile') : t('addProfile')}
          </h3>

          {/* Provider presets */}
          <div className="flex flex-wrap gap-2">
            {PROVIDER_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p)}
                className="rounded-full border px-3 py-1 text-xs transition-opacity hover:opacity-70"
                style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
              >
                {p.label}
              </button>
            ))}
          </div>

          {[
            { key: 'name' as const, label: t('profileName'), type: 'text', required: true },
            { key: 'base_url' as const, label: t('baseUrl'), type: 'url', required: true },
            { key: 'api_key' as const, label: t('apiKey'), type: 'password', required: !isEdit },
            { key: 'model' as const, label: t('model'), type: 'text', required: true },
          ].map(({ key, label, type, required }) => (
            <div key={key} className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: 'var(--fg-muted)' }}>
                {label}
              </label>
              <input
                type={type}
                {...field(key)}
                required={required}
                autoComplete="off"
                placeholder={key === 'api_key' && isEdit ? t('apiKeyKeepHint') : undefined}
                className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-1"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
              />
            </div>
          ))}

          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--fg)' }}>
            <input
              type="checkbox"
              checked={fields.is_default}
              onChange={(e) => setFields((f) => ({ ...f, is_default: e.target.checked }))}
            />
            {t('setDefault')}
          </label>

          {error && (
            <p className="text-xs" style={{ color: 'oklch(65% 0.18 30)' }}>
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
              style={{ background: 'var(--color-accent)', color: 'oklch(10% 0.015 250)' }}
            >
              {submitting ? '...' : isEdit ? tCommon('save') : t('addProfile')}
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded-lg px-4 py-2 text-sm"
              style={{ color: 'var(--fg-muted)' }}
            >
              {tCommon('cancel')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
