/**
 * Resolving a wiki link to the page it means.
 *
 * The model writes links the way a human would — `[[DRAM 市場 2026 年供需危機]]`
 * (the page's title), `[[Agentic AI Transformation]]` (no folder, spaced) — while
 * the page is stored as `summaries/dram-market-2026-crisis.md`. And once
 * maintenance re-shelves a page into another workspace, every link to it in the
 * old workspace points at nothing at all.
 *
 * Measured on production: of 581 links, 424 matched by slug alias, 37 more match
 * only by title, and 69 more resolve only in a different workspace. Everything
 * here is a *unique* match — an ambiguous target is left unresolved rather than
 * guessed at, because sending the reader to the wrong page is worse than telling
 * them the link is dead.
 */
import { canonicalWikiAlias } from './slug';

export interface AliasCandidate {
  slug: string;
  title?: string | null;
}

/**
 * The one page a link target names, or null when nothing (or more than one thing)
 * matches. Slug beats title: a link that names a real slug means that page even if
 * some other page happens to carry it as a title.
 */
export function pickAliasMatch<T extends AliasCandidate>(candidates: T[], target: string): T | null {
  const alias = canonicalWikiAlias(target);
  if (!alias) return null;

  const bySlug = candidates.filter((c) => canonicalWikiAlias(c.slug) === alias);
  if (bySlug.length === 1) return bySlug[0]!;
  if (bySlug.length > 1) return null; // colliding basenames — do not guess

  const byTitle = candidates.filter((c) => c.title && canonicalWikiAlias(c.title) === alias);
  return byTitle.length === 1 ? byTitle[0]! : null;
}
