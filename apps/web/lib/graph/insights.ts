import { pickAliasMatch, type AliasCandidate } from '@/lib/wiki/resolve';

export const MAX_GRAPH_INSIGHT_ITEMS = 100;

export interface GraphPage extends AliasCandidate {
  slug: string;
  title: string | null;
}

export interface GraphPageLink {
  from_slug: string;
  to_slug: string;
}

export interface GraphInsightPage {
  slug: string;
  title: string | null;
}

export interface GraphInsightMissingLink {
  from_slug: string;
  to_slug: string;
}

export interface GraphInsightCommunity {
  id: string;
  pages: GraphInsightPage[];
}

export interface GraphInsightCounts {
  pages: number;
  links: number;
  orphans: number;
  communities: number;
  bridges: number;
  missingLinks: number;
}

export interface GraphInsights {
  counts: GraphInsightCounts;
  orphans: GraphInsightPage[];
  communities: GraphInsightCommunity[];
  bridges: GraphInsightPage[];
  missingLinks: GraphInsightMissingLink[];
}

interface ResolvedEdge {
  source: string;
  target: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePages(left: GraphPage, right: GraphPage): number {
  return compareText(left.slug, right.slug) || compareText(left.title ?? '', right.title ?? '');
}

function compareInsightPages(left: GraphInsightPage, right: GraphInsightPage): number {
  return compareText(left.slug, right.slug) || compareText(left.title ?? '', right.title ?? '');
}

function pageSummary(page: GraphPage): GraphInsightPage {
  return { slug: page.slug, title: page.title ?? null };
}

function sortedPageSummaries(pages: readonly GraphPage[]): GraphInsightPage[] {
  return pages.map(pageSummary).sort(compareInsightPages);
}

function cap<T>(items: readonly T[]): T[] {
  return items.slice(0, MAX_GRAPH_INSIGHT_ITEMS);
}

function edgeKey(source: string, target: string): string {
  return compareText(source, target) <= 0 ? `${source}\u0000${target}` : `${target}\u0000${source}`;
}

function resolveEdges(
  pages: readonly GraphPage[],
  links: readonly GraphPageLink[],
): { edges: ResolvedEdge[]; missingLinks: GraphInsightMissingLink[] } {
  const edgesByKey = new Map<string, ResolvedEdge>();
  const missingLinks: GraphInsightMissingLink[] = [];
  const candidates = [...pages];

  for (const link of links) {
    const source = pickAliasMatch(candidates, link.from_slug);
    const target = pickAliasMatch(candidates, link.to_slug);
    if (!target) {
      missingLinks.push({ from_slug: link.from_slug, to_slug: link.to_slug });
    }
    if (!source || !target || source.slug === target.slug) continue;

    const key = edgeKey(source.slug, target.slug);
    if (!edgesByKey.has(key)) {
      edgesByKey.set(key, { source: source.slug, target: target.slug });
    }
  }

  const edges = Array.from(edgesByKey.values()).sort(
    (left, right) => compareText(left.source, right.source) || compareText(left.target, right.target),
  );
  missingLinks.sort(
    (left, right) => compareText(left.from_slug, right.from_slug) || compareText(left.to_slug, right.to_slug),
  );
  return { edges, missingLinks };
}

function buildAdjacency(pages: readonly GraphPage[], edges: readonly ResolvedEdge[]): Map<string, Set<string>> {
  const adjacency = new Map(pages.map((page) => [page.slug, new Set<string>()]));
  for (const edge of edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  return adjacency;
}

function findComponents(
  pages: readonly GraphPage[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const page of pages) {
    if (visited.has(page.slug)) continue;
    const component: string[] = [];
    const pending = [page.slug];
    visited.add(page.slug);
    while (pending.length > 0) {
      const slug = pending.pop()!;
      component.push(slug);
      const neighbors = Array.from(adjacency.get(slug) ?? []).sort(compareText).reverse();
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    component.sort(compareText);
    components.push(component);
  }

  components.sort((left, right) => compareText(left[0] ?? '', right[0] ?? ''));
  return components;
}

/**
 * Tarjan's linear-time articulation-point pass over the simple undirected graph.
 * ponytail: connected components are structural groups, not semantic communities; add
 * embeddings/LLM clustering only when users need topic similarity rather than reachability.
 */
function findArticulationSlugs(
  pages: readonly GraphPage[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const discovery = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string>();
  const articulation = new Set<string>();
  let clock = 0;

  const visit = (slug: string): void => {
    discovery.set(slug, ++clock);
    low.set(slug, discovery.get(slug)!);
    let childCount = 0;

    for (const neighbor of Array.from(adjacency.get(slug) ?? []).sort(compareText)) {
      if (!discovery.has(neighbor)) {
        parent.set(neighbor, slug);
        childCount += 1;
        visit(neighbor);
        low.set(slug, Math.min(low.get(slug)!, low.get(neighbor)!));

        const isRoot = !parent.has(slug);
        if ((isRoot && childCount > 1) || (!isRoot && low.get(neighbor)! >= discovery.get(slug)!)) {
          articulation.add(slug);
        }
      } else if (parent.get(slug) !== neighbor) {
        low.set(slug, Math.min(low.get(slug)!, discovery.get(neighbor)!));
      }
    }
  };

  for (const page of pages) {
    if (!discovery.has(page.slug)) visit(page.slug);
  }
  return articulation;
}

export function analyzeGraphInsights(
  inputPages: readonly GraphPage[],
  inputLinks: readonly GraphPageLink[],
): GraphInsights {
  const pages = [...inputPages].sort(comparePages);
  const pageBySlug = new Map(pages.map((page) => [page.slug, page]));
  const { edges, missingLinks } = resolveEdges(pages, inputLinks);
  const adjacency = buildAdjacency(pages, edges);
  const components = findComponents(pages, adjacency);
  const articulationSlugs = findArticulationSlugs(pages, adjacency);
  const orphans = pages.filter((page) => (adjacency.get(page.slug)?.size ?? 0) === 0);
  const bridges = pages.filter((page) => articulationSlugs.has(page.slug));
  const communities = cap(
    components.map((component) => ({
      id: `community:${component[0] ?? 'empty'}`,
      pages: cap(
        component
          .map((slug) => pageBySlug.get(slug))
          .filter((page): page is GraphPage => page !== undefined)
          .map(pageSummary),
      ),
    })),
  );

  return {
    counts: {
      pages: pages.length,
      links: edges.length,
      orphans: orphans.length,
      communities: components.length,
      bridges: bridges.length,
      missingLinks: missingLinks.length,
    },
    orphans: cap(sortedPageSummaries(orphans)),
    communities,
    bridges: cap(sortedPageSummaries(bridges)),
    missingLinks: cap(missingLinks),
  };
}
