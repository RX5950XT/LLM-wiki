'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send, Bookmark, Loader2, CheckCircle, ChevronRight, Plus, Bot } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { parseCitations } from '@/lib/ai/citation-parser';
import { isDriveReconnectError, reconnectGoogleDrive } from '@/lib/google/drive-reconnect';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Slugs of wiki pages the LLM referenced to produce this answer */
  citedSlugs?: string[];
}

interface Profile {
  id: string;
  name: string;
  model: string;
  is_default: boolean;
}

interface ConversationPanelProps {
  workspaceId: string;
  onSourceAdded?: () => void;
  onPageWritten?: (slug: string) => void;
  onPageClick?: (slug: string) => void;
}

const MAX_INGEST_FILE_BYTES = 2 * 1024 * 1024;

function isUrl(text: string): boolean {
  try {
    const u = new URL(text.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function extractTitle(text: string, fallbackTitle: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? fallbackTitle;
  return line.replace(/^#+\s*/, '').trim().slice(0, 80);
}

function parseInternalWikiHref(href: string): string | null {
  if (href.startsWith('wiki://')) {
    return decodeURIComponent(href.slice(7).split('#')[0] ?? '');
  }

  if (/^(https?:|mailto:|tel:|#)/i.test(href)) return null;
  if (!href.endsWith('.md')) return null;
  return href.replace(/^\//, '').split('#')[0] ?? null;
}

function preserveWikiUrlTransform(url: string): string {
  return url.startsWith('wiki:') ? url : defaultUrlTransform(url);
}

export function ConversationPanel({
  workspaceId,
  onSourceAdded,
  onPageWritten,
  onPageClick,
}: ConversationPanelProps) {
  const t = useTranslations();
  const locale = useLocale();
  const [ingestInput, setIngestInput] = useState('');
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestResult, setIngestResult] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<{ name: string; status: 'pending' | 'uploading' | 'done' | 'error'; error?: string }[]>([]);
  const [driveReconnectPending, setDriveReconnectPending] = useState(false);
  const [wasReconnected] = useState(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('r') === '1',
  );

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [savedSlug, setSavedSlug] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  const startDriveReconnect = useCallback(async () => {
    if (wasReconnected) {
      const msg = t('workspace.driveReconnectFailed');
      setError(new Error(msg));
      setIngestError(msg);
      return;
    }
    setDriveReconnectPending(true);
    try {
      await reconnectGoogleDrive(`/w/${workspaceId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('workspace.startGoogleFailed');
      setDriveReconnectPending(false);
      setError(new Error(msg));
      setIngestError(msg);
    }
  }, [workspaceId, wasReconnected]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    fetch('/api/settings/profiles')
      .then((r) => r.json())
      .then((d) => {
        const list = d.profiles ?? [];
        setProfiles(list);
        const defaultOne = list.find((p: Profile) => p.is_default);
        if (defaultOne) {
          setSelectedProfileId(defaultOne.id);
        } else if (list.length > 0) {
          setSelectedProfileId(list[0].id);
        }
      })
      .catch(() => {
        /* silently ignore profile fetch errors */ 
      });
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setShowProfileMenu(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const loadFileIntoIngest = useCallback(
    async (file: File) => {
      setIngestError(null);
      setIngestResult(null);

      const isSupported = file.name.endsWith('.md') || file.name.endsWith('.txt') || file.type.startsWith('text/');
      if (!isSupported) {
        setIngestError(t('ingest.unsupportedType'));
        return false;
      }

      if (file.size > MAX_INGEST_FILE_BYTES) {
        setIngestError(t('ingest.fileTooLarge'));
        return false;
      }

      try {
        const text = await file.text();
        setIngestInput(text);
        setIngestResult(t('ingest.fileLoaded', { name: file.name }));
        return true;
      } catch {
        setIngestError(t('ingest.fileReadError'));
        return false;
      }
    },
    [t],
  );

  const ingestText = useCallback(
    async (title: string, content: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const payload = {
          kind: 'text' as const,
          title,
          content,
          workspace_id: workspaceId,
          profile_id: selectedProfileId,
        };
        const res = await fetch('/api/ingest', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-llm-wiki-locale': locale,
          },
          body: JSON.stringify(payload),
        });
        const raw = await res.text();
        let message = t('ingest.failedGeneric');
        if (raw) {
          try {
            const data = JSON.parse(raw) as { error?: unknown };
            message = typeof data.error === 'string' ? data.error : message;
          } catch {
            message = raw;
          }
        }

        if (!res.ok) {
          if (res.status === 403 && isDriveReconnectError(message)) {
            await startDriveReconnect();
          }
          return { ok: false, error: message };
        }

        return { ok: true };
      } catch {
        return { ok: false, error: t('ingest.failedGeneric') };
      }
    },
    [locale, workspaceId, selectedProfileId, startDriveReconnect, t],
  );

  const handleBatchIngest = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const validFiles: File[] = [];

      for (const file of Array.from(files)) {
        const isSupported = file.name.endsWith('.md') || file.name.endsWith('.txt') || file.type.startsWith('text/');
        const isSmallEnough = file.size <= MAX_INGEST_FILE_BYTES;
        if (isSupported && isSmallEnough) {
          validFiles.push(file);
        }
      }

      if (validFiles.length === 0) {
        setIngestError(t('ingest.unsupportedType'));
        return;
      }

      setUploadQueue(validFiles.map((f) => ({ name: f.name, status: 'pending' })));
      setIngesting(true);

      let idx = 0;
      for (const file of validFiles) {
        setUploadQueue((prev) => prev.map((item, i) => (i === idx ? { ...item, status: 'uploading' } : item)));

        try {
          const text = await file.text();
          const result = await ingestText(extractTitle(text, t('common.untitled')), text);

          setUploadQueue((prev) =>
            prev.map((item, i) =>
              i === idx
                ? { ...item, status: result.ok ? 'done' : 'error', error: result.ok ? undefined : result.error ?? t('ingest.failedGeneric') }
                : item,
            ),
          );

          if (result.ok) {
            onSourceAdded?.();
          }
        } catch {
          setUploadQueue((prev) => prev.map((item, i) => (i === idx ? { ...item, status: 'error', error: t('ingest.fileReadError') } : item)));
        }
        idx++;
      }

      setIngesting(false);
    },
    [t, ingestText, onSourceAdded],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim() || isLoading) return;

      const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: input };
      const assistantId = crypto.randomUUID();
      const allMessages = [...messages, userMsg];

      setMessages([...allMessages, { id: assistantId, role: 'assistant', content: '' }]);
      setInput('');
      setIsLoading(true);
      setError(null);
      setSavedSlug(null);

      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-llm-wiki-locale': locale,
          },
          body: JSON.stringify({
            messages: allMessages.map((m) => ({ role: m.role, content: m.content })),
            workspace_id: workspaceId,
            profile_id: selectedProfileId,
          }),
        });

        if (!res.ok) {
          const bodyText = await res.text();
          const message = bodyText || `Query failed: ${res.statusText}`;
          if (res.status === 403 && isDriveReconnectError(message)) {
            await startDriveReconnect();
          }
          throw new Error(message);
        }
        if (!res.body) throw new Error('No response body');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let raw = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          raw += chunk;

          // Show only the text portion while streaming (strip citation block if already present)
          const displayText = raw.includes('\x00CITATIONS\x00')
            ? raw.slice(0, raw.lastIndexOf('\x00CITATIONS\x00'))
            : raw;

          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: displayText } : m)),
          );
        }

        // After stream ends, parse citations from full raw response
        const { text, citedSlugs } = parseCitations(raw);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: text, citedSlugs } : m,
          ),
        );
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      } finally {
        setIsLoading(false);
      }
    },
    [input, isLoading, locale, messages, workspaceId, selectedProfileId, startDriveReconnect],
  );

  const handleIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ingestInput.trim()) return;
    setIngesting(true);
    setIngestError(null);
    setIngestResult(null);

    try {
      const trimmed = ingestInput.trim();
      const payload = isUrl(trimmed)
        ? { kind: 'url' as const, url: trimmed, workspace_id: workspaceId, profile_id: selectedProfileId }
        : { kind: 'text' as const, title: extractTitle(trimmed, t('common.untitled')), content: trimmed, workspace_id: workspaceId, profile_id: selectedProfileId };

      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-llm-wiki-locale': locale,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) {
        const message = data.error ?? t('ingest.failedGeneric');
        setIngestError(message);
        if (res.status === 403 && isDriveReconnectError(message)) {
          await startDriveReconnect();
        }
      } else {
        setIngestResult(t('ingest.doneStatus', { status: data.status }));
        setIngestInput('');
        onSourceAdded?.();
      }
    } catch {
      setIngestError(t('ingest.failedGeneric'));
    } finally {
      setIngesting(false);
    }
  };

  const handleFileBack = useCallback(
    async (message: Message) => {
      if (!message.citedSlugs) return;
      const lastUser = [...messages]
        .reverse()
        .find((m) => m.role === 'user' && messages.indexOf(m) < messages.indexOf(message));
      const question = lastUser?.content ?? 'Query';

      const res = await fetch(`/api/workspaces/${workspaceId}/synthesis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          answer: message.content,
          cited_slugs: message.citedSlugs,
        }),
      });

      if (res.ok) {
        const { slug } = await res.json();
        setSavedSlug(slug);
        onPageWritten?.(slug);
      }
    },
    [messages, workspaceId, onPageWritten],
  );

  return (
    <div
      className="flex h-full flex-col border-l"
      style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
    >
      {/* Ingest strip */}
      <form
        onSubmit={handleIngest}
        className="border-b px-4 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex gap-2">
          <label
            className="self-end rounded-md border p-1.5 transition-all duration-100 hover:opacity-70 active:scale-90"
            style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
            title={t('ingest.uploadFile')}
            aria-label={t('ingest.uploadFile')}
          >
            <Plus size={14} />
            <input
              type="file"
              accept=".md,.txt,text/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files;
                if (files && files.length > 0) void handleBatchIngest(files);
                e.target.value = '';
              }}
              disabled={ingesting}
            />
          </label>
          <textarea
            value={ingestInput}
            onChange={(e) => {
              setIngestInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 80)}px`;
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingFile(true);
            }}
            onDragLeave={() => setIsDraggingFile(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDraggingFile(false);
              const files = e.dataTransfer.files;
              if (files && files.length > 0) void handleBatchIngest(files);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                handleIngest(e as unknown as React.FormEvent);
              }
            }}
            placeholder={isDraggingFile ? t('ingest.dropHere') : t('ingest.placeholder')}
            rows={1}
            className="flex-1 resize-none rounded-md border px-3 py-1.5 text-xs outline-none transition-all duration-150"
            style={{
              background: isDraggingFile ? 'var(--color-accent-glow)' : 'var(--bg-2)',
              borderColor: isDraggingFile ? 'var(--color-accent)' : 'var(--border)',
              color: 'var(--fg)',
              overflow: 'hidden',
            }}
            disabled={ingesting}
          />
          <button
            type="submit"
            disabled={ingesting || !ingestInput.trim()}
            className="self-end rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-100 active:scale-95 disabled:opacity-50"
            style={{ background: 'var(--color-accent)', color: 'oklch(10% 0.015 250)' }}
          >
            {ingesting ? <Loader2 size={12} className="animate-spin" /> : t('ingest.button')}
          </button>
        </div>
        {ingestError && (
          <p className="mt-1 text-xs" style={{ color: 'oklch(65% 0.18 30)' }}>
            {ingestError}
          </p>
        )}
        {ingestResult && (
          <p className="mt-1 text-xs" style={{ color: 'var(--color-accent)' }}>
            {ingestResult}
          </p>
        )}
        {ingesting && (
          <div
            className="mt-2 flex items-center gap-2 rounded-md px-2.5 py-2 text-xs"
            style={{ background: 'var(--color-accent-glow)', color: 'var(--color-accent)' }}
          >
            <Loader2 size={12} className="animate-spin" />
            <span>{t('ingest.running')}</span>
          </div>
        )}
        {uploadQueue.length > 0 && (
          <div className="mt-2 space-y-1">
            {uploadQueue.map((item, idx) => (
              <div key={idx} className="flex items-center gap-2 text-xs">
                <span className="truncate" style={{ color: 'var(--fg-muted)' }}>{item.name}</span>
                {item.status === 'pending' && <span style={{ color: 'var(--fg-muted)' }}>{t('ingest.queuePending')}</span>}
                {item.status === 'uploading' && <Loader2 size={10} className="animate-spin" style={{ color: 'var(--color-accent)' }} />}
                {item.status === 'done' && <CheckCircle size={10} style={{ color: 'oklch(65% 0.22 145)' }} />}
                {item.status === 'error' && <span style={{ color: 'oklch(65% 0.18 30)' }}>{item.error ?? t('ingest.failed')}</span>}
              </div>
            ))}
          </div>
        )}
      </form>

      {/* Saved synthesis notification */}
      {savedSlug && (
        <div
          className="flex items-center justify-between border-b px-4 py-2"
          style={{ borderColor: 'var(--border)', background: 'var(--color-accent-glow)' }}
        >
          <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-accent)' }}>
            <CheckCircle size={12} /> {t('ingest.savedSynthesis')}
          </span>
          <button
            onClick={() => {
              onPageClick?.(savedSlug);
              setSavedSlug(null);
            }}
            className="flex items-center gap-0.5 text-xs transition-opacity hover:opacity-70"
            style={{ color: 'var(--color-accent)' }}
          >
            {t('common.view')} <ChevronRight size={12} />
          </button>
        </div>
      )}

      {/* Chat messages */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <p className="text-center text-xs" style={{ color: 'var(--fg-muted)' }}>
            {t('query.empty')}
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`space-y-1 ${m.role === 'user' ? 'text-right' : 'text-left'}`}
          >
            <div
              className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                m.role === 'user' ? 'ml-auto' : 'chat-prose llm-content'
              }`}
              style={{
                background: m.role === 'user' ? 'var(--color-accent-muted)' : 'var(--bg-2)',
                color: 'var(--fg)',
                whiteSpace: m.role === 'user' ? 'pre-wrap' : undefined,
              }}
            >
              {m.role === 'assistant' ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  urlTransform={preserveWikiUrlTransform}
                  components={{
                    img: () => null,
                    a: ({ children, href, ...props }) => {
                      const slug = href ? parseInternalWikiHref(href) : null;
                      if (slug && onPageClick) {
                        return (
                          <a
                            {...props}
                            href={href}
                            onClick={(event) => {
                              event.preventDefault();
                              onPageClick(slug);
                            }}
                          >
                            {children}
                          </a>
                        );
                      }

                      return <a {...props} href={href}>{children}</a>;
                    },
                  }}
                >
                  {m.content}
                </ReactMarkdown>
              ) : (
                m.content
              )}
            </div>

            {/* Citations */}
            {m.role === 'assistant' && m.citedSlugs && m.citedSlugs.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {m.citedSlugs.map((slug) => (
                  <button
                    key={slug}
                    onClick={() => onPageClick?.(slug)}
                    className="rounded px-1.5 py-0.5 text-xs transition-opacity hover:opacity-70"
                    style={{
                      background: 'var(--color-accent-glow)',
                      color: 'var(--color-accent)',
                      border: '1px solid var(--color-accent)',
                      opacity: 0.9,
                    }}
                    title={slug}
                  >
                    {slug.split('/').at(-1)?.replace('.md', '') ?? slug}
                  </button>
                ))}
              </div>
            )}

            {/* File-back button (only for completed assistant messages with citations) */}
            {m.role === 'assistant' && m.citedSlugs !== undefined && m.content.length > 0 && (
              <button
                onClick={() => handleFileBack(m)}
                className="flex items-center gap-1 text-xs transition-opacity hover:opacity-70"
                style={{ color: 'var(--fg-muted)' }}
              >
                <Bookmark size={11} /> {t('query.fileBack')}
              </button>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--fg-muted)' }}>
            <Loader2 size={12} className="animate-spin" /> {t('query.thinking')}
          </div>
        )}
        {error && (
          <p className="text-xs" style={{ color: 'oklch(65% 0.18 30)' }}>
            {error.message}
          </p>
        )}
        {driveReconnectPending && (
          <p className="text-xs" style={{ color: 'var(--fg-muted)' }}>
            {t('common.reconnectingDrive')}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Query input */}
      <form
        onSubmit={handleSubmit}
        className="border-t px-4 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex gap-2">
          {/* Model selector */}
          {profiles.length > 0 && (
            <div className="relative shrink-0" ref={profileMenuRef}>
              <button
                type="button"
                onClick={() => setShowProfileMenu((s) => !s)}
                disabled={isLoading}
                className="flex h-full items-center gap-1 rounded-md border px-2.5 py-2 text-xs font-medium transition-all duration-100 hover:opacity-70 active:scale-95 disabled:opacity-40"
                style={{
                  background: 'var(--bg-2)',
                  borderColor: 'var(--border)',
                  color: 'var(--fg)',
                }}
                title={t('common.selectModel')}
              >
                <Bot size={13} />
              </button>

              {showProfileMenu && (
                <div
                  className="absolute bottom-full left-0 z-50 mb-1 w-56 overflow-hidden rounded-lg border shadow-lg"
                  style={{
                    background: 'var(--bg-2)',
                    borderColor: 'var(--border)',
                    maxHeight: 240,
                    overflowY: 'auto',
                  }}
                >
                  <div className="px-3 py-2 text-xs font-medium" style={{ color: 'var(--fg-muted)' }}>
                    {t('common.selectModel')}
                  </div>
                  {profiles.map((p) => {
                    const isSelected = p.id === selectedProfileId;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setSelectedProfileId(p.id);
                          setShowProfileMenu(false);
                        }}
                        className="flex w-full flex-col px-3 py-2 text-left text-xs transition-all duration-100 hover:opacity-70"
                        style={{
                          color: 'var(--fg)',
                          borderLeft: isSelected ? '3px solid oklch(65% 0.22 145)' : '3px solid transparent',
                          background: isSelected ? 'var(--color-accent-glow)' : undefined,
                        }}
                      >
                        <span className="font-medium">{p.name}</span>
                        <span className="truncate" style={{ color: 'var(--fg-muted)', fontSize: 10 }}>
                          {p.model}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('query.placeholder')}
            className="flex-1 rounded-md border px-3 py-2 text-sm outline-none"
            style={{
              background: 'var(--bg-2)',
              borderColor: 'var(--border)',
              color: 'var(--fg)',
            }}
            disabled={isLoading || driveReconnectPending}
          />
          <button
            type="submit"
            disabled={isLoading || driveReconnectPending || !input.trim()}
            className="rounded-md p-2 disabled:opacity-50"
            style={{ background: 'var(--color-accent)', color: 'oklch(10% 0.015 250)' }}
          >
            <Send size={14} />
          </button>
        </div>
      </form>
    </div>
  );
}
