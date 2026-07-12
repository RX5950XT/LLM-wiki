'use client';

import { useEffect } from 'react';
import { HelpCircle, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
}

export function HelpDialog({ open, onClose }: HelpDialogProps) {
  const t = useTranslations('help');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const sections = [
    ['workspace', t('workspaceTitle'), t('workspaceBody')],
    ['ingest', t('ingestTitle'), t('ingestBody')],
    ['chat', t('chatTitle'), t('chatBody')],
    ['tools', t('toolsTitle'), t('toolsBody')],
    ['settings', t('settingsTitle'), t('settingsBody')],
    ['drive', t('driveTitle'), t('driveBody')],
  ] as const;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        style={{ background: 'oklch(8% 0.01 250 / 0.55)' }}
        aria-label={t('close')}
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="wiki-help-title"
        className="relative max-h-[85vh] w-full max-w-xl overflow-hidden rounded-xl border shadow-2xl"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
      >
        <header
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
        >
          <div className="flex items-center gap-2">
            <HelpCircle size={18} style={{ color: 'var(--color-accent)' }} />
            <h2 id="wiki-help-title" className="text-base font-semibold">
              {t('title')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 transition-all duration-100 hover:opacity-70 active:scale-95"
            style={{ color: 'var(--fg-muted)' }}
            aria-label={t('close')}
            title={t('close')}
          >
            <X size={16} />
          </button>
        </header>
        <div className="max-h-[calc(85vh-56px)] overflow-y-auto px-5 py-4">
          <div className="space-y-5">
            {sections.map(([key, title, body]) => (
              <section key={key} className="space-y-1.5">
                <h3 className="text-sm font-medium" style={{ color: 'var(--color-accent)' }}>
                  {title}
                </h3>
                <p className="text-sm leading-6" style={{ color: 'var(--fg-muted)' }}>
                  {body}
                </p>
              </section>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
