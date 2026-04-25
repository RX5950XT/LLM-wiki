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
  /**
   * Incremented each time Realtime notifies us that the *currently viewed* page
   * has been updated. PageViewer watches this to show the staleness banner.
   */
  const [viewerRefreshKey, setViewerRefreshKey] = useState(0);

  const refreshPageList = useCallback(() => {
    fetch(`/api/workspaces/${workspaceId}/pages`)
      .then((r) => r.json())
      .then((d) => d.pages && setPages(d.pages));
  }, [workspaceId]);

  const handlePageWritten = useCallback(
    (slug: string) => {
      setActivePage(slug);
      refreshPageList();
    },
    [refreshPageList],
  );

  // Realtime: refresh page list; signal PageViewer when the active page changes
  const handleRealtimeChange = useCallback(
    ({ slug }: PageChangedEvent) => {
      refreshPageList();
      setActivePage((current) => {
        if (current === slug) {
          // Increment refresh key to trigger staleness banner in PageViewer
          setViewerRefreshKey((k) => k + 1);
        }
        return current;
      });
    },
    [refreshPageList],
  );

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
            className="w-60 shrink-0 overflow-hidden border-r"
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
            refreshKey={viewerRefreshKey}
          />
        </div>

        {/* Right: conversation + ingest */}
        {rightOpen && (
          <div className="w-96 shrink-0 overflow-hidden">
            <ConversationPanel
              workspaceId={workspaceId}
              onSourceAdded={refreshPageList}
              onPageWritten={handlePageWritten}
              onPageClick={setActivePage}
            />
          </div>
        )}
      </div>
    </div>
  );
}
