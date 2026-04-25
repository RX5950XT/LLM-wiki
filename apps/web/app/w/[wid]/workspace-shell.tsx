'use client';

import { useState, useCallback } from 'react';
import { PanelLeft, PanelRight } from 'lucide-react';
import { PageTree } from '@/components/wiki/page-tree';
import { PageViewer } from '@/components/wiki/page-viewer';
import { ConversationPanel } from '@/components/wiki/conversation-panel';
import { useRealtimePages, type PageChangedEvent } from '@/lib/sync/realtime';

interface PageEntry {
  slug: string;
  title: string | null;
  kind: string;
  zone: string;
}

interface WorkspaceShellProps {
  workspaceId: string;
  workspaceName: string;
  initialPages: PageEntry[];
}

export function WorkspaceShell({ workspaceId, workspaceName, initialPages }: WorkspaceShellProps) {
  const [activePage, setActivePage] = useState<string>('index.md');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [pages, setPages] = useState(initialPages);

  const handlePageWritten = useCallback((slug: string) => {
    setActivePage(slug);
    // Refresh page list
    fetch(`/api/workspaces/${workspaceId}/pages`)
      .then((r) => r.json())
      .then((d) => d.pages && setPages(d.pages));
  }, [workspaceId]);

  // Realtime: refresh page list + re-render viewer when LLM (or another device) writes a page
  const handleRealtimeChange = useCallback(({ slug }: PageChangedEvent) => {
    fetch(`/api/workspaces/${workspaceId}/pages`)
      .then((r) => r.json())
      .then((d) => d.pages && setPages(d.pages));
    setActivePage((current) => (current === slug ? slug : current));
  }, [workspaceId]);

  useRealtimePages(workspaceId, handleRealtimeChange);

  return (
    <div
      className="flex h-screen flex-col"
      style={{ background: 'var(--bg)', color: 'var(--fg)' }}
    >
      {/* Top bar */}
      <header
        className="flex h-10 items-center justify-between border-b px-4"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => setLeftOpen((o) => !o)}
            className="rounded p-1 transition-opacity hover:opacity-70"
            style={{ color: 'var(--fg-muted)' }}
            aria-label="Toggle sidebar"
          >
            <PanelLeft size={16} />
          </button>
          <span className="text-sm font-medium">{workspaceName}</span>
        </div>
        <button
          onClick={() => setRightOpen((o) => !o)}
          className="rounded p-1 transition-opacity hover:opacity-70"
          style={{ color: 'var(--fg-muted)' }}
          aria-label="Toggle conversation"
        >
          <PanelRight size={16} />
        </button>
      </header>

      {/* Main three-panel layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: page tree */}
        {leftOpen && (
          <div
            className="w-60 shrink-0 border-r overflow-hidden"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
          >
            <PageTree
              workspaceId={workspaceId}
              initialPages={pages}
              activePage={activePage}
              onSelectPage={setActivePage}
            />
          </div>
        )}

        {/* Center: wiki page viewer */}
        <div className="flex-1 overflow-hidden">
          <PageViewer
            workspaceId={workspaceId}
            slug={activePage}
            onWikiLinkClick={setActivePage}
          />
        </div>

        {/* Right: conversation + ingest */}
        {rightOpen && (
          <div className="w-96 shrink-0 overflow-hidden">
            <ConversationPanel
              workspaceId={workspaceId}
              onSourceAdded={() => {}}
              onPageWritten={handlePageWritten}
            />
          </div>
        )}
      </div>
    </div>
  );
}
