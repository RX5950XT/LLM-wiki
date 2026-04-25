'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Bookmark, Loader2 } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface ConversationPanelProps {
  workspaceId: string;
  onSourceAdded?: () => void;
  onPageWritten?: (slug: string) => void;
}

export function ConversationPanel({ workspaceId, onSourceAdded, onPageWritten }: ConversationPanelProps) {
  const [ingestUrl, setIngestUrl] = useState('');
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestResult, setIngestResult] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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

      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: allMessages.map((m) => ({ role: m.role, content: m.content })),
            workspace_id: workspaceId,
          }),
        });

        if (!res.ok) throw new Error(`Query failed: ${res.statusText}`);
        if (!res.body) throw new Error('No response body');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + chunk } : m,
            ),
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      } finally {
        setIsLoading(false);
      }
    },
    [input, isLoading, messages, workspaceId],
  );

  const handleIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ingestUrl.trim()) return;
    setIngesting(true);
    setIngestError(null);
    setIngestResult(null);

    const res = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'url', url: ingestUrl, workspace_id: workspaceId }),
    });
    const data = await res.json();

    setIngesting(false);
    if (!res.ok) {
      setIngestError(data.error ?? 'Ingest failed');
    } else {
      setIngestResult(`Done — ${data.status}`);
      setIngestUrl('');
      onSourceAdded?.();
    }
  };

  const handleFileBack = async (message: string) => {
    const res = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'text',
        title: 'Query synthesis',
        content: message,
        workspace_id: workspaceId,
      }),
    });
    if (res.ok) onPageWritten?.('synthesis');
  };

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
          <input
            type="url"
            value={ingestUrl}
            onChange={(e) => setIngestUrl(e.target.value)}
            placeholder="Paste URL to ingest…"
            className="flex-1 rounded-md border px-3 py-1.5 text-xs outline-none"
            style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--fg)' }}
            disabled={ingesting}
          />
          <button
            type="submit"
            disabled={ingesting || !ingestUrl.trim()}
            className="rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            style={{ background: 'var(--color-accent)', color: 'oklch(10% 0.015 250)' }}
          >
            {ingesting ? <Loader2 size={12} className="animate-spin" /> : 'Ingest'}
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
      </form>

      {/* Chat messages */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <p className="text-center text-xs" style={{ color: 'var(--fg-muted)' }}>
            Ask your wiki anything…
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`space-y-1 ${m.role === 'user' ? 'text-right' : 'text-left'}`}
          >
            <div
              className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                m.role === 'user' ? 'ml-auto' : 'llm-content'
              }`}
              style={{
                background: m.role === 'user' ? 'var(--color-accent-muted)' : 'var(--bg-2)',
                color: 'var(--fg)',
              }}
            >
              {m.content}
            </div>
            {m.role === 'assistant' && (
              <button
                onClick={() => handleFileBack(m.content)}
                className="flex items-center gap-1 text-xs transition-opacity hover:opacity-70"
                style={{ color: 'var(--fg-muted)' }}
              >
                <Bookmark size={11} /> Save as synthesis page
              </button>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--fg-muted)' }}>
            <Loader2 size={12} className="animate-spin" /> Thinking…
          </div>
        )}
        {error && (
          <p className="text-xs" style={{ color: 'oklch(65% 0.18 30)' }}>
            {error.message}
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
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask your wiki anything…"
            className="flex-1 rounded-md border px-3 py-2 text-sm outline-none"
            style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--fg)' }}
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
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
