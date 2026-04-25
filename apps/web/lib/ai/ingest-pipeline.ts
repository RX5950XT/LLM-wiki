import { generateText, stepCountIs } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import { createLLMClient } from './client';
import { buildWikiTools } from './tools';
import { readDriveFile } from '@/lib/drive/client';
import type { LLMProfile, IngestJob } from '@llm-wiki/shared-types';

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

  const userMessage = `
## Current Wiki Index
\`\`\`markdown
${indexContent}
\`\`\`

## New Source to Ingest
Title: ${ctx.sourceTitle}

\`\`\`markdown
${ctx.sourceContent}
\`\`\`

Please integrate this source into the wiki following the instructions in your system prompt.
Remember: touch at least 5 existing pages (update + new), update index.md, and append to log.md.
`.trim();

  const result = await generateText({
    model,
    system: ctx.systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    tools,
    stopWhen: stepCountIs(30),
  });

  // Collect all slugs written during this ingest
  const touchedSlugs = new Set<string>();
  for (const step of result.steps ?? []) {
    for (const toolResult of step.toolResults ?? []) {
      if (toolResult.toolName === 'writePage') {
        const res = toolResult.output as { slug?: string };
        if (res.slug) touchedSlugs.add(res.slug);
      }
    }
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
