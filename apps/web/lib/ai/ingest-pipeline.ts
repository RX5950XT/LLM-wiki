import { createHash } from 'crypto';
import { stepCountIs, streamText, type ModelMessage } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import { createLLMClient } from './client';
import { classifyIngestFailure } from './ingest-retry';
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

export { publicIngestError } from './ingest-retry';

const NUDGE_PROMPT =
  'No writePage call has completed yet. Continue the validated plan now; do not answer with prose.';

/**
 * The model regularly stops after a few pages and answers in prose, which the
 * review pass then rejects as incomplete. Name the pages it still owes.
 */
export function nudgeForRemaining(remaining: readonly string[]): string {
  if (remaining.length === 0) return NUDGE_PROMPT;
  return `These planned pages have no completed writePage call yet: ${remaining.join(', ')}. Write every one of them now with writePage; do not answer with prose.`;
}
// Bounded by the time budget too; a stalled provider call costs one attempt, not the run.
const MAX_WRITE_ATTEMPTS = 4;
const MAX_PAGE_WRITE_FAILURES = 3;
/**
 * Vercel kills the whole invocation at maxDuration = 300s, and a killed run
 * never writes its job row: the job sits in `running` until the 8-minute stale
 * sweep. Stop first, so the checkpoint is consistent and a retry resumes from it.
 */
const PIPELINE_BUDGET_MS = 210_000;
/**
 * The budget above is only checked between steps; a provider call that hangs
 * past it would still be killed by Vercel. This aborts any request in flight,
 * so the failure is recorded on the job and "retry" resumes from the checkpoint.
 */
const PIPELINE_HARD_STOP_MS = 260_000;

/** Failure text for a run that ran out of wall clock with pages still owed. */
export function budgetExhaustedError(written: number, planned: number): Error {
  return new Error(
    `Ingest ran out of time after ${written} of ${planned} planned pages. Retry to continue from here.`,
  );
}

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
  /**
   * When the Vercel invocation began. Vercel's 300s clock starts at the request,
   * not here: a POST that spent 150s routing left the pipeline too little time.
   */
  startedAt?: number;
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
    ...(Array.isArray(raw.skipped_pages)
      ? { skipped_pages: raw.skipped_pages.filter((item): item is string => typeof item === 'string') }
      : {}),
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

/** Real progress: the retry budget only counts runs that got nowhere. */
async function saveProgress(ctx: IngestContext, phase: IngestPhase, checkpoint: IngestCheckpoint): Promise<void> {
  await updateJob(ctx, {
    status: 'running',
    phase,
    checkpoint,
    touched_pages: checkpoint.written_pages,
    retry_count: 0,
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
  skippedPages: readonly string[] = [],
): Promise<{ audit: IngestPageAudit[]; issues: string[] }> {
  const skipped = new Set(skippedPages);
  const requested = uniqueSlugs([...plan.target_pages.filter((slug) => !skipped.has(slug)), ...writtenPages]);
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

const MAX_PRELOADED_PAGE_CHARS = 16_000;
const MAX_PRELOADED_TOTAL_CHARS = 80_000;

/**
 * Current content of the planned pages that already exist, so the model can rewrite
 * them without a readPage step each. Oversized or unreadable pages are left to readPage.
 */
async function loadCurrentPages(
  ctx: IngestContext,
  slugs: readonly string[],
): Promise<Array<{ slug: string; content: string }>> {
  if (slugs.length === 0) return [];
  const { data, error } = await ctx.supabase
    .from('pages')
    .select('slug, drive_file_id')
    .eq('workspace_id', ctx.workspaceId)
    .in('slug', [...slugs]);
  if (error) console.warn('[ingest] preload lookup failed', { error: error.message });
  if (error || !data) return [];
  const pages = await Promise.all(
    (data as Array<{ slug: string; drive_file_id: string | null }>)
      .filter((row) => row.drive_file_id)
      .map(async (row) => {
        try {
          return { slug: row.slug, content: await readDriveFile(ctx.drive, row.drive_file_id!) };
        } catch (readError) {
          console.warn('[ingest] preload read failed', { slug: row.slug, error: readError });
          return null;
        }
      }),
  );
  let total = 0;
  return pages.filter((page): page is { slug: string; content: string } => {
    if (!page || page.content.length > MAX_PRELOADED_PAGE_CHARS) return false;
    if (total + page.content.length > MAX_PRELOADED_TOTAL_CHARS) return false;
    total += page.content.length;
    return true;
  });
}

/**
 * Two-stage, resumable source compilation. The job row is the checkpoint and
 * attemptToken fences every status/checkpoint write; each page write commits
 * independently so the next invocation resumes from the saved plan.
 */
export async function runIngestPipeline(ctx: IngestContext): Promise<string[]> {
  const startedAt = ctx.startedAt ?? Date.now();
  const deadline = startedAt + PIPELINE_BUDGET_MS;
  const hardStop = AbortSignal.timeout(Math.max(0, startedAt + PIPELINE_HARD_STOP_MS - Date.now()));
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

      const model = createLLMClient(ctx.profile, { signal: hardStop });
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
      await saveProgress(ctx, 'writing', checkpoint);
    }

    if (!plan) throw new Error('Ingest analysis produced no plan.');
    if (await isPaused(ctx)) return markPaused(ctx, 'writing', checkpoint);

    const model = createLLMClient(ctx.profile, { signal: hardStop });
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
        content: buildIngestWritePrompt(
          ctx.sourceTitle,
          ctx.sourceContent,
          plan,
          [...touched],
          await loadCurrentPages(ctx, plan.target_pages.filter((slug) => !touched.has(slug))),
        ),
      },
    ];
    let lastWriteError: unknown = null;
    const toolStartedAt = new Map<string, number>();
    const plannedTargets = plan.target_pages;
    const skipped = new Set(checkpoint.skipped_pages ?? []);
    const writeFailures = new Map<string, number>();
    const writeErrors: string[] = [];
    let lastModelText = '';
    /** A page the model cannot write must not sink the other pages of the import. */
    const recordWriteFailure = (rawSlug: unknown, reason: string) => {
      writeErrors.push(`${String(rawSlug)}: ${reason}`.slice(0, 200));
      if (typeof rawSlug !== 'string') return;
      const slug = normalizeWikiSlug(rawSlug);
      if (!plannedTargets.includes(slug)) return;
      const failures = (writeFailures.get(slug) ?? 0) + 1;
      writeFailures.set(slug, failures);
      if (/locked by the user/i.test(reason) || failures >= MAX_PAGE_WRITE_FAILURES) skipped.add(slug);
    };
    const unwrittenTargets = () => plannedTargets.filter((slug) => !touched.has(slug) && !skipped.has(slug));
    // index.md / log.md are not plan targets, so a model that stopped after the targets left the
    // new pages unindexed and the import unlogged. Nudge for them too, but never fail the job on them.
    const unwrittenWrites = () => [
      ...unwrittenTargets(),
      ...['index.md', 'log.md'].filter((slug) => !touched.has(slug)),
    ];

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      // A review checkpoint means writing already finished; a retry only re-runs the review.
      if (Date.now() > deadline || checkpoint.review) break;
      if (attempt > 0) {
        messages.push({ role: 'user', content: nudgeForRemaining(unwrittenWrites()) });
      }
      try {
        // Streaming, not generateText: only a stream lets createLLMClient re-send a provider call that
        // sends nothing (a non-stream call that stalls burns 150s on one tiny step, then the budget).
        let streamError: unknown = null;
        const result = streamText({
          model,
          abortSignal: hardStop,
          onError: ({ error }) => {
            streamError = error;
          },
          // Record each page the moment its write commits: a model that writes 11 pages in one
          // step would otherwise lose the whole record if the invocation dies before the step ends.
          onChunk: async ({ chunk }) => {
            if (chunk.type === 'tool-call') toolStartedAt.set(chunk.toolCallId, Date.now());
            if (chunk.type === 'tool-result') {
              const tookMs = Date.now() - (toolStartedAt.get(chunk.toolCallId) ?? Date.now());
              if (tookMs > 15_000) console.warn('[ingest] slow tool', { jobId: ctx.jobId, tool: chunk.toolName, tookMs });
            }
            if (chunk.type !== 'tool-result' || chunk.toolName !== 'writePage') return;
            const output = chunk.output as { ok?: boolean; slug?: string; result?: string; error?: unknown };
            if (!output?.ok || !output.slug) {
              recordWriteFailure((chunk.input as { slug?: unknown } | undefined)?.slug, String(output?.error ?? 'write refused'));
              return;
            }
            if (output.result !== 'unchanged') wroteUpdatedPage = true;
            if (touched.has(output.slug)) return;
            touched.add(output.slug);
            checkpoint = { ...checkpoint, plan, written_pages: [...touched] };
            await saveProgress(ctx, 'writing', checkpoint);
          },
          system: ctx.systemPrompt,
          messages,
          tools,
          // Some models answer the write prompt in prose and never touch a tool: 4 such replies were
          // a whole failed import. Until every planned page is written, a tool call is mandatory.
          prepareStep: () => ({ toolChoice: unwrittenWrites().length > 0 ? 'required' : 'auto' }),
          stopWhen: [
            stepCountIs(30),
            () => Date.now() > deadline,
            () => pauseAfterStep,
            () => unwrittenWrites().length === 0,
          ],
          onStepFinish: async (step) => {
            if (step.text.trim()) lastModelText = step.text.trim().slice(0, 500);
            // A tool that threw arrives here, not in onChunk.
            for (const part of step.content) {
              if (part.type !== 'tool-error' || part.toolName !== 'writePage') continue;
              recordWriteFailure(
                (part.input as { slug?: unknown } | undefined)?.slug,
                part.error instanceof Error ? part.error.message : String(part.error),
              );
            }
            // Where a slow write spends its time (model vs. failing tools) — read it, don't guess.
            console.info('[ingest] step', {
              jobId: ctx.jobId,
              elapsedMs: PIPELINE_BUDGET_MS - (deadline - Date.now()),
              finishReason: step.finishReason,
              tools: (step.toolResults ?? []).map((r) => {
                const out = r.output as { ok?: boolean; slug?: string; error?: unknown };
                return `${r.toolName}:${out?.slug ?? ''}:${out?.ok === false ? `fail ${JSON.stringify(out.error ?? '').slice(0, 120)}` : 'ok'}`;
              }),
              outputTokens: step.usage.outputTokens,
            });
            if (await isPaused(ctx)) pauseAfterStep = true;
          },
        });
        // A stream aborted mid-response (request timeout) skips onError and leaves
        // `result.response` pending forever; consumeStream swallows it unless asked.
        await result.consumeStream({
          onError: (error) => {
            streamError = error;
          },
        });
        if (streamError) throw streamError;
        messages.push(...(await result.response).messages);
        lastWriteError = null;
        if (unwrittenWrites().length === 0) break;
      } catch (error) {
        console.warn('[ingest] write attempt failed', { jobId: ctx.jobId, attempt, error: error instanceof Error ? error.message : error });
        lastWriteError = error;
        // A newer attempt owns the job now; writing on would race it page by page.
        if (error instanceof IngestLeaseLostError || attempt + 1 >= MAX_WRITE_ATTEMPTS) throw error;
        // Out of quota or a bad model: another attempt in this run cannot help.
        if (classifyIngestFailure(error).kind !== 'transient') throw error;
      }
    }

    checkpoint = {
      ...checkpoint,
      plan,
      written_pages: [...touched],
      ...(skipped.size > 0 ? { skipped_pages: [...skipped] } : {}),
    };
    if (pauseAfterStep || (await isPaused(ctx))) {
      return markPaused(ctx, 'writing', checkpoint);
    }
    if (lastWriteError && touched.size === 0) throw lastWriteError;
    if (unwrittenTargets().length > 0 && Date.now() > deadline) {
      await saveCheckpoint(ctx, 'writing', checkpoint);
      throw budgetExhaustedError(touched.size, plannedTargets.length);
    }
    if (touched.size === 0) {
      // Vercel keeps logs for an hour on this plan; the reason must outlive that.
      await saveCheckpoint(ctx, 'writing', {
        ...checkpoint,
        diagnostics: { last_text: lastModelText, write_errors: writeErrors.slice(-5) },
      });
      throw new Error('The model wrote no pages for this source.');
    }
    if (skipped.size > 0) console.warn('[ingest] skipped pages', { jobId: ctx.jobId, skipped: [...skipped], writeErrors: writeErrors.slice(-5) });

    // A retry keeps a passed review; an incomplete one is re-checked (the pages may have
    // landed since), and still fails rather than reaching a false done status.
    if (!checkpoint.review?.complete) {
      await saveCheckpoint(ctx, 'review', checkpoint);
      if (await isPaused(ctx)) return markPaused(ctx, 'review', checkpoint);
      const pageAudit = await auditWrittenPages(ctx, sourceId, plan, [...touched], [...skipped]);
      // The verdict below comes from the audit. The model's opinion is a nice-to-have and must
      // not cost a finished import when the provider hiccups or the quota runs out right here.
      const review = await generateIngestReview(
        model,
        ctx.sourceTitle,
        plan,
        [...touched],
        pageAudit.audit,
      ).catch((error: unknown): IngestReview => {
        console.warn('[ingest] model review skipped', { jobId: ctx.jobId, error: error instanceof Error ? error.message : error });
        return { written_pages: [...touched], missing_pages: [], contradictions: [], issues: [], complete: true, summary: '' };
      });
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
          // Whether the pages landed is checked by code; the model's content quibbles are kept in
          // `issues` but must not fail an ingest whose every planned page exists with its source.
          complete: pageAudit.issues.length === 0,
        },
      };
      await saveCheckpoint(ctx, 'review', checkpoint);
      const completedReview = checkpoint.review;
      if (!completedReview) throw new Error('Ingest review produced no result.');
      if (!completedReview.complete) {
        throw new Error(`Ingest review incomplete: ${completedReview.issues.join('; ')}`);
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
