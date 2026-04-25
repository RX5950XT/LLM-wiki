'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
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
}

// react-force-graph-2d is ESM-only and uses window, so we load it dynamically
// to avoid Next.js SSR issues.
export function GraphView({ workspaceId, activePage, onNodeClick }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
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
  }, [workspaceId]);

  // Dynamically load and mount react-force-graph-2d
  useEffect(() => {
    if (loading || !containerRef.current || graphData.nodes.length === 0) return;

    let mounted = true;
    let ForceGraph: ReturnType<typeof import('react-force-graph-2d')>['default'] | null = null;
    let root: { unmount: () => void } | null = null;

    (async () => {
      try {
        const mod = await import('react-force-graph-2d');
        ForceGraph = mod.default;

        if (!mounted || !containerRef.current) return;

        const { createRoot } = await import('react-dom/client');
        const { createElement } = await import('react');

        const width = containerRef.current.clientWidth || 600;
        const height = containerRef.current.clientHeight || 400;

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
            if ((node as GraphNode & { id: string }).id === activePage) return '#a78bfa';
            switch (node.kind) {
              case 'entity': return '#60a5fa';
              case 'concept': return '#34d399';
              case 'synthesis': return '#f59e0b';
              default: return '#94a3b8';
            }
          },
          linkColor: () => 'rgba(148,163,184,0.3)',
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
  }, [loading, graphData, activePage]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--fg-muted)' }}>
        Loading graph…
      </div>
    );
  }

  if (graphData.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--fg-muted)' }}>
        No pages yet
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" />;
}
