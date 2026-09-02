import { createHash } from 'crypto';
import { APICallError, generateText, stepCountIs, type ModelMessage } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import { createLLMClient } from './client';
import { buildWikiTools } from './tools';
import {
  buildIngestWritePrompt,
  generateIngestPlan,
  generateIngestReview,
  type IngestPageAudit,
  ingestPlanSchema,
  ingestReviewSchema,
  normalizeIngestPlan,
} from './ingest-plan';
import { markdownBody, parseFrontmatter } from './frontmatter-merge';
import { normalizeWikiSlug } from '@/lib/wiki/slug';
import { readDriveFile } from '@/lib/drive/client';
import type {
  IngestCheckpoint,
  IngestPhase,
  IngestPlan,
  IngestReview,
  IngestStatus,
  LLMProfile,
} from '@llm-wiki/shared-types';

const NUDGE_PROMPT =
  'No writePage call has completed yet. Continue the validated plan now; do not answer with prose.';
const MAX_WRITE_ATTEMPTS = 2;

export interface IngestContext {
  supabase: SupabaseClient;
  drive: drive_v3.Drive;
  workspaceId: string;
  wikiFolderId: string;
  sourceContent: string;
  sourceTitle: string;
  systemPrompt: string;
  profile: LLMProfile;
  jobId: string;
  /** Optional for callers that already loaded the job row. */
  sourceId?: string;
  /** Fencing token claimed by the runner; never incremented by the pipeline. */
  attemptToken: number;
  /** Cooperative cancellation checked between stages and after tool steps. */
  pauseRequested?: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
}

interface StoredJob {
  id: string;
  source_id: string;
  status: IngestStatus;
  phase: IngestPhase;
  touched_pages: string[] | null;
  checkpoint: unknown;
  attempt_count: number;
  source_sha256: string | null;
  result: 'updated' | 'unchanged' | null;
}

export class IngestLeaseLostError extends Error {
  constructor() {
    super('Ingest job lease was replaced by a newer attempt.');
    this.name = 'IngestLeaseLostError';
  }
}

/** Public job-row text: the provider's message only, never its URL/body/keys. */
export function publicIngestError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'The model wrote no pages for this source.') return message;
  if (message === 'SUSPECTED_TRUNCATION') return message;
  if (message.startsWith('Ingest review incomplete')) return 'Ingest review incomplete';
  if (message.startsWith('Invalid ingest target page slug')) return 'Ingest plan contains an invalid page target';
  if (message.startsWith('Ingest plan exceeds')) return 'Ingest plan contains too many page targets';
  if (/No LLM profile configured/i.test(message)) return 'No LLM profile configured';
  if (/Google Drive.*(authori[sz]|reauthor|access)/i.test(message)) {
    return 'Google Drive authorization required';
  }
  // A bad model id or provider outage fails every retry identically. Showing the
  // provider's own words is the only way the user can tell retrying is pointless.
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ? ` (${error.statusCode})` : '';
    return `Model call failed${status}: ${message.slice(0, 200)}`;
  }
  return 'Ingest failed';
}

function hashSource(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function uniqueSlugs(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function checkpointFrom(value: unknown, touchedPages: readonly string[]): IngestCheckpoint {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const planResult = ingestPlanSchema.safeParse(raw.plan);
  const reviewResult = ingestReviewSchema.safeParse(raw.review);
  const written = Array.isArray(raw.written_pages)
    ? raw.written_pages.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    ...(planResult.success ? { plan: normalizeIngestPlan(planResult.data as IngestPlan) } : {}),
    written_pages: uniqueSlugs([...touchedPages, ...written]),
    ...(reviewResult.success ? { review: reviewResult.data as IngestReview } : {}),
  };
}

async function loadJob(ctx: IngestContext): Promise<StoredJob> {
  const { data, error } = await ctx.supabase
    .from('ingest_jobs')
    .select('id, source_id, status, phase, touched_pages, checkpoint, attempt_count, source_sha256, result')
    .eq('id', ctx.jobId)
    .single();
  if (error) throw new Error(`ingest job lookup failed: ${error.message}`);
  if (!data) throw new Error(`Ingest job not found: ${ctx.jobId}`);
  return data as StoredJob;
}

async function updateJob(
  ctx: IngestContext,
  values: Record<string, unknown>,
  expectedStatuses: IngestStatus | readonly IngestStatus[] = 'running',
): Promise<void> {
  let query = ctx.supabase
    .from('ingest_jobs')
    .update(values)
    .eq('id', ctx.jobId)
    .eq('workspace_id', ctx.workspaceId)
    .eq('attempt_count', ctx.attemptToken);
  const statuses = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
  query = statuses.length === 1 ? query.eq('status', statuses[0]) : query.in('status', statuses);
  const { data, error } = await query.select('id').maybeSingle();
  if (error) throw new Error(`ingest job update failed: ${error.message}`);
  if (!data) throw new IngestLeaseLostError();
}

async function saveCheckpoint(
  ctx: IngestContext,
  phase: IngestPhase,
  checkpoint: IngestCheckpoint,
  status: IngestStatus = 'running',
): Promise<void> {
  await updateJob(ctx, {
    status,
    phase,
    checkpoint,
    touched_pages: checkpoint.written_pages,
  });
}

async function isPaused(ctx: IngestContext): Promise<boolean> {
  if (ctx.signal?.aborted) return true;
  return Boolean(await ctx.pauseRequested?.());
}

async function updateSourceHash(
  ctx: IngestContext,
  sourceId: string,
  sourceSha256: string,
): Promise<void> {
  const { error } = await ctx.supabase
    .from('sources')
    .update({
      content_sha256: sourceSha256,
      byte_size: Buffer.byteLength(ctx.sourceContent, 'utf8'),
    })
    .eq('id', sourceId)
    .eq('workspace_id', ctx.workspaceId);
  if (error) throw new Error(`source metadata update failed: ${error.message}`);
}

async function finishSource(ctx: IngestContext, sourceId: string): Promise<void> {
  const { error } = await ctx.supabase
    .from('sources')
    .update({ ingested_at: new Date().toISOString() })
    .eq('id', sourceId)
    .eq('workspace_id', ctx.workspaceId);
  if (error) throw new Error(`source completion update failed: ${error.message}`);
}

async function markPaused(
  ctx: IngestContext,
  phase: IngestPhase,
  checkpoint: IngestCheckpoint,
): Promise<string[]> {
  await saveCheckpoint(ctx, phase, checkpoint, 'paused');
  return checkpoint.written_pages;
}

async function markFailed(
  ctx: IngestContext,
  error: Error,
  checkpoint: IngestCheckpoint,
  phase: IngestPhase,
): Promise<void> {
  await updateJob(ctx, {
    phase,
    checkpoint,
    touched_pages: checkpoint.written_pages,
    status: 'failed',
    error: publicIngestError(error),
    finished_at: new Date().toISOString(),
  }, 'running');
}

function planInventory(
  pages: Array<{ slug: string; title: string | null; kind: string }>,
): string {
  return (
    pages.map((item) => `- ${item.slug} (${item.kind}) «${item.title ?? ''}»`).join('\n') ||
    '(no pages yet)'
  );
}

async function auditWrittenPages(
  ctx: IngestContext,
  sourceId: string,
  plan: IngestPlan,
  writtenPages: readonly string[],
): Promise<{ audit: IngestPageAudit[]; issues: string[] }> {
  const requested = uniqueSlugs([...plan.target_pages, ...writtenPages]);
  const { data, error } = await ctx.supabase
    .from('pages')
    .select('slug, drive_file_id')
    .eq('workspace_id', ctx.workspaceId)
    .in('slug', requested.map(normalizeWikiSlug));
  if (error) throw new Error(`ingest review page lookup failed: ${error.message}`);

  const rows = (data ?? []) as Array<{ slug: string; drive_file_id: string }>;
  const bySlug = new Map(rows.map((row) => [normalizeWikiSlug(row.slug).toLowerCase(), row]));
  const audit: IngestPageAudit[] = [];
  const issues: string[] = [];
  for (const requestedSlug of requested) {
    const slug = normalizeWikiSlug(requestedSlug);
    const row = bySlug.get(slug.toLowerCase());
    if (!row) {
      audit.push({ slug, exists: false, source_present: false, body_preview: '' });
      if (plan.target_pages.some((target) => normalizeWikiSlug(target).toLowerCase() === slug.toLowerCase())) {
        issues.push(`Missing planned page: ${slug}`);
      }
      continue;
    }

    const content = await readDriveFile(ctx.drive, row.drive_file_id);
    const sources = parseFrontmatter(content).frontmatter.sources;
    const sourcePresent = Array.isArray(sources)
      ? sources.some((value) => value === sourceId)
      : sources === sourceId;
    audit.push({
      slug: row.slug,
      exists: true,
      source_present: sourcePresent,
      body_preview: markdownBody(content).slice(0, 4_000),
    });
    if (!sourcePresent) issues.push(`Missing source in frontmatter: ${row.slug}`);
  }
  return { audit, issues };
}

/**
 * Two-stage, resumable source compilation. The job row is the checkpoint and
 * attemptToken fences every status/checkpoint write; each page write commits
 * independently so the next invocation resumes from the saved plan.
 */
export async function runIngestPipeline(ctx: IngestContext): Promise<string[]> {
  const job = await loadJob(ctx);
  const sourceId = ctx.sourceId ?? job.source_id;
  const sourceSha256 = hashSource(ctx.sourceContent);
  let checkpoint = checkpointFrom(job.checkpoint, job.touched_pages ?? []);

  if (job.attempt_count !== ctx.attemptToken) throw new IngestLeaseLostError();
  if (job.status === 'done') return checkpoint.written_pages;
  if (job.status !== 'running') throw new IngestLeaseLostError();

  await updateJob(ctx, {
    source_sha256: sourceSha256,
    error: null,
  });
  await updateSourceHash(ctx, sourceId, sourceSha256);

  let plan = checkpoint.plan;
  try {
    if (!plan) {
      if (await isPaused(ctx)) return markPaused(ctx, 'analysis', checkpoint);

      const model = createLLMClient(ctx.profile);
      const { data: indexPage, error: indexError } = await ctx.supabase
        .from('pages')
        .select('drive_file_id')
        .eq('workspace_id', ctx.workspaceId)
        .eq('slug', 'index.md')
        .maybeSingle();
      if (indexError) throw new Error(`index lookup failed: ${indexError.message}`);
      const indexContent = indexPage?.drive_file_id
        ? await readDriveFile(ctx.drive, indexPage.drive_file_id)
        : '(No index yet)';

      const { data: existingPages, error: pagesError } = await ctx.supabase
        .from('pages')
        .select('slug, title, kind')
        .eq('workspace_id', ctx.workspaceId)
        .eq('zone', 'wiki')
        .order('updated_at', { ascending: false })
        .limit(400);
      if (pagesError) throw new Error(`page inventory lookup failed: ${pagesError.message}`);

      plan = await generateIngestPlan(model, {
        systemPrompt: ctx.systemPrompt,
        sourceTitle: ctx.sourceTitle,
        sourceContent: ctx.sourceContent,
        indexContent,
        inventory: planInventory(
          (existingPages ?? []) as Array<{ slug: string; title: string | null; kind: string }>,
        ),
      });
      checkpoint = { ...checkpoint, plan, written_pages: uniqueSlugs(checkpoint.written_pages) };
      await saveCheckpoint(ctx, 'writing', checkpoint);
    }

    if (!plan) throw new Error('Ingest analysis produced no plan.');
    if (await isPaused(ctx)) return markPaused(ctx, 'writing', checkpoint);

    const model = createLLMClient(ctx.profile);
    const touched = new Set(checkpoint.written_pages);
    let wroteUpdatedPage = touched.size > 0;
    let pauseAfterStep = false;
    const tools = buildWikiTools({
      supabase: ctx.supabase,
      drive: ctx.drive,
      workspaceId: ctx.workspaceId,
      wikiFolderId: ctx.wikiFolderId,
      confirmDestructive: true,
      sourceId,
      ingestWriteOnly: true,
      writePageAllowlist: new Set(
        [...plan.target_pages, 'index.md', 'log.md'].map(normalizeWikiSlug),
      ),
    });
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: buildIngestWritePrompt(ctx.sourceTitle, ctx.sourceContent, plan, [...touched]),
      },
    ];
    let lastWriteError: unknown = null;

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) messages.push({ role: 'user', content: NUDGE_PROMPT });
      try {
        const result = await generateText({
          model,
          system: ctx.systemPrompt,
          messages,
          tools,
          stopWhen: stepCountIs(30),
          onStepFinish: async (step) => {
            let changed = false;
            for (const toolResult of step.toolResults ?? []) {
              if (toolResult.toolName !== 'writePage') continue;
              const output = toolResult.output as { ok?: boolean; slug?: string; result?: string };
              if (!output.ok || !output.slug) continue;
              if (!touched.has(output.slug)) changed = true;
              touched.add(output.slug);
              if (output.result !== 'unchanged') wroteUpdatedPage = true;
            }
            if (changed) {
              checkpoint = { ...checkpoint, plan, written_pages: [...touched] };
              await saveCheckpoint(ctx, 'writing', checkpoint);
            }
            if (await isPaused(ctx)) pauseAfterStep = true;
          },
        });
        messages.push(...result.response.messages);
        lastWriteError = null;
        if (touched.size > 0) break;
      } catch (error) {
        lastWriteError = error;
        if (attempt + 1 >= MAX_WRITE_ATTEMPTS) throw error;
      }
    }

    checkpoint = { ...checkpoint, plan, written_pages: [...touched] };
    if (pauseAfterStep || (await isPaused(ctx))) {
      return markPaused(ctx, 'writing', checkpoint);
    }
    if (lastWriteError && touched.size === 0) throw lastWriteError;
    if (touched.size === 0) {
      const error = new Error('The model wrote no pages for this source.');
      await markFailed(ctx, error, checkpoint, 'writing');
      throw error;
    }

    if (checkpoint.review) {
      // A retry after a crash may already have a review checkpoint. An incomplete
      // review is a failed ingest, never a path to a false done status.
      if (!checkpoint.review.complete) {
        const error = new Error(`Ingest review incomplete: ${checkpoint.review.issues.join('; ')}`);
        await markFailed(ctx, error, checkpoint, 'review');
        throw error;
      }
    } else {
      await saveCheckpoint(ctx, 'review', checkpoint);
      if (await isPaused(ctx)) return markPaused(ctx, 'review', checkpoint);
      const pageAudit = await auditWrittenPages(ctx, sourceId, plan, [...touched]);
      const review = await generateIngestReview(
        model,
        ctx.sourceTitle,
        plan,
        [...touched],
        pageAudit.audit,
      );
      checkpoint = {
        ...checkpoint,
        review: {
          ...review,
          missing_pages: uniqueSlugs([
            ...review.missing_pages,
            ...pageAudit.issues
              .filter((issue) => issue.startsWith('Missing planned page:'))
              .map((issue) => issue.replace('Missing planned page: ', '')),
          ]),
          issues: uniqueSlugs([...review.issues, ...pageAudit.issues]),
          complete: review.complete && pageAudit.issues.length === 0,
        },
      };
      await saveCheckpoint(ctx, 'review', checkpoint);
      const completedReview = checkpoint.review;
      if (!completedReview) throw new Error('Ingest review produced no result.');
      if (!completedReview.complete) {
        const error = new Error(`Ingest review incomplete: ${completedReview.issues.join('; ')}`);
        await markFailed(ctx, error, checkpoint, 'review');
        throw error;
      }
    }

    await finishSource(ctx, sourceId);
    const { error: logError } = await ctx.supabase.from('logs').insert({
      workspace_id: ctx.workspaceId,
      kind: 'ingest',
      summary: `Ingested "${ctx.sourceTitle}" — ${touched.size} pages updated`,
      payload: {
        source_id: sourceId,
        source_sha256: sourceSha256,
        touched_pages: [...touched],
        plan,
        review: checkpoint.review,
      },
    });
    if (logError) throw new Error(`ingest log insert failed: ${logError.message}`);

    await updateJob(ctx, {
      status: 'done',
      phase: 'done',
      checkpoint,
      touched_pages: [...touched],
      result: wroteUpdatedPage ? 'updated' : 'unchanged',
      finished_at: new Date().toISOString(),
      error: null,
    }, 'running');
    return [...touched];
  } catch (error) {
    // The caller owns final error presentation. Every database write above checks
    // its response, so a failed checkpoint can never be reported as successful.
    throw error;
  }
}
