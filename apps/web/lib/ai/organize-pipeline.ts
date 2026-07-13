import { generateText, stepCountIs } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import { createLLMClient } from './client';
import { buildWikiTools } from './tools';
import type { LLMProfile } from '@llm-wiki/shared-types';

interface OrganizeContext {
  supabase: SupabaseClient;
  drive: drive_v3.Drive;
  userId: string;
  /** Workspace the user triggered from — the report page is written here */
  workspaceId: string;
  wikiFolderId: string;
  /** When true, duplicate deletions are listed in the report instead of executed */
  confirmDestructive: boolean;
  locale?: string | null;
  profile: LLMProfile;
  jobId: string;
}

/**
 * Cross-workspace organize: find duplicated knowledge, merge it, move
 * misplaced pages to better-fitting workspaces, and write a report page
 * (_organize/YYYYMMDD.md) into the triggering workspace.
 */
export async function runOrganizePipeline(ctx: OrganizeContext): Promise<string> {
  const tools = buildWikiTools({
    supabase: ctx.supabase,
    drive: ctx.drive,
    workspaceId: ctx.workspaceId,
    wikiFolderId: ctx.wikiFolderId,
    userId: ctx.userId,
    crossWorkspace: true,
    // Organize is a long background job — a confirmation card can't be shown,
    // so in confirm mode deletions are forbidden outright (report them instead).
    confirmDestructive: ctx.confirmDestructive,
    locale: ctx.locale,
  });
  // Workspace lifecycle is out of scope for organize — never let an unattended
  // background job create or delete whole workspaces (deleteWorkspace would run
  // with no confirmation when the user has confirmations off).
  for (const name of ['createWorkspace', 'deleteWorkspace', 'renameWorkspace']) {
    delete (tools as Record<string, unknown>)[name];
  }

  const model = createLLMClient(ctx.profile);

  const { data: workspaces } = await ctx.supabase
    .from('workspaces')
    .select('id, name')
    .eq('owner_id', ctx.userId);

  const { data: pageRows } = await ctx.supabase
    .from('pages')
    .select('workspace_id, slug, title, kind')
    .in('workspace_id', (workspaces ?? []).map((w) => w.id))
    .eq('zone', 'wiki')
    .order('updated_at', { ascending: false })
    .limit(3000);

  const pagesByWorkspace = new Map<string, { slug: string; title: string | null; kind: string }[]>();
  for (const row of pageRows ?? []) {
    const list = pagesByWorkspace.get(row.workspace_id) ?? [];
    list.push({ slug: row.slug, title: row.title, kind: row.kind });
    pagesByWorkspace.set(row.workspace_id, list);
  }

  const inventory = (workspaces ?? [])
    .map((w) => {
      const pages = pagesByWorkspace.get(w.id) ?? [];
      const lines = pages.map((p) => `  - ${p.slug} (${p.kind}) ${p.title ?? ''}`).join('\n');
      return `## Workspace "${w.name}" (workspace_id: ${w.id})${w.id === ctx.workspaceId ? ' [current]' : ''}\n${lines || '  (empty)'}`;
    })
    .join('\n\n');

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const reportSlug = `_organize/${today}.md`;

  const deletionPolicy = ctx.confirmDestructive
    ? 'Deletion is DISABLED in this run: when pages should be removed (true duplicates after merging), list them in the report under "建議刪除" instead of calling deletePage.'
    : 'You may delete true duplicate pages with deletePage AFTER merging their unique content into the surviving page.';

  const userMessage = `
You are reorganizing the user's entire knowledge base across ALL workspaces.

# Full inventory
${inventory}

# Your tasks
1. Find duplicated or overlapping knowledge (same entity/concept appearing in multiple pages or workspaces). Read the candidates with readPage before judging.
2. Merge duplicates: consolidate unique content into the best surviving page (writePage), then handle the redundant page per the deletion policy below.
3. Re-classify misplaced pages: if a page clearly belongs to a different workspace, move it with movePageToWorkspace. Fix dangling wikilinks it reports.
4. Keep each workspace's index.md accurate after your changes.
5. Finally, write a report page with writePage to slug "${reportSlug}" (kind: "lint") in the current workspace summarizing: duplicates found, merges done, pages moved, and suggested deletions if any. Write the report in the user's UI language (${ctx.locale ?? 'zh-TW'}).

# Deletion policy
${deletionPolicy}

Work through the inventory systematically. Prefer fewer, higher-quality merged pages over many fragments.
`.trim();

  const progress = new Set<string>();

  await generateText({
    model,
    system:
      'You are the maintainer of a structured markdown knowledge base spread across multiple workspaces. You act through tools only.',
    messages: [{ role: 'user', content: userMessage }],
    tools,
    stopWhen: stepCountIs(60),
    onStepFinish: async (step) => {
      let added = false;
      for (const toolResult of step.toolResults ?? []) {
        const output = toolResult.output as { slug?: string; ok?: boolean } | undefined;
        if (!output?.ok) continue;
        const label = `${toolResult.toolName}:${output.slug ?? ''}`;
        if (!progress.has(label)) {
          progress.add(label);
          added = true;
        }
      }
      if (added) {
        await ctx.supabase
          .from('agent_jobs')
          .update({ progress: Array.from(progress) })
          .eq('id', ctx.jobId);
      }
    },
  });

  // The model may run out of steps before writing the report page (step 5 of 5).
  // Only hand the client a report_slug that actually exists, so it doesn't
  // navigate to a page-not-found and make a real run look broken.
  const { data: reportPage } = await ctx.supabase
    .from('pages')
    .select('slug')
    .eq('workspace_id', ctx.workspaceId)
    .eq('slug', reportSlug)
    .maybeSingle();
  const finalReportSlug = reportPage ? reportSlug : null;

  await ctx.supabase
    .from('agent_jobs')
    .update({
      status: 'done',
      progress: Array.from(progress),
      report_workspace_id: finalReportSlug ? ctx.workspaceId : null,
      report_slug: finalReportSlug,
      finished_at: new Date().toISOString(),
    })
    .eq('id', ctx.jobId);

  await ctx.supabase.from('logs').insert({
    workspace_id: ctx.workspaceId,
    kind: 'lint',
    summary: `Organize run — ${progress.size} operations`,
    payload: { operations: Array.from(progress), report_slug: finalReportSlug },
  });

  return finalReportSlug ?? reportSlug;
}
