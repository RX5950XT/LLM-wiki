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

/** Workspaces holding nothing but scaffolding, old enough to be a real leftover. */
export function pickDeletableWorkspaces(
  workspaces: WorkspaceRow[],
  pages: InventoryRow[],
  currentWorkspaceId: string,
  now: number,
): WorkspaceRow[] {
  const holdsKnowledge = new Set(
    pages.filter((p) => !SCAFFOLDING_SLUGS.has(p.slug)).map((p) => p.workspace_id),
  );
  return workspaces.filter((w) => {
    if (holdsKnowledge.has(w.id)) return false;
    // The user is looking at it — deleting it leaves them staring at a dead page.
    if (w.id === currentWorkspaceId) return false;
    const age = now - Date.parse(w.created_at ?? '');
    // Unparseable created_at → NaN → false → keep it. Never delete on a bad date.
    return age >= NEW_WORKSPACE_GRACE_MS;
  });
}

/** Delete the emptied husks. Returns progress labels for agent_jobs.progress. */
export async function sweepEmptyWorkspaces(
  drive: drive_v3.Drive,
  userId: string,
  workspaces: WorkspaceRow[],
  pages: InventoryRow[],
  currentWorkspaceId: string,
): Promise<{ ops: string[]; deletedIds: Set<string> }> {
  const ops: string[] = [];
  const deletedIds = new Set<string>();

  for (const ws of pickDeletableWorkspaces(workspaces, pages, currentWorkspaceId, Date.now())) {
    const result = await deleteWorkspaceForUser(drive, userId, ws.id);
    if (result.ok) {
      ops.push(`deleteWorkspace:${ws.name}`);
      deletedIds.add(ws.id);
    }
  }
  return { ops, deletedIds };
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
