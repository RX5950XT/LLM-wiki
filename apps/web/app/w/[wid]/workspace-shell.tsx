'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PanelLeft, PanelRight, GitFork, FlaskConical, ChevronDown, LogOut, Plus, Settings, Search, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PageTree } from '@/components/wiki/page-tree';
import { PageViewer } from '@/components/wiki/page-viewer';
import { ConversationPanel } from '@/components/wiki/conversation-panel';
import { GraphView } from '@/components/wiki/graph-view';
import { useRealtimePages, type PageChangedEvent } from '@/lib/sync/realtime';
import { createClient } from '@/lib/supabase/client';

interface PageEntry {
  slug: string;
  title: string | null;
  kind: string;
  zone: string;
}

interface WorkspaceEntry {
  id: string;
  name: string;
}

interface WorkspaceShellProps {
  workspaceId: string;
  workspaceName: string;
  workspaces: WorkspaceEntry[];
  initialPages: PageEntry[];
}

export function WorkspaceShell({ workspaceId, workspaceName, workspaces, initialPages }: WorkspaceShellProps) {
  const t = useTranslations();
  const router = useRouter();
  const [activePage, setActivePage] = useState<string>('index.md');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [showGraph, setShowGraph] = useState(false);
  const [lintRunning, setLintRunning] = useState(false);
  const [showWsMenu, setShowWsMenu] = useState(false);
  const [pages, setPages] = useState(initialPages);
  const [leftWidth, setLeftWidth] = useState(240);
  const [rightWidth, setRightWidth] = useState(384);
  const dragging = useRef<{ side: 'left' | 'right'; startX: number; startWidth: number } | null>(null);

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ slug: string; title: string | null; kind: string }[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
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

  const handleRealtimeChange = useCallback(
    ({ slug }: PageChangedEvent) => {
      refreshPageList();
      setActivePage((current) => {
        if (current === slug) {
          setViewerRefreshKey((k) => k + 1);
        }
        return current;
      });
    },
    [refreshPageList],
  );

  useRealtimePages(workspaceId, handleRealtimeChange);

  useEffect(() => {
    router.prefetch('/settings');
  }, [router]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearch(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  useEffect(() => {
    if (!showSearch || searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      setSearchLoading(true);
      fetch(`/api/search?workspace_id=${workspaceId}&q=${encodeURIComponent(searchQuery)}`)
        .then((r) => r.json())
        .then((d) => {
          setSearchResults(d.pages ?? []);
          setSearchLoading(false);
        })
        .catch(() => {
          setSearchResults([]);
          setSearchLoading(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery, showSearch, workspaceId]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const { side, startX, startWidth } = dragging.current;
      const delta = e.clientX - startX;
      if (side === 'left') {
        setLeftWidth(Math.max(160, Math.min(480, startWidth + delta)));
      } else {
        setRightWidth(Math.max(240, Math.min(600, startWidth - delta)));
      }
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startDrag = useCallback(
    (e: React.MouseEvent, side: 'left' | 'right') => {
      dragging.current = { side, startX: e.clientX, startWidth: side === 'left' ? leftWidth : rightWidth };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    },
    [leftWidth, rightWidth],
  );

  const runLint = useCallback(async () => {
    setLintRunning(true);
    try {
      await fetch('/api/lint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      refreshPageList();
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      setActivePage(`_lint/${today}.md`);
    } finally {
      setLintRunning(false);
    }
  }, [workspaceId, refreshPageList]);

  const handleSignOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }, []);

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
            className="rounded p-1 transition-all duration-100 hover:opacity-70 active:scale-90"
            style={{ color: 'var(--fg-muted)' }}
            aria-label={t('workspace.toggleSidebar')}
            title={t('workspace.toggleSidebar')}
          >
            <PanelLeft size={16} />
          </button>

          {/* Workspace switcher */}
          <div className="relative">
            <button
              onClick={() => setShowWsMenu((o) => !o)}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-sm font-medium transition-opacity hover:opacity-70"
              style={{ color: 'var(--fg)' }}
            >
              {workspaceName}
              <ChevronDown size={12} style={{ color: 'var(--fg-muted)' }} />
            </button>

            {showWsMenu && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowWsMenu(false)}
                />
                <div
                  className="animate-dropdown absolute left-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-lg border shadow-lg"
                  style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
                >
                  {workspaces.map((ws) => (
                    <a
                      key={ws.id}
                      href={`/w/${ws.id}`}
                      className="flex items-center px-3 py-2 text-sm transition-opacity hover:opacity-70"
                      style={{
                        color: ws.id === workspaceId ? 'var(--color-accent)' : 'var(--fg)',
                        background: ws.id === workspaceId ? 'var(--color-accent-glow)' : undefined,
                      }}
                    >
                      {ws.name}
                    </a>
                  ))}
                  <div className="border-t" style={{ borderColor: 'var(--border)' }} />
                  <a
                    href="/w/create"
                    className="flex items-center gap-1.5 px-3 py-2 text-sm transition-opacity hover:opacity-70"
                    style={{ color: 'var(--fg-muted)' }}
                  >
                    <Plus size={13} /> {t('workspace.addWorkspace')}
                  </a>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative" ref={searchRef}>
            <button
              onClick={() => setShowSearch((s) => !s)}
              className="rounded p-1 transition-all duration-100 hover:opacity-70 active:scale-90"
              style={{ color: showSearch ? 'var(--color-accent)' : 'var(--fg-muted)' }}
              aria-label="Search"
              title="Search"
            >
              <Search size={16} />
            </button>

            {showSearch && (
              <div
                className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border shadow-lg"
                style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
              >
                <div className="px-3 py-2">
                  <input
                    autoFocus
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search wiki..."
                    className="w-full rounded-md border px-3 py-1.5 text-sm outline-none"
                    style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                  />
                </div>
                {searchLoading && (
                  <div className="flex items-center justify-center px-3 py-2">
                    <Loader2 size={14} className="animate-spin" style={{ color: 'var(--fg-muted)' }} />
                  </div>
                )}
                {searchResults.length > 0 && (
                  <div className="max-h-60 overflow-y-auto">
                    {searchResults.map((r) => (
                      <button
                        key={r.slug}
                        onClick={() => {
                          setActivePage(r.slug);
                          setShowSearch(false);
                          setSearchQuery('');
                        }}
                        className="flex w-full flex-col px-3 py-2 text-left text-xs transition-opacity hover:opacity-70"
                        style={{ color: 'var(--fg)' }}
                      >
                        <span className="font-medium">{r.title ?? r.slug}</span>
                        <span className="truncate" style={{ color: 'var(--fg-muted)' }}>
                          {r.kind} · {r.slug}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {!searchLoading && searchQuery.trim().length >= 2 && searchResults.length === 0 && (
                  <div className="px-3 py-2 text-xs" style={{ color: 'var(--fg-muted)' }}>
                    No results
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Graph view toggle */}
          <button
            onClick={() => setShowGraph((g) => !g)}
            className="rounded p-1 transition-all duration-100 hover:opacity-70 active:scale-90"
            style={{ color: showGraph ? 'var(--color-accent)' : 'var(--fg-muted)' }}
            aria-label={t('workspace.toggleGraphView')}
            title={t('workspace.graphView')}
          >
            <GitFork size={16} />
          </button>

          {/* Lint trigger */}
          <button
            onClick={runLint}
            disabled={lintRunning}
            className="rounded p-1 transition-all duration-100 hover:opacity-70 active:scale-90 disabled:opacity-40"
            style={{ color: 'var(--fg-muted)' }}
            aria-label={t('workspace.runLint')}
            title={lintRunning ? t('workspace.lintRunning') : t('workspace.runLint')}
          >
            <FlaskConical size={16} />
          </button>

          <button
            onClick={() => setRightOpen((o) => !o)}
            className="rounded p-1 transition-all duration-100 hover:opacity-70 active:scale-90"
            style={{ color: 'var(--fg-muted)' }}
            aria-label={t('workspace.toggleConversation')}
            title={t('workspace.toggleConversation')}
          >
            <PanelRight size={16} />
          </button>

          <Link
            href="/settings"
            prefetch
            className="rounded p-1 transition-all duration-100 hover:opacity-70 active:scale-90"
            style={{ color: 'var(--fg-muted)' }}
            aria-label={t('common.settings')}
            title={t('common.settings')}
          >
            <Settings size={16} />
          </Link>

          {/* Logout */}
          <button
            onClick={handleSignOut}
            className="rounded p-1 transition-all duration-100 hover:opacity-70 active:scale-90"
            style={{ color: 'var(--fg-muted)' }}
            aria-label={t('auth.signOut')}
            title={t('auth.signOut')}
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {/* Main three-panel layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: page tree */}
        {leftOpen && (
          <>
            <div
              className="shrink-0 overflow-hidden"
              style={{ width: leftWidth, borderRight: '1px solid var(--border)', background: 'var(--bg-2)' }}
            >
              <PageTree
                initialPages={pages}
                activePage={activePage}
                onSelectPage={setActivePage}
              />
            </div>
            <div
              className="shrink-0 cursor-col-resize"
              style={{ width: 4 }}
              onMouseDown={(e) => startDrag(e, 'left')}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--color-accent)'; (e.currentTarget as HTMLDivElement).style.opacity = '0.4'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ''; (e.currentTarget as HTMLDivElement).style.opacity = ''; }}
            />
          </>
        )}

        {/* Center: wiki page viewer OR graph view */}
        <div className="flex-1 overflow-hidden">
          {showGraph ? (
            <GraphView
              workspaceId={workspaceId}
              activePage={activePage}
              onNodeClick={(slug) => {
                setActivePage(slug);
                setShowGraph(false);
              }}
            />
          ) : (
            <PageViewer
              workspaceId={workspaceId}
              slug={activePage}
              onWikiLinkClick={setActivePage}
              refreshKey={viewerRefreshKey}
            />
          )}
        </div>

        {/* Right: conversation + ingest */}
        {rightOpen && (
          <>
            <div
              className="shrink-0 cursor-col-resize"
              style={{ width: 4 }}
              onMouseDown={(e) => startDrag(e, 'right')}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--color-accent)'; (e.currentTarget as HTMLDivElement).style.opacity = '0.4'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ''; (e.currentTarget as HTMLDivElement).style.opacity = ''; }}
            />
            <div style={{ width: rightWidth }} className="shrink-0 overflow-hidden">
              <ConversationPanel
                workspaceId={workspaceId}
                onSourceAdded={refreshPageList}
                onPageWritten={handlePageWritten}
                onPageClick={setActivePage}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
