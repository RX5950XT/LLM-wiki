import { tool } from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import { readDriveFile, writeDriveFile, ensureFolder, findFile } from '@/lib/drive/client';
import {
  createWorkspaceForUser,
  deleteWorkspaceForUser,
  renameWorkspaceForUser,
} from '@/lib/workspaces/manage';
import { normalizeWikiSlug, parseWikiLink } from '@/lib/wiki/slug';

/** Destructive action the model proposed but that awaits user confirmation. */
export interface ActionProposal {
  action: 'delete_page' | 'delete_workspace';
  params: Record<string, string>;
  label: string;
}

interface ToolContext {
  supabase: SupabaseClient;
  drive: drive_v3.Drive;
  workspaceId: string;
  /** Root wiki folder ID in Drive (current workspace) */
  wikiFolderId: string;
  /** Required for cross-workspace access & workspace management tools */
  userId?: string;
  /** Enable cross-workspace tools (query/organize; ingest stays single-workspace) */
  crossWorkspace?: boolean;
  /** When true, delete-type tools emit proposals instead of executing */
  confirmDestructive?: boolean;
  onProposal?: (proposal: ActionProposal) => void;
  /** Optional callback invoked each time LLM reads a page slug */
  onPageRead?: (slug: string) => void;
  /** UI locale for workspace creation seeds */
  locale?: string | null;
  /**
   * Whether the model may delete whole workspaces. The chat does (the user asks for
   * it and confirms a card); maintenance does NOT — left with the tool, a model
   * "merges" by sweeping a workspace's pages into an unrelated one and deleting the
   * husk, and the user loses a shelf while the UI reports "N changes". Empty
   * workspaces are removed by code instead (lib/ai/organize-mechanical.ts).
   */
  allowWorkspaceDelete?: boolean;
  /**
   * Pages an earlier pass of the same maintenance run already moved. They are
   * frozen: without this the model re-litigates every borderline page on each pass
   * and the same page ping-pongs between two workspaces run after run.
   */
  frozenMoveSlugs?: ReadonlySet<string>;
}

export interface Scope {
  workspaceId: string;
  wikiFolderId: string;
}

/** Slugs the LLM must never delete or move — the wiki would break without them. */
const PROTECTED_SLUGS = new Set(['index.md', 'log.md']);

/**
 * LLM tools may only touch the wiki zone. notes/ is user-owned (LLM read-only
 * conceptually, but these tools must not write it), _schema/ holds user rules.
 * Returns an error string, or null if the slug is acceptable.
 */
/**
 * The wiki holds knowledge, not the model's working notes. Left unconstrained,
 * gemini-3.5-flash wrote `plans/ingest-manus-ai-acquisition.md` and
 * `update-plan.json.md` (kind: "lint") into the user's base — its own todo list,
 * shelved next to the pages it was supposed to be writing.
 */
const WIKI_FOLDERS = new Set(['entities', 'concepts', 'summary', 'summaries', 'synthesis']);
const ROOT_PAGES = new Set(['index.md', 'log.md']);

/**
 * Zone guard — applies to EVERY operation, including deletes. Keep it that way: a
 * guard that also blocks deletion would make the junk it is meant to prevent
 * permanent (the first version of the folder rule below did exactly that, and the
 * five `plans/…` pages already in the base could not be removed by any tool).
 */
function guardWikiSlug(slug: string): string | null {
  const s = slug.trim();
  if (!s || s.startsWith('/') || s.includes('..') || s.includes('\\')) {
    return `Invalid slug: ${slug}`;
  }
  if (s.startsWith('notes/') || s.startsWith('_schema/') || s.startsWith('sources/')) {
    return `Slug "${slug}" is outside the wiki zone. LLM tools may only modify wiki pages.`;
  }
  return null;
}

/** Write guard: where a *new* page may land. Never used for delete or read. */
function guardKnowledgeSlug(slug: string): string | null {
  const zoneError = guardWikiSlug(slug);
  if (zoneError) return zoneError;
  const normalized = normalizeSlug(slug.trim());
  if (ROOT_PAGES.has(normalized)) return null;
  const folder = normalized.split('/')[0]!;
  if (!normalized.includes('/') || !WIKI_FOLDERS.has(folder)) {
    return (
      `Slug "${slug}" is not a knowledge page. Wiki pages live in ` +
      `entities/, concepts/, summary/ or synthesis/ (plus index.md and log.md). ` +
      `Do not write plans, todo lists or working notes into the wiki.`
    );
  }
  return null;
}

function normalizeSlug(slug: string): string {
  const s = slug.trim();
  return s.endsWith('.md') ? s : `${s}.md`;
}

/**
 * Resolve a model-supplied slug to the slug a page is ACTUALLY stored under.
 *
 * The model copies slugs out of the page inventory, and a batch of legacy rows
 * live there without the `.md` suffix. Blindly appending `.md` made those pages
 * unreachable: readPage/deletePage looked up a row that does not exist, so the
 * model would writePage a fresh `X.md`, delete that same `X.md` believing it had
 * removed the duplicate, and churn until the function's 300s budget ran out.
 * Ask the DB instead of guessing. Returns null when no page matches.
 */
async function resolveExistingSlug(
  supabase: SupabaseClient,
  workspaceId: string,
  rawSlug: string,
): Promise<string | null> {
  const raw = rawSlug.trim();
  const normalized = normalizeSlug(raw);
  const candidates = raw === normalized ? [normalized] : [normalized, raw];

  const { data } = await supabase
    .from('pages')
    .select('slug')
    .eq('workspace_id', workspaceId)
    .in('slug', candidates);
  if (!data?.length) return null;

  // Prefer the canonical `.md` row when both forms somehow exist.
  return data.find((page) => page.slug === normalized)?.slug ?? data[0]!.slug;
}

const workspaceIdParam = z
  .string()
  .uuid()
  .optional()
  .describe('Target workspace id. Omit to use the current workspace.');

export function buildWikiTools(ctx: ToolContext) {
  // Drive folder lookups repeat for every nested write in one pipeline run — memoize.
  // Keys are `${workspaceId}:${path}` so cross-workspace writes never collide.
  const folderCache = new Map<string, string>();
  const scopeCache = new Map<string, Scope>();

  const currentScope: Scope = { workspaceId: ctx.workspaceId, wikiFolderId: ctx.wikiFolderId };

  async function resolveScope(workspace_id?: string): Promise<Scope | { error: string }> {
    if (!workspace_id || workspace_id === ctx.workspaceId) return currentScope;
    if (!ctx.crossWorkspace || !ctx.userId) {
      return { error: 'Cross-workspace access is not enabled for this operation.' };
    }
    const cached = scopeCache.get(workspace_id);
    if (cached) return cached;

    const { data: ws } = await ctx.supabase
      .from('workspaces')
      .select('id, drive_folder_id')
      .eq('id', workspace_id)
      .eq('owner_id', ctx.userId)
      .single();
    if (!ws) return { error: `Workspace not found: ${workspace_id}` };

    const wikiFolderId = await findFile(
      ctx.drive,
      'wiki',
      ws.drive_folder_id,
      'application/vnd.google-apps.folder',
    );
    if (!wikiFolderId) return { error: `Wiki folder not found for workspace ${workspace_id}` };

    const scope: Scope = { workspaceId: workspace_id, wikiFolderId };
    scopeCache.set(workspace_id, scope);
    return scope;
  }

  /**
   * Returns a proposal result when confirmation mode blocks a destructive action.
   * With onProposal (interactive chat) the user gets a confirmation card; without it
   * (background jobs like organize) the action is simply refused — there is nobody
   * to confirm, so the model must report it instead of retrying.
   */
  function gateDestructive(proposal: ActionProposal): { proposed: true; message: string } | null {
    if (!ctx.confirmDestructive) return null;
    if (ctx.onProposal) {
      ctx.onProposal(proposal);
      return {
        proposed: true,
        message:
          `Awaiting user confirmation: ${proposal.label}. ` +
          'A confirmation card has been shown to the user. Do not retry; tell the user to confirm it.',
      };
    }
    return {
      proposed: true,
      message:
        `Destructive actions are disabled in this run (${proposal.label} was NOT performed). ` +
        'Do not retry; list it in your report as a suggested deletion instead.',
    };
  }

  const writePageCore = (scope: Scope, args: WritePageArgs) =>
    writePageForWorkspace({ supabase: ctx.supabase, drive: ctx.drive }, scope, args, folderCache);
  const deletePageCore = (scope: Scope, rawSlug: string) =>
    deletePageForWorkspace({ supabase: ctx.supabase, drive: ctx.drive }, scope, rawSlug);

  const baseTools = {
    readPage: tool({
      description: 'Read a wiki page by its slug (e.g. "index.md", "entities/karpathy.md")',
      inputSchema: z.object({
        slug: z.string().describe('Page slug'),
        workspace_id: workspaceIdParam,
      }),
      execute: async ({ slug, workspace_id }: { slug: string; workspace_id?: string }) => {
        const scope = await resolveScope(workspace_id);
        if ('error' in scope) return scope;
        // Only record reads from the CURRENT workspace as citations — a cross-
        // workspace read would produce a chip that dead-links in this workspace.
        if (scope.workspaceId === ctx.workspaceId) ctx.onPageRead?.(slug);
        const storedSlug = await resolveExistingSlug(ctx.supabase, scope.workspaceId, slug);
        if (!storedSlug) return { error: `Page not found: ${slug}` };
        const { data: page } = await ctx.supabase
          .from('pages')
          .select('drive_file_id, title')
          .eq('workspace_id', scope.workspaceId)
          .eq('slug', storedSlug)
          .single();
        if (!page) return { error: `Page not found: ${slug}` };
        const content = await readDriveFile(ctx.drive, page.drive_file_id);
        return { slug: storedSlug, title: page.title, content };
      },
    }),

    writePage: tool({
      description: 'Create or overwrite a wiki page. Only call for wiki zone pages.',
      inputSchema: z.object({
        slug: z.string().describe('Page slug, e.g. "entities/karpathy.md"'),
        content_md: z.string().describe('Full markdown content including frontmatter'),
        kind: z
          .enum(['entity', 'concept', 'summary', 'synthesis', 'index', 'log', 'lint'])
          .describe('Page kind'),
        title: z.string().optional(),
        workspace_id: workspaceIdParam,
      }),
      execute: async ({
        slug,
        content_md,
        kind,
        title,
        workspace_id,
      }: {
        slug: string;
        content_md: string;
        kind: 'entity' | 'concept' | 'summary' | 'synthesis' | 'index' | 'log' | 'lint';
        title?: string;
        workspace_id?: string;
      }) => {
        const scope = await resolveScope(workspace_id);
        if ('error' in scope) return scope;
        return writePageCore(scope, { slug, content_md, kind, title });
      },
    }),

    searchPages: tool({
      description: 'Full-text search across wiki page titles and slugs',
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().min(1).max(20).default(10),
        workspace_id: workspaceIdParam,
      }),
      execute: async ({ query, limit, workspace_id }: { query: string; limit: number; workspace_id?: string }) => {
        const scope = await resolveScope(workspace_id);
        if ('error' in scope) return scope;
        const { data: pages, error } = await ctx.supabase.rpc('search_pages', {
          p_workspace_id: scope.workspaceId,
          p_query: query,
        });

        if (!error) return { pages: (pages ?? []).slice(0, limit) };

        // Strip characters with meaning in PostgREST or-filter / like patterns
        const safeQuery = query.replace(/[,()|%\\]/g, ' ').trim();
        if (!safeQuery) return { pages: [] };
        const { data: fallbackPages } = await ctx.supabase
          .from('pages')
          .select('slug, title, kind, updated_at')
          .eq('workspace_id', scope.workspaceId)
          .eq('zone', 'wiki')
          .or(`slug.ilike.%${safeQuery}%,title.ilike.%${safeQuery}%`)
          .order('updated_at', { ascending: false })
          .limit(limit);
        return { pages: fallbackPages ?? [] };
      },
    }),

    listPages: tool({
      description: 'List all wiki pages, optionally filtered by kind',
      inputSchema: z.object({
        kind: z.string().optional().describe('Filter by kind: entity, concept, synthesis, etc.'),
        workspace_id: workspaceIdParam,
      }),
      execute: async ({ kind, workspace_id }: { kind?: string; workspace_id?: string }) => {
        const scope = await resolveScope(workspace_id);
        if ('error' in scope) return scope;
        let q = ctx.supabase
          .from('pages')
          .select('slug, title, kind, updated_at')
          .eq('workspace_id', scope.workspaceId)
          .eq('zone', 'wiki')
          .order('updated_at', { ascending: false });
        if (kind) q = q.eq('kind', kind);
        const { data: pages } = await q.limit(100);
        return { pages: pages ?? [] };
      },
    }),

    deletePage: tool({
      description: 'Delete a wiki page by its slug. Use with caution.',
      inputSchema: z.object({
        slug: z.string().describe('Page slug to delete'),
        workspace_id: workspaceIdParam,
      }),
      execute: async ({ slug: rawSlug, workspace_id }: { slug: string; workspace_id?: string }) => {
        const scope = await resolveScope(workspace_id);
        if ('error' in scope) return scope;
        const guardError = guardWikiSlug(rawSlug);
        if (guardError) return { error: guardError };
        const slug = normalizeSlug(rawSlug);
        if (PROTECTED_SLUGS.has(slug)) {
          return { error: `Page "${slug}" is a core wiki page and cannot be deleted.` };
        }
        // Surface not-found / locked BEFORE proposing — otherwise the confirm
        // card would only fail on click. Mirrors deletePageForWorkspace's guards.
        const storedSlug = await resolveExistingSlug(ctx.supabase, scope.workspaceId, rawSlug);
        if (!storedSlug) return { error: `Page not found: ${slug}` };
        const { data: existing } = await ctx.supabase
          .from('pages')
          .select('id, locked_by_human')
          .eq('workspace_id', scope.workspaceId)
          .eq('slug', storedSlug)
          .maybeSingle();
        if (!existing) return { error: `Page not found: ${slug}` };
        if (existing.locked_by_human) {
          return { error: `Page "${slug}" is locked by the user and cannot be deleted.` };
        }
        const gated = gateDestructive({
          action: 'delete_page',
          params: { workspace_id: scope.workspaceId, slug: storedSlug },
          label: `Delete page ${storedSlug}`,
        });
        if (gated) return gated;
        return deletePageCore(scope, storedSlug);
      },
    }),

    movePage: tool({
      description: 'Rename/move a wiki page to a new slug. Updates all incoming wikilinks.',
      inputSchema: z.object({
        oldSlug: z.string().describe('Current slug'),
        newSlug: z.string().describe('Target slug'),
        workspace_id: workspaceIdParam,
      }),
      execute: async ({
        oldSlug: rawOldSlug,
        newSlug: rawNewSlug,
        workspace_id,
      }: {
        oldSlug: string;
        newSlug: string;
        workspace_id?: string;
      }) => {
        const scope = await resolveScope(workspace_id);
        if ('error' in scope) return scope;
        const guardError = guardWikiSlug(rawOldSlug) ?? guardKnowledgeSlug(rawNewSlug);
        if (guardError) return { error: guardError };
        const newSlug = normalizeSlug(rawNewSlug);
        if (PROTECTED_SLUGS.has(normalizeSlug(rawOldSlug))) {
          return { error: `Page "${rawOldSlug}" is a core wiki page and cannot be moved.` };
        }
        // The stored slug may lack the .md suffix (legacy rows) — move THAT row.
        const oldSlug = await resolveExistingSlug(ctx.supabase, scope.workspaceId, rawOldSlug);
        if (!oldSlug) return { error: `Page not found: ${rawOldSlug}` };

        const { data: page } = await ctx.supabase
          .from('pages')
          .select('id, drive_file_id, content_hash, title, kind, version, updated_by, locked_by_human')
          .eq('workspace_id', scope.workspaceId)
          .eq('slug', oldSlug)
          .single();
        if (!page) return { error: `Page not found: ${oldSlug}` };
        if (page.locked_by_human) {
          return { error: `Page "${oldSlug}" is locked by the user and cannot be moved.` };
        }

        const { data: target } = await ctx.supabase
          .from('pages')
          .select('id')
          .eq('workspace_id', scope.workspaceId)
          .eq('slug', newSlug)
          .maybeSingle();
        if (target) return { error: `Target page already exists: ${newSlug}` };

        // Read content, rewrite wikilinks in other pages pointing to oldSlug
        const { data: incomingLinks } = await ctx.supabase
          .from('page_links')
          .select('from_slug')
          .eq('workspace_id', scope.workspaceId)
          .eq('to_slug', oldSlug);

        for (const link of incomingLinks ?? []) {
          const { data: fromPage } = await ctx.supabase
            .from('pages')
            .select('id, drive_file_id, version')
            .eq('workspace_id', scope.workspaceId)
            .eq('slug', link.from_slug)
            .single();
          if (fromPage) {
            const content = await readDriveFile(ctx.drive, fromPage.drive_file_id);
            // Wikilinks are usually written WITHOUT .md ([[entities/foo]]) but
            // page_links stores them normalized with .md — match both forms,
            // preserving any |display or #anchor suffix.
            const oldBase = oldSlug.replace(/\.md$/, '');
            const newBase = newSlug.replace(/\.md$/, '');
            const linkPattern = new RegExp(
              `\\[\\[${escapeRegExp(oldBase)}(?:\\.md)?([|#][^\\]]*)?\\]\\]`,
              'g',
            );
            const updated = content.replace(linkPattern, (_m, rest: string | undefined) =>
              `[[${newBase}${rest ?? ''}]]`,
            );
            if (updated !== content) {
              await writeDriveFile(ctx.drive, updated, {
                fileId: fromPage.drive_file_id,
                name: link.from_slug.split('/').at(-1) ?? link.from_slug,
                parentId: await resolveParentFolder(ctx, scope, link.from_slug, folderCache),
              });
              await updatePageRecord(ctx, fromPage.id, {
                content_hash: await hashContent(updated),
                search_text: updated.slice(0, 2000),
                version: fromPage.version + 1,
                updated_by: 'llm',
              });
            }
          }
        }

        const fileName = newSlug.split('/').at(-1) ?? newSlug;
        const newParentId = await resolveParentFolder(ctx, scope, newSlug, folderCache);
        const file = await ctx.drive.files.get({ fileId: page.drive_file_id, fields: 'parents' });
        const currentParents = file.data.parents ?? [];
        await ctx.drive.files.update({
          fileId: page.drive_file_id,
          requestBody: { name: fileName },
          addParents: newParentId,
          removeParents: currentParents.filter((parent) => parent !== newParentId).join(',') || undefined,
          fields: 'id',
        });

        await updatePageRecord(ctx, page.id, {
          slug: newSlug,
          version: page.version + 1,
          updated_by: 'llm',
        });

        // Update page_links
        const { error: outgoingLinksError } = await ctx.supabase
          .from('page_links')
          .update({ from_slug: newSlug })
          .eq('workspace_id', scope.workspaceId)
          .eq('from_slug', oldSlug);
        if (outgoingLinksError) throw new Error(`page_links update failed: ${outgoingLinksError.message}`);

        const { error: incomingLinksError } = await ctx.supabase
          .from('page_links')
          .update({ to_slug: newSlug })
          .eq('workspace_id', scope.workspaceId)
          .eq('to_slug', oldSlug);
        if (incomingLinksError) throw new Error(`page_links update failed: ${incomingLinksError.message}`);

        return { ok: true, oldSlug, newSlug };
      },
    }),
  };

  if (!ctx.crossWorkspace || !ctx.userId) return baseTools;
  const userId = ctx.userId;

  const adminTools = {
    listWorkspaces: tool({
      description: 'List all workspaces the user owns (id + name). Use the ids with other tools.',
      inputSchema: z.object({}),
      execute: async () => {
        const { data: workspaces } = await ctx.supabase
          .from('workspaces')
          .select('id, name, created_at')
          .eq('owner_id', userId)
          .order('created_at', { ascending: true });
        return {
          workspaces: (workspaces ?? []).map((w) => ({
            id: w.id,
            name: w.name,
            current: w.id === ctx.workspaceId,
          })),
        };
      },
    }),

    reorderWorkspaces: tool({
      description:
        'Set the display order of the user\'s workspaces. Pass ALL workspace ids in the desired order (call listWorkspaces first).',
      inputSchema: z.object({
        workspace_ids: z.array(z.string().uuid()).min(1).describe('Workspace ids, first = top'),
      }),
      execute: async ({ workspace_ids }: { workspace_ids: string[] }) => {
        const { data: owned } = await ctx.supabase
          .from('workspaces')
          .select('id')
          .eq('owner_id', userId);
        const ownedIds = (owned ?? []).map((w) => w.id);
        const requested = [...new Set(workspace_ids)].filter((id) => ownedIds.includes(id));
        if (requested.length === 0) return { error: 'None of the given workspace ids are yours.' };
        // Workspaces the model left out keep their relative position at the end,
        // so a partial order never drops a workspace out of the list.
        const finalOrder = [...requested, ...ownedIds.filter((id) => !requested.includes(id))];
        for (const [index, id] of finalOrder.entries()) {
          const { error } = await ctx.supabase
            .from('workspaces')
            .update({ sort_order: index })
            .eq('id', id)
            .eq('owner_id', userId);
          if (error) return { error: `Reorder failed: ${error.message}` };
        }
        return { ok: true, order: finalOrder };
      },
    }),

    createWorkspace: tool({
      description: 'Create a new workspace (Drive folders + system pages included).',
      inputSchema: z.object({ name: z.string().min(1).max(100) }),
      execute: async ({ name }: { name: string }) => {
        const result = await createWorkspaceForUser(ctx.drive, userId, name, ctx.locale);
        if (!result.ok) return { error: result.error };
        return { ok: true, workspace_id: result.id, name };
      },
    }),

    renameWorkspace: tool({
      description: 'Rename a workspace.',
      inputSchema: z.object({
        workspace_id: z.string().uuid(),
        name: z.string().min(1).max(100),
      }),
      execute: async ({ workspace_id, name }: { workspace_id: string; name: string }) => {
        const result = await renameWorkspaceForUser(userId, workspace_id, name);
        if (!result.ok) return { error: result.error };
        return { ok: true, workspace_id, name: result.name };
      },
    }),

    movePageToWorkspace: tool({
      description:
        'Move a wiki page from one workspace to another. Content is copied to the target and the source page is deleted. Wikilinks in the source workspace that pointed to it become dangling — fix them with writePage if needed.',
      inputSchema: z.object({
        slug: z.string().describe('Page slug in the source workspace'),
        to_workspace_id: z.string().uuid(),
        from_workspace_id: z
          .string()
          .uuid()
          .optional()
          .describe('Source workspace id. Omit for the current workspace.'),
        new_slug: z.string().optional().describe('Optional new slug in the target workspace'),
      }),
      execute: async ({
        slug: rawSlug,
        to_workspace_id,
        from_workspace_id,
        new_slug,
      }: {
        slug: string;
        to_workspace_id: string;
        from_workspace_id?: string;
        new_slug?: string;
      }) => {
        // Each maintenance pass re-derives the taxonomy from scratch, so a page whose
        // home is genuinely arguable (a datacenter concept: tech industry?
        // semiconductors? AI?) gets moved out by one pass and straight back by the
        // next — churn that also keeps `more_work` true, so the button spends its
        // passes undoing itself. One move per page per run; the earlier pass decided.
        if (
          ctx.frozenMoveSlugs?.has(normalizeSlug(rawSlug)) ||
          ctx.frozenMoveSlugs?.has(rawSlug.trim())
        ) {
          return {
            error: `"${rawSlug}" was already re-shelved earlier in this maintenance run. Leave it where it is and move on.`,
          };
        }

        const fromScope = await resolveScope(from_workspace_id);
        if ('error' in fromScope) return fromScope;
        const toScope = await resolveScope(to_workspace_id);
        if ('error' in toScope) return toScope;
        if (fromScope.workspaceId === toScope.workspaceId) {
          return { error: 'Source and target workspaces are the same. Use movePage instead.' };
        }

        const guardError = guardWikiSlug(rawSlug) ?? (new_slug ? guardKnowledgeSlug(new_slug) : null);
        if (guardError) return { error: guardError };
        const targetSlug = normalizeSlug(new_slug ?? rawSlug);
        if (PROTECTED_SLUGS.has(normalizeSlug(rawSlug)) || PROTECTED_SLUGS.has(targetSlug)) {
          return { error: 'Core wiki pages (index.md, log.md) cannot be moved across workspaces.' };
        }
        const slug = await resolveExistingSlug(ctx.supabase, fromScope.workspaceId, rawSlug);
        if (!slug) return { error: `Page not found: ${rawSlug}` };

        const { data: page } = await ctx.supabase
          .from('pages')
          .select('drive_file_id, title, kind, locked_by_human')
          .eq('workspace_id', fromScope.workspaceId)
          .eq('slug', slug)
          .single();
        if (!page) return { error: `Page not found: ${slug}` };
        if (page.locked_by_human) {
          return { error: `Page "${slug}" is locked by the user and cannot be moved.` };
        }

        const { data: existingTarget } = await ctx.supabase
          .from('pages')
          .select('id')
          .eq('workspace_id', toScope.workspaceId)
          .eq('slug', targetSlug)
          .maybeSingle();
        if (existingTarget) {
          return { error: `Target page already exists in destination workspace: ${targetSlug}` };
        }

        const content = await readDriveFile(ctx.drive, page.drive_file_id);

        const written = await writePageCore(toScope, {
          slug: targetSlug,
          content_md: content,
          kind: page.kind ?? 'concept',
          title: page.title ?? undefined,
        });
        if ('error' in written) return written;

        // Collect source-side referrers before deleting (their wikilinks go dangling)
        const { data: referrers } = await ctx.supabase
          .from('page_links')
          .select('from_slug')
          .eq('workspace_id', fromScope.workspaceId)
          .eq('to_slug', slug);

        const deleted = await deletePageCore(fromScope, slug);
        if ('error' in deleted) {
          // Roll back the target write so the move is all-or-nothing; a retry
          // then won't hit "target already exists" with the source still present.
          await deletePageCore(toScope, targetSlug).catch(() => {});
          return {
            error: `Move aborted: source deletion failed (${deleted.error}). The page was left unchanged in the source workspace.`,
          };
        }

        return {
          ok: true,
          slug: targetSlug,
          from_workspace_id: fromScope.workspaceId,
          to_workspace_id: toScope.workspaceId,
          dangling_refs: (referrers ?? []).map((r) => r.from_slug),
        };
      },
    }),
  };

  // Withheld from the maintenance job: see ToolContext.allowWorkspaceDelete.
  if (ctx.allowWorkspaceDelete === false) return { ...baseTools, ...adminTools };

  const deleteWorkspaceTool = {
    deleteWorkspace: tool({
      description:
        'Delete an entire workspace (Drive folder is trashed, all pages removed). Destructive.',
      inputSchema: z.object({ workspace_id: z.string().uuid() }),
      execute: async ({ workspace_id }: { workspace_id: string }) => {
        const { data: ws } = await ctx.supabase
          .from('workspaces')
          .select('id, name')
          .eq('id', workspace_id)
          .eq('owner_id', userId)
          .maybeSingle();
        if (!ws) return { error: `Workspace not found: ${workspace_id}` };

        const gated = gateDestructive({
          action: 'delete_workspace',
          // `name` is display-only; /api/agent/execute strips unknown fields
          params: { workspace_id, name: ws.name },
          label: `Delete workspace "${ws.name}"`,
        });
        if (gated) return gated;

        const result = await deleteWorkspaceForUser(ctx.drive, userId, workspace_id);
        if (!result.ok) return { error: result.error };
        return { ok: true, workspace_id, name: ws.name };
      },
    }),
  };

  return { ...baseTools, ...adminTools, ...deleteWorkspaceTool };
}

/** Minimal deps for page write/delete cores — shared by tools and /api/agent/execute. */
export interface PageOpDeps {
  supabase: SupabaseClient;
  drive: drive_v3.Drive;
}

export interface WritePageArgs {
  slug: string;
  content_md: string;
  kind: string;
  title?: string;
}

export async function writePageForWorkspace(
  deps: PageOpDeps,
  scope: Scope,
  { slug: rawSlug, content_md, kind, title }: WritePageArgs,
  folderCache?: Map<string, string>,
) {
  const guardError = guardKnowledgeSlug(rawSlug);
  if (guardError) return { error: guardError };
  const slug = normalizeSlug(rawSlug);

  // The page may be stored under a legacy suffix-less slug. Overwrite THAT row
  // (and migrate it to `.md` below) rather than creating a twin next to it.
  const storedSlug = await resolveExistingSlug(deps.supabase, scope.workspaceId, rawSlug);
  const { data: existing } = storedSlug
    ? await deps.supabase
        .from('pages')
        .select('id, drive_file_id, version, title, locked_by_human')
        .eq('workspace_id', scope.workspaceId)
        .eq('slug', storedSlug)
        .maybeSingle()
    : { data: null };

  if (existing?.locked_by_human) {
    return {
      error: `Page "${slug}" is locked by the user and must not be modified. Note the needed change in log.md instead.`,
    };
  }

  const fileName = slug.split('/').at(-1) ?? slug;
  const parentFolderId = await resolveParentFolder(deps, scope, slug, folderCache);

  const fileId = await writeDriveFile(deps.drive, content_md, {
    fileId: existing?.drive_file_id,
    name: fileName,
    parentId: parentFolderId,
  });

  const contentHash = await hashContent(content_md);

  const searchText = content_md.slice(0, 2000);

  if (existing) {
    await updatePageRecord(deps, existing.id, {
      // `slug` (not storedSlug): a legacy row converges to the canonical .md form.
      slug,
      drive_file_id: fileId,
      content_hash: contentHash,
      version: existing.version + 1,
      updated_by: 'llm',
      title: title ?? existing.title,
      search_text: searchText,
    });
  } else {
    await insertPageRecord(deps, {
      workspace_id: scope.workspaceId,
      slug,
      kind,
      zone: 'wiki',
      drive_file_id: fileId,
      content_hash: contentHash,
      title: title ?? null,
      updated_by: 'llm',
      search_text: searchText,
    });
  }

  // Sync page_links: delete old outgoing links, insert new ones. A migrated
  // legacy row still has links filed under its old suffix-less slug.
  const toSlugs = extractWikiLinks(content_md);
  const { error: delError } = await deps.supabase
    .from('page_links')
    .delete()
    .eq('workspace_id', scope.workspaceId)
    .in('from_slug', storedSlug && storedSlug !== slug ? [slug, storedSlug] : [slug]);
  if (delError) throw new Error(`page_links delete failed: ${delError.message}`);
  if (toSlugs.length > 0) {
    const { error: insError } = await deps.supabase.from('page_links').insert(
      toSlugs.map((to_slug) => ({ workspace_id: scope.workspaceId, from_slug: slug, to_slug })),
    );
    if (insError) throw new Error(`page_links insert failed: ${insError.message}`);
  }

  return { ok: true as const, slug, fileId };
}

export async function deletePageForWorkspace(deps: PageOpDeps, scope: Scope, rawSlug: string) {
  const guardError = guardWikiSlug(rawSlug);
  if (guardError) return { error: guardError };
  if (PROTECTED_SLUGS.has(normalizeSlug(rawSlug))) {
    return { error: `Page "${rawSlug}" is a core wiki page and cannot be deleted.` };
  }
  // Delete the row that actually exists — legacy rows have no .md suffix, and
  // forcing one made the model delete the page it had just written instead.
  const slug = await resolveExistingSlug(deps.supabase, scope.workspaceId, rawSlug);
  if (!slug) return { error: `Page not found: ${rawSlug}` };
  const linkSlugs = [...new Set([slug, normalizeSlug(slug)])];

  const { data: page } = await deps.supabase
    .from('pages')
    .select('id, drive_file_id, locked_by_human')
    .eq('workspace_id', scope.workspaceId)
    .eq('slug', slug)
    .single();
  if (!page) return { error: `Page not found: ${slug}` };
  if (page.locked_by_human) {
    return { error: `Page "${slug}" is locked by the user and cannot be deleted.` };
  }

  const { error: outgoingLinksError } = await deps.supabase
    .from('page_links')
    .delete()
    .eq('workspace_id', scope.workspaceId)
    .in('from_slug', linkSlugs);
  if (outgoingLinksError) throw new Error(`page_links delete failed: ${outgoingLinksError.message}`);

  const { error: incomingLinksError } = await deps.supabase
    .from('page_links')
    .delete()
    .eq('workspace_id', scope.workspaceId)
    .in('to_slug', linkSlugs);
  if (incomingLinksError) throw new Error(`page_links delete failed: ${incomingLinksError.message}`);

  let driveWarning: string | undefined;
  try {
    await deps.drive.files.delete({ fileId: page.drive_file_id });
  } catch (error) {
    driveWarning = error instanceof Error ? error.message : 'unknown Drive delete error';
  }

  const { error: pageDeleteError } = await deps.supabase.from('pages').delete().eq('id', page.id);
  if (pageDeleteError) throw new Error(`page delete failed: ${pageDeleteError.message}`);

  return { ok: true as const, slug, warning: driveWarning };
}

async function resolveParentFolder(
  deps: PageOpDeps,
  scope: Scope,
  slug: string,
  cache?: Map<string, string>,
): Promise<string> {
  const parts = slug.split('/');
  if (parts.length === 1) return scope.wikiFolderId;

  let parentId = scope.wikiFolderId;
  let path = '';
  for (const part of parts.slice(0, -1)) {
    path = path ? `${path}/${part}` : part;
    const cacheKey = `${scope.workspaceId}:${path}`;
    const cached = cache?.get(cacheKey);
    if (cached) {
      parentId = cached;
      continue;
    }
    parentId = await ensureFolder(deps.drive, part, parentId);
    cache?.set(cacheKey, parentId);
  }
  return parentId;
}

async function hashContent(content: string): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Parse [[wikilink]] / [[wikilink|display]] / [[wikilink#anchor]] from markdown.
 * Strip display name and anchor before storing in page_links — otherwise
 * `concepts/foo#bar` becomes a permanently dead edge (no such page).
 */
function extractWikiLinks(content: string): string[] {
  const links = new Set<string>();
  for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const { slug } = parseWikiLink(match[1] ?? '');
    if (!slug) continue;
    links.add(normalizeWikiSlug(slug));
  }
  return Array.from(links);
}

async function insertPageRecord(
  deps: PageOpDeps,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await deps.supabase.from('pages').insert(values);
  if (!error) return;

  if (isMissingSearchTextError(error)) {
    const { search_text: _searchText, ...fallbackValues } = values;
    const { error: fallbackError } = await deps.supabase.from('pages').insert(fallbackValues);
    if (!fallbackError) return;
    throw new Error(`pages insert failed: ${fallbackError.message}`);
  }

  throw new Error(`pages insert failed: ${error.message}`);
}

async function updatePageRecord(
  deps: PageOpDeps,
  pageId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await deps.supabase.from('pages').update(values).eq('id', pageId);
  if (!error) return;

  if (isMissingSearchTextError(error)) {
    const { search_text: _searchText, ...fallbackValues } = values;
    const { error: fallbackError } = await deps.supabase
      .from('pages')
      .update(fallbackValues)
      .eq('id', pageId);
    if (!fallbackError) return;
    throw new Error(`pages update failed: ${fallbackError.message}`);
  }

  throw new Error(`pages update failed: ${error.message}`);
}

function isMissingSearchTextError(error: { message?: string }): boolean {
  const message = error.message?.toLowerCase() ?? '';
  return message.includes('search_text') && (
    message.includes('column') || message.includes('schema cache')
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
