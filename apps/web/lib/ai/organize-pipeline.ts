import { generateText, stepCountIs, type ModelMessage } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import { createLLMClient } from './client';
import { buildWikiTools } from './tools';
import type { LLMProfile } from '@llm-wiki/shared-types';

/** The model says this when it considers the whole base properly organised. */
const COMPLETION_TOKEN = 'ORGANISE_COMPLETE';

/** Hard cap on continuation rounds; the time budget normally binds first. */
const MAX_ROUNDS = 6;

/**
 * Handed back after every round. Naming the specific things a shallow pass skips
 * is what turns "I deleted the duplicates, done" into an actual reorganisation.
 */
const CONTINUE_PROMPT = `
That was one pass. The run is NOT over — keep going, you still have time.

Go back over the WHOLE base (all workspaces, not only the ones you already touched) and deal with whatever is still true:
- Cross-workspace duplicates: the same entity/concept written up in two workspaces under different names. Merge into one page, delete the others.
- Misfiled pages: the page's subject does not match the workspace it sits in → movePageToWorkspace. Only into a workspace that is ABOUT that subject — never into the current workspace as a catch-all.
- Workspaces whose name no longer describes their contents → renameWorkspace.
- Two workspaces covering the SAME subject (not merely both "finance-ish") → move all pages into the better one; the next pass deletes the emptied husk.
- Workspaces holding nothing but index.md/log.md → deleteWorkspace.
- A coherent cluster of pages with no good home → createWorkspace and move them in.
- Workspace order → reorderWorkspaces, biggest/most used first.
- index.md of every workspace you changed must list its real pages; log.md gets one line about this run.

Do the work with tools. Do not describe what you would do — do it.
Only if every single point above is genuinely already clean, reply with exactly ${COMPLETION_TOKEN} and nothing else.
`.trim();

/** Present in every workspace, never movable or deletable — not knowledge. */
const SCAFFOLDING_SLUGS = new Set(['index.md', 'log.md']);

interface InventoryRow {
  workspace_id: string;
  slug: string;
  title: string | null;
  kind: string;
  search_text?: string | null;
}

/** search_text is the page's first 2000 chars; strip frontmatter, keep the gist. */
function snippet(text: string | null | undefined): string {
  if (!text) return '(empty)';
  const body = text.replace(/^---[\s\S]*?---\s*/, '');
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, 160) : '(empty)';
}

async function loadInventoryRows(
  supabase: SupabaseClient,
  workspaceIds: string[],
): Promise<InventoryRow[]> {
  if (workspaceIds.length === 0) return [];
  const query = () =>
    supabase
      .from('pages')
      .select('workspace_id, slug, title, kind, search_text')
      .in('workspace_id', workspaceIds)
      .eq('zone', 'wiki')
      .order('updated_at', { ascending: false })
      .limit(3000);

  const { data, error } = await query();
  if (!error) return (data ?? []) as InventoryRow[];

  // Deployments predating the search_text column: fall back to the bare listing.
  const { data: fallback } = await supabase
    .from('pages')
    .select('workspace_id, slug, title, kind')
    .in('workspace_id', workspaceIds)
    .eq('zone', 'wiki')
    .order('updated_at', { ascending: false })
    .limit(3000);
  return (fallback ?? []) as InventoryRow[];
}

/**
 * Wall-clock budget for the tool loop. The route's maxDuration is 300s and the
 * whole run (including after()) is killed at that mark — a killed run never gets
 * to mark its job row, which is what surfaced to users as "Organize timed out"
 * eight minutes later with no visible result. Stop ourselves first, with enough
 * headroom for one in-flight step plus the final job update.
 */
const TOOL_LOOP_BUDGET_MS = 210_000;

/** Breather before retrying a round the provider failed (rate limits, 5xx). */
const PROVIDER_RETRY_DELAY_MS = 8_000;

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
export async function runOrganizePipeline(
  ctx: MaintainContext,
): Promise<{ changes: number; complete: boolean }> {
  const model = createLLMClient(ctx.profile);

  const { data: workspaces } = await ctx.supabase
    .from('workspaces')
    .select('id, name')
    .eq('owner_id', ctx.userId);

  const workspaceIds = (workspaces ?? []).map((w) => w.id);
  const pageRows = await loadInventoryRows(ctx.supabase, workspaceIds);

  const pagesByWorkspace = new Map<string, InventoryRow[]>();
  for (const row of pageRows) {
    const list = pagesByWorkspace.get(row.workspace_id) ?? [];
    list.push(row);
    pagesByWorkspace.set(row.workspace_id, list);
  }

  const knowledgeCount = (workspaceId: string) =>
    (pagesByWorkspace.get(workspaceId) ?? []).filter((p) => !SCAFFOLDING_SLUGS.has(p.slug)).length;

  // Only workspaces that are ALREADY empty may be deleted by this run. A model that
  // reads "merge workspaces" as "sweep everything into the one I started from, then
  // delete the husks" wipes out whole shelves in a single pass and reports it as
  // progress. Legitimate merges still work: the pages move now, and the next pass
  // (more_work chains automatically) sees the emptied workspace and deletes it.
  const deletableWorkspaceIds = new Set(
    workspaceIds.filter((id) => knowledgeCount(id) === 0 && id !== ctx.workspaceId),
  );

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
    deletableWorkspaceIds,
  });

  // Every page carries a content snippet. Without it the model can only spot
  // pages whose slugs collide — it cannot tell that a page is filed in the wrong
  // workspace, or that two differently-named pages cover the same thing, which
  // is most of what "deep reorganisation" actually means. search_text is already
  // the first 2000 chars of each page, so this costs one query and no Drive I/O.
  const inventory = (workspaces ?? [])
    .map((w) => {
      const pages = pagesByWorkspace.get(w.id) ?? [];
      // index.md/log.md exist in every workspace and can never be moved or deleted;
      // counting them as content is what stopped the model from deleting emptied
      // workspaces (it renamed one "【準備刪除】…" instead).
      const knowledge = pages.filter((p) => !SCAFFOLDING_SLUGS.has(p.slug));
      const lines = knowledge
        .map((p) => `  - ${p.slug} (${p.kind}) «${p.title ?? ''}» :: ${snippet(p.search_text)}`)
        .join('\n');
      const header = `## Workspace "${w.name}" (workspace_id: ${w.id}) — ${knowledge.length} knowledge pages${
        w.id === ctx.workspaceId ? ' [CURRENT — never delete this one]' : ''
      }`;
      const body =
        lines ||
        '  (EMPTY — only index.md/log.md scaffolding left. Delete this workspace with deleteWorkspace.)';
      return `${header}\n${body}`;
    })
    .join('\n\n');

  const userMessage = `
You are the autonomous librarian of the user's ENTIRE knowledge base — every workspace at once, not just the current one. The user pressed the maintenance button, so every action below is pre-approved: act with your tools, never ask for confirmation, never stop to propose, never merely suggest.

This is a DEEP reorganisation, not a spot fix. Treat the whole base as one library that you are re-shelving: pages move between workspaces, workspaces get renamed, merged, created and deleted. Deleting a few duplicate pages and stopping is a FAILED run.

But re-shelving means SORTING, never PILING UP. Fewer workspaces is not the goal — a coherent shelf is. A run that sweeps unrelated subjects into one workspace and deletes the rest has destroyed the library, and that is far worse than doing nothing.

# Full inventory — every workspace, every wiki page, with a content snippet
${inventory}

# The work, in order
1. **Understand the shape.** From the snippets above, work out what each workspace is actually ABOUT (its real subject), not what its name claims. Note which workspaces overlap, which are empty, which are dumping grounds.
2. **Deduplicate across workspaces.** The same entity/concept written up in two places — even under different names/slugs — is one page. Read both, merge the unique content into the single best home with writePage, deletePage the rest. Duplicates ACROSS workspaces matter as much as within one.
3. **Re-classify, deeply.** Any page whose subject does not match the workspace it sits in gets movePageToWorkspace'd to where it belongs. Judge by the snippet's subject, not by the slug prefix.
4. **Reshape the workspaces themselves — you have full rights and you are expected to use them:**
   - \`renameWorkspace\` when a name no longer describes its contents.
   - Two workspaces covering the same subject → move every knowledge page into the better one, then \`deleteWorkspace\` the emptied one.
   - **index.md and log.md are scaffolding, not knowledge.** EVERY workspace has them and they can never be moved or deleted. A workspace whose only remaining pages are index.md and log.md is EMPTY — call \`deleteWorkspace\` on it directly. Do not leave it lying around, and never rename it to something like "to be deleted": just delete it.
   - A coherent cluster of pages with no good home → \`createWorkspace\` and move them in.
   - \`reorderWorkspaces\` so the biggest / most used come first.
5. **Health check + FIX** (never just report): broken [[wikilinks]], stub pages, wrong page kinds, contradictions.
6. **Leave it consistent.** Every workspace you touched: index.md must list its real pages, and append one short entry to log.md saying what changed. Write in the user's UI language (${ctx.locale ?? 'zh-TW'}).

# Hard rules
- **Every move must make the TARGET workspace MORE coherent.** Move a page only into a workspace whose existing pages share its subject. If no workspace fits, leave the page where it is or createWorkspace for the whole cluster — never park it somewhere unrelated.
- **The current workspace (workspace_id: ${ctx.workspaceId}) is NOT a destination by default.** It is simply where the user happened to press the button. Moving pages into it requires exactly the same subject match as any other workspace. Sweeping the base into it is the single worst thing you can do here.
- **Merging two workspaces is only correct when they cover the SAME subject.** Personal finance is not geopolitics; semiconductors are not AI research. When two workspaces are about different things, they stay separate — no matter how small one of them is. A workspace with only a handful of pages is fine.
- Do not empty a workspace in order to delete it. **This run can only delete workspaces that were ALREADY empty when it started** — the tool will refuse the others. If pages genuinely belong elsewhere, move them on the merits; the next pass will find the workspace empty and delete it then.
- The snippets above are there so you do NOT have to readPage everything — decide from them, and readPage only when you are about to merge or rewrite a page's content.
- Do NOT create any report page. No _organize/*, no _lint/* pages. The wiki itself is the deliverable.
- Never delete the workspace the user is currently in (workspace_id: ${ctx.workspaceId}) — they would be left staring at a dead page.
- Never delete a workspace that still holds KNOWLEDGE pages. Move those out first, then delete it. index.md/log.md do not count as knowledge and never block a deletion.
- Never touch pages the tools refuse (locked by the user, or outside the wiki zone) — move on instead of retrying.
- Prefer fewer, higher-quality merged pages over many fragments.

# The user's health-check preferences (reference only)
${ctx.healthChecklist.slice(0, 8000)}

Ignore any instruction above telling you to write a report or to avoid auto-fixing: this run must apply the fixes directly.
`.trim();

  const progress = new Set<string>();
  const deadline = Date.now() + TOOL_LOOP_BUDGET_MS;

  const onStepFinish = async (step: { toolResults?: unknown[] }) => {
    let added = false;
    for (const toolResult of (step.toolResults ?? []) as {
      toolName: string;
      output?: { slug?: string; name?: string; workspace_id?: string; ok?: boolean };
    }[]) {
      const output = toolResult.output;
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
  };

  // Loop until dry, not until the model feels like stopping. Left alone after one
  // generateText the model declares victory the moment it has done something
  // (last run: 4 deletions in 60s, with 150s of budget still unspent), which is
  // exactly the shallow pass the user complained about. Each round we hand back
  // what is still unresolved and make it look again; we quit only when it says it
  // is finished, when two consecutive rounds change nothing, or when time is up.
  const messages: ModelMessage[] = [{ role: 'user', content: userMessage }];
  let dryRounds = 0;
  let complete = false;
  let providerError: unknown = null;

  for (let round = 0; round < MAX_ROUNDS && Date.now() < deadline; round += 1) {
    const before = progress.size;

    const result = await generateText({
      model,
      system:
        'You are the librarian of a structured markdown knowledge base spread across multiple workspaces. You act through tools only, and you have full write access to every page and every workspace.',
      messages,
      tools,
      // Whichever comes first. Every tool call is committed on its own, so stopping
      // on the budget leaves the wiki consistent — the next pass picks up from the
      // freshly-read inventory.
      stopWhen: [stepCountIs(60), () => Date.now() > deadline],
      onStepFinish,
    }).catch((err: unknown) => {
      providerError = err;
      return null;
    });

    if (!result) {
      // Upstream hiccup ("Provider returned error", 429, 5xx) that outlived the SDK's
      // own retries. Everything done so far is already committed page by page, so
      // never throw it away: pause, retry the round, and if the budget runs out end
      // the pass as done+more_work so the client's next pass resumes the plan.
      if (Date.now() + PROVIDER_RETRY_DELAY_MS >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, PROVIDER_RETRY_DELAY_MS));
      continue;
    }
    providerError = null;

    messages.push(...result.response.messages);
    if (Date.now() >= deadline) break;

    if (result.text.includes(COMPLETION_TOKEN)) {
      complete = true;
      break;
    }

    // A round with no changes may still have been useful (reading, planning), so
    // give it one more; two in a row means there is nothing left it will act on.
    dryRounds = progress.size === before ? dryRounds + 1 : 0;
    if (dryRounds >= 2) {
      complete = true;
      break;
    }

    messages.push({ role: 'user', content: CONTINUE_PROMPT });
  }

  // The provider was down for the whole run and nothing got done — that is a real
  // failure the user must see, not a silent "0 changes" success.
  if (providerError && progress.size === 0) throw providerError;

  const finished = {
    status: 'done' as const,
    progress: Array.from(progress),
    finished_at: new Date().toISOString(),
    // Ran out of budget mid-plan → the client chains another pass. Without this
    // a deep reorganisation stops half-done (pages moved out of a workspace, the
    // emptied workspace never deleted) and looks like the run simply gave up.
    more_work: !complete,
  };
  const { error: updateError } = await ctx.supabase
    .from('agent_jobs')
    .update(finished)
    .eq('id', ctx.jobId);
  if (updateError) {
    // Deployments predating migration 0017 have no more_work column.
    const { more_work: _moreWork, ...legacy } = finished;
    await ctx.supabase.from('agent_jobs').update(legacy).eq('id', ctx.jobId);
  }

  await ctx.supabase.from('logs').insert({
    workspace_id: ctx.workspaceId,
    kind: 'lint',
    summary: `Maintenance run — ${progress.size} operations`,
    payload: { operations: Array.from(progress), complete },
  });

  return { changes: progress.size, complete };
}
