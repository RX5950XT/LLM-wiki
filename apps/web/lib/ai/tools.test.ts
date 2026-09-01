import { describe, expect, it } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import { buildWikiTools, deletePageForWorkspace, writePageForWorkspace } from './tools';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222';

function tools(overrides: Partial<Parameters<typeof buildWikiTools>[0]> = {}) {
  return buildWikiTools({
    supabase: {} as SupabaseClient,
    drive: {} as drive_v3.Drive,
    workspaceId: WORKSPACE,
    wikiFolderId: 'folder',
    userId: 'user',
    crossWorkspace: true,
    confirmDestructive: false,
    ...overrides,
  });
}

describe('buildWikiTools', () => {
  it('ingest mode exposes only read/list/search/write and enforces the plan allowlist', async () => {
    const ingestTools = tools({
      crossWorkspace: false,
      ingestWriteOnly: true,
      writePageAllowlist: new Set(['concepts/allowed.md', 'index.md', 'log.md']),
    });
    expect(Object.keys(ingestTools).sort()).toEqual(['listPages', 'readPage', 'searchPages', 'writePage']);
    const result = (await ingestTools.writePage.execute!(
      {
        slug: 'concepts/not-allowed.md',
        content_md: '# no',
        kind: 'concept',
      },
      { toolCallId: 'test', messages: [] },
    )) as { error?: string };
    expect(result.error).toContain('outside the validated ingest plan');
  });

  it('withholds deleteWorkspace when the caller disables it', () => {
    // The failure it prevents: a maintenance pass "merges" workspaces by sweeping
    // one workspace's pages into an unrelated one and deleting the husk — a whole
    // shelf disappears and the UI only says "N changes". Empty workspaces are swept
    // by code (organize-mechanical.ts), so the model never needs this tool.
    expect(Object.keys(tools({ allowWorkspaceDelete: false }))).not.toContain('deleteWorkspace');
  });

  it('keeps deleteWorkspace for the chat, where the user asks and confirms', () => {
    expect(Object.keys(tools())).toContain('deleteWorkspace');
  });

  // Measured on a production run: 4 pages were moved out by one maintenance pass and
  // straight back by the next, because each pass re-derives the taxonomy. The churn
  // also keeps `more_work` true, so the button spends passes undoing itself.
  it('refuses to move a page an earlier pass of the same run already moved', async () => {
    const move = tools({ frozenMoveSlugs: new Set(['concepts/data-center-infrastructure.md']) })
      .movePageToWorkspace;

    const result = (await move.execute!(
      {
        slug: 'concepts/data-center-infrastructure.md',
        to_workspace_id: OTHER_WORKSPACE,
      },
      { toolCallId: 'test', messages: [] },
    )) as { error?: string };

    expect(result.error).toContain('already re-shelved');
  });
});

describe('wiki zone guard — the model must not shelve its own working notes', () => {
  const scope = { workspaceId: 'w1', wikiFolderId: 'folder-1' };
  const deps = { supabase: {} as never, drive: {} as never };

  it('refuses a plans/ page', async () => {
    const result = await writePageForWorkspace(deps, scope, {
      slug: 'plans/ingest-manus-ai-acquisition.md',
      content_md: '# Plan\n1. read source\n2. write pages',
      kind: 'synthesis',
      title: 'Plan: Ingest Manus AI',
    });
    expect((result as { error?: string }).error).toContain('not a knowledge page');
  });

  it('refuses a root scratch file', async () => {
    const result = await writePageForWorkspace(deps, scope, {
      slug: 'update-plan.json',
      content_md: '{}',
      kind: 'lint',
      title: 'Update Plan JSON',
    });
    expect((result as { error?: string }).error).toContain('not a knowledge page');
  });
});

it('keeps synthesis writes in sync through the shared page writer', async () => {
  const content = '# Synthesis\n\nSee [[entities/source|Source]].';
  let insertedPage: Record<string, unknown> | undefined;
  let insertedLinks: Array<Record<string, string>> | undefined;

  const supabase = {
    from(table: string) {
      if (table === 'pages') {
        return {
          select: () => ({ eq: () => ({ in: async () => ({ data: [] }) }) }),
          insert: async (values: Record<string, unknown>) => {
            insertedPage = values;
            return { error: null };
          },
        };
      }
      return {
        delete: () => ({ eq: () => ({ in: async () => ({ error: null }) }) }),
        insert: async (values: Array<Record<string, string>>) => {
          insertedLinks = values;
          return { error: null };
        },
      };
    },
  } as never;
  const drive = {
    files: {
      list: async () => ({ data: { files: [] } }),
      create: async ({ requestBody }: { requestBody?: { mimeType?: string } }) => ({
        data: {
          id:
            requestBody?.mimeType === 'application/vnd.google-apps.folder'
              ? 'synthesis-folder'
              : 'synthesis-page',
        },
      }),
    },
  } as never;

  const result = await writePageForWorkspace(
    { supabase, drive },
    { workspaceId: WORKSPACE, wikiFolderId: 'wiki-folder' },
    {
      slug: 'synthesis/20260831-1200-topic.md',
      content_md: content,
      kind: 'synthesis',
      title: 'Topic',
    },
  );

  expect(result).toEqual({
    ok: true,
    slug: 'synthesis/20260831-1200-topic.md',
    fileId: 'synthesis-page',
    result: 'updated',
  });
  expect(insertedPage).toMatchObject({
    workspace_id: WORKSPACE,
    slug: 'synthesis/20260831-1200-topic.md',
    kind: 'synthesis',
    zone: 'wiki',
    drive_file_id: 'synthesis-page',
    title: 'Topic',
    updated_by: 'llm',
    search_text: content,
  });
  expect(insertedPage?.content_hash).toMatch(/^[0-9a-f]{16}$/);
  expect(insertedLinks).toEqual([
    {
      workspace_id: WORKSPACE,
      from_slug: 'synthesis/20260831-1200-topic.md',
      to_slug: 'entities/source.md',
    },
  ]);
});

// The guard must never make existing junk permanent: it blocks *writing* a page
// outside the knowledge folders, not deleting one that is already there.
describe('deleting a non-knowledge page stays possible', () => {
  it('does not reject plans/… on the delete path', async () => {
    const deps = {
      supabase: {
        from: () => ({
          select: () => ({ eq: () => ({ in: async () => ({ data: [] }) }) }),
        }),
      } as never,
      drive: {} as never,
    };
    const result = await deletePageForWorkspace(deps, { workspaceId: 'w1', wikiFolderId: 'f1' }, 'plans/plan-2026-11-24.md');
    // No page row exists in this stub, so it reports "not found" — crucially NOT
    // "not a knowledge page", which is what the over-broad guard used to say.
    expect(JSON.stringify(result)).not.toContain('not a knowledge page');
  });
});

function existingPageDeps(
  content: string,
  overrides: {
    onWrite?: (text: string) => void;
    updateData?: Record<string, string> | null;
    onLinkDelete?: () => void;
  } = {},
) {
  const page = {
    id: 'page-1',
    drive_file_id: 'drive-1',
    version: 3,
    title: 'Existing',
    locked_by_human: false,
  };
  const supabase = {
    from(table: string) {
      if (table === 'pages') {
        return {
          select(fields: string) {
            if (fields === 'slug') {
              return { eq: () => ({ in: async () => ({ data: [{ slug: 'concepts/topic.md' }], error: null }) }) };
            }
            return {
              eq: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: page, error: null }) }),
              }),
            };
          },
          update: (values: Record<string, unknown>) => {
            const builder = {
              eq: () => builder,
              select: () => builder,
              maybeSingle: async () => ({
                data: overrides.updateData === undefined ? { id: 'page-1' } : overrides.updateData,
                error: null,
              }),
            };
            void values;
            return builder;
          },
        };
      }
      return {
        delete: () => ({
          eq: () => ({
            in: async () => {
              overrides.onLinkDelete?.();
              return { error: null };
            },
          }),
        }),
        insert: async () => ({ error: null }),
      };
    },
  } as never;
  const drive = {
    files: {
      get: async ({ alt }: { alt?: string }) =>
        alt === 'media'
          ? { data: content }
          : { data: { id: 'drive-1', mimeType: 'text/markdown', trashed: false } },
      update: async ({ media }: { media?: { body?: AsyncIterable<string> } }) => {
        if (media?.body) {
          let next = '';
          for await (const chunk of media.body) next += chunk;
          overrides.onWrite?.(next);
        }
        return { data: { id: 'drive-1' } };
      },
      list: async () => ({ data: { files: [] } }),
      create: async () => ({ data: { id: 'folder-1' } }),
    },
  } as never;
  return { supabase, drive };
}

describe('shared writer safety', () => {
  it('rejects suspicious shortening before any Drive write', async () => {
    const longBody = 'x'.repeat(500);
    let writes = 0;
    const deps = existingPageDeps(`---\ntitle: Existing\nsources: [old]\n---\n${longBody}`, {
      onWrite: () => {
        writes += 1;
      },
    });

    const result = await writePageForWorkspace(
      deps,
      { workspaceId: WORKSPACE, wikiFolderId: 'wiki-folder' },
      {
        slug: 'concepts/topic.md',
        content_md: '---\ntitle: Rewritten\n---\nshort',
        kind: 'concept',
        sourceId: 'source-1',
      },
    );

    expect(result).toEqual({ error: 'SUSPECTED_TRUNCATION' });
    expect(writes).toBe(0);
  });

  it('merges old metadata before writing and records it in the DB row', async () => {
    let written = '';
    let updated: Record<string, unknown> | undefined;
    const deps = existingPageDeps(
      '---\nsources: [old]\ntags: [one]\ncustom_flag: true\n---\nOld body.',
      { onWrite: (text) => (written = text) },
    );
    (deps.supabase as { from: (table: string) => unknown }).from = (table: string) => {
      const base = existingPageDeps(
        '---\nsources: [old]\ntags: [one]\ncustom_flag: true\n---\nOld body.',
      ).supabase as never;
      if (table !== 'pages') return (base as { from: (name: string) => unknown }).from(table);
      return {
        select: (fields: string) => (base as any).from('pages').select(fields),
        update: (values: Record<string, unknown>) => {
          updated = values;
          const builder = {
            eq: () => builder,
            select: () => builder,
            maybeSingle: async () => ({ data: { id: 'page-1' }, error: null }),
          };
          return builder;
        },
      };
    };

    const result = await writePageForWorkspace(
      deps,
      { workspaceId: WORKSPACE, wikiFolderId: 'wiki-folder' },
      {
        slug: 'concepts/topic.md',
        content_md: '---\nsources: [new]\ntags: [two]\n---\nNew body.',
        kind: 'concept',
        sourceId: 'source-1',
      },
    );

    expect(result).toMatchObject({ ok: true, result: 'updated' });
    expect(written).toContain('sources: ["old", "new", "source-1"]');
    expect(written).toContain('tags: ["one", "two"]');
    expect(written).toContain('custom_flag: true');
    expect(updated?.frontmatter).toMatchObject({ sources: ['old', 'new', 'source-1'], tags: ['one', 'two'] });
  });

  it('restores Drive and skips page_links when the version CAS loses', async () => {
    const writes: string[] = [];
    let linkDeletes = 0;
    const deps = existingPageDeps(
      '---\nsources: [old]\n---\nPrevious body.',
      { onWrite: (text) => writes.push(text), updateData: null, onLinkDelete: () => (linkDeletes += 1) },
    );
    const result = await writePageForWorkspace(
      deps,
      { workspaceId: WORKSPACE, wikiFolderId: 'wiki-folder' },
      {
        slug: 'concepts/topic.md',
        content_md: '---\nsources: [new]\n---\nNew body.',
        kind: 'concept',
        sourceId: 'source-1',
      },
    );
    expect(result).toEqual({ error: 'WRITE_CONFLICT' });
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain('Previous body.');
    expect(linkDeletes).toBe(0);
  });

  it('trashes a newly-created Drive file when the page insert loses a race', async () => {
    let trashed = false;
    const supabase = {
      from(table: string) {
        if (table === 'pages') {
          return {
            select: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }),
            insert: async () => ({ error: { message: 'duplicate slug' } }),
          };
        }
        return { delete: () => ({ eq: () => ({ in: async () => ({ error: null }) }) }) };
      },
    } as never;
    const drive = {
      files: {
        list: async () => ({ data: { files: [] } }),
        create: async () => ({ data: { id: 'new-page' } }),
        update: async ({ requestBody }: { requestBody?: { trashed?: boolean } }) => {
          trashed = requestBody?.trashed === true;
          return { data: { id: 'new-page' } };
        },
      },
    } as never;
    await expect(
      writePageForWorkspace(
        { supabase, drive },
        { workspaceId: WORKSPACE, wikiFolderId: 'wiki-folder' },
        { slug: 'concepts/race.md', content_md: '# Race', kind: 'concept' },
      ),
    ).rejects.toThrow('pages insert failed');
    expect(trashed).toBe(true);
  });
});
