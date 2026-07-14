/**
 * Auto-routing for imports: pick the workspace an incoming source belongs to,
 * creating one when it belongs to none.
 *
 * The whole point is that the user does not have to file things by hand, so a
 * failure here must never block the import — it falls back to the workspace the
 * import was triggered from. What it must NOT do is fall back *silently and
 * claim success*: `decided: false` tells the caller the placement was a fallback,
 * not a judgement, so the UI stops reporting "filed into X" for an import that
 * merely landed where the user already was.
 */
import type { drive_v3 } from 'googleapis';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateText } from 'ai';
import { createLLMClient } from './client';
import { createWorkspaceForUser } from '@/lib/workspaces/manage';
import { SCAFFOLDING_SLUGS } from './organize-mechanical';

/** Ceiling on router-created workspaces, so a misfiring router can't shard the base. */
const MAX_AUTO_WORKSPACES = 12;

/** Titles per workspace shown to the router — enough to recognise the subject. */
const TITLES_PER_WORKSPACE = 40;

/**
 * The provider behind this project ("Provider returned error" on roughly one call
 * in ten) makes a single-shot routing call a coin flip. One failed call used to
 * dump the source into whatever workspace the user happened to be looking at, and
 * the UI still said "filed into X" — which is exactly what "auto-filing does not
 * work" looked like from the outside.
 */
const ROUTING_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_500;

export interface RoutableWorkspace {
  id: string;
  name: string;
}

export type RoutingDecision =
  | { kind: 'existing'; id: string }
  | { kind: 'new'; name: string };

/**
 * Read the router's one-line reply. Accepts the workspace id (what we ask for),
 * the workspace name (what small models answer with anyway), or `NEW: <name>`.
 */
export function parseRoutingReply(
  text: string,
  workspaces: RoutableWorkspace[],
  canCreate: boolean,
): RoutingDecision | null {
  const byId = workspaces.find((w) => text.includes(w.id));
  if (byId) return { kind: 'existing', id: byId.id };

  const newName = parseNewWorkspaceName(text);
  if (newName) {
    // "NEW: AI" when an "AI" workspace already exists is a name match, not a new
    // shelf — and a batch of files on one new subject must not spawn twins.
    const existing = findByName(workspaces, newName);
    if (existing) return { kind: 'existing', id: existing.id };
    return canCreate ? { kind: 'new', name: newName } : null;
  }

  // No id, no NEW: — a model that answered with the bare workspace name.
  const line = text.trim().split('\n').find((l) => l.trim().length > 0) ?? '';
  const byName = findByName(workspaces, line.replace(/^["'「『]+|["'」』]+$/g, '').trim());
  return byName ? { kind: 'existing', id: byName.id } : null;
}

function findByName(workspaces: RoutableWorkspace[], name: string): RoutableWorkspace | undefined {
  if (name.length < 2) return undefined;
  const needle = name.trim().toLowerCase();
  return workspaces.find((w) => w.name.trim().toLowerCase() === needle);
}

/** `NEW: <name>` — the router's way of saying nothing existing fits. */
function parseNewWorkspaceName(text: string): string | null {
  const match = /NEW\s*[:：]\s*(.+)/i.exec(text);
  if (!match) return null;
  const name = (match[1]?.split('\n')[0] ?? '')
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .trim()
    .slice(0, 50);
  return name.length >= 2 ? name : null;
}

export interface RoutingResult {
  workspaceId: string;
  /** The router created this workspace for the source. */
  created: boolean;
  /** False when this is the fallback, not a routing decision. */
  decided: boolean;
}

export async function routeToWorkspace(
  supabase: SupabaseClient,
  drive: drive_v3.Drive,
  userId: string,
  profileRow: Parameters<typeof createLLMClient>[0],
  sourceTitle: string,
  sourceContent: string,
  fallbackId: string,
  locale: string,
): Promise<RoutingResult> {
  const stay: RoutingResult = { workspaceId: fallbackId, created: false, decided: false };

  const { data: allWorkspaces } = await supabase
    .from('workspaces')
    .select('id, name')
    .eq('owner_id', userId);
  if (!allWorkspaces?.length) return stay;

  const { data: pageRows } = await supabase
    .from('pages')
    .select('workspace_id, slug, title')
    .in('workspace_id', allWorkspaces.map((w) => w.id))
    .eq('zone', 'wiki')
    .order('updated_at', { ascending: false })
    .limit(1500);

  const titlesByWorkspace = new Map<string, string[]>();
  for (const row of pageRows ?? []) {
    if (SCAFFOLDING_SLUGS.has(row.slug)) continue;
    const list = titlesByWorkspace.get(row.workspace_id) ?? [];
    if (list.length < TITLES_PER_WORKSPACE && row.title) list.push(row.title);
    titlesByWorkspace.set(row.workspace_id, list);
  }

  // An empty husk is not a shelf to file things on: it holds no subject to match
  // against, and maintenance deletes it anyway. Offering it as a target is how a
  // source ends up in a workspace called "My Wiki".
  const workspaces = allWorkspaces.filter((w) => (titlesByWorkspace.get(w.id) ?? []).length > 0);

  // Nothing in the base yet — the first import stays put rather than spawning a
  // second workspace next to the empty one.
  if (workspaces.length === 0) return stay;

  const workspaceSummary = workspaces
    .map((w) => `- id: ${w.id}\n  name: ${w.name}\n  pages: ${(titlesByWorkspace.get(w.id) ?? []).join(', ')}`)
    .join('\n');

  const canCreate = allWorkspaces.length < MAX_AUTO_WORKSPACES;
  const prompt = `Workspaces:\n${workspaceSummary}\n\nContent title: ${sourceTitle}\nContent excerpt:\n${sourceContent.slice(0, 1500)}\n\nReply with EITHER the id of the workspace this content belongs in${
    canCreate
      ? `, OR "NEW: <short workspace name>" if its subject is clearly outside every workspace above. Strongly prefer an existing workspace — related content belongs together, and a new workspace is only right when nothing above covers this subject at all. Name it in the user's language (${locale}).`
      : '. You must pick one of the ids above.'
  }`;

  const model = createLLMClient(profileRow);

  for (let attempt = 0; attempt < ROUTING_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));

    const text = await generateText({
      model,
      system:
        'You file incoming content into the knowledge workspace where it belongs. Answer with a single line and nothing else.',
      prompt,
    })
      .then((result) => result.text)
      .catch(() => null);
    if (text === null) continue; // provider hiccup — the retry is the whole point

    const decision = parseRoutingReply(text, workspaces, canCreate);
    if (!decision) continue; // unparseable reply; one more try before giving up

    if (decision.kind === 'existing') {
      return { workspaceId: decision.id, created: false, decided: true };
    }

    const created = await createWorkspaceForUser(drive, userId, decision.name, locale);
    return created.ok
      ? { workspaceId: created.id, created: true, decided: true }
      : stay;
  }

  return stay;
}
