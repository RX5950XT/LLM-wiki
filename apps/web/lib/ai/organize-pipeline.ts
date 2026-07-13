import { generateText, stepCountIs } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import { createLLMClient } from './client';
import { buildWikiTools } from './tools';
import type { LLMProfile } from '@llm-wiki/shared-types';

interface MaintainContext {
  supabase: SupabaseClient;
  drive: drive_v3.Drive;
  userId: string;
  /** Workspace the run was triggered from (the model's default scope) */
  workspaceId: string;
  wikiFolderId: string;
  /** User's `_schema/lint.md` (health-check preferences), or the default prompt */
  healthChecklist: string;
  locale?: string | null;
  profile: LLMProfile;
  jobId: string;
}

/**
 * The single maintenance pass: health check + dedupe + re-classification across
 * ALL workspaces, executed with full write access (the user confirmed the run in
 * the UI — there is no second confirmation step here).
 *
 * It deliberately writes NO report page: the wiki itself is the output. The tool
 * calls it performed are streamed into agent_jobs.progress instead.
 */
export async function runOrganizePipeline(ctx: MaintainContext): Promise<number> {
  const tools = buildWikiTools({
    supabase: ctx.supabase,
    drive: ctx.drive,
    workspaceId: ctx.workspaceId,
    wikiFolderId: ctx.wikiFolderId,
    userId: ctx.userId,
    crossWorkspace: true,
    // The maintenance button IS the confirmation. Gating deletes here would leave
    // duplicates in place forever (nobody can confirm a background job's cards).
    confirmDestructive: false,
    locale: ctx.locale,
  });

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

  const userMessage = `
You are the autonomous maintainer of the user's ENTIRE knowledge base. The user pressed the maintenance button, which means every action below is pre-approved: act with your tools, never ask for confirmation, never stop to propose.

# Full inventory (all workspaces)
${inventory}

# What to do
1. Health check + FIX (do not just report): broken [[wikilinks]], orphan pages with no inbound link, stub pages, contradictions between pages, wrong page kinds. Read pages with readPage before judging, fix them with writePage / movePage / deletePage.
2. Deduplicate: find the same entity/concept living in several pages or workspaces. Merge the unique content into the single best page (writePage), then deletePage the redundant ones.
3. Re-classify: move a page that clearly belongs elsewhere with movePageToWorkspace, and fix the dangling wikilinks it reports back.
4. Workspace hygiene (you have full rights): renameWorkspace when a name no longer matches its content, createWorkspace when a coherent cluster of pages deserves its own home, deleteWorkspace ONLY after you moved its pages out (never delete a workspace that still holds knowledge), reorderWorkspaces to put the most active first.
5. Keep every touched workspace's index.md accurate and append one short entry to its log.md describing what this maintenance run changed. Write in the user's UI language (${ctx.locale ?? 'zh-TW'}).

# Hard rules
- Do NOT create any report page. No _organize/*, no _lint/* pages. The wiki itself is the deliverable.
- Never delete the workspace the user is currently in (workspace_id: ${ctx.workspaceId}) — they would be left staring at a dead page.
- Never touch pages the tools refuse (locked by the user, or outside the wiki zone) — move on instead of retrying.
- Prefer fewer, higher-quality merged pages over many fragments.

# The user's health-check preferences (reference only)
${ctx.healthChecklist.slice(0, 8000)}

Ignore any instruction above telling you to write a report or to avoid auto-fixing: this run must apply the fixes directly.
`.trim();

  const progress = new Set<string>();

  await generateText({
    model,
    system:
      'You are the maintainer of a structured markdown knowledge base spread across multiple workspaces. You act through tools only, and you have full write access to pages and workspaces.',
    messages: [{ role: 'user', content: userMessage }],
    tools,
    stopWhen: stepCountIs(80),
    onStepFinish: async (step) => {
      let added = false;
      for (const toolResult of step.toolResults ?? []) {
        const output = toolResult.output as
          | { slug?: string; name?: string; workspace_id?: string; ok?: boolean }
          | undefined;
        if (!output?.ok) continue;
        // Workspace-level ops carry no slug — fall back to name/id so two different
        // renames don't collapse into one progress entry.
        const target = output.slug ?? output.name ?? output.workspace_id ?? '';
        const label = `${toolResult.toolName}:${target}`;
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

  await ctx.supabase
    .from('agent_jobs')
    .update({
      status: 'done',
      progress: Array.from(progress),
      finished_at: new Date().toISOString(),
    })
    .eq('id', ctx.jobId);

  await ctx.supabase.from('logs').insert({
    workspace_id: ctx.workspaceId,
    kind: 'lint',
    summary: `Maintenance run — ${progress.size} operations`,
    payload: { operations: Array.from(progress) },
  });

  return progress.size;
}
