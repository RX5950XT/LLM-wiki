import { tool } from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import { readDriveFile, writeDriveFile, ensureFolder } from '@/lib/drive/client';

interface ToolContext {
  supabase: SupabaseClient;
  drive: drive_v3.Drive;
  workspaceId: string;
  /** Root wiki folder ID in Drive */
  wikiFolderId: string;
  /** Optional callback invoked each time LLM reads a page slug */
  onPageRead?: (slug: string) => void;
}

export function buildWikiTools(ctx: ToolContext) {
  return {
    readPage: tool({
      description: 'Read a wiki page by its slug (e.g. "index.md", "entities/karpathy.md")',
      inputSchema: z.object({ slug: z.string().describe('Page slug') }),
      execute: async ({ slug }: { slug: string }) => {
        ctx.onPageRead?.(slug);
        const { data: page } = await ctx.supabase
          .from('pages')
          .select('drive_file_id, title')
          .eq('workspace_id', ctx.workspaceId)
          .eq('slug', slug)
          .single();
        if (!page) return { error: `Page not found: ${slug}` };
        const content = await readDriveFile(ctx.drive, page.drive_file_id);
        return { slug, title: page.title, content };
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
      }),
      execute: async ({
        slug,
        content_md,
        kind,
        title,
      }: {
        slug: string;
        content_md: string;
        kind: 'entity' | 'concept' | 'summary' | 'synthesis' | 'index' | 'log' | 'lint';
        title?: string;
      }) => {
        const { data: existing } = await ctx.supabase
          .from('pages')
          .select('id, drive_file_id, version, title')
          .eq('workspace_id', ctx.workspaceId)
          .eq('slug', slug)
          .maybeSingle();

        const fileName = slug.split('/').at(-1) ?? slug;
        const parentFolderId = await resolveParentFolder(ctx, slug);

        const fileId = await writeDriveFile(ctx.drive, content_md, {
          fileId: existing?.drive_file_id,
          name: fileName,
          parentId: parentFolderId,
        });

        const contentHash = await hashContent(content_md);

        const searchText = content_md.slice(0, 2000);

        if (existing) {
          await updatePageRecord(ctx, existing.id, {
            drive_file_id: fileId,
            content_hash: contentHash,
            version: existing.version + 1,
            updated_by: 'llm',
            title: title ?? existing.title,
            search_text: searchText,
          });
        } else {
          await insertPageRecord(ctx, {
            workspace_id: ctx.workspaceId,
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

        // Sync page_links: delete old outgoing links, insert new ones
        const toSlugs = extractWikiLinks(content_md);
        const { error: delError } = await ctx.supabase
          .from('page_links')
          .delete()
          .eq('workspace_id', ctx.workspaceId)
          .eq('from_slug', slug);
        if (delError) throw new Error(`page_links delete failed: ${delError.message}`);
        if (toSlugs.length > 0) {
          const { error: insError } = await ctx.supabase.from('page_links').insert(
            toSlugs.map((to_slug) => ({ workspace_id: ctx.workspaceId, from_slug: slug, to_slug })),
          );
          if (insError) throw new Error(`page_links insert failed: ${insError.message}`);
        }

        return { ok: true, slug, fileId };
      },
    }),

    searchPages: tool({
      description: 'Full-text search across wiki page titles and slugs',
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      execute: async ({ query, limit }: { query: string; limit: number }) => {
        const { data: pages, error } = await ctx.supabase.rpc('search_pages', {
          p_workspace_id: ctx.workspaceId,
          p_query: query,
        });

        if (!error) return { pages: (pages ?? []).slice(0, limit) };

        const { data: fallbackPages } = await ctx.supabase
          .from('pages')
          .select('slug, title, kind, updated_at')
          .eq('workspace_id', ctx.workspaceId)
          .eq('zone', 'wiki')
          .or(`slug.ilike.%${query}%,title.ilike.%${query}%`)
          .order('updated_at', { ascending: false })
          .limit(limit);
        return { pages: fallbackPages ?? [] };
      },
    }),

    listPages: tool({
      description: 'List all wiki pages, optionally filtered by kind',
      inputSchema: z.object({
        kind: z.string().optional().describe('Filter by kind: entity, concept, synthesis, etc.'),
      }),
      execute: async ({ kind }: { kind?: string }) => {
        let q = ctx.supabase
          .from('pages')
          .select('slug, title, kind, updated_at')
          .eq('workspace_id', ctx.workspaceId)
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
      }),
      execute: async ({ slug }: { slug: string }) => {
        const { data: page } = await ctx.supabase
          .from('pages')
          .select('id, drive_file_id')
          .eq('workspace_id', ctx.workspaceId)
          .eq('slug', slug)
          .single();
        if (!page) return { error: `Page not found: ${slug}` };

        const { error: outgoingLinksError } = await ctx.supabase
          .from('page_links')
          .delete()
          .eq('workspace_id', ctx.workspaceId)
          .eq('from_slug', slug);
        if (outgoingLinksError) throw new Error(`page_links delete failed: ${outgoingLinksError.message}`);

        const { error: incomingLinksError } = await ctx.supabase
          .from('page_links')
          .delete()
          .eq('workspace_id', ctx.workspaceId)
          .eq('to_slug', slug);
        if (incomingLinksError) throw new Error(`page_links delete failed: ${incomingLinksError.message}`);

        let driveWarning: string | undefined;
        try {
          await ctx.drive.files.delete({ fileId: page.drive_file_id });
        } catch (error) {
          driveWarning = error instanceof Error ? error.message : 'unknown Drive delete error';
        }

        const { error: pageDeleteError } = await ctx.supabase.from('pages').delete().eq('id', page.id);
        if (pageDeleteError) throw new Error(`page delete failed: ${pageDeleteError.message}`);

        return { ok: true, slug, warning: driveWarning };
      },
    }),

    movePage: tool({
      description: 'Rename/move a wiki page to a new slug. Updates all incoming wikilinks.',
      inputSchema: z.object({
        oldSlug: z.string().describe('Current slug'),
        newSlug: z.string().describe('Target slug'),
      }),
      execute: async ({ oldSlug, newSlug }: { oldSlug: string; newSlug: string }) => {
        const { data: page } = await ctx.supabase
          .from('pages')
          .select('id, drive_file_id, content_hash, title, kind, version, updated_by')
          .eq('workspace_id', ctx.workspaceId)
          .eq('slug', oldSlug)
          .single();
        if (!page) return { error: `Page not found: ${oldSlug}` };

        const { data: target } = await ctx.supabase
          .from('pages')
          .select('id')
          .eq('workspace_id', ctx.workspaceId)
          .eq('slug', newSlug)
          .maybeSingle();
        if (target) return { error: `Target page already exists: ${newSlug}` };

        // Read content, rewrite wikilinks in other pages pointing to oldSlug
        const { data: incomingLinks } = await ctx.supabase
          .from('page_links')
          .select('from_slug')
          .eq('workspace_id', ctx.workspaceId)
          .eq('to_slug', oldSlug);

        for (const link of incomingLinks ?? []) {
          const { data: fromPage } = await ctx.supabase
            .from('pages')
            .select('id, drive_file_id, version')
            .eq('workspace_id', ctx.workspaceId)
            .eq('slug', link.from_slug)
            .single();
          if (fromPage) {
            const content = await readDriveFile(ctx.drive, fromPage.drive_file_id);
            const updated = content.replace(
              new RegExp(`\\[\\[${escapeRegExp(oldSlug)}([^\\]]*)\\]\\]`, 'g'),
              `[[${newSlug}$1]]`,
            );
            if (updated !== content) {
              await writeDriveFile(ctx.drive, updated, {
                fileId: fromPage.drive_file_id,
                name: link.from_slug.split('/').at(-1) ?? link.from_slug,
                parentId: await resolveParentFolder(ctx, link.from_slug),
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
        const newParentId = await resolveParentFolder(ctx, newSlug);
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
          .eq('workspace_id', ctx.workspaceId)
          .eq('from_slug', oldSlug);
        if (outgoingLinksError) throw new Error(`page_links update failed: ${outgoingLinksError.message}`);

        const { error: incomingLinksError } = await ctx.supabase
          .from('page_links')
          .update({ to_slug: newSlug })
          .eq('workspace_id', ctx.workspaceId)
          .eq('to_slug', oldSlug);
        if (incomingLinksError) throw new Error(`page_links update failed: ${incomingLinksError.message}`);

        return { ok: true, oldSlug, newSlug };
      },
    }),
  };
}

async function resolveParentFolder(ctx: ToolContext, slug: string): Promise<string> {
  const parts = slug.split('/');
  if (parts.length === 1) return ctx.wikiFolderId;

  let parentId = ctx.wikiFolderId;
  for (const part of parts.slice(0, -1)) {
    parentId = await ensureFolder(ctx.drive, part, parentId);
  }
  return parentId;
}

async function hashContent(content: string): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Parse [[wikilink]] and [[wikilink|display]] patterns from markdown content.
 * Normalises targets to include .md extension.
 */
function extractWikiLinks(content: string): string[] {
  const links = new Set<string>();
  for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    let slug = (match[1] ?? '').split('|')[0]!.trim();
    if (slug && !slug.endsWith('.md')) slug += '.md';
    if (slug) links.add(slug);
  }
  return Array.from(links);
}

async function insertPageRecord(
  ctx: ToolContext,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await ctx.supabase.from('pages').insert(values);
  if (!error) return;

  if (isMissingSearchTextError(error)) {
    const { search_text: _searchText, ...fallbackValues } = values;
    const { error: fallbackError } = await ctx.supabase.from('pages').insert(fallbackValues);
    if (!fallbackError) return;
    throw new Error(`pages insert failed: ${fallbackError.message}`);
  }

  throw new Error(`pages insert failed: ${error.message}`);
}

async function updatePageRecord(
  ctx: ToolContext,
  pageId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await ctx.supabase.from('pages').update(values).eq('id', pageId);
  if (!error) return;

  if (isMissingSearchTextError(error)) {
    const { search_text: _searchText, ...fallbackValues } = values;
    const { error: fallbackError } = await ctx.supabase
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
