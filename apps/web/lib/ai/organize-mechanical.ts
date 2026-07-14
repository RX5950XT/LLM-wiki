/**
 * The parts of maintenance that do NOT need a model.
 *
 * Deleting an emptied workspace and spotting two pages that are literally the
 * same page are decidable from the pages table. Handing them to the LLM cost a
 * full 200s tool loop, produced a different answer every run, and — when the
 * model read "merge workspaces" as "sweep everything into the one I started
 * from, then delete the husk" — wiped out an entire shelf. Code does these; the
 * model is left with the judgement calls (what a page is about, where it belongs).
 */
import type { drive_v3 } from 'googleapis';
import { deleteWorkspaceForUser } from '@/lib/workspaces/manage';
import { canonicalWikiAlias } from '@/lib/wiki/slug';

/** Present in every workspace, never movable or deletable — not knowledge. */
export const SCAFFOLDING_SLUGS = new Set(['index.md', 'log.md']);

/**
 * A workspace created moments ago is empty because nothing has been imported into
 * it YET (the import router creates one, then ingests into it). Deleting those out
 * from under the user is the one way this sweep could hurt.
 */
const NEW_WORKSPACE_GRACE_MS = 60 * 60 * 1000;

export interface WorkspaceRow {
  id: string;
  name: string;
  created_at?: string | null;
}

export interface InventoryRow {
  workspace_id: string;
  slug: string;
  title: string | null;
  kind: string;
  search_text?: string | null;
}

/**
 * Workspaces holding nothing but scaffolding, old enough to be a real leftover.
 *
 * `graceExemptIds` are workspaces THIS maintenance run created itself: the grace
 * period exists to protect a workspace the import router just made (its ingest is
 * still writing into it), and a workspace the run created but never filled is not
 * that — leaving it costs the user an empty shelf in their switcher for an hour.
 */
export function pickDeletableWorkspaces(
  workspaces: WorkspaceRow[],
  pages: InventoryRow[],
  currentWorkspaceId: string,
  now: number,
  graceExemptIds: ReadonlySet<string> = new Set(),
): WorkspaceRow[] {
  const holdsKnowledge = new Set(
    pages.filter((p) => !SCAFFOLDING_SLUGS.has(p.slug)).map((p) => p.workspace_id),
  );
  return workspaces.filter((w) => {
    if (holdsKnowledge.has(w.id)) return false;
    // The user is looking at it — deleting it leaves them staring at a dead page.
    if (w.id === currentWorkspaceId) return false;
    if (graceExemptIds.has(w.id)) return true;
    const age = now - Date.parse(w.created_at ?? '');
    // Unparseable created_at → NaN → false → keep it. Never delete on a bad date.
    return age >= NEW_WORKSPACE_GRACE_MS;
  });
}

/**
 * Delete the emptied husks. Returns progress labels for agent_jobs.progress.
 *
 * Sweeping is a chore, not the job: a workspace whose Drive folder is gone makes
 * `deleteWorkspaceForUser` throw, and an uncaught throw here would fail the whole
 * maintenance run before the model even starts. Skip the husk, keep going.
 */
export async function sweepEmptyWorkspaces(
  drive: drive_v3.Drive,
  userId: string,
  workspaces: WorkspaceRow[],
  pages: InventoryRow[],
  currentWorkspaceId: string,
  graceExemptIds: ReadonlySet<string> = new Set(),
): Promise<{ ops: string[]; deletedIds: Set<string> }> {
  const ops: string[] = [];
  const deletedIds = new Set<string>();

  for (const ws of pickDeletableWorkspaces(
    workspaces,
    pages,
    currentWorkspaceId,
    Date.now(),
    graceExemptIds,
  )) {
    const result = await deleteWorkspaceForUser(drive, userId, ws.id).catch((error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    if (result.ok) {
      ops.push(`deleteWorkspace:${ws.name}`);
      deletedIds.add(ws.id);
    }
  }
  return { ops, deletedIds };
}

export interface LinkRow {
  workspace_id: string;
  from_slug: string;
  to_slug: string;
}

export interface DeadLink extends LinkRow {
  /** Present when the target exists in a DIFFERENT workspace (maintenance moved it). */
  lives_in_workspace_id?: string;
}

/**
 * Links that point at nothing.
 *
 * The health check was told to "fix broken [[wikilinks]]" and never fixed any:
 * finding them means cross-referencing every link against every page, which the
 * model cannot do by eyeballing an inventory. Code can, exactly, in one pass —
 * so code does it and hands over the list.
 *
 * A link is alive if some page in the same workspace matches it by slug alias or
 * by title alias (that is what the page API resolves at read time, so anything it
 * resolves must not be reported as broken here). What is left is genuinely dead:
 * either the page sits in another workspace, or nobody ever wrote it.
 */
export function findDeadLinks(links: LinkRow[], pages: InventoryRow[]): DeadLink[] {
  const aliasesByWorkspace = new Map<string, Set<string>>();
  const workspacesByAlias = new Map<string, string>();

  for (const page of pages) {
    const set = aliasesByWorkspace.get(page.workspace_id) ?? new Set<string>();
    for (const alias of [canonicalWikiAlias(page.slug), page.title ? canonicalWikiAlias(page.title) : '']) {
      if (!alias) continue;
      set.add(alias);
      if (!workspacesByAlias.has(alias)) workspacesByAlias.set(alias, page.workspace_id);
    }
    aliasesByWorkspace.set(page.workspace_id, set);
  }

  const dead: DeadLink[] = [];
  for (const link of links) {
    const alias = canonicalWikiAlias(link.to_slug);
    if (!alias) continue;
    if (aliasesByWorkspace.get(link.workspace_id)?.has(alias)) continue;
    const elsewhere = workspacesByAlias.get(alias);
    dead.push(elsewhere ? { ...link, lives_in_workspace_id: elsewhere } : link);
  }
  return dead;
}

/**
 * Pages a workspace's index.md does not link to. "The index is out of date" is a
 * set difference, not a judgement call — the model only has to write the lines.
 */
export function findPagesMissingFromIndex(
  workspaceId: string,
  pages: InventoryRow[],
  indexLinks: LinkRow[],
): string[] {
  const linked = new Set(
    indexLinks
      .filter((l) => l.workspace_id === workspaceId && l.from_slug === 'index.md')
      .map((l) => canonicalWikiAlias(l.to_slug)),
  );
  return pages
    .filter((p) => p.workspace_id === workspaceId && !SCAFFOLDING_SLUGS.has(p.slug))
    .filter((p) => !linked.has(canonicalWikiAlias(p.slug)) && !linked.has(canonicalWikiAlias(p.title ?? '')))
    .map((p) => p.slug);
}

export interface DuplicateCluster {
  label: string;
  pages: InventoryRow[];
}

/**
 * Pages that are the same page written twice: same slug once folder prefix, case
 * and separators are stripped (`concepts/HBM` vs `concepts/hbm.md`), or the same
 * title under different slugs. Cheap, exact, and it works across workspaces —
 * which is where the model missed them, because it only ever compared slugs.
 *
 * Semantic duplicates (two names for one thing) are still the model's job.
 */
export function findDuplicateClusters(pages: InventoryRow[]): DuplicateCluster[] {
  const knowledge = pages.filter((p) => !SCAFFOLDING_SLUGS.has(p.slug));
  const clusters = new Map<string, InventoryRow[]>();

  const add = (key: string, page: InventoryRow) => {
    const list = clusters.get(key) ?? [];
    list.push(page);
    clusters.set(key, list);
  };

  for (const page of knowledge) {
    add(`slug:${canonicalWikiAlias(page.slug)}`, page);
    const title = page.title?.trim().toLowerCase();
    if (title) add(`title:${title}`, page);
  }

  const seen = new Set<string>();
  const out: DuplicateCluster[] = [];
  for (const [key, list] of clusters) {
    if (list.length < 2) continue;
    // The same pair reached from both the slug and the title key is one cluster.
    const fingerprint = list
      .map((p) => `${p.workspace_id}/${p.slug}`)
      .sort()
      .join('|');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push({ label: key.slice(key.indexOf(':') + 1), pages: list });
  }
  return out;
}

/**
 * A workspace whose index.md is still the "this wiki is empty" seed while it holds
 * real pages. Maintenance can create a workspace and move pages into it in its last
 * pass, run out of budget, and leave the new shelf announcing it has nothing — which
 * is exactly what the user opens first. Listing the pages that exist is not a
 * judgement call, so code does it; the next model pass will regroup the list into
 * themes with its own prose.
 */
const INDEX_SECTIONS: Record<string, Record<string, string>> = {
  'zh-TW': {
    entity: '實體',
    concept: '概念',
    summary: '摘要',
    synthesis: '綜合',
    other: '其他',
  },
  en: {
    entity: 'Entities',
    concept: 'Concepts',
    summary: 'Summaries',
    synthesis: 'Synthesis',
    other: 'Other',
  },
};

export function buildSeedIndexMarkdown(
  workspaceName: string,
  pages: InventoryRow[],
  locale: string,
): string {
  const labels = INDEX_SECTIONS[locale] ?? INDEX_SECTIONS.en!;
  const knowledge = pages.filter((p) => !SCAFFOLDING_SLUGS.has(p.slug));
  const order = ['entity', 'concept', 'summary', 'synthesis', 'other'];

  const sections = order
    .map((kind) => {
      const rows = knowledge.filter((p) =>
        kind === 'other' ? !order.slice(0, 4).includes(p.kind) : p.kind === kind,
      );
      if (rows.length === 0) return null;
      const items = rows
        .map((p) => `- [[${p.slug}|${p.title?.trim() || p.slug}]]`)
        .sort()
        .join('\n');
      return `## ${labels[kind]}\n\n${items}`;
    })
    .filter(Boolean);

  return `# ${workspaceName}\n\n${sections.join('\n\n')}\n`;
}
