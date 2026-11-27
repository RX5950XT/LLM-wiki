'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { isImeKey } from '@/lib/ime';

interface TokenRecord {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
}

type Agent = 'claude' | 'codex' | 'grok' | 'json';
const AGENTS: { id: Agent; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'grok', label: 'Grok CLI' },
  { id: 'json', label: 'JSON (.mcp.json)' },
];

async function fetchTokens(): Promise<TokenRecord[] | null> {
  const res = await fetch('/api/settings/mcp-tokens').catch(() => null);
  const data = (await res?.json().catch(() => null)) as { tokens?: TokenRecord[] } | null;
  return res?.ok && Array.isArray(data?.tokens) ? data.tokens : null;
}

/** Ready-to-paste setup for each agent; `token` is shown only right after creation. */
export function mcpSnippet(agent: Agent, url: string, token: string): string {
  switch (agent) {
    case 'claude':
      return `claude mcp add --transport http llm-wiki ${url} --header "Authorization: Bearer ${token}"`;
    case 'codex':
      return `# Windows: setx LLM_WIKI_MCP_TOKEN "${token}"   macOS/Linux: export LLM_WIKI_MCP_TOKEN="${token}"\ncodex mcp add llm-wiki --url ${url} --bearer-token-env-var LLM_WIKI_MCP_TOKEN`;
    case 'grok':
      return `# ~/.grok/config.toml\n[mcp_servers.llm-wiki]\nurl = "${url}"\nheaders = { "Authorization" = "Bearer ${token}" }`;
    case 'json':
      return JSON.stringify({ mcpServers: { 'llm-wiki': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  }
}

function CopyButton({ value }: { value: string }) {
  const t = useTranslations('settings');
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="shrink-0 rounded-md border px-2 py-1 text-xs"
      style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
    >
      {copied ? t('mcpCopied') : t('mcpCopy')}
    </button>
  );
}

/**
 * Settings → MCP: tokens that let other agents (Claude Code, Codex, Grok CLI…) read
 * this wiki through /api/mcp. The token is shown once, with setup for each agent.
 */
export function McpConnections() {
  const t = useTranslations('settings');
  const [tokens, setTokens] = useState<TokenRecord[] | null>(null);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [agent, setAgent] = useState<Agent>('claude');
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Absolute so it can be pasted into an agent's config as-is.
  const url = `${process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, '') ?? ''}/api/mcp`;

  useEffect(() => {
    let cancelled = false;
    void fetchTokens().then((list) => {
      if (cancelled) return;
      if (!list) setError(t('mcpFailed'));
      setTokens(list ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [t, reloadKey]);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch('/api/settings/mcp-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { token?: string; error?: string } | null;
    setBusy(false);
    if (!res?.ok || typeof data?.token !== 'string') {
      setError(typeof data?.error === 'string' ? data.error : t('mcpFailed'));
      return;
    }
    setCreated(data.token);
    setName('');
    load();
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/settings/mcp-tokens', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => null);
    setBusy(false);
    setConfirmId(null);
    if (!res?.ok) {
      setError(t('mcpFailed'));
      return;
    }
    setTokens((list) => list?.filter((tok) => tok.id !== id) ?? list);
  };

  const fieldStyle = { background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' };
  const snippet = mcpSnippet(agent, url, created ?? '<token>');

  return (
    <div className="space-y-4 rounded-lg border p-4" style={{ borderColor: 'var(--border)' }}>
      <p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
        {t('mcpBody')}
      </p>

      <div className="space-y-1">
        <p className="text-xs" style={{ color: 'var(--fg-muted)' }}>
          {t('mcpEndpoint')}
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 font-mono text-xs" style={{ background: 'var(--bg-2)', color: 'var(--fg)' }}>
            {url}
          </code>
          <CopyButton value={url} />
        </div>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isImeKey(e)) e.preventDefault();
          }}
          maxLength={80}
          placeholder={t('mcpNamePlaceholder')}
          aria-label={t('mcpNamePlaceholder')}
          className="min-w-0 flex-1 rounded-md border px-3 py-1.5 text-sm"
          style={fieldStyle}
        />
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="shrink-0 rounded-lg px-4 py-1.5 text-sm font-medium disabled:opacity-50"
          style={{ background: 'var(--color-accent)', color: 'var(--on-accent)' }}
        >
          {t('mcpCreate')}
        </button>
      </form>

      {created && (
        <div className="space-y-2 rounded-md border p-3" style={{ borderColor: 'var(--color-accent)' }}>
          <p className="text-xs font-medium" style={{ color: 'var(--fg)' }}>
            {t('mcpTokenOnce')}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md px-2 py-1.5 font-mono text-xs" style={{ background: 'var(--bg-2)', color: 'var(--fg)' }}>
              {created}
            </code>
            <CopyButton value={created} />
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--fg-muted)' }}>
            {t('mcpSetup')}
          </span>
          {AGENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setAgent(a.id)}
              aria-pressed={agent === a.id}
              className="rounded-md border px-2 py-1 text-xs"
              style={{
                borderColor: agent === a.id ? 'var(--color-accent)' : 'var(--border)',
                color: agent === a.id ? 'var(--fg)' : 'var(--fg-muted)',
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto rounded-md px-3 py-2 font-mono text-xs" style={{ background: 'var(--bg-2)', color: 'var(--fg)' }}>
            {snippet}
          </pre>
          <CopyButton value={snippet} />
        </div>
      </div>

      <ul className="space-y-1">
        {tokens?.length === 0 && (
          <li className="text-xs" style={{ color: 'var(--fg-muted)' }}>
            {t('mcpNoTokens')}
          </li>
        )}
        {tokens?.map((tok) => (
          <li key={tok.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm" style={{ background: 'var(--bg-2)' }}>
            <div className="min-w-0 flex-1">
              <p className="truncate" style={{ color: 'var(--fg)' }}>
                {tok.name} <span className="font-mono text-xs" style={{ color: 'var(--fg-muted)' }}>{tok.token_prefix}…</span>
              </p>
              <p className="text-xs" style={{ color: 'var(--fg-muted)' }}>
                {tok.last_used_at ? `${t('mcpLastUsed')} ${new Date(tok.last_used_at).toLocaleString()}` : t('mcpNeverUsed')}
              </p>
            </div>
            {confirmId === tok.id ? (
              <span className="flex shrink-0 gap-2 text-xs">
                <button type="button" disabled={busy} onClick={() => void revoke(tok.id)} className="underline" style={{ color: 'oklch(65% 0.18 30)' }}>
                  {t('mcpRevokeConfirm')}
                </button>
                <button type="button" onClick={() => setConfirmId(null)} className="underline" style={{ color: 'var(--fg-muted)' }}>
                  {t('chatgptCancel')}
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmId(tok.id)} className="shrink-0 text-xs underline" style={{ color: 'var(--fg-muted)' }}>
                {t('mcpRevoke')}
              </button>
            )}
          </li>
        ))}
      </ul>

      {error && (
        <p className="text-xs" style={{ color: 'oklch(65% 0.18 30)' }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
