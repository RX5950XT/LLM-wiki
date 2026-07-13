/**
 * Canonical wiki-link resolution shared by the page API (server) and the graph
 * (client). The LLM writes links like `[[Agentic AI Transformation]]` while the
 * real page slug is `concepts/agentic_ai_transformation.md`; both collapse to
 * the same alias so a link can be matched to its page regardless of folder
 * prefix, casing, or separator style.
 */
export function canonicalWikiAlias(value: string): string {
  const basename = value
    .trim()
    .replace(/^\//, '')
    .split('#')[0]!
    .replace(/\.md$/i, '')
    .split('/')
    .at(-1)!;
  return basename
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[\s_\-()]+/g, '');
}

/** Normalize a raw wiki target to a `.md` slug (no fuzzy matching). */
export function normalizeWikiSlug(slug: string): string {
  const trimmed = slug.trim().replace(/^\//, '');
  if (!trimmed) return trimmed;
  return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
}
