'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PanelLeft, PanelRight, GitFork, FlaskConical, ChevronDown, LogOut, Plus, Settings, Search, Loader2, HelpCircle, Pencil, Trash2, GripVertical } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { PageTree } from '@/components/wiki/page-tree';
import { PageViewer } from '@/components/wiki/page-viewer';
import { ConversationPanel } from '@/components/wiki/conversation-panel';
import { GraphView } from '@/components/wiki/graph-view';
import { HelpDialog } from '@/components/wiki/help-dialog';
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
  sort_order?: number;
}

interface WorkspaceShellProps {
  workspaceId: string;
  workspaceName: string;
  workspaces: WorkspaceEntry[];
  initialPages: PageEntry[];
  initialPage?: string;
}

export function WorkspaceShell({ workspaceId, workspaceName, workspaces, initialPages, initialPage = 'index.md' }: WorkspaceShellProps) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [activePage, setActivePage] = useState<string>(initialPage);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(
    typeof window !== 'undefined' ? decodeURIComponent(window.location.hash.replace(/^#/, '')) || null : null,
  );
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [showGraph, setShowGraph] = useState(false);
  const [lintRunning, setLintRunning] = useState(false);
  const [showWsMenu, setShowWsMenu] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [workspaceList, setWorkspaceList] = useState(workspaces);
  const [currentWorkspaceName, setCurrentWorkspaceName] = useState(workspaceName);
  const [renamingWorkspace, setRenamingWorkspace] = useState<WorkspaceEntry | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<WorkspaceEntry | null>(null);
  const [creatingNote, setCreatingNote] = useState(false);
  const [renamingNote, setRenamingNote] = useState<PageEntry | null>(null);
  const [deletingNote, setDeletingNote] = useState<PageEntry | null>(null);
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const [workspaceActionLoading, setWorkspaceActionLoading] = useState(false);
  const [pages, setPages] = useState(initialPages);
  const [leftWidth, setLeftWidth] = useState(240);
  const [rightWidth, setRightWidth] = useState(384);
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);
  const [graphRefreshKey, setGraphRefreshKey] = useState(0);
  const dragging = useRef<{ side: 'left' | 'right'; startX: number; startWidth: number } | null>(null);
  const dragFrame = useRef<number | null>(null);
  const pendingLeftWidth = useRef<number | null>(null);
  const pendingRightWidth = useRef<number | null>(null);
  const activePageVersionRef = useRef<number | null>(null);

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
    fetch(`/api/workspaces/${workspaceId}/pages`, {
      headers: { 'x-llm-wiki-locale': locale },
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.pages) {
          setPages(d.pages);
          setGraphRefreshKey((key) => key + 1);
        }
      });
  }, [locale, workspaceId]);

  const resolvePageSlug = useCallback((rawSlug: string) => {
    const normalized = normalizeWikiTarget(rawSlug);
    const exact = pages.find((page) => page.slug === normalized) ?? pages.find((page) => page.slug === rawSlug);
    if (exact) return exact.slug;

    const targetAlias = canonicalWikiAlias(rawSlug);
    const aliasMatch = pages.find((page) => {
      const pageSlug = page.slug.replace(/\.md$/i, '');
      const base = pageSlug.split('/').at(-1) ?? pageSlug;
      return canonicalWikiAlias(pageSlug) === targetAlias ||
        canonicalWikiAlias(base) === targetAlias ||
        canonicalWikiAlias(page.title ?? '') === targetAlias;
    });
    return aliasMatch?.slug ?? normalized;
  }, [pages]);

  const selectPage = useCallback((slug: string, anchor?: string) => {
    const resolvedSlug = resolvePageSlug(slug);
    setActivePage(resolvedSlug);
    setActiveAnchor(anchor ?? null);
    const hash = anchor ? `#${encodeURIComponent(anchor)}` : '';
    window.history.replaceState(null, '', `/w/${workspaceId}?page=${encodeURIComponent(resolvedSlug)}${hash}`);
  }, [resolvePageSlug, workspaceId]);

  const handlePageWritten = useCallback(
    (slug: string) => {
      selectPage(slug);
      refreshPageList();
    },
    [selectPage, refreshPageList],
  );

  const handleRealtimeChange = useCallback(
    ({ slug, version }: PageChangedEvent) => {
      refreshPageList();
      setActivePage((current) => {
        if (current === slug && version > (activePageVersionRef.current ?? 0)) {
          setViewerRefreshKey((k) => k + 1);
        }
        return current;
      });
    },
    [refreshPageList],
  );

  useRealtimePages(workspaceId, handleRealtimeChange);

  useEffect(() => {
    setWorkspaceList(workspaces);
    setCurrentWorkspaceName(workspaceName);
  }, [workspaceName, workspaces]);

  useEffect(() => {
    setPages(initialPages);
  }, [initialPages]);

  useEffect(() => {
    router.prefetch('/settings');
  }, []);

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
    const flushDragWidths = () => {
      dragFrame.current = null;
      if (pendingLeftWidth.current != null) {
        setLeftWidth(pendingLeftWidth.current);
        pendingLeftWidth.current = null;
      }
      if (pendingRightWidth.current != null) {
        setRightWidth(pendingRightWidth.current);
        pendingRightWidth.current = null;
      }
    };

    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const { side, startX, startWidth } = dragging.current;
      const delta = e.clientX - startX;
      if (side === 'left') {
        pendingLeftWidth.current = Math.max(160, Math.min(480, startWidth + delta));
      } else {
        pendingRightWidth.current = Math.max(240, Math.min(600, startWidth - delta));
      }

      if (dragFrame.current == null) {
        dragFrame.current = window.requestAnimationFrame(flushDragWidths);
      }
    };
    const onUp = () => {
      if (!dragging.current) return;
      if (dragFrame.current != null) {
        window.cancelAnimationFrame(dragFrame.current);
        dragFrame.current = null;
      }
      flushDragWidths();
      dragging.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      if (dragFrame.current != null) {
        window.cancelAnimationFrame(dragFrame.current);
      }
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
      const res = await fetch('/api/lint', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-llm-wiki-locale': locale,
        },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      const data = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) {
        throw new Error(data?.error ?? 'Lint failed');
      }
      refreshPageList();
      const today = new Date().toISOString().slice(0, 10);
      selectPage(`_lint/${today}.md`);
    } catch (error) {
      setWorkspaceActionError(error instanceof Error ? error.message : 'Lint failed');
    } finally {
      setLintRunning(false);
    }
  }, [locale, workspaceId, refreshPageList]);

  const handleSignOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }, []);

  const createNote = useCallback(async (title: string) => {
    const trimmed = title.trim();
    if (!trimmed) {
      setCreatingNote(false);
      return;
    }

    setWorkspaceActionLoading(true);
    setWorkspaceActionError(null);
    try {
      const res = await fetch(`/api/pages/${workspaceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-llm-wiki-locale': locale,
        },
        body: JSON.stringify({ zone: 'notes', title: trimmed }),
      });
      const data = await res.json().catch(() => null) as { slug?: string; error?: string } | null;
      if (!res.ok || !data?.slug) throw new Error(data?.error ?? 'Failed to create note');
      refreshPageList();
      selectPage(data.slug);
      setCreatingNote(false);
    } catch (error) {
      setWorkspaceActionError(error instanceof Error ? error.message : 'Failed to create note');
    } finally {
      setWorkspaceActionLoading(false);
    }
  }, [locale, refreshPageList, selectPage, workspaceId]);

  const renameNote = useCallback(async (page: PageEntry, title: string) => {
    const trimmed = title.trim();
    if (!trimmed || trimmed === page.title) {
      setRenamingNote(null);
      return;
    }

    setWorkspaceActionLoading(true);
    setWorkspaceActionError(null);
    try {
      const res = await fetch(`/api/pages/${workspaceId}/${encodeSlugPath(page.slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
      const data = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? 'Failed to rename note');
      setPages((prev) => prev.map((item) => (item.slug === page.slug ? { ...item, title: trimmed } : item)));
      setRenamingNote(null);
      refreshPageList();
    } catch (error) {
      setWorkspaceActionError(error instanceof Error ? error.message : 'Failed to rename note');
    } finally {
      setWorkspaceActionLoading(false);
    }
  }, [refreshPageList, workspaceId]);

  const deleteNote = useCallback(async (page: PageEntry) => {
    setWorkspaceActionLoading(true);
    setWorkspaceActionError(null);
    try {
      const res = await fetch(`/api/pages/${workspaceId}/${encodeSlugPath(page.slug)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? 'Failed to delete note');
      setPages((prev) => prev.filter((item) => item.slug !== page.slug));
      if (activePage === page.slug) selectPage('index.md');
      setDeletingNote(null);
      refreshPageList();
    } catch (error) {
      setWorkspaceActionError(error instanceof Error ? error.message : 'Failed to delete note');
    } finally {
      setWorkspaceActionLoading(false);
    }
  }, [activePage, refreshPageList, selectPage, workspaceId]);

  const renameWorkspace = useCallback(async (workspace: WorkspaceEntry, name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === workspace.name) {
      setRenamingWorkspace(null);
      return;
    }

    setWorkspaceActionLoading(true);
    setWorkspaceActionError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => null) as { workspace?: WorkspaceEntry; error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? 'Failed to rename workspace');
      const updated = data?.workspace ?? { ...workspace, name: trimmed };
      setWorkspaceList((prev) => prev.map((item) => (item.id === updated.id ? { ...item, name: updated.name } : item)));
      if (updated.id === workspaceId) setCurrentWorkspaceName(updated.name);
      setRenamingWorkspace(null);
    } catch (error) {
      setWorkspaceActionError(error instanceof Error ? error.message : 'Failed to rename workspace');
    } finally {
      setWorkspaceActionLoading(false);
    }
  }, [workspaceId]);

  const deleteWorkspace = useCallback(async (workspace: WorkspaceEntry) => {
    setWorkspaceActionLoading(true);
    setWorkspaceActionError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? 'Failed to delete workspace');
      const remaining = workspaceList.filter((item) => item.id !== workspace.id);
      setWorkspaceList(remaining);
      setDeletingWorkspace(null);
      if (workspace.id === workspaceId) {
        router.push(remaining[0] ? `/w/${remaining[0].id}` : '/w');
      }
    } catch (error) {
      setWorkspaceActionError(error instanceof Error ? error.message : 'Failed to delete workspace');
    } finally {
      setWorkspaceActionLoading(false);
    }
  }, [router, workspaceId, workspaceList]);

  const persistWorkspaceOrder = useCallback(async (ordered: WorkspaceEntry[]) => {
    setWorkspaceList(ordered);
    setWorkspaceActionError(null);
    try {
      const res = await fetch('/api/workspaces/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_ids: ordered.map((workspace) => workspace.id) }),
      });
      const data = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? 'Failed to reorder workspaces');
    } catch (error) {
      setWorkspaceList(workspaceList);
      setWorkspaceActionError(error instanceof Error ? error.message : 'Failed to reorder workspaces');
    }
  }, [workspaceList]);

  const moveWorkspace = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;

    const current = [...workspaceList];
    const fromIndex = current.findIndex((workspace) => workspace.id === draggedId);
    const toIndex = current.findIndex((workspace) => workspace.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return;

    const [moved] = current.splice(fromIndex, 1);
    if (!moved) return;
    current.splice(toIndex, 0, moved);
    void persistWorkspaceOrder(current);
  }, [persistWorkspaceOrder, workspaceList]);

  const activeNote = pages.find((page) => page.slug === activePage && page.zone === 'notes' && page.slug !== 'notes/guide.md') ?? null;

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
              className="flex min-w-[180px] max-w-[260px] items-center justify-between gap-3 rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-150 hover:opacity-80 active:scale-[0.98]"
              style={{ color: 'var(--fg)', background: 'var(--bg)', borderColor: 'var(--border)' }}
              aria-expanded={showWsMenu}
              aria-label={t('workspace.switchWorkspace')}
            >
              <span className="truncate">{currentWorkspaceName}</span>
              <ChevronDown
                size={14}
                className={`shrink-0 transition-transform duration-150 ${showWsMenu ? 'rotate-180' : ''}`}
                style={{ color: 'var(--fg-muted)' }}
              />
            </button>

            {showWsMenu && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowWsMenu(false)}
                />
                <div
                  className="animate-dropdown absolute left-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border shadow-lg"
                  style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
                >
                  {workspaceList.map((ws) => (
                    <div
                      key={ws.id}
                      className="flex items-center gap-1 px-2 py-1.5"
                      draggable
                      onDragStart={() => setDraggingWorkspaceId(ws.id)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => {
                        if (draggingWorkspaceId) moveWorkspace(draggingWorkspaceId, ws.id);
                        setDraggingWorkspaceId(null);
                      }}
                      onDragEnd={() => setDraggingWorkspaceId(null)}
                      style={{
                        background:
                          draggingWorkspaceId === ws.id
                            ? 'var(--bg)'
                            : ws.id === workspaceId
                              ? 'var(--color-accent-glow)'
                              : undefined,
                      }}
                    >
                      <button
                        type="button"
                        className="cursor-grab rounded p-1 active:cursor-grabbing"
                        style={{ color: 'var(--fg-muted)' }}
                        aria-label={t('workspace.reorderWorkspace')}
                        title={t('workspace.reorderWorkspace')}
                      >
                        <GripVertical size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => router.push(`/w/${ws.id}`)}
                        className="min-w-0 flex-1 px-1 py-1 text-left text-sm transition-opacity hover:opacity-75"
                        style={{ color: ws.id === workspaceId ? 'var(--color-accent)' : 'var(--fg)' }}
                      >
                        <span className="block truncate font-medium">{ws.name}</span>
                        {ws.id === workspaceId && (
                          <span className="block text-[11px]" style={{ color: 'var(--fg-muted)' }}>
                            {t('workspace.currentWorkspace')}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowWsMenu(false);
                          setWorkspaceActionError(null);
                          setRenamingWorkspace(ws);
                        }}
                        className="rounded p-1 transition-opacity hover:opacity-70"
                        style={{ color: 'var(--fg-muted)' }}
                        aria-label={t('workspace.renameWorkspace')}
                        title={t('workspace.renameWorkspace')}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowWsMenu(false);
                          setWorkspaceActionError(null);
                          setDeletingWorkspace(ws);
                        }}
                        className="rounded p-1 transition-opacity hover:opacity-70"
                        style={{ color: 'oklch(65% 0.18 30)' }}
                        aria-label={t('workspace.deleteWorkspace')}
                        title={t('workspace.deleteWorkspace')}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                  <div className="border-t" style={{ borderColor: 'var(--border)' }} />
                  <a
                    href="/w/create"
                    className="flex items-center gap-2 px-3 py-2.5 text-sm transition-opacity hover:opacity-75"
                    style={{ color: 'var(--fg)' }}
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
              aria-label={t('common.search')}
              title={t('common.search')}
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
                    placeholder={t('query.searchWiki')}
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
                          selectPage(r.slug);
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
                    {t('common.noResults')}
                  </div>
                )}
              </div>
            )}
          </div>

          {activeNote && (
            <>
              <button
                type="button"
                onClick={() => {
                  setWorkspaceActionError(null);
                  setRenamingNote(activeNote);
                }}
                className="rounded p-1 transition-all duration-100 hover:opacity-70 active:scale-90"
                style={{ color: 'var(--fg-muted)' }}
                aria-label={t('wiki.renameNote')}
                title={t('wiki.renameNote')}
              >
                <Pencil size={16} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setWorkspaceActionError(null);
                  setDeletingNote(activeNote);
                }}
                className="rounded p-1 transition-all duration-100 hover:opacity-70 active:scale-90"
                style={{ color: 'oklch(65% 0.18 30)' }}
                aria-label={t('wiki.deleteNote')}
                title={t('wiki.deleteNote')}
              >
                <Trash2 size={16} />
              </button>
            </>
          )}

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

          <button
            onClick={() => setShowHelp(true)}
            className="rounded p-1 transition-all duration-100 hover:opacity-70 active:scale-90"
            style={{ color: 'var(--fg-muted)' }}
            aria-label={t('help.open')}
            title={t('help.open')}
          >
            <HelpCircle size={16} />
          </button>

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
                onSelectPage={selectPage}
                onCreateNote={() => {
                  setWorkspaceActionError(null);
                  setCreatingNote(true);
                }}
                onRenameNote={(page) => {
                  setWorkspaceActionError(null);
                  setRenamingNote(page);
                }}
                onDeleteNote={(page) => {
                  setWorkspaceActionError(null);
                  setDeletingNote(page);
                }}
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
              refreshKey={graphRefreshKey}
              onNodeClick={(slug) => {
                selectPage(slug);
                setShowGraph(false);
              }}
            />
          ) : (
            <PageViewer
              workspaceId={workspaceId}
              slug={activePage}
              anchor={activeAnchor}
              onWikiLinkClick={selectPage}
              onPageLoaded={(page) => {
                activePageVersionRef.current = page.version;
              }}
              onPageSaved={refreshPageList}
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
                onPageClick={selectPage}
              />
            </div>
          </>
        )}
      </div>
      <HelpDialog open={showHelp} onClose={() => setShowHelp(false)} />
      {renamingWorkspace && (
        <WorkspaceRenameDialog
          workspace={renamingWorkspace}
          loading={workspaceActionLoading}
          error={workspaceActionError}
          onClose={() => setRenamingWorkspace(null)}
          onSubmit={(name) => renameWorkspace(renamingWorkspace, name)}
        />
      )}
      {deletingWorkspace && (
        <WorkspaceDeleteDialog
          workspace={deletingWorkspace}
          loading={workspaceActionLoading}
          error={workspaceActionError}
          onClose={() => setDeletingWorkspace(null)}
          onConfirm={() => deleteWorkspace(deletingWorkspace)}
        />
      )}
      {creatingNote && (
        <NoteCreateDialog
          loading={workspaceActionLoading}
          error={workspaceActionError}
          onClose={() => setCreatingNote(false)}
          onSubmit={createNote}
        />
      )}
      {renamingNote && (
        <NoteRenameDialog
          note={renamingNote}
          loading={workspaceActionLoading}
          error={workspaceActionError}
          onClose={() => setRenamingNote(null)}
          onSubmit={(title) => renameNote(renamingNote, title)}
        />
      )}
      {deletingNote && (
        <NoteDeleteDialog
          note={deletingNote}
          loading={workspaceActionLoading}
          error={workspaceActionError}
          onClose={() => setDeletingNote(null)}
          onConfirm={() => deleteNote(deletingNote)}
        />
      )}
    </div>
  );
}

function encodeSlugPath(slug: string): string {
  return slug.split('/').map(encodeURIComponent).join('/');
}

function normalizeWikiTarget(slug: string): string {
  const trimmed = decodeURIComponent(slug).trim().replace(/^\//, '').split('#')[0] ?? '';
  if (!trimmed) return trimmed;
  return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
}

function canonicalWikiAlias(value: string): string {
  return value
    .trim()
    .replace(/^\//, '')
    .split('#')[0]!
    .replace(/\.md$/i, '')
    .split('/')
    .at(-1)!
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[\s_\-()]+/g, '');
}

function WorkspaceRenameDialog({
  workspace,
  loading,
  error,
  onClose,
  onSubmit,
}: {
  workspace: WorkspaceEntry;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const t = useTranslations();
  const [name, setName] = useState(workspace.name);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="absolute inset-0 cursor-default" style={{ background: 'oklch(8% 0.01 250 / 0.55)' }} onClick={onClose} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(name);
        }}
        className="relative w-full max-w-sm space-y-4 rounded-xl border p-5 shadow-2xl"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
      >
        <h2 className="text-base font-semibold">{t('workspace.renameWorkspace')}</h2>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={100}
          className="w-full rounded-md border px-3 py-2 text-sm outline-none"
          style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--fg)' }}
          autoFocus
        />
        {error && <p className="text-xs" style={{ color: 'oklch(65% 0.18 30)' }}>{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm" style={{ color: 'var(--fg-muted)' }}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--color-accent)', color: 'oklch(10% 0.015 250)' }}
          >
            {t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

function WorkspaceDeleteDialog({
  workspace,
  loading,
  error,
  onClose,
  onConfirm,
}: {
  workspace: WorkspaceEntry;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="absolute inset-0 cursor-default" style={{ background: 'oklch(8% 0.01 250 / 0.55)' }} onClick={onClose} />
      <section
        className="relative w-full max-w-sm space-y-4 rounded-xl border p-5 shadow-2xl"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
      >
        <h2 className="text-base font-semibold">{t('workspace.deleteWorkspace')}</h2>
        <p className="text-sm leading-6" style={{ color: 'var(--fg-muted)' }}>
          {t('workspace.deleteWorkspaceConfirm', { name: workspace.name })}
        </p>
        {error && <p className="text-xs" style={{ color: 'oklch(65% 0.18 30)' }}>{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm" style={{ color: 'var(--fg-muted)' }}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: 'oklch(65% 0.18 30)', color: 'oklch(10% 0.015 30)' }}
          >
            {t('common.delete')}
          </button>
        </div>
      </section>
    </div>
  );
}

function NoteCreateDialog({
  loading,
  error,
  onClose,
  onSubmit,
}: {
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (title: string) => void;
}) {
  const t = useTranslations();
  const [title, setTitle] = useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="absolute inset-0 cursor-default" style={{ background: 'oklch(8% 0.01 250 / 0.55)' }} onClick={onClose} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(title);
        }}
        className="relative w-full max-w-md rounded-2xl border p-5 shadow-2xl"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
      >
        <h2 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>
          {t('wiki.createNote')}
        </h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--fg-muted)' }}>
          {t('wiki.createNoteHint')}
        </p>
        <input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('common.untitled')}
          className="mt-4 w-full rounded-xl border px-3 py-2 text-sm outline-none"
          style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
        />
        {error && (
          <p className="mt-3 text-xs" style={{ color: 'oklch(70% 0.18 25)' }}>
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm transition-opacity hover:opacity-70"
            style={{ color: 'var(--fg-muted)' }}
            disabled={loading}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={loading || !title.trim()}
            className="rounded-lg px-3 py-1.5 text-sm transition-opacity hover:opacity-70 disabled:opacity-40"
            style={{ background: 'var(--color-accent)', color: 'white' }}
          >
            {loading ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

function NoteRenameDialog({
  note,
  loading,
  error,
  onClose,
  onSubmit,
}: {
  note: PageEntry;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (title: string) => void;
}) {
  const t = useTranslations();
  const [title, setTitle] = useState(note.title ?? note.slug.replace(/^notes\//, '').replace(/\.md$/, ''));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="absolute inset-0 cursor-default" style={{ background: 'oklch(8% 0.01 250 / 0.55)' }} onClick={onClose} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(title);
        }}
        className="relative w-full max-w-sm space-y-4 rounded-xl border p-5 shadow-2xl"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
      >
        <h2 className="text-base font-semibold">{t('wiki.renameNote')}</h2>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={120}
          className="w-full rounded-md border px-3 py-2 text-sm outline-none"
          style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--fg)' }}
          autoFocus
        />
        {error && <p className="text-xs" style={{ color: 'oklch(65% 0.18 30)' }}>{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm" style={{ color: 'var(--fg-muted)' }}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={loading || !title.trim()}
            className="rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--color-accent)', color: 'oklch(10% 0.015 250)' }}
          >
            {t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

function NoteDeleteDialog({
  note,
  loading,
  error,
  onClose,
  onConfirm,
}: {
  note: PageEntry;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="absolute inset-0 cursor-default" style={{ background: 'oklch(8% 0.01 250 / 0.55)' }} onClick={onClose} />
      <section
        className="relative w-full max-w-sm space-y-4 rounded-xl border p-5 shadow-2xl"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
      >
        <h2 className="text-base font-semibold">{t('wiki.deleteNote')}</h2>
        <p className="text-sm leading-6" style={{ color: 'var(--fg-muted)' }}>
          {t('wiki.deleteNoteConfirm', { title: note.title ?? note.slug })}
        </p>
        {error && <p className="text-xs" style={{ color: 'oklch(65% 0.18 30)' }}>{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm" style={{ color: 'var(--fg-muted)' }}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: 'oklch(65% 0.18 30)', color: 'oklch(10% 0.015 30)' }}
          >
            {t('common.delete')}
          </button>
        </div>
      </section>
    </div>
  );
}
