'use client';

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useRouter } from 'next/navigation';
import {
  ArrowUp,
  Bookmark,
  Loader2,
  CheckCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  Square,
  AlertTriangle,
  X,
  ExternalLink,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { parseCitations } from '@/lib/ai/citation-parser';
import type { ActionProposal } from '@/lib/ai/tools';
import type { RawSourceCitation } from '@/lib/ai/source-tools';
import { isDriveReconnectError, reconnectGoogleDrive } from '@/lib/google/drive-reconnect';
import { ImportDialog } from './import-dialog';

type ProposalStatus = 'pending' | 'running' | 'done' | 'error' | 'dismissed';
type QueryMode = 'standard' | 'faithful';

const COMPOSER_MAX_HEIGHT = 160;
const QUERY_MODES: readonly QueryMode[] = ['standard', 'faithful'];

interface MessageProposal extends ActionProposal {
  status: ProposalStatus;
  error?: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Slugs of wiki pages the LLM referenced to produce this answer */
  citedSlugs?: string[];
  /** Sources actually read by the Faithful query tools */
  rawCitations?: RawSourceCitation[];
  /** Keep rendering rules stable when the user changes mode later. */
  queryMode?: QueryMode;
  /** Destructive actions awaiting user confirmation */
  proposals?: MessageProposal[];
}

interface Profile {
  id: string;
  name: string;
  model: string;
  is_default: boolean;
}

interface WorkspaceRef {
  id: string;
  name: string;
}

interface ConversationPanelProps {
  workspaceId: string;
  workspaceName?: string;
  /** Page the user is currently viewing — sent as default chat context */
  currentSlug?: string;
  /** All workspaces (for @-tagging as extra context) */
  workspaces?: WorkspaceRef[];
  onSourceAdded?: () => void;
  onPageWritten?: (slug: string) => void;
  onPageClick?: (slug: string) => void;
  /** The AI can create/rename/delete workspaces mid-chat — refresh the switcher */
  onWorkspacesChanged?: () => void;
}

function isSafeSourceUrl(value: string | null): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
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

function ComposerOption({
  label,
  hint,
  selected,
  onSelect,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className="composer-option flex min-h-11 w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm" style={{ color: 'var(--fg)' }}>
          {label}
        </span>
        <span className="block truncate text-xs" style={{ color: 'var(--fg-muted)' }}>
          {hint}
        </span>
      </span>
      {selected && <Check size={15} className="shrink-0" style={{ color: 'var(--color-accent)' }} />}
    </button>
  );
}

export function ConversationPanel({
  workspaceId,
  workspaceName,
  currentSlug,
  workspaces = [],
  onSourceAdded,
  onPageWritten,
  onPageClick,
  onWorkspacesChanged,
}: ConversationPanelProps) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [driveReconnectPending, setDriveReconnectPending] = useState(false);
  const [wasReconnected] = useState(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('r') === '1',
  );

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [savedSlug, setSavedSlug] = useState<string | null>(null);
  const [fileBackPendingId, setFileBackPendingId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [queryMode, setQueryMode] = useState<QueryMode>('standard');
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  // @-tagged workspaces used as extra context for the next question
  const [taggedWorkspaces, setTaggedWorkspaces] = useState<WorkspaceRef[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return workspaces
      .filter((w) => w.id !== workspaceId)
      .filter((w) => !taggedWorkspaces.some((tw) => tw.id === w.id))
      .filter((w) => (q ? w.name.toLowerCase().includes(q) : true))
      .slice(0, 6);
  }, [mentionQuery, workspaces, workspaceId, taggedWorkspaces]);

  const startDriveReconnect = useCallback(async () => {
    if (wasReconnected) {
      const msg = t('workspace.driveReconnectFailed');
      setError(new Error(msg));
      return;
    }
    setDriveReconnectPending(true);
    try {
      await reconnectGoogleDrive(`/w/${workspaceId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('workspace.startGoogleFailed');
      setDriveReconnectPending(false);
      setError(new Error(msg));
    }
  }, [workspaceId, wasReconnected, t]);

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
      if (actionMenuRef.current && !actionMenuRef.current.contains(e.target as Node)) {
        setShowActionMenu(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // The box grows with what is typed, then scrolls; it shrinks back after sending.
  useLayoutEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [input]);

  // Detect an active "@..." mention fragment at the caret end of the input
  const updateMentionState = useCallback(
    (value: string) => {
      const match = /(?:^|\s)@([^\s@]*)$/.exec(value);
      if (match && workspaces.length > 1) {
        setMentionQuery(match[1] ?? '');
        setMentionIndex(0);
      } else {
        setMentionQuery(null);
      }
    },
    [workspaces.length],
  );

  const selectMention = useCallback(
    (ws: WorkspaceRef) => {
      setTaggedWorkspaces((prev) => (prev.length >= 5 ? prev : [...prev, ws]));
      setInput((prev) => prev.replace(/(^|\s)@[^\s@]*$/, '$1').trimEnd());
      setMentionQuery(null);
      inputRef.current?.focus();
    },
    [],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim() || isLoading) return;

      const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: input };
      const assistantId = crypto.randomUUID();
      const allMessages = [...messages, userMsg];

      setMessages([
        ...allMessages,
        { id: assistantId, role: 'assistant', content: '', queryMode },
      ]);
      setInput('');
      setMentionQuery(null);
      setIsLoading(true);
      setError(null);
      setSavedSlug(null);

      const controller = new AbortController();
      abortRef.current = controller;
      let raw = '';

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
            current_slug: currentSlug,
            context_workspace_ids: taggedWorkspaces.map((w) => w.id),
            query_mode: queryMode,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const bodyText = await res.text();
          const message =
            queryMode === 'faithful'
              ? t('query.faithfulFailed')
              : bodyText || `Query failed: ${res.statusText}`;
          if (res.status === 403 && isDriveReconnectError(bodyText)) {
            await startDriveReconnect();
          }
          throw new Error(message);
        }
        if (!res.body) throw new Error('No response body');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          raw += chunk;

          // Show only the text portion while streaming (strip metadata blocks)
          const nulIdx = raw.indexOf('\x00');
          const displayText = nulIdx === -1 ? raw : raw.slice(0, nulIdx);

          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: displayText } : m)),
          );
        }

        // After stream ends, parse citation + action blocks from full raw response
        const { text, citedSlugs, proposals, rawCitations } = parseCitations(raw);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: text,
                  citedSlugs,
                  rawCitations,
                  queryMode,
                  proposals: proposals.map((p) => ({ ...p, status: 'pending' as const })),
                }
              : m,
          ),
        );
        // Standard tools may have changed workspace metadata; Faithful has no write path.
        if (queryMode === 'standard') onWorkspacesChanged?.();
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          // User pressed Stop — keep the partial answer instead of discarding it
          if (raw) {
            const { text, citedSlugs, rawCitations } = parseCitations(raw);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: text, citedSlugs, rawCitations } : m,
              ),
            );
          } else {
            setMessages((prev) => prev.filter((m) => m.id !== assistantId));
          }
        } else {
          setError(
            queryMode === 'faithful'
              ? new Error(t('query.faithfulFailed'))
              : err instanceof Error
                ? err
                : new Error('Unknown error'),
          );
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        }
      } finally {
        abortRef.current = null;
        setIsLoading(false);
      }
    },
    [
      input,
      isLoading,
      locale,
      messages,
      workspaceId,
      selectedProfileId,
      currentSlug,
      taggedWorkspaces,
      queryMode,
      startDriveReconnect,
      onWorkspacesChanged,
      t,
    ],
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const setProposalStatus = useCallback(
    (messageId: string, proposalIdx: number, status: ProposalStatus, errMsg?: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                proposals: m.proposals?.map((p, i) =>
                  i === proposalIdx ? { ...p, status, error: errMsg } : p,
                ),
              }
            : m,
        ),
      );
    },
    [],
  );

  const executeProposal = useCallback(
    async (messageId: string, proposalIdx: number, proposal: MessageProposal) => {
      setProposalStatus(messageId, proposalIdx, 'running');
      try {
        const res = await fetch('/api/agent/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: proposal.action, ...proposal.params }),
        });
        const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
        if (!res.ok) {
          const msg = typeof data?.error === 'string' ? data.error : t('query.actionFailed');
          setProposalStatus(messageId, proposalIdx, 'error', msg);
          return;
        }
        setProposalStatus(messageId, proposalIdx, 'done');
        onSourceAdded?.();
        if (proposal.action === 'delete_workspace') {
          if (proposal.params.workspace_id === workspaceId) {
            // Current workspace is gone — leave it
            router.push('/w');
          } else {
            onWorkspacesChanged?.();
          }
        }
      } catch {
        setProposalStatus(messageId, proposalIdx, 'error', t('query.actionFailed'));
      }
    },
    [setProposalStatus, onSourceAdded, onWorkspacesChanged, router, workspaceId, t],
  );

  const handleFileBack = useCallback(
    async (message: Message) => {
      if (!message.citedSlugs || fileBackPendingId) return;
      const lastUser = [...messages]
        .reverse()
        .find((m) => m.role === 'user' && messages.indexOf(m) < messages.indexOf(message));
      const question = lastUser?.content ?? 'Query';

      setFileBackPendingId(message.id);
      setError(null);
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/synthesis`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            answer: message.content,
            cited_slugs: message.citedSlugs,
          }),
        });

        const data = await res.json().catch(() => null) as { slug?: string; error?: unknown } | null;
        if (!res.ok || !data?.slug) {
          const errMessage = typeof data?.error === 'string' ? data.error : t('query.fileBackFailed');
          throw new Error(errMessage);
        }
        setSavedSlug(data.slug);
        onPageWritten?.(data.slug);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(t('query.fileBackFailed')));
      } finally {
        setFileBackPendingId(null);
      }
    },
    [messages, workspaceId, onPageWritten, fileBackPendingId, t],
  );

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

  return (
    <div
      className="flex h-full flex-col border-l"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
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
          <p className="px-2 py-8 text-sm leading-6" style={{ color: 'var(--fg-muted)' }}>
            {t('query.empty')}
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`space-y-1 ${m.role === 'user' ? 'text-right' : 'text-left'}`}
          >
            <div
              className={`text-sm ${
                m.role === 'user' ? 'ml-auto inline-block max-w-[85%] rounded-xl px-3 py-2' : 'chat-prose llm-content py-2'
              }`}
              style={{
                background: m.role === 'user' ? 'var(--surface-secondary)' : 'transparent',
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

            {m.role === 'assistant' && m.queryMode === 'faithful' && (
              <span
                className="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px]"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
                aria-label={t('query.faithfulBadge')}
              >
                {t('query.faithfulBadge')}
              </span>
            )}

            {/* Citations */}
            {m.role === 'assistant' &&
              ((m.citedSlugs && m.citedSlugs.length > 0) ||
                (m.rawCitations && m.rawCitations.length > 0)) && (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {m.citedSlugs?.map((slug) => (
                    <button
                      key={slug}
                      onClick={() => onPageClick?.(slug)}
                      className="min-h-11 rounded px-2 py-1 text-xs transition-opacity hover:opacity-70"
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
                  {m.rawCitations?.map((citation) => {
                    const label = citation.title || citation.source_id;
                    const lineRange = t('query.sourceLines', {
                      start: citation.locator.line_start,
                      end: citation.locator.line_end,
                    });
                    const chip = (
                      <span
                        className="inline-flex min-h-11 items-center gap-1 rounded border px-2 py-1 text-xs"
                      style={{
                          background: 'var(--bg)',
                          color: 'var(--fg)',
                          borderColor: 'var(--border)',
                          opacity: 0.9,
                        }}
                        title={`${label} · ${lineRange}`}
                      >
                        <span className="max-w-48 truncate">{label}</span>
                        <span className="whitespace-nowrap">{lineRange}</span>
                        {isSafeSourceUrl(citation.url) && <ExternalLink size={11} aria-hidden="true" />}
                      </span>
                    );
                    return isSafeSourceUrl(citation.url) ? (
                      <a
                        key={`${citation.source_id}:${citation.locator.line_start}:${citation.locator.line_end}`}
                        href={citation.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`${label} · ${lineRange}`}
                      >
                        {chip}
                      </a>
                    ) : (
                      <span
                        key={`${citation.source_id}:${citation.locator.line_start}:${citation.locator.line_end}`}
                        aria-label={`${label} · ${lineRange}`}
                      >
                        {chip}
                      </span>
                    );
                  })}
                </div>
              )}

            {/* Destructive-action confirmation cards */}
            {m.role === 'assistant' &&
              m.queryMode !== 'faithful' &&
              m.proposals?.map((proposal, idx) =>
                proposal.status === 'dismissed' ? null : (
                  <div
                    key={`${m.id}-proposal-${idx}`}
                    className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
                    style={{
                      borderColor:
                        proposal.status === 'error' ? 'oklch(65% 0.18 30)' : 'var(--border)',
                      background: 'var(--bg-2)',
                      color: 'var(--fg)',
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <AlertTriangle size={13} style={{ color: 'oklch(70% 0.15 70)' }} />
                      <span className="truncate">
                        {proposal.action === 'delete_workspace'
                          ? t('query.confirmDeleteWorkspace', { name: proposal.params.name ?? '' })
                          : t('query.confirmDeletePage', { slug: proposal.params.slug ?? '' })}
                      </span>
                    </span>
                    {proposal.status === 'pending' && (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <button
                          onClick={() => executeProposal(m.id, idx, proposal)}
                          className="rounded px-2 py-1 font-medium transition-opacity hover:opacity-80"
                          style={{ background: 'oklch(55% 0.18 30)', color: 'white' }}
                        >
                          {t('query.confirmAction')}
                        </button>
                        <button
                          onClick={() => setProposalStatus(m.id, idx, 'dismissed')}
                          className="rounded px-2 py-1 transition-opacity hover:opacity-70"
                          style={{ color: 'var(--fg-muted)' }}
                        >
                          {t('common.cancel')}
                        </button>
                      </span>
                    )}
                    {proposal.status === 'running' && (
                      <Loader2 size={12} className="shrink-0 animate-spin" style={{ color: 'var(--color-accent)' }} />
                    )}
                    {proposal.status === 'done' && (
                      <CheckCircle size={13} className="shrink-0" style={{ color: 'oklch(65% 0.22 145)' }} />
                    )}
                    {proposal.status === 'error' && (
                      <span className="shrink-0" style={{ color: 'oklch(65% 0.18 30)' }}>
                        {proposal.error ?? t('query.actionFailed')}
                      </span>
                    )}
                  </div>
                ),
              )}

            {/* File-back button (only for completed assistant messages with citations) */}
            {m.role === 'assistant' &&
              m.queryMode === 'standard' &&
              m.citedSlugs !== undefined &&
              m.content.length > 0 && (
              <button
                onClick={() => handleFileBack(m)}
                disabled={fileBackPendingId !== null}
                className="flex items-center gap-1 text-xs transition-opacity hover:opacity-70 disabled:opacity-40"
                style={{ color: 'var(--fg-muted)' }}
              >
                {fileBackPendingId === m.id ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Bookmark size={11} />
                )}{' '}
                {t('query.fileBack')}
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

      {/* Composer: one card holding the text, then the things that act on it */}
      <form onSubmit={handleSubmit} className="px-3 pb-3 pt-2">
        <div
          className="relative rounded-2xl border transition-colors duration-150 focus-within:border-[var(--color-accent)]"
          style={{ background: 'var(--surface-secondary)', borderColor: 'var(--border)' }}
        >
          {taggedWorkspaces.length > 0 && (
            <div className="flex flex-wrap gap-1 px-3 pt-2.5">
              {taggedWorkspaces.map((ws) => (
                <span
                  key={ws.id}
                  className="flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs"
                  style={{ background: 'var(--color-accent-glow)', color: 'var(--color-accent)' }}
                >
                  <span className="truncate">@{ws.name}</span>
                  <button
                    type="button"
                    onClick={() => setTaggedWorkspaces((prev) => prev.filter((w) => w.id !== ws.id))}
                    className="shrink-0 transition-opacity hover:opacity-70"
                    aria-label={t('common.close')}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* @-mention workspace dropdown */}
          {mentionQuery !== null && mentionCandidates.length > 0 && (
            <div
              className="animate-dropup absolute bottom-full left-0 z-50 mb-2 w-full max-w-72 overflow-hidden rounded-2xl border shadow-lg"
              style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
              role="listbox"
            >
              <div className="px-3 py-1.5 text-xs" style={{ color: 'var(--fg-muted)' }}>
                {t('query.tagWorkspace')}
              </div>
              {mentionCandidates.map((ws, idx) => (
                <button
                  key={ws.id}
                  type="button"
                  role="option"
                  aria-selected={idx === mentionIndex}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectMention(ws);
                  }}
                  className="flex w-full items-center px-3 py-2 text-left text-xs"
                  style={{
                    color: 'var(--fg)',
                    background: idx === mentionIndex ? 'var(--color-accent-glow)' : undefined,
                  }}
                >
                  <span className="truncate">@{ws.name}</span>
                </button>
              ))}
            </div>
          )}

          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              updateMentionState(e.target.value);
            }}
            onKeyDown={(e) => {
              if (mentionQuery !== null && mentionCandidates.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % mentionCandidates.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  selectMention(mentionCandidates[mentionIndex]!);
                  return;
                }
                if (e.key === 'Escape') {
                  setMentionQuery(null);
                  return;
                }
              }
              // Enter also confirms a Chinese IME candidate, and that must not send the message.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={t('query.placeholder')}
            aria-label={t('query.placeholder')}
            className="block w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-base leading-6 outline-none sm:text-sm"
            style={{ color: 'var(--fg)', maxHeight: COMPOSER_MAX_HEIGHT }}
            disabled={driveReconnectPending}
          />

          <div className="flex items-center gap-1 px-2 pb-2">
            <button
              type="button"
              onClick={() => setShowImport(true)}
              disabled={isLoading}
              className="composer-tool h-9 w-9 shrink-0 justify-center"
              title={t('ingest.dialogTitle')}
              aria-label={t('ingest.dialogTitle')}
            >
              <Plus size={18} />
            </button>

            {/* Not positioned, so the menu anchors to the card and stays inside a narrow panel */}
            <div
              className="min-w-0"
              ref={actionMenuRef}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setShowActionMenu(false);
                  actionMenuRef.current?.querySelector('button')?.focus();
                }
              }}
            >
              <button
                type="button"
                onClick={() => setShowActionMenu((open) => !open)}
                disabled={isLoading}
                className="composer-tool h-9 min-w-0 max-w-full gap-1 px-2 text-xs"
                title={t('query.actionMenu')}
                aria-label={t('query.actionMenu')}
                aria-expanded={showActionMenu}
                aria-controls="query-action-menu"
              >
                <span className="truncate">
                  {selectedProfile?.name ?? t('query.modeStandard')}
                  {queryMode === 'faithful' && ` · ${t('query.modeFaithful')}`}
                </span>
                <ChevronDown size={13} className="shrink-0" />
              </button>

              {showActionMenu && (
                <div
                  id="query-action-menu"
                  className="animate-dropup absolute bottom-full left-0 z-50 mb-2 w-full max-w-80 overflow-y-auto rounded-2xl border p-1 shadow-lg"
                  style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', maxHeight: 360 }}
                >
                  {profiles.length > 0 && (
                    <div role="radiogroup" aria-label={t('common.selectModel')}>
                      <div className="px-2.5 pb-1 pt-1.5 text-xs" style={{ color: 'var(--fg-muted)' }}>
                        {t('common.selectModel')}
                      </div>
                      {profiles.map((p) => (
                        <ComposerOption
                          key={p.id}
                          label={p.name}
                          hint={p.model}
                          selected={p.id === selectedProfileId}
                          onSelect={() => {
                            setSelectedProfileId(p.id);
                            setShowActionMenu(false);
                          }}
                        />
                      ))}
                      <div className="mx-2.5 my-1 border-t" style={{ borderColor: 'var(--border)' }} />
                    </div>
                  )}
                  <div role="radiogroup" aria-label={t('query.queryMode')}>
                    <div className="px-2.5 pb-1 pt-1.5 text-xs" style={{ color: 'var(--fg-muted)' }}>
                      {t('query.queryMode')}
                    </div>
                    {QUERY_MODES.map((mode) => (
                      <ComposerOption
                        key={mode}
                        label={mode === 'standard' ? t('query.modeStandard') : t('query.modeFaithful')}
                        hint={mode === 'standard' ? t('query.modeStandardHint') : t('query.modeFaithfulHint')}
                        selected={queryMode === mode}
                        onSelect={() => {
                          setQueryMode(mode);
                          setShowActionMenu(false);
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {isLoading ? (
              <button
                type="button"
                onClick={stopStreaming}
                className="composer-send ml-auto"
                style={{ background: 'var(--fg)', color: 'var(--bg)' }}
                aria-label={t('query.stop')}
                title={t('query.stop')}
              >
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={driveReconnectPending || !input.trim()}
                aria-label={t('query.send')}
                title={t('query.send')}
                className="composer-send ml-auto"
                style={
                  input.trim()
                    ? { background: 'var(--color-accent)', color: 'var(--on-accent)' }
                    : { background: 'var(--border)', color: 'var(--fg-muted)' }
                }
              >
                <ArrowUp size={18} strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>
      </form>

      {showImport && (
        <ImportDialog
          workspaceId={workspaceId}
          workspaceName={workspaceName ?? ''}
          profileId={selectedProfileId}
          onClose={() => setShowImport(false)}
          onSourceAdded={onSourceAdded}
          onWorkspaceCreated={onWorkspacesChanged}
        />
      )}
    </div>
  );
}
