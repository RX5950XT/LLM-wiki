'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { canonicalWikiAlias } from '@/lib/wiki/slug';

interface GraphNode {
  id: string;
  label: string;
  kind: string;
}

interface GraphLink {
  source: string;
  target: string;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

interface GraphViewProps {
  workspaceId: string;
  activePage?: string;
  onNodeClick?: (slug: string) => void;
  refreshKey?: number;
}

/**
 * The palette is one cool family drawn around the app's cyan accent, with a single
 * warm exception: synthesis pages are the only ones the wiki reasons out for itself
 * rather than transcribes, so they are the one thing that reads warm on a cold field.
 */
const KIND_GROUPS = ['entity', 'concept', 'summary', 'synthesis'] as const;
type KindGroup = (typeof KIND_GROUPS)[number] | 'other';

const KIND_COLOR: Record<KindGroup, string> = {
  entity: '#4ea8de',
  concept: '#2ec4b6',
  summary: '#7b8ed8',
  synthesis: '#e8a33d',
  other: '#8b9095',
};

function kindGroup(kind: string): KindGroup {
  const k = kind.toLowerCase();
  if (k.startsWith('entit')) return 'entity';
  if (k.startsWith('concept')) return 'concept';
  if (k.startsWith('summar')) return 'summary';
  if (k.startsWith('synth')) return 'synthesis';
  return 'other';
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function isDarkTheme(): boolean {
  if (typeof window === 'undefined') return true;
  const attr = document.documentElement.dataset.theme;
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Fade a hex colour to an rgba string — canvas has no alpha channel on fillStyle. */
function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// react-force-graph-2d is ESM-only and uses window, so we load it dynamically
// to avoid Next.js SSR issues.
export function GraphView({ workspaceId, activePage, onNodeClick, refreshKey = 0 }: GraphViewProps) {
  const t = useTranslations('graph');
  const containerRef = useRef<HTMLDivElement>(null);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<Set<KindGroup>>(new Set());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rootRef = useRef<{ render: (el: any) => void; unmount: () => void } | null>(null);
  // Every wiki write arrives over Realtime, so graphData changes mid-view during an
  // import or a maintenance run. Re-creating the force graph each time restarts the
  // layout from random positions and throws the camera back to its default — the
  // base reads as a jittering knot. Carry the settled coordinates across, and fit
  // the view only the first time it settles.
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const didFitRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const rootContainerRef = useRef<HTMLDivElement | null>(null);
  // Read inside the canvas painter, which is created once — a ref keeps filtering
  // instant instead of tearing the force simulation down and re-settling it.
  const hiddenRef = useRef(hiddenKinds);
  hiddenRef.current = hiddenKinds;

  // Load graph data from Supabase
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    async function load() {
      // Only the first load blanks the panel. A refresh (a page written while the
      // graph is open) must not swap the canvas for a spinner and back — that
      // unmounts the force graph and loses both the layout and the camera.
      if (!hasLoadedRef.current) setLoading(true);
      try {
        const [pagesRes, linksRes] = await Promise.all([
          supabase
            .from('pages')
            .select('slug, title, kind')
            .eq('workspace_id', workspaceId)
            // The graph is the knowledge base, not the machinery: the _schema rule
            // pages are not part of what the wiki knows and were showing up as nodes.
            .eq('zone', 'wiki'),
          supabase
            .from('page_links')
            .select('from_slug, to_slug')
            .eq('workspace_id', workspaceId),
        ]);

        if (cancelled) return;

        const nodes: GraphNode[] = (pagesRes.data ?? []).map((p) => ({
          id: p.slug as string,
          label: (p.title ?? p.slug) as string,
          kind: (p.kind ?? 'wiki') as string,
        }));

        // Resolve edge endpoints to real node ids. ~37% of stored links use a
        // different slug format (missing folder / casing) or point at pages that
        // no longer exist; without this the force graph spawns phantom nodes.
        const nodeIds = new Set(nodes.map((n) => n.id));
        const aliasCount = new Map<string, number>();
        const aliasToId = new Map<string, string>();
        for (const n of nodes) {
          const a = canonicalWikiAlias(n.id);
          aliasCount.set(a, (aliasCount.get(a) ?? 0) + 1);
          aliasToId.set(a, n.id);
        }
        const resolveId = (raw: string): string | null => {
          if (nodeIds.has(raw)) return raw;
          const a = canonicalWikiAlias(raw);
          return aliasCount.get(a) === 1 ? aliasToId.get(a)! : null;
        };

        const links: GraphLink[] = [];
        const seen = new Set<string>();
        for (const l of linksRes.data ?? []) {
          const source = resolveId(l.from_slug as string);
          const target = resolveId(l.to_slug as string);
          if (!source || !target || source === target) continue;
          const key = `${source} ${target}`;
          if (seen.has(key)) continue;
          seen.add(key);
          links.push({ source, target });
        }

        setGraphData({ nodes, links });
      } finally {
        if (!cancelled) {
          hasLoadedRef.current = true;
          setLoading(false);
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [workspaceId, refreshKey]);

  // A different workspace is a different map: keep neither its coordinates nor its camera.
  useEffect(() => {
    hasLoadedRef.current = false;
    positionsRef.current.clear();
    didFitRef.current = false;
  }, [workspaceId]);

  // Track container size so panel drags / window resizes reflow the canvas
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        setSize((prev) =>
          prev && Math.abs(prev.width - width) < 2 && Math.abs(prev.height - height) < 2
            ? prev
            : { width, height },
        );
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading, graphData.nodes.length]);

  const orphanCount = useMemo(() => {
    const linked = new Set<string>();
    for (const l of graphData.links) {
      linked.add(l.source);
      linked.add(l.target);
    }
    return graphData.nodes.filter((n) => !linked.has(n.id)).length;
  }, [graphData]);

  const toggleKind = useCallback((kind: KindGroup) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
    fgRef.current?.refresh?.();
  }, []);

  const zoomToFit = useCallback(() => {
    fgRef.current?.zoomToFit?.(prefersReducedMotion() ? 0 : 500, 48);
  }, []);

  // Dynamically load and mount react-force-graph-2d
  useEffect(() => {
    if (loading || !containerRef.current || graphData.nodes.length === 0) return;

    let mounted = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ForceGraph: React.ComponentType<any> | null = null;

    (async () => {
      try {
        const mod = await import('react-force-graph-2d');
        ForceGraph = mod.default;

        if (!mounted || !containerRef.current) return;

        const { createRoot } = await import('react-dom/client');
        const { createElement } = await import('react');

        // Resume each node where the simulation last left it, so a Realtime update
        // nudges the layout instead of scattering it.
        for (const node of graphData.nodes) {
          const previous = positionsRef.current.get(node.id);
          if (previous) Object.assign(node, previous);
        }

        const width = size?.width ?? containerRef.current.clientWidth ?? 600;
        const height = size?.height ?? containerRef.current.clientHeight ?? 400;
        const accent = cssVar('--color-accent', '#00bbcb');
        const labelColor = cssVar('--fg-muted', '#8b9095');
        const dark = isDarkTheme();
        const reduceMotion = prefersReducedMotion();

        // Connectivity is the graph's only real quantity, so it drives everything
        // that reads at a glance: size, glow, and how loud the label is.
        //
        // d3-force REWRITES link.source/target in place from an id into the node
        // object, so on any re-mount (a panel drag is enough) these are no longer
        // strings. Keying the degree map off them raw made every node come out with
        // degree 0 — the whole graph rendered as unconnected husks.
        const endpointId = (end: unknown): string =>
          typeof end === 'object' && end !== null ? (end as { id: string }).id : (end as string);

        const degree = new Map<string, number>();
        const neighbors = new Map<string, Set<string>>();
        for (const link of graphData.links) {
          const source = endpointId(link.source);
          const target = endpointId(link.target);
          degree.set(source, (degree.get(source) ?? 0) + 1);
          degree.set(target, (degree.get(target) ?? 0) + 1);
          if (!neighbors.has(source)) neighbors.set(source, new Set());
          if (!neighbors.has(target)) neighbors.set(target, new Set());
          neighbors.get(source)!.add(target);
          neighbors.get(target)!.add(source);
        }
        const maxDegree = Math.max(1, ...degree.values());
        const hover: { id: string | null } = { id: null };

        const visible = (node: GraphNode) => !hiddenRef.current.has(kindGroup(node.kind));
        const nodeColor = (node: GraphNode) => KIND_COLOR[kindGroup(node.kind)];
        const nodeRadius = (node: GraphNode) => {
          const d = degree.get(node.id) ?? 0;
          return Math.min(2.6 + Math.sqrt(d) * 1.7, 13);
        };

        /** 1 = fully lit, lower = pushed back. Hover focuses a neighbourhood. */
        const emphasis = (node: GraphNode): number => {
          if (!hover.id) return 1;
          if (node.id === hover.id) return 1;
          return neighbors.get(hover.id)?.has(node.id) ? 0.92 : 0.12;
        };

        const fg = createElement(ForceGraph!, {
          ref: fgRef,
          graphData,
          width,
          height,
          backgroundColor: 'transparent',
          nodeLabel: (node: GraphNode) => node.label,
          nodeVal: (node: GraphNode) => nodeRadius(node) ** 2 / 4,
          nodeVisibility: visible,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkVisibility: (link: any) => {
            const s = typeof link.source === 'object' ? link.source : { kind: '' };
            const target = typeof link.target === 'object' ? link.target : { kind: '' };
            return visible(s as GraphNode) && visible(target as GraphNode);
          },
          // Settle the layout off-screen for readers who asked for no motion, instead
          // of animating a swarm of nodes into place in front of them.
          warmupTicks: reduceMotion ? 200 : 0,
          cooldownTicks: reduceMotion ? 0 : undefined,
          // Fill the panel once the layout settles, instead of leaving the whole base
          // as a knot in the middle of an empty canvas. Only the first settle: yanking
          // the camera every time a page is written would fight whoever is reading.
          onEngineStop: () => {
            for (const node of graphData.nodes as (GraphNode & { x?: number; y?: number })[]) {
              if (typeof node.x === 'number' && typeof node.y === 'number') {
                positionsRef.current.set(node.id, { x: node.x, y: node.y });
              }
            }
            if (didFitRef.current) return;
            didFitRef.current = true;
            fgRef.current?.zoomToFit?.(reduceMotion ? 0 : 400, 56);
          },
          nodeCanvasObjectMode: () => 'replace' as const,
          nodeCanvasObject: (
            node: GraphNode & { x?: number; y?: number },
            canvasCtx: CanvasRenderingContext2D,
            globalScale: number,
          ) => {
            const x = node.x ?? 0;
            const y = node.y ?? 0;
            const r = nodeRadius(node);
            const d = degree.get(node.id) ?? 0;
            const alpha = emphasis(node);
            const color = nodeColor(node);
            const isActive = node.id === activePage;
            const focused = hover.id === node.id;

            // A page nothing links to is a finding, not noise: draw it hollow so it
            // stays legible and countable rather than dimmed into the background.
            const orphan = d === 0;

            canvasCtx.save();
            canvasCtx.globalAlpha = alpha;

            // Hubs glow: the more the wiki connects a page, the brighter it burns.
            const glow = (d / maxDegree) * (dark ? 16 : 8);
            if (!orphan && glow > 0.5 && alpha > 0.5) {
              canvasCtx.shadowColor = withAlpha(isActive ? accent : color, dark ? 0.55 : 0.3);
              canvasCtx.shadowBlur = glow;
            }

            canvasCtx.beginPath();
            canvasCtx.arc(x, y, r, 0, 2 * Math.PI);
            if (orphan) {
              canvasCtx.lineWidth = 1 / globalScale + 0.35;
              canvasCtx.strokeStyle = withAlpha(color, 0.75);
              canvasCtx.stroke();
            } else {
              canvasCtx.fillStyle = isActive ? accent : color;
              canvasCtx.fill();
            }
            canvasCtx.shadowBlur = 0;

            // The page you are reading gets an instrument ring — a marker, not a blob.
            if (isActive || focused) {
              canvasCtx.beginPath();
              canvasCtx.arc(x, y, r + 3.5, 0, 2 * Math.PI);
              canvasCtx.lineWidth = 1.2 / globalScale + 0.3;
              canvasCtx.strokeStyle = withAlpha(isActive ? accent : color, isActive ? 0.9 : 0.5);
              canvasCtx.stroke();
            }

            // Labels ramp in with zoom instead of snapping on at a threshold; the
            // focused neighbourhood and the active page are always named. They stay
            // out until you lean in — at the zoom that fits the whole base, every
            // label on screen at once is a hairball, not a map.
            const zoomAlpha = Math.min(1, Math.max(0, (globalScale - 1.5) / 0.8));
            const named = focused || isActive || (hover.id != null && alpha > 0.5);
            const labelAlpha = named ? alpha : zoomAlpha * alpha;
            if (labelAlpha > 0.05) {
              const fontSize = Math.max(10 / globalScale, 2.6);
              canvasCtx.globalAlpha = labelAlpha;
              canvasCtx.font = `${named ? '600 ' : ''}${fontSize}px "Geist", "Noto Sans TC", sans-serif`;
              canvasCtx.textAlign = 'center';
              canvasCtx.textBaseline = 'top';
              canvasCtx.fillStyle = isActive ? accent : named ? color : labelColor;
              canvasCtx.fillText(node.label, x, y + r + 2.5);
            }
            canvasCtx.restore();
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkColor: (link: any) => {
            const s = typeof link.source === 'object' ? link.source.id : link.source;
            const target = typeof link.target === 'object' ? link.target.id : link.target;
            if (hover.id) {
              if (s !== hover.id && target !== hover.id) {
                return dark ? 'rgba(139,144,149,0.05)' : 'rgba(79,86,94,0.05)';
              }
              return withAlpha(accent.startsWith('#') ? accent : '#00bbcb', 0.85);
            }
            return dark ? 'rgba(139,144,149,0.22)' : 'rgba(79,86,94,0.18)';
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkWidth: (link: any) => {
            if (!hover.id) return 0.8;
            const s = typeof link.source === 'object' ? link.source.id : link.source;
            const target = typeof link.target === 'object' ? link.target.id : link.target;
            return s === hover.id || target === hover.id ? 1.8 : 0.5;
          },
          onNodeHover: (node: GraphNode | null) => {
            hover.id = node?.id ?? null;
            if (containerRef.current) {
              containerRef.current.style.cursor = node ? 'pointer' : 'grab';
            }
          },
          onNodeClick: (node: GraphNode) => {
            onNodeClick?.((node as GraphNode & { id: string }).id);
          },
        });

        // Re-render the same root instead of unmounting it: a fresh root means a
        // fresh force-graph instance, which resets the camera — the reason the base
        // kept snapping back to a tiny knot while an import was writing pages.
        // (A root bound to a container React has since replaced is dead: rebuild it.)
        if (rootRef.current && rootContainerRef.current !== containerRef.current) {
          rootRef.current.unmount();
          rootRef.current = null;
        }
        if (!rootRef.current) {
          rootRef.current = createRoot(containerRef.current!);
          rootContainerRef.current = containerRef.current;
        }
        rootRef.current.render(fg);

        // The camera controls (fit, recenter) live on the imperative handle. Without
        // it they fail silently and the base sits as an unreadable knot in the middle.
        setTimeout(() => {
          if (mounted && !fgRef.current) {
            console.warn('[graph] force-graph imperative handle missing — zoom controls are dead');
          }
        }, 1500);
      } catch (e) {
        console.error('Graph load failed', e);
      }
    })();

    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, graphData, activePage, size]);

  // Tear the force graph down only when the panel itself goes away.
  useEffect(
    () => () => {
      rootRef.current?.unmount();
      rootRef.current = null;
      fgRef.current = null;
    },
    [],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--fg-muted)' }}>
        {t('loading')}
      </div>
    );
  }

  if (graphData.nodes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-sm" style={{ color: 'var(--fg)' }}>{t('empty')}</p>
        <p className="text-xs" style={{ color: 'var(--fg-muted)' }}>{t('emptyHint')}</p>
      </div>
    );
  }

  const filters: { kind: KindGroup; label: string }[] = [
    { kind: 'entity', label: t('legendEntity') },
    { kind: 'concept', label: t('legendConcept') },
    { kind: 'summary', label: t('legendSummary') },
    { kind: 'synthesis', label: t('legendSynthesis') },
    { kind: 'other', label: t('legendOther') },
  ];

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />

      {/* Legend and filter are the same control: the colour key is the switch. */}
      <div
        className="absolute bottom-3 left-3 flex flex-wrap items-center gap-1.5 rounded-xl border p-1.5"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
        role="group"
        aria-label={t('filterLabel')}
      >
        {filters.map(({ kind, label }) => {
          const off = hiddenKinds.has(kind);
          return (
            <button
              key={kind}
              type="button"
              onClick={() => toggleKind(kind)}
              aria-pressed={!off}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] transition-opacity hover:opacity-80"
              style={{
                background: off ? 'transparent' : 'var(--bg)',
                color: off ? 'var(--fg-muted)' : 'var(--fg)',
                opacity: off ? 0.5 : 1,
              }}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{
                  background: off ? 'transparent' : KIND_COLOR[kind],
                  border: `1px solid ${KIND_COLOR[kind]}`,
                }}
              />
              {label}
            </button>
          );
        })}
      </div>

      {/* Readout: what the graph is showing, and how much of it is unconnected. */}
      <div
        className="absolute top-3 left-3 flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[11px]"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
      >
        <span>{t('stats', { pages: graphData.nodes.length, links: graphData.links.length })}</span>
        {orphanCount > 0 && (
          <span
            className="rounded px-1.5 py-0.5"
            style={{ background: 'var(--color-accent-glow)', color: 'var(--color-accent)' }}
          >
            {t('orphans', { count: orphanCount })}
          </span>
        )}
        <button
          type="button"
          onClick={zoomToFit}
          className="ml-1 rounded p-1 transition-opacity hover:opacity-70"
          style={{ color: 'var(--fg)' }}
          aria-label={t('zoomToFit')}
          title={t('zoomToFit')}
        >
          <Crosshair size={12} />
        </button>
      </div>
    </div>
  );
}
