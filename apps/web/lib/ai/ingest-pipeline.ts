import { generateText, stepCountIs, type ModelMessage } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import { createLLMClient } from './client';
import { buildWikiTools } from './tools';
import { readDriveFile } from '@/lib/drive/client';
import type { LLMProfile, IngestJob } from '@llm-wiki/shared-types';

/**
 * A run that called no tool wrote nothing — the model answered with prose instead
 * of working. It happened on 7 of 22 production imports, and every one of them was
 * marked `done` and shown to the user as a successful import. Whether the source
 * made it into the wiki is decidable in code, so decide it in code: nudge once,
 * then fail loudly.
 */
const NUDGE_PROMPT = `You have not written anything: no writePage call was made, so the source is still not in the wiki. Do not explain and do not ask — integrate it NOW with writePage calls (update the existing pages it touches, create the new ones, then update index.md and append to log.md).`;

const MAX_ATTEMPTS = 2;

/** Breather before retrying a round the provider failed (rate limits, 5xx). */
const PROVIDER_RETRY_DELAY_MS = 5_000;

interface IngestContext {
  supabase: SupabaseClient;
  drive: drive_v3.Drive;
  workspaceId: string;
  wikiFolderId: string;
  sourceContent: string;
  sourceTitle: string;
  systemPrompt: string;
  profile: LLMProfile;
  jobId: string;
}

/**
 * Run the full LLM ingest pipeline for one source.
 * Reads existing wiki state, produces a cascade update plan, and executes writes.
 * Expects at least 5 touched pages per the Karpathy principle.
 */
export async function runIngestPipeline(ctx: IngestContext): Promise<string[]> {
  const tools = buildWikiTools({
    supabase: ctx.supabase,
    drive: ctx.drive,
    workspaceId: ctx.workspaceId,
    wikiFolderId: ctx.wikiFolderId,
  });

  const model = createLLMClient(ctx.profile);

  // Always read index.md first so LLM understands current wiki structure
  const { data: indexPage } = await ctx.supabase
    .from('pages')
    .select('drive_file_id')
    .eq('workspace_id', ctx.workspaceId)
    .eq('slug', 'index.md')
    .single();

  const indexContent = indexPage
    ? await readDriveFile(ctx.drive, indexPage.drive_file_id)
    : '(No index yet)';

  // index.md is hand-maintained by the model and drifts; the pages table is the
  // truth. Without this list the model cannot see what already exists and happily
  // writes a second page for an entity it already covered under another slug.
  const { data: existingPages } = await ctx.supabase
    .from('pages')
    .select('slug, title, kind')
    .eq('workspace_id', ctx.workspaceId)
    .eq('zone', 'wiki')
    .order('updated_at', { ascending: false })
    .limit(400);

  const inventory =
    (existingPages ?? []).map((p) => `- ${p.slug} (${p.kind}) «${p.title ?? ''}»`).join('\n') ||
    '(no pages yet)';

  const userMessage = `
## Current Wiki Index
\`\`\`markdown
${indexContent}
\`\`\`

## Every page that already exists in this workspace (authoritative)
${inventory}

## New Source to Ingest
Title: ${ctx.sourceTitle}

\`\`\`markdown
${ctx.sourceContent}
\`\`\`

Please integrate this source into the wiki following the instructions in your system prompt.

Integrate, do not accumulate: before you writePage a slug that is not in the list above, check whether one of the pages listed already covers that entity/concept — even under a different name, casing or slug. If it does, readPage it and rewrite THAT page with the merged content. Never leave two pages describing the same thing.

Remember: touch at least 5 existing pages (update + new), update index.md, and append to log.md.
`.trim();

  // Collected incrementally so pollers see live progress, not just the final count
  const touchedSlugs = new Set<string>();

  const messages: ModelMessage[] = [{ role: 'user', content: userMessage }];
  let providerError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS && touchedSlugs.size === 0; attempt += 1) {
    if (attempt > 0) {
      // Same conversation, harder instruction: a model that talked instead of
      // acting usually acts when told it produced nothing.
      if (providerError) await new Promise((resolve) => setTimeout(resolve, PROVIDER_RETRY_DELAY_MS));
      messages.push({ role: 'user', content: NUDGE_PROMPT });
    }

    const result = await generateText({
      model,
      system: ctx.systemPrompt,
      messages,
      tools,
      stopWhen: stepCountIs(30),
      onStepFinish: async (step) => {
        let added = false;
        for (const toolResult of step.toolResults ?? []) {
          if (toolResult.toolName === 'writePage') {
            const res = toolResult.output as { slug?: string };
            if (res.slug && !touchedSlugs.has(res.slug)) {
              touchedSlugs.add(res.slug);
              added = true;
            }
          }
        }
        if (added) {
          // Progress heartbeat for GET /api/ingest pollers; status stays 'running'
          await ctx.supabase
            .from('ingest_jobs')
            .update({ touched_pages: Array.from(touchedSlugs) })
            .eq('id', ctx.jobId);
        }
      },
    }).catch((err: unknown) => {
      providerError = err;
      return null;
    });

    if (result) {
      providerError = null;
      messages.push(...result.response.messages);
    }
  }

  if (touchedSlugs.size === 0) {
    // The route's after() marks the job failed with this message. Anything is
    // better than telling the user the import succeeded when the wiki is unchanged.
    throw providerError instanceof Error
      ? providerError
      : new Error('The model wrote no pages for this source. Re-ingest it, or pick a stronger model.');
  }

  const touched = Array.from(touchedSlugs);

  // Update job record with results
  await ctx.supabase
    .from('ingest_jobs')
    .update({
      status: 'done',
      touched_pages: touched,
      finished_at: new Date().toISOString(),
    })
    .eq('id', ctx.jobId);

  // Write activity log
  await ctx.supabase.from('logs').insert({
    workspace_id: ctx.workspaceId,
    kind: 'ingest',
    summary: `Ingested "${ctx.sourceTitle}" — ${touched.length} pages updated`,
    payload: { touched_pages: touched, source_title: ctx.sourceTitle },
  });

  return touched;
}
