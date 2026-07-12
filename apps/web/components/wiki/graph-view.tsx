'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';

interface GraphNode {
  id: string;
  label: string;
  kind: string;
  val?: number;
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

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// react-force-graph-2d is ESM-only and uses window, so we load it dynamically
// to avoid Next.js SSR issues.
export function GraphView({ workspaceId, activePage, onNodeClick, refreshKey = 0 }: GraphViewProps) {
  const t = useTranslations('graph');
  const containerRef = useRef<HTMLDivElement>(null);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);

  // Load graph data from Supabase
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const [pagesRes, linksRes] = await Promise.all([
          supabase
            .from('pages')
            .select('slug, title, kind')
            .eq('workspace_id', workspaceId),
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

        const links: GraphLink[] = (linksRes.data ?? []).map((l) => ({
          source: l.from_slug as string,
          target: l.to_slug as string,
        }));

        setGraphData({ nodes, links });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [workspaceId, refreshKey]);

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

  // Dynamically load and mount react-force-graph-2d
  useEffect(() => {
    if (loading || !containerRef.current || graphData.nodes.length === 0) return;

    let mounted = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ForceGraph: React.ComponentType<any> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let root: { render: (el: any) => void; unmount: () => void } | null = null;

    (async () => {
      try {
        const mod = await import('react-force-graph-2d');
        ForceGraph = mod.default;

        if (!mounted || !containerRef.current) return;

        const { createRoot } = await import('react-dom/client');
        const { createElement } = await import('react');

        const width = size?.width ?? containerRef.current.clientWidth ?? 600;
        const height = size?.height ?? containerRef.current.clientHeight ?? 400;
        const accent = cssVar('--color-accent', '#2dd4bf');
        const mutedLink = cssVar('--border', 'rgba(148,163,184,0.5)');

        const fg = createElement(ForceGraph!, {
          ref: fgRef,
          graphData,
          width,
          height,
          backgroundColor: 'transparent',
          nodeLabel: (node: GraphNode) => node.label,
          nodeVal: (node: GraphNode) =>
            node.kind === 'index' ? 6 : node.kind === 'entity' ? 4 : 2,
          nodeColor: (node: GraphNode) => {
            if ((node as GraphNode & { id: string }).id === activePage) return accent;
            switch (node.kind) {
              case 'entity': return '#60a5fa';
              case 'concept': return '#34d399';
              case 'synthesis': return '#f59e0b';
              default: return '#94a3b8';
            }
          },
          linkColor: () => mutedLink,
          onNodeClick: (node: GraphNode) => {
            onNodeClick?.((node as GraphNode & { id: string }).id);
          },
        });

        root = createRoot(containerRef.current!);
        root.render(fg);
      } catch (e) {
        console.error('Graph load failed', e);
      }
    })();

    return () => {
      mounted = false;
      root?.unmount();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, graphData, activePage, size]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--fg-muted)' }}>
        {t('loading')}
      </div>
    );
  }

  if (graphData.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--fg-muted)' }}>
        {t('empty')}
      </div>
    );
  }

  const legend: { color: string; label: string }[] = [
    { color: '#60a5fa', label: t('legendEntity') },
    { color: '#34d399', label: t('legendConcept') },
    { color: '#f59e0b', label: t('legendSynthesis') },
    { color: '#94a3b8', label: t('legendOther') },
  ];

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <div
        className="absolute bottom-3 right-3 flex flex-col gap-1 rounded-lg border px-2.5 py-2 text-xs"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
      >
        {legend.map((item) => (
          <span key={item.label} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: item.color }}
            />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
