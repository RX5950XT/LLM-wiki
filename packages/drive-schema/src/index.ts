/**
 * Canonical Google Drive folder layout for a workspace.
 *
 * Root: My Drive / Apps / LLM Wiki / {workspace-id}
 */

export const APP_ROOT_NAME = 'LLM Wiki';

export const ZONE = {
  wiki: 'wiki',
  notes: 'notes',
  sources: 'sources',
  schema: '_schema',
} as const;

export type ZoneKey = keyof typeof ZONE;
export type ZoneDir = (typeof ZONE)[ZoneKey];

export const WIKI_SUBDIRS = [
  'entities',
  'concepts',
  'summaries',
  'synthesis',
  '_lint',
] as const;

export type WikiSubdir = (typeof WIKI_SUBDIRS)[number];

export const SPECIAL_PAGES = {
  index: 'index.md',
  log: 'log.md',
} as const;

export const SCHEMA_FILES = {
  ingest: 'ingest.md',
  query: 'query.md',
  lint: 'lint.md',
} as const;

/** Build a path inside a workspace folder: e.g. `wiki/entities/karpathy.md`. */
export function workspacePath(zone: ZoneDir, ...segments: string[]): string {
  return [zone, ...segments].filter(Boolean).join('/');
}

/** Slug → full drive path. Slug is zone-less, e.g. `entities/karpathy.md`. */
export function slugToPath(zone: ZoneDir, slug: string): string {
  const normalized = slug.startsWith('/') ? slug.slice(1) : slug;
  return workspacePath(zone, normalized);
}

/** Validate a slug: must be `<subdir>/<name>.md` or a top-level special file. */
export function isValidWikiSlug(slug: string): boolean {
  if (slug === SPECIAL_PAGES.index || slug === SPECIAL_PAGES.log) return true;
  const match = slug.match(/^([a-z_]+)\/([a-z0-9][a-z0-9-]*)\.md$/);
  if (!match) return false;
  const [, sub] = match;
  return (WIKI_SUBDIRS as readonly string[]).includes(sub!);
}

export const INITIAL_INDEX_CONTENT = `---
title: "Wiki Index"
kind: index
created: ${new Date().toISOString().slice(0, 10)}
---

# Wiki Index

This wiki is empty. Add a source to begin.

## Entities

## Concepts

## Summaries

## Synthesis
`;

export const INITIAL_LOG_CONTENT = `---
title: "Wiki Log"
kind: log
created: ${new Date().toISOString().slice(0, 10)}
---

# Wiki Log

Chronological record of ingests, queries, and lint passes. Append-only.
`;
