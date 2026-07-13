'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PanelLeft, PanelRight, GitFork, FlaskConical, ChevronDown, LogOut, Plus, Settings, Search, Loader2, HelpCircle, Pencil, Trash2, GripVertical, Library, Wand2, Wrench, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { PageTree } from '@/components/wiki/page-tree';
import { PageViewer } from '@/components/wiki/page-viewer';
import { ConversationPanel } from '@/components/wiki/conversation-panel';
import { GraphView } from '@/components/wiki/graph-view';
import { HelpDialog } from '@/components/wiki/help-dialog';
import { SourcesDialog } from '@/components/wiki/sources-dialog';
import { useRealtimePages, type PageChangedEvent } from '@/lib/sync/realtime';
import { createClient } from '@/lib/supabase/client';

interface PageEntry {
  slug: string;
  title: string | null;
  kind: string;
  zone: string;
  updated_at?: string;
  version?: number;
}

const PAGE_LIST_LIMIT = 2000;

interface WorkspaceEntry {
  id: string;
  name: string;
  sort_order?: number;
}

/** Active health-check / organize job, tracked across reloads via localStorage. */
interface MaintState {
  kind: 'lint' | 'organize';
  jobId: string;
  status: 'running' | 'done' | 'failed';
  error?: string | null;
  reportSlug?: string | null;
  reportWorkspaceId?: string | null;
}

const MAINTENANCE_STORAGE_KEY = 'llmwiki:maintenance';

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
  const [maintenance, setMaintenance] = useState<MaintState | null>(null);
  const [showMaintMenu, setShowMaintMenu] = useState(false);
  const [showWsMenu, setShowWsMenu] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [workspaceList, setWorkspaceList] = useState(workspaces);
  const [currentWorkspaceName, setCurrentWorkspaceName] = useState(workspaceName);
  const [renamingWorkspace, setRenamingWorkspace] = useState<WorkspaceEntry | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<WorkspaceEntry | null>(null);
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const [workspaceActionLoading, setWorkspaceActionLoading] = useState(false);
  const maintMenuRef = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState(initialPages);
  const [leftWidth, setLeftWidth] = useState(240);
  const [rightWidth, setRightWidth] = useState(384);
  // Pointer-based workspace drag: which row, where it started, live offset
  const [wsDrag, setWsDrag] = useState<{ id: string; from: number; to: number; dy: number; rowH: number } | null>(null);
  const wsDragRef = useRef<{ startY: number; from: number; to: number; rowH: number; id: string } | null>(null);
  const [reducedMotion] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [graphRefreshKey, setGraphRefreshKey] = useState(0);
  const dragging = useRef<{ side: 'left' | 'right'; startX: number; startWidth: number } | null>(null);
  const dragFrame = useRef<number | null>(null);
  const pendingLeftWidth = useRef<number | null>(null);
  const pendingRightWidth = useRef<number | null>(null);
  const activePageVersionRef = useRef<number | null>(null);
  const graphRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ slug: string; title: string | null; kind: string }[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchActiveIdx, setSearchActiveIdx] = useState(0);
  const searchRef = useRef<HTMLDivElement>(null);

  // Collapse side panels on small screens (once, after hydration, to avoid SSR mismatch)
  useEffect(() => {
    if (window.matchMedia('(max-width: 767px)').matches) {
      setLeftOpen(false);
      setRightOpen(false);
    } else if (window.matchMedia('(max-width: 1023px)').matches) {
      setRightOpen(false);
    }
  }, []);
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

  // The chat AI can create/rename/delete workspaces — re-sync the switcher list
  const refreshWorkspaceList = useCallback(() => {
    fetch('/api/workspaces')
      .then((r) => r.json())
      .then((d) => {
        if (!Array.isArray(d.workspaces)) return;
        setWorkspaceList(
          d.workspaces.map((w: { id: string; name: string | null; sort_order?: number }) => ({
            id: w.id,
            name: w.name ?? 'Untitled',
            sort_order: w.sort_order ?? undefined,
          })),
        );
        const current = d.workspaces.find((w: { id: string }) => w.id === workspaceId);
        if (current?.name) setCurrentWorkspaceName(current.name);
      })
      .catch(() => {
        /* non-fatal: the switcher just keeps the stale list */
      });
  }, [workspaceId]);

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
    const nextUrl = `/w/${workspaceId}?page=${encodeURIComponent(resolvedSlug)}${hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    // pushState so browser Back walks the wiki trail instead of leaving the workspace
    if (currentUrl !== nextUrl) {
      window.history.pushState({ page: resolvedSlug }, '', nextUrl);
    }
  }, [resolvePageSlug, workspaceId]);

  useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      const page = params.get('page');
      setActivePage(page ?? initialPage);
      setActiveAnchor(decodeURIComponent(window.location.hash.replace(/^#/, '')) || null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [initialPage]);

  const handlePageWritten = useCallback(
    (slug: string) => {
      selectPage(slug);
      refreshPageList();
    },
    [selectPage, refreshPageList],
  );

  const debouncedGraphRefresh = useCallback(() => {
    if (graphRefreshTimer.current) {
      clearTimeout(graphRefreshTimer.current);
    }
    graphRefreshTimer.current = setTimeout(() => {
      setGraphRefreshKey((k) => k + 1);
    }, 2000);
  }, []);

  const handleRealtimeChange = useCallback(
    (event: PageChangedEvent) => {
      setPages((prev) => {
        if (event.eventType === 'DELETE') {
          return prev.filter((p) => p.slug !== event.slug);
        }

        const idx = prev.findIndex((p) => p.slug === event.slug);

        if (event.eventType === 'UPDATE' && idx >= 0) {
          const existing = prev[idx]!;
          if ((existing.version ?? 0) >= event.version) return prev;
          const next = [...prev];
          next[idx] = {
            ...existing,
            ...(event.title !== undefined ? { title: event.title } : {}),
            ...(event.kind !== undefined ? { kind: event.kind } : {}),
            ...(event.zone !== undefined ? { zone: event.zone } : {}),
            ...(event.updatedAt !== undefined ? { updated_at: event.updatedAt } : {}),
            version: event.version,
          };
          return next.sort(
            (a, b) => new Date(b.updated_at ?? '').getTime() - new Date(a.updated_at ?? '').getTime(),
          );
        }

        if (event.eventType === 'INSERT' || (event.eventType === 'UPDATE' && idx < 0)) {
          const inserted = {
            slug: event.slug,
            title: event.title ?? '',
            kind: event.kind ?? 'wiki',
            zone: event.zone ?? 'wiki',
            updated_at: event.updatedAt ?? new Date().toISOString(),
            version: event.version,
          };
          return [...prev, inserted]
            .sort(
              (a, b) => new Date(b.updated_at ?? '').getTime() - new Date(a.updated_at ?? '').getTime(),
            )
            .slice(0, PAGE_LIST_LIMIT);
        }

        return prev;
      });

      if (event.eventType === 'DELETE') {
        setActivePage((current) => (current === event.slug ? 'index.md' : current));
      }

      if (event.eventType !== 'DELETE') {
        setActivePage((current) => {
          if (current === event.slug && event.version > (activePageVersionRef.current ?? 0)) {
            setViewerRefreshKey((k) => k + 1);
          }
          return current;
        });
      }

      debouncedGraphRefresh();
    },
    [debouncedGraphRefresh],
  );

  useRealtimePages(workspaceId, handleRealtimeChange);

  useEffect(() => {
    return () => {
      if (graphRefreshTimer.current) {
        clearTimeout(graphRefreshTimer.current);
      }
    };
  }, []);

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

  // Ctrl/Cmd+K opens full-text search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    setSearchActiveIdx(0);
  }, [searchResults]);

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

    // Pointer events instead of mouse events so panel resize also works on touch
    const onMove = (e: PointerEvent) => {
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
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      if (dragFrame.current != null) {
        window.cancelAnimationFrame(dragFrame.current);
      }
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, []);

  const startDrag = useCallback(
    (e: React.PointerEvent, side: 'left' | 'right') => {
      dragging.current = { side, startX: e.clientX, startWidth: side === 'left' ? leftWidth : rightWidth };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    },
    [leftWidth, rightWidth],
  );

  // Unified maintenance (health check + organize): both are background jobs in
  // agent_jobs, tracked by a single pill and recoverable after a page reload.
  const startMaintenance = useCallback(
    async (kind: 'lint' | 'organize') => {
      if (maintenance?.status === 'running') return;
      setShowMaintMenu(false);
      if (kind === 'organize' && !window.confirm(t('workspace.organizeConfirm'))) return;
      setMaintenance(null);
      setWorkspaceActionError(null);
      try {
        const res = await fetch(kind === 'lint' ? '/api/lint' : '/api/organize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-llm-wiki-locale': locale },
          body: JSON.stringify({ workspace_id: workspaceId }),
        });
        // 409 = a maintenance job is already running; its jobId is returned so
        // we can adopt and keep tracking it instead of erroring.
        const data = (await res.json().catch(() => null)) as { jobId?: string; error?: string } | null;
        if (!data?.jobId) throw new Error(data?.error ?? t('workspace.maintenanceFailed'));
        localStorage.setItem(MAINTENANCE_STORAGE_KEY, JSON.stringify({ kind, jobId: data.jobId }));
        setMaintenance({ kind, jobId: data.jobId, status: 'running' });
      } catch (error) {
        setWorkspaceActionError(error instanceof Error ? error.message : t('workspace.maintenanceFailed'));
      }
    },
    [maintenance?.status, locale, workspaceId, t],
  );

  const dismissMaintenance = useCallback(() => {
    localStorage.removeItem(MAINTENANCE_STORAGE_KEY);
    setMaintenance(null);
  }, []);

  const openMaintenanceReport = useCallback(() => {
    if (!maintenance?.reportSlug) return;
    const targetWs = maintenance.reportWorkspaceId ?? workspaceId;
    if (targetWs !== workspaceId) {
      router.push(`/w/${targetWs}?page=${encodeURIComponent(maintenance.reportSlug)}`);
    } else {
      selectPage(maintenance.reportSlug);
    }
    dismissMaintenance();
  }, [maintenance, workspaceId, router, selectPage, dismissMaintenance]);

  // Recover a maintenance job that was started before a reload / tab close.
  useEffect(() => {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(MAINTENANCE_STORAGE_KEY) : null;
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as { kind: 'lint' | 'organize'; jobId: string };
      if (saved?.jobId && (saved.kind === 'lint' || saved.kind === 'organize')) {
        setMaintenance({ kind: saved.kind, jobId: saved.jobId, status: 'running' });
      }
    } catch {
      localStorage.removeItem(MAINTENANCE_STORAGE_KEY);
    }
  }, []);

  // Poll the active job until it settles. The job runs server-side regardless of
  // whether this page is open, so closing the tab never cancels it.
  useEffect(() => {
    if (maintenance?.status !== 'running') return;
    const { kind, jobId } = maintenance;
    const endpoint = kind === 'lint' ? '/api/lint' : '/api/organize';
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`${endpoint}?job_id=${encodeURIComponent(jobId)}`);
        if (!res.ok) return;
        const poll = (await res.json()) as {
          status?: string;
          error?: string;
          report_slug?: string | null;
          report_workspace_id?: string | null;
        };
        if (cancelled) return;
        if (poll.status === 'done' || poll.status === 'failed') {
          localStorage.removeItem(MAINTENANCE_STORAGE_KEY);
          setMaintenance({
            kind,
            jobId,
            status: poll.status,
            error: poll.error ?? null,
            reportSlug: poll.report_slug ?? null,
            reportWorkspaceId: poll.report_workspace_id ?? null,
          });
          if (poll.status === 'done') {
            refreshPageList();
            setGraphRefreshKey((k) => k + 1);
          }
        }
      } catch {
        /* transient network error — keep polling */
      }
    };
    void tick();
    const id = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [maintenance?.status, maintenance?.jobId, maintenance?.kind, refreshPageList]);

  // Close the maintenance menu on outside click
  useEffect(() => {
    if (!showMaintMenu) return;
    const onClick = (e: MouseEvent) => {
      if (maintMenuRef.current && !maintMenuRef.current.contains(e.target as Node)) {
        setShowMaintMenu(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showMaintMenu]);

  const handleSignOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }, []);

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

  // FLIP-style pointer drag: the grabbed row follows the cursor, neighbours
  // slide out of the way with a transform transition, drop commits the order.
  const startWorkspaceDrag = useCallback((e: React.PointerEvent, ws: WorkspaceEntry, index: number) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const row = handle.closest('[data-ws-row]') as HTMLElement | null;
    const rowH = row?.offsetHeight ?? 44;
    wsDragRef.current = { startY: e.clientY, from: index, to: index, rowH, id: ws.id };
    setWsDrag({ id: ws.id, from: index, to: index, dy: 0, rowH });
    handle.setPointerCapture(e.pointerId);
  }, []);

  const moveWorkspaceDrag = useCallback((e: React.PointerEvent) => {
    const drag = wsDragRef.current;
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    const to = Math.max(
      0,
      Math.min(workspaceList.length - 1, drag.from + Math.round(dy / drag.rowH)),
    );
    drag.to = to;
    setWsDrag({ id: drag.id, from: drag.from, to, dy, rowH: drag.rowH });
  }, [workspaceList.length]);

  const endWorkspaceDrag = useCallback(() => {
    const drag = wsDragRef.current;
    wsDragRef.current = null;
    setWsDrag(null);
    if (drag && drag.to !== drag.from) {
      const next = [...workspaceList];
      const [moved] = next.splice(drag.from, 1);
      if (moved) {
        next.splice(drag.to, 0, moved);
        void persistWorkspaceOrder(next);
      }
    }
  }, [persistWorkspaceOrder, workspaceList]);

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
                  {workspaceList.map((ws, wsIndex) => {
                    const isDraggedRow = wsDrag?.id === ws.id;
                    let rowTransform: string | undefined;
                    if (wsDrag && isDraggedRow) {
                      rowTransform = `translateY(${wsDrag.dy}px)`;
                    } else if (wsDrag) {
                      // Neighbours slide to make room for the dragged row
                      const { from, to, rowH } = wsDrag;
                      if (wsIndex > from && wsIndex <= to) rowTransform = `translateY(-${rowH}px)`;
                      else if (wsIndex < from && wsIndex >= to) rowTransform = `translateY(${rowH}px)`;
                    }
                    return (
                    <div
                      key={ws.id}
                      data-ws-row
                      className="flex items-center gap-1 px-2 py-1.5"
                      style={{
                        background:
                          isDraggedRow
                            ? 'var(--bg)'
                            : ws.id === workspaceId
                              ? 'var(--color-accent-glow)'
                              : undefined,
                        transform: rowTransform,
                        transition: isDraggedRow || reducedMotion ? 'none' : 'transform 150ms cubic-bezier(0.25, 1, 0.5, 1)',
                        position: 'relative',
                        zIndex: isDraggedRow ? 10 : undefined,
                        boxShadow: isDraggedRow ? '0 4px 16px oklch(0% 0 0 / 0.25)' : undefined,
                        touchAction: 'none',
                      }}
                    >
                      <button
                        type="button"
                        className="cursor-grab rounded p-1 active:cursor-grabbing"
                        style={{ color: 'var(--fg-muted)', touchAction: 'none' }}
                        aria-label={t('workspace.reorderWorkspace')}
                        title={t('workspace.reorderWorkspace')}
                        onPointerDown={(e) => startWorkspaceDrag(e, ws, wsIndex)}
                        onPointerMove={moveWorkspaceDrag}
                        onPointerUp={endWorkspaceDrag}
                        onPointerCancel={endWorkspaceDrag}
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
                    );
                  })}
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
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setShowSearch(false);
                        setSearchQuery('');
                      } else if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setSearchActiveIdx((i) => Math.min(i + 1, Math.max(searchResults.length - 1, 0)));
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setSearchActiveIdx((i) => Math.max(i - 1, 0));
                      } else if (e.key === 'Enter') {
                        const r = searchResults[searchActiveIdx] ?? searchResults[0];
                        if (r) {
                          selectPage(r.slug);
                          setShowSearch(false);
                          setSearchQuery('');
                        }
                      }
                    }}
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
                    {searchResults.map((r, idx) => (
                      <button
                        key={r.slug}
                        onClick={() => {
                          selectPage(r.slug);
                          setShowSearch(false);
                          setSearchQuery('');
                        }}
                        onMouseEnter={() => setSearchActiveIdx(idx)}
                        className="flex w-full flex-col px-3 py-2 text-left text-xs transition-opacity hover:opacity-70"
                        style={{
                          color: 'var(--fg)',
                          background: idx === searchActiveIdx ? 'var(--color-accent-glow)' : undefined,
                        }}
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

          {/* Sources list */}
          <button
            onClick={() => setShowSources(true)}
            className="rounded p-1 transition-all duration-100 hover:opacity-70 active:scale-90"
            style={{ color: 'var(--fg-muted)' }}
            aria-label={t('sources.open')}
            title={t('sources.open')}
          >
            <Library size={16} />
          </button>

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

          {/* Unified maintenance menu: health check + organize (both background jobs) */}
          <div className="relative" ref={maintMenuRef}>
            <button
              onClick={() => setShowMaintMenu((v) => !v)}
              className="rounded p-1 transition-all duration-100 hover:opacity-70 active:scale-90"
              style={{ color: maintenance?.status === 'running' ? 'var(--color-accent)' : 'var(--fg-muted)' }}
              aria-label={t('workspace.maintenance')}
              aria-haspopup="menu"
              aria-expanded={showMaintMenu}
              title={t('workspace.maintenance')}
            >
              {maintenance?.status === 'running' ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Wrench size={16} />
              )}
            </button>
            {showMaintMenu && (
              <div
                className="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-lg border shadow-lg"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
                role="menu"
              >
                <button
                  onClick={() => startMaintenance('lint')}
                  disabled={maintenance?.status === 'running'}
                  className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-2)] disabled:opacity-40"
                  role="menuitem"
                >
                  <FlaskConical size={15} className="mt-0.5 shrink-0" style={{ color: 'var(--color-accent)' }} />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium" style={{ color: 'var(--fg)' }}>
                      {t('workspace.healthCheckItem')}
                    </span>
                    <span className="block text-[11px]" style={{ color: 'var(--fg-muted)' }}>
                      {t('workspace.healthCheckDesc')}
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => startMaintenance('organize')}
                  disabled={maintenance?.status === 'running'}
                  className="flex w-full items-start gap-2.5 border-t px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-2)] disabled:opacity-40"
                  style={{ borderColor: 'var(--border)' }}
                  role="menuitem"
                >
                  <Wand2 size={15} className="mt-0.5 shrink-0" style={{ color: 'var(--color-accent)' }} />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium" style={{ color: 'var(--fg)' }}>
                      {t('workspace.organizeItem')}
                    </span>
                    <span className="block text-[11px]" style={{ color: 'var(--fg-muted)' }}>
                      {t('workspace.organizeDesc')}
                    </span>
                  </span>
                </button>
              </div>
            )}
          </div>

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

      {/* Maintenance status strip: running (background-safe) / done / failed */}
      {maintenance && (
        <div
          className="flex items-center gap-3 border-b px-4 py-2 text-xs"
          style={{
            borderColor: 'var(--border)',
            background: maintenance.status === 'failed' ? 'var(--bg-2)' : 'var(--color-accent-glow)',
            color: maintenance.status === 'failed' ? 'oklch(65% 0.18 30)' : 'var(--color-accent)',
          }}
          role="status"
          aria-live="polite"
        >
          {maintenance.status === 'running' && <Loader2 size={14} className="shrink-0 animate-spin" />}
          {maintenance.status === 'done' && <CheckCircle2 size={14} className="shrink-0" />}
          {maintenance.status === 'failed' && <AlertCircle size={14} className="shrink-0" />}
          <span className="min-w-0 flex-1 truncate">
            {maintenance.status === 'running'
              ? `${
                  maintenance.kind === 'lint'
                    ? t('workspace.maintenanceRunningLint')
                    : t('workspace.maintenanceRunningOrganize')
                } · ${t('workspace.maintenanceBackgroundHint')}`
              : maintenance.status === 'done'
                ? maintenance.kind === 'lint'
                  ? t('workspace.maintenanceDoneLint')
                  : t('workspace.maintenanceDoneOrganize')
                : maintenance.error || t('workspace.maintenanceFailed')}
          </span>
          {maintenance.status === 'done' && maintenance.reportSlug && (
            <button
              type="button"
              onClick={openMaintenanceReport}
              className="shrink-0 rounded px-2 py-0.5 font-medium underline-offset-2 hover:underline"
            >
              {t('workspace.viewReport')}
            </button>
          )}
          {maintenance.status !== 'running' && (
            <button
              type="button"
              onClick={dismissMaintenance}
              className="shrink-0 rounded p-1 transition-opacity hover:opacity-70"
              style={{ color: 'var(--fg-muted)' }}
              aria-label={t('workspace.dismiss')}
              title={t('workspace.dismiss')}
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {/* Global action error strip — dialogs render their own copy; this covers
          failures (e.g. lint) that happen with no dialog open */}
      {workspaceActionError && !renamingWorkspace && !deletingWorkspace && (
        <div
          className="flex items-center justify-between gap-3 border-b px-4 py-2 text-xs"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-2)', color: 'oklch(65% 0.18 30)' }}
          role="alert"
        >
          <span className="truncate">{workspaceActionError}</span>
          <button
            type="button"
            onClick={() => setWorkspaceActionError(null)}
            className="shrink-0 rounded p-1 transition-opacity hover:opacity-70"
            style={{ color: 'var(--fg-muted)' }}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            ✕
          </button>
        </div>
      )}

      {/* Main three-panel layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: page tree */}
        {leftOpen && (
          <>
            <div
              className="shrink-0 overflow-hidden"
              style={{ width: leftWidth, maxWidth: '80vw', borderRight: '1px solid var(--border)', background: 'var(--bg-2)' }}
            >
              <PageTree
                initialPages={pages}
                activePage={activePage}
                onSelectPage={selectPage}
              />
            </div>
            <div
              className="shrink-0 cursor-col-resize"
              style={{ width: 4, touchAction: 'none' }}
              onPointerDown={(e) => startDrag(e, 'left')}
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
              style={{ width: 4, touchAction: 'none' }}
              onPointerDown={(e) => startDrag(e, 'right')}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--color-accent)'; (e.currentTarget as HTMLDivElement).style.opacity = '0.4'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ''; (e.currentTarget as HTMLDivElement).style.opacity = ''; }}
            />
            <div style={{ width: rightWidth, maxWidth: '80vw' }} className="shrink-0 overflow-hidden">
              <ConversationPanel
                workspaceId={workspaceId}
                workspaceName={currentWorkspaceName}
                currentSlug={activePage}
                workspaces={workspaceList}
                onSourceAdded={refreshPageList}
                onPageWritten={handlePageWritten}
                onPageClick={selectPage}
                onWorkspacesChanged={refreshWorkspaceList}
              />
            </div>
          </>
        )}
      </div>
      <HelpDialog open={showHelp} onClose={() => setShowHelp(false)} />
      {showSources && <SourcesDialog workspaceId={workspaceId} onClose={() => setShowSources(false)} />}
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
    </div>
  );
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

function ModalShell({
  labelId,
  onClose,
  children,
}: {
  labelId: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelId}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        style={{ background: 'oklch(8% 0.01 250 / 0.55)' }}
        onClick={onClose}
        aria-hidden="true"
        tabIndex={-1}
      />
      {children}
    </div>
  );
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
    <ModalShell labelId="ws-rename-title" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(name);
        }}
        className="relative w-full max-w-sm space-y-4 rounded-xl border p-5 shadow-2xl"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
      >
        <h2 id="ws-rename-title" className="text-base font-semibold">{t('workspace.renameWorkspace')}</h2>
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
    </ModalShell>
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
    <ModalShell labelId="ws-delete-title" onClose={onClose}>
      <section
        className="relative w-full max-w-sm space-y-4 rounded-xl border p-5 shadow-2xl"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
      >
        <h2 id="ws-delete-title" className="text-base font-semibold">{t('workspace.deleteWorkspace')}</h2>
        <p className="text-sm leading-6" style={{ color: 'var(--fg-muted)' }}>
          {t('workspace.deleteWorkspaceConfirm', { name: workspace.name })}
        </p>
        {error && <p className="text-xs" style={{ color: 'oklch(65% 0.18 30)' }}>{error}</p>}
        <div className="flex justify-end gap-2">
          {/* autoFocus Cancel so Enter can't accidentally destroy a workspace */}
          <button type="button" autoFocus onClick={onClose} className="rounded-md px-3 py-2 text-sm" style={{ color: 'var(--fg-muted)' }}>
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
    </ModalShell>
  );
}

