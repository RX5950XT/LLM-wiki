import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { readDriveFile } from '@/lib/drive/client';
import { createDriveClientForUser, isGoogleDriveAuthError } from '@/lib/google/drive-auth';
import { pickAliasMatch } from '@/lib/wiki/resolve';
import { normalizeWikiSlug, parseWikiLink } from '@/lib/wiki/slug';

/**
 * Read-only wiki tools served to outside agents over MCP. Every query runs with the
 * service role, so the owner check on the workspace is the ONLY authorization wall:
 * each tool goes through `ownedWorkspace` / `ownedWorkspaces` first. Nothing here
 * writes — other agents read the wiki, the wiki's own LLM keeps maintaining it.
 */

export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

interface McpToolContext {
  admin: SupabaseClient;
  userId: string;
}

const uuid = z.string().uuid();
const PAGE_LIST_LIMIT = 500;

const text = (value: unknown): McpToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message: string): McpToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

async function ownedWorkspaces(ctx: McpToolContext): Promise<{ id: string; name: string }[]> {
  const { data, error } = await ctx.admin
    .from('workspaces')
    .select('id, name, sort_order, created_at')
    .eq('owner_id', ctx.userId)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (error) throw new Error(`workspaces lookup failed: ${error.message}`);
  return (data ?? []).map((w) => ({ id: w.id as string, name: w.name as string }));
}

async function ownedWorkspace(ctx: McpToolContext, workspaceId: string): Promise<{ id: string; name: string } | null> {
  const { data } = await ctx.admin
    .from('workspaces')
    .select('id, name')
    .eq('id', workspaceId)
    .eq('owner_id', ctx.userId)
    .maybeSingle();
  return data ? { id: data.id as string, name: data.name as string } : null;
}

const NO_WORKSPACE = 'Workspace not found. Call list_workspaces for valid ids.';

async function listWorkspaces(ctx: McpToolContext): Promise<McpToolResult> {
  const workspaces = await ownedWorkspaces(ctx);
  if (!workspaces.length) return text({ workspaces: [] });
  const { data } = await ctx.admin
    .from('pages')
    .select('workspace_id')
    .in('workspace_id', workspaces.map((w) => w.id))
    .eq('zone', 'wiki');
  const counts = new Map<string, number>();
  for (const row of data ?? []) counts.set(row.workspace_id as string, (counts.get(row.workspace_id as string) ?? 0) + 1);
  return text({ workspaces: workspaces.map((w) => ({ ...w, pages: counts.get(w.id) ?? 0 })) });
}

const ListPagesArgs = z.object({ workspace_id: uuid, kind: z.string().max(40).optional() });

async function listPages(ctx: McpToolContext, args: unknown): Promise<McpToolResult> {
  const parsed = ListPagesArgs.safeParse(args);
  if (!parsed.success) return fail('workspace_id (uuid) is required.');
  const ws = await ownedWorkspace(ctx, parsed.data.workspace_id);
  if (!ws) return fail(NO_WORKSPACE);
  let query = ctx.admin
    .from('pages')
    .select('slug, title, kind, updated_at')
    .eq('workspace_id', ws.id)
    .eq('zone', 'wiki')
    .order('slug', { ascending: true });
  if (parsed.data.kind) query = query.eq('kind', parsed.data.kind);
  const { data, error } = await query.limit(PAGE_LIST_LIMIT);
  if (error) return fail(`Listing pages failed: ${error.message}`);
  return text({ workspace: ws, pages: data ?? [] });
}

const SearchArgs = z.object({
  query: z.string().trim().min(1).max(200),
  workspace_id: uuid.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

type SearchHit = { workspace_id: string; slug: string; title: string | null; kind: string | null; updated_at: string | null };

async function searchWorkspace(ctx: McpToolContext, workspaceId: string, query: string, limit: number): Promise<SearchHit[]> {
  const { data, error } = await ctx.admin.rpc('search_pages', { p_workspace_id: workspaceId, p_query: query });
  if (!error && data?.length) {
    return (data as Omit<SearchHit, 'workspace_id'>[]).slice(0, limit).map((p) => ({ ...p, workspace_id: workspaceId }));
  }
  // Full-text found nothing (or the RPC is missing): substring match, PostgREST-special chars stripped.
  const safe = query.replace(/[,()|%\\*]/g, ' ').trim();
  if (!safe) return [];
  const { data: rows } = await ctx.admin
    .from('pages')
    .select('slug, title, kind, updated_at')
    .eq('workspace_id', workspaceId)
    .eq('zone', 'wiki')
    .or(`slug.ilike.%${safe}%,title.ilike.%${safe}%,search_text.ilike.%${safe}%`)
    .order('updated_at', { ascending: false })
    .limit(limit);
  return ((rows ?? []) as Omit<SearchHit, 'workspace_id'>[]).map((p) => ({ ...p, workspace_id: workspaceId }));
}

async function searchPages(ctx: McpToolContext, args: unknown): Promise<McpToolResult> {
  const parsed = SearchArgs.safeParse(args);
  if (!parsed.success) return fail('query (1–200 characters) is required; workspace_id must be a uuid when given.');
  const { query, workspace_id } = parsed.data;
  const limit = parsed.data.limit ?? 20;
  let workspaces: { id: string; name: string }[];
  if (workspace_id) {
    const ws = await ownedWorkspace(ctx, workspace_id);
    if (!ws) return fail(NO_WORKSPACE);
    workspaces = [ws];
  } else {
    workspaces = await ownedWorkspaces(ctx);
  }
  const names = new Map(workspaces.map((w) => [w.id, w.name]));
  const hits = (await Promise.all(workspaces.map((w) => searchWorkspace(ctx, w.id, query, limit)))).flat();
  return text({
    results: hits.slice(0, limit).map((h) => ({ ...h, workspace_name: names.get(h.workspace_id) })),
  });
}

const ReadArgs = z.object({ workspace_id: uuid, slug: z.string().trim().min(1).max(500) });

async function readPage(ctx: McpToolContext, args: unknown): Promise<McpToolResult> {
  const parsed = ReadArgs.safeParse(args);
  if (!parsed.success) return fail('workspace_id (uuid) and slug are required.');
  const ws = await ownedWorkspace(ctx, parsed.data.workspace_id);
  if (!ws) return fail(NO_WORKSPACE);

  // Accept what a reader would paste: `[[slug|label]]`, no `.md`, a title.
  const target = parseWikiLink(parsed.data.slug.replace(/^\[\[|\]\]$/g, '')).slug;
  const { data: candidates, error } = await ctx.admin
    .from('pages')
    .select('slug, title, kind, drive_file_id, updated_at')
    .eq('workspace_id', ws.id)
    .eq('zone', 'wiki');
  if (error) return fail(`Page lookup failed: ${error.message}`);
  const rows = (candidates ?? []) as { slug: string; title: string | null; kind: string; drive_file_id: string; updated_at: string }[];
  const normalized = normalizeWikiSlug(target);
  const page = rows.find((r) => r.slug === normalized) ?? rows.find((r) => r.slug === target) ?? pickAliasMatch(rows, target);
  if (!page) return fail(`Page not found: ${target}. Use list_pages or search_pages to find the slug.`);

  try {
    const drive = await createDriveClientForUser(ctx.userId);
    const content = await readDriveFile(drive, page.drive_file_id);
    return text(`<!-- workspace: ${ws.name} (${ws.id}) · slug: ${page.slug} · updated: ${page.updated_at} -->\n${content}`);
  } catch (err) {
    if (isGoogleDriveAuthError(err)) {
      return fail('Google Drive access has expired. Open LLM Wiki and reconnect Google Drive, then retry.');
    }
    console.error('[mcp] read_page failed', { slug: page.slug, message: err instanceof Error ? err.message : err });
    return fail('Reading the page from Google Drive failed. Retry later.');
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const MCP_TOOLS = [
  {
    name: 'list_workspaces',
    title: 'List workspaces',
    description: 'List the knowledge-base workspaces (id, name, number of wiki pages). Start here: other tools take a workspace_id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: 'list_pages',
    title: 'List pages',
    description: 'List the wiki pages of one workspace (slug, title, kind, updated_at). index.md is the table of contents, log.md the change log.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace id from list_workspaces' },
        kind: { type: 'string', description: 'Optional filter: entity, concept, summary, synthesis, index, log' },
      },
      required: ['workspace_id'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'search_pages',
    title: 'Search pages',
    description: 'Full-text search over wiki pages. Searches every workspace unless workspace_id is given. Returns slugs to pass to read_page.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search words' },
        workspace_id: { type: 'string', description: 'Optional: limit to one workspace' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 20)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'read_page',
    title: 'Read page',
    description:
      'Read one wiki page as markdown (YAML frontmatter included). [[wikilinks]] inside it name other pages of the same workspace and can be passed back as slug.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace id from list_workspaces' },
        slug: { type: 'string', description: 'Page slug such as "index.md" or "concepts/rag.md"; a [[wikilink]] target or page title also works' },
      },
      required: ['workspace_id', 'slug'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
] as const;

export async function callMcpTool(ctx: McpToolContext, name: string, args: unknown): Promise<McpToolResult | null> {
  switch (name) {
    case 'list_workspaces':
      return listWorkspaces(ctx);
    case 'list_pages':
      return listPages(ctx, args);
    case 'search_pages':
      return searchPages(ctx, args);
    case 'read_page':
      return readPage(ctx, args);
    default:
      return null;
  }
}
