import { describe, expect, it } from 'bun:test';
import { analyzeGraphInsights, type GraphPage, type GraphPageLink } from './insights';

const page = (slug: string, title = slug): GraphPage => ({ slug, title });
const link = (from_slug: string, to_slug: string): GraphPageLink => ({ from_slug, to_slug });

describe('analyzeGraphInsights', () => {
  it('finds orphans and stable connected components while ignoring duplicate and self-loop edges', () => {
    const pages = [
      page('concepts/isolated.md', 'Isolated'),
      page('concepts/a.md', 'A'),
      page('concepts/b.md', 'B'),
      page('entities/d.md', 'D'),
      page('entities/e.md', 'E'),
    ];
    const result = analyzeGraphInsights(pages, [
      link('concepts/a', 'concepts/b.md'),
      link('concepts/b.md', 'concepts/a.md'),
      link('concepts/b.md', 'concepts/b.md'),
      link('entities/e.md', 'entities/d'),
    ]);

    expect(result.counts).toEqual({
      pages: 5,
      links: 2,
      orphans: 1,
      communities: 3,
      bridges: 0,
      missingLinks: 0,
    });
    expect(result.orphans.map((item) => item.slug)).toEqual(['concepts/isolated.md']);
    expect(result.communities.map((item) => item.id)).toEqual([
      'community:concepts/a.md',
      'community:concepts/isolated.md',
      'community:entities/d.md',
    ]);
    expect(result.communities[0]!.pages.map((item) => item.slug)).toEqual([
      'concepts/a.md',
      'concepts/b.md',
    ]);
  });

  it('marks articulation pages, not ordinary endpoints, as bridges', () => {
    const result = analyzeGraphInsights(
      [page('a.md'), page('b.md'), page('c.md'), page('d.md'), page('e.md')],
      [link('a.md', 'b.md'), link('b.md', 'c.md'), link('b.md', 'd.md'), link('d.md', 'e.md')],
    );

    expect(result.bridges.map((item) => item.slug)).toEqual(['b.md', 'd.md']);
  });

  it('reports dead and ambiguous targets without guessing an alias collision', () => {
    const result = analyzeGraphInsights(
      [page('concepts/dram.md', 'Memory'), page('entities/dram.md', 'DRAM'), page('live.md', 'Live page')],
      [link('live.md', 'Live page'), link('live.md', 'does-not-exist'), link('live.md', 'dram')],
    );

    expect(result.counts.missingLinks).toBe(2);
    expect(result.missingLinks).toEqual([
      { from_slug: 'live.md', to_slug: 'does-not-exist' },
      { from_slug: 'live.md', to_slug: 'dram' },
    ]);
  });

  it('does not depend on input row order', () => {
    const pages = [page('z.md'), page('a.md'), page('m.md')];
    const links = [link('z.md', 'a.md')];
    expect(analyzeGraphInsights(pages, links)).toEqual(
      analyzeGraphInsights([...pages].reverse(), [...links].reverse()),
    );
  });

  it('caps lists without losing total counts', () => {
    const result = analyzeGraphInsights(
      Array.from({ length: 101 }, (_, index) => page(`isolated/${index}.md`)),
      [],
    );

    expect(result.counts).toMatchObject({ pages: 101, orphans: 101, communities: 101 });
    expect(result.orphans).toHaveLength(100);
    expect(result.communities).toHaveLength(100);
  });
});
