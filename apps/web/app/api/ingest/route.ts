import { NextRequest, NextResponse, after } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';
import {
  loadRunnableIngestJobs,
  recoverDeadIngestJobs,
  runPendingIngestJob,
} from '@/lib/ai/ingest-job-runner';
import {
  INGEST_JOB_ERROR_CODES,
  isDeadRunning,
  transitionIngestJob,
} from '@/lib/ai/ingest-job-state';
import { RUNNER_LEASE_MS } from '@/lib/ai/ingest-retry';
import { resolveUiLocaleFromRequest } from '@/lib/i18n/ui-locale';
import type { UiLocale } from '@llm-wiki/drive-schema';
import { localizeIngestError } from '@/lib/ai/ingest-error-i18n';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_INPUT_BYTES } from '@/lib/ingest/document-parser';

export const maxDuration = 300;

const MAX_TEXT_LENGTH = 2 * 1024 * 1024;
const INTAKE_STORE_HOLD_MS = 60_000;
const REQUEST_OVERHEAD_BYTES = 64 * 1024;
const MAX_JSON_REQUEST_BYTES = MAX_TEXT_LENGTH + REQUEST_OVERHEAD_BYTES;
const MAX_MULTIPART_REQUEST_BYTES = MAX_INPUT_BYTES + REQUEST_OVERHEAD_BYTES;
/** One user rarely has more; the rest start on the next poll or worker tick. */
const JOBS_STARTED_PER_POLL = 3;

const TargetFields = {
  workspace_id: z.string().uuid().optional(),
  auto_route: z.boolean().optional(),
  fallback_workspace_id: z.string().uuid().optional(),
  profile_id: z.string().uuid().nullish(),
  /** Same id = same job, so a client re-sending after a lost response cannot import twice. */
  client_request_id: z.string().uuid().optional(),
};

const IngestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    url: z.string().url().max(2048),
    ...TargetFields,
  }),
  z.object({
    kind: z.literal('text'),
    title: z.string().min(1).max(300),
    content: z.string().min(1).max(MAX_TEXT_LENGTH),
    ...TargetFields,
  }),
]);

const JobActionSchema = z.object({
  job_id: z.unknown().optional(),
  action: z.enum(['pause', 'resume', 'retry']),
});

const MultipartFieldsSchema = z.object({
  workspace_id: z.string().uuid().optional(),
  fallback_workspace_id: z.string().uuid().optional(),
  auto_route: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
  profile_id: z.string().uuid().optional(),
  client_request_id: z.string().uuid().optional(),
});

export type MultipartIngestFields = {
  file: File;
  workspace_id?: string;
  fallback_workspace_id?: string;
  auto_route?: boolean;
  profile_id?: string;
  client_request_id?: string;
};

export type IngestRequestBodyKind = 'json' | 'multipart';

export type ContentLengthCheck =
  | { ok: true; bytes: number }
  | { ok: false; status: 400 | 411 | 413; code: string; message: string };

/** Check the declared body size before Next.js parses and buffers the request. */
export function checkIngestContentLength(
  headers: Pick<Headers, 'get'>,
  kind: IngestRequestBodyKind,
): ContentLengthCheck {
  const raw = headers.get('content-length');
  if (raw === null || raw.trim() === '') {
    return { ok: false, status: 411, code: 'CONTENT_LENGTH_REQUIRED', message: 'Content-Length header is required' };
  }
  if (!/^\d+$/.test(raw.trim())) {
    return { ok: false, status: 400, code: 'INVALID_CONTENT_LENGTH', message: 'Invalid Content-Length header' };
  }
  const bytes = Number(raw.trim());
  if (!Number.isSafeInteger(bytes)) {
    return { ok: false, status: 400, code: 'INVALID_CONTENT_LENGTH', message: 'Invalid Content-Length header' };
  }
  const maxBytes = kind === 'multipart' ? MAX_MULTIPART_REQUEST_BYTES : MAX_JSON_REQUEST_BYTES;
  if (bytes > maxBytes) {
    return { ok: false, status: 413, code: 'INGEST_REQUEST_TOO_LARGE', message: 'Ingest request is too large' };
  }
  return { ok: true, bytes };
}

export function parseMultipartIngestFields(
  formData: FormData,
): { ok: true; data: MultipartIngestFields } | { ok: false; message: string } {
  const file = formData.get('file');
  if (!(file instanceof File)) return { ok: false, message: 'file is required' };
  if (file.size > MAX_INPUT_BYTES) return { ok: false, message: 'file is too large' };
  const parsed = MultipartFieldsSchema.safeParse({
    workspace_id: formData.get('workspace_id') || undefined,
    fallback_workspace_id: formData.get('fallback_workspace_id') || undefined,
    auto_route: formData.get('auto_route') || undefined,
    profile_id: formData.get('profile_id') || undefined,
    client_request_id: formData.get('client_request_id') || undefined,
  });
  if (!parsed.success) return { ok: false, message: 'invalid multipart ingest fields' };
  return { ok: true, data: { file, ...parsed.data } };
}

type IngestJobAction = z.infer<typeof JobActionSchema>['action'];

export function parseIngestJobAction(
  body: unknown,
  queryJobId?: string | null,
):
  | { ok: true; data: { jobId: string; action: IngestJobAction } }
  | { ok: false; code: string; message: string } {
  const parsed = JobActionSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, code: INGEST_JOB_ERROR_CODES.invalidAction, message: 'Invalid job action' };
  }
  const jobId = parsed.data.job_id === undefined ? queryJobId : parsed.data.job_id;
  const parsedJobId = z.string().uuid().safeParse(jobId);
  if (!parsedJobId.success) return { ok: false, code: 'INVALID_JOB_ID', message: 'Invalid job_id' };
  return { ok: true, data: { jobId: parsedJobId.data, action: parsed.data.action } };
}

const JOB_FIELDS =
  'id, workspace_id, source_id, status, phase, result, attempt_count, error, touched_pages, started_at, finished_at, updated_at, next_attempt_at, wait_reason, retry_count';

type WorkspaceRow = {
  id: string;
  name: string;
  drive_folder_id: string;
  ingest_profile_id: string | null;
  default_profile_id: string | null;
};

type JobRow = {
  id: string;
  workspace_id: string;
  source_id: string;
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed';
  phase: string;
  result: 'updated' | 'unchanged' | null;
  attempt_count: number;
  error: string | null;
  touched_pages: string[] | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string | null;
  next_attempt_at: string | null;
  wait_reason: 'usage_limit' | 'retry' | 'continue' | null;
  retry_count: number;
};

function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23505';
}

async function loadWorkspace(
  supabase: SupabaseClient,
  id: string,
  ownerId: string,
): Promise<WorkspaceRow | null> {
  const { data, error } = await supabase
    .from('workspaces')
    .select('id, name, drive_folder_id, ingest_profile_id, default_profile_id')
    .eq('id', id)
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (error) throw new Error(`workspace lookup failed: ${error.message}`);
  return (data as WorkspaceRow | null) ?? null;
}

async function loadDefaultProfileId(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('llm_profiles')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('is_default', true)
    .maybeSingle();
  if (error) throw new Error(`default LLM profile lookup failed: ${error.message}`);
  return data?.id ?? null;
}

function schedulePendingJob(jobId: string, ownerId: string, locale: string, startedAt?: number): void {
  after(async () => {
    try {
      await runPendingIngestJob({ jobId, ownerId, locale, startedAt });
    } catch (error) {
      console.error('[ingest] unable to start pending job', { jobId, error });
    }
  });
}

function publicJob(job: JobRow, locale: UiLocale, workspaceName?: string) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    result: job.result,
    attempt_count: job.attempt_count,
    error: localizeIngestError(job.error, locale),
    touched_pages: job.touched_pages ?? [],
    source_id: job.source_id,
    workspace_id: job.workspace_id,
    ...(workspaceName ? { workspace_name: workspaceName } : {}),
    started_at: job.started_at,
    finished_at: job.finished_at,
    updated_at: job.updated_at,
    next_attempt_at: job.next_attempt_at,
    wait_reason: job.wait_reason,
    retry_count: job.retry_count,
  };
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const locale = resolveUiLocaleFromRequest(request);
  const { supabase, user } = await getRequestUser(request);
  if (!user) return errorResponse(401, 'UNAUTHORIZED', 'Unauthorized');

  try {
    const isMultipart = request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data') ?? false;
    const contentLength = checkIngestContentLength(request.headers, isMultipart ? 'multipart' : 'json');
    if (!contentLength.ok) {
      return errorResponse(contentLength.status, contentLength.code, contentLength.message);
    }
    const multipart = isMultipart
      ? parseMultipartIngestFields(await request.formData().catch(() => new FormData()))
      : null;
    if (isMultipart && (!multipart || !multipart.ok)) {
      return errorResponse(400, 'INVALID_MULTIPART_INGEST', multipart?.message ?? 'Invalid multipart ingest request');
    }
    const body = isMultipart ? null : await request.json().catch(() => null);
    const parsed = isMultipart ? null : IngestSchema.safeParse(body);
    if (!isMultipart && (!parsed || !parsed.success)) {
      return errorResponse(400, 'INVALID_INGEST_REQUEST', 'Invalid ingest request');
    }

    const multipartData = multipart?.ok ? multipart.data : null;
    const jsonData = parsed?.success ? parsed.data : null;
    const input = multipartData ? { kind: 'file' as const, ...multipartData } : jsonData!;
    const autoRoute = input.auto_route === true;
    const explicitWorkspaceId = input.workspace_id ?? null;
    const fallbackWorkspaceId = input.fallback_workspace_id ?? explicitWorkspaceId;
    if (!autoRoute && !explicitWorkspaceId) {
      return errorResponse(400, 'WORKSPACE_REQUIRED', 'workspace_id required');
    }
    if (autoRoute && !fallbackWorkspaceId) {
      return errorResponse(400, 'FALLBACK_WORKSPACE_REQUIRED', 'fallback_workspace_id required with auto_route');
    }

    const gateWorkspace = await loadWorkspace(supabase, fallbackWorkspaceId ?? explicitWorkspaceId!, user.id);
    if (!gateWorkspace) return errorResponse(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found');

    let overrideProfileId: string | null = null;
    if (input.profile_id) {
      const { data, error } = await supabase
        .from('llm_profiles')
        .select('id')
        .eq('id', input.profile_id)
        .eq('owner_id', user.id)
        .maybeSingle();
      if (error) throw new Error(`profile override lookup failed: ${error.message}`);
      overrideProfileId = data?.id ?? null;
    }

    // Only what the user alone can fix is answered here; the reconnect flow depends on this 403.
    const hasProfile =
      overrideProfileId ??
      gateWorkspace.ingest_profile_id ??
      gateWorkspace.default_profile_id ??
      (await loadDefaultProfileId(supabase, user.id));
    if (!hasProfile) {
      return errorResponse(422, 'LLM_PROFILE_REQUIRED', 'No LLM profile configured. Go to Settings to add one.');
    }
    try {
      await createDriveClientForUser(user.id);
    } catch (error) {
      if (isGoogleDriveAuthError(error)) {
        return errorResponse(403, 'DRIVE_RECONNECT_REQUIRED', GOOGLE_DRIVE_REAUTH_MESSAGE);
      }
      throw error;
    }

    const started = (job: Pick<JobRow, 'id' | 'status' | 'result'>) =>
      NextResponse.json({ jobId: job.id, status: job.status, result: job.result }, { status: 202 });
    const clientRequestId = input.client_request_id ?? null;
    const findExisting = async (): Promise<JobRow | null> => {
      if (!clientRequestId) return null;
      const { data, error } = await supabase
        .from('ingest_jobs')
        .select(JOB_FIELDS)
        .eq('client_request_id', clientRequestId)
        .maybeSingle();
      if (error) throw new Error(`ingest request lookup failed: ${error.message}`);
      return (data as JobRow | null) ?? null;
    };
    const replay = await findExisting();
    if (replay) return started(replay);

    // Everything slow (fetching the URL, parsing, routing, Drive) happens after the response. The
    // request is durable from here on: closing the app or the tab cannot lose it any more.
    const placeholder =
      input.kind === 'file'
        ? { kind: 'file', title: input.file.name.replace(/\.[^.]+$/, '') || input.file.name, url: null, mime_type: input.file.type }
        : input.kind === 'url'
          ? { kind: 'url', title: input.url, url: input.url, mime_type: 'text/markdown' }
          : { kind: 'text', title: input.title, url: null, mime_type: 'text/plain' };
    const { data: sourceRow, error: sourceError } = await supabase
      .from('sources')
      .insert({ workspace_id: gateWorkspace.id, ...placeholder })
      .select('id')
      .single();
    if (sourceError || !sourceRow) throw new Error(`source insert failed: ${sourceError?.message ?? 'empty response'}`);
    const sourceId = (sourceRow as { id: string }).id;
    const dropSource = async () => {
      const { error } = await supabase.from('sources').delete().eq('id', sourceId);
      if (error) console.error('[ingest] placeholder source cleanup failed', { sourceId, error: error.message });
    };

    const { data: jobRow, error: jobError } = await supabase
      .from('ingest_jobs')
      .insert({
        workspace_id: gateWorkspace.id,
        source_id: sourceId,
        profile_id: overrideProfileId,
        status: 'pending',
        phase: 'intake',
        checkpoint: { written_pages: [] },
        touched_pages: [],
        attempt_count: 0,
        client_request_id: clientRequestId,
        // Any polling client or the cron may start a due job, and a 2 MB intake takes
        // about a second to store. Not due until its content is really there.
        next_attempt_at: new Date(Date.now() + INTAKE_STORE_HOLD_MS).toISOString(),
      })
      .select(JOB_FIELDS)
      .single();
    if (jobError || !jobRow) {
      await dropSource();
      if (isUniqueViolation(jobError)) {
        const raced = await findExisting();
        if (raced) return started(raced);
      }
      throw new Error(`ingest job insert failed: ${jobError?.message ?? 'empty response'}`);
    }
    const job = jobRow as JobRow;

    const { error: intakeError } = await createAdminClient()
      .from('ingest_intakes')
      .insert({
        job_id: job.id,
        kind: input.kind,
        auto_route: autoRoute,
        locale,
        ...(input.kind === 'file'
          ? {
              filename: input.file.name,
              mime: input.file.type,
              file_base64: Buffer.from(await input.file.arrayBuffer()).toString('base64'),
            }
          : input.kind === 'url'
            ? { url: input.url }
            : { title: input.title, content: input.content }),
      });
    if (intakeError) {
      await dropSource(); // the job cascades with it
      throw new Error(`ingest intake insert failed: ${intakeError.message}`);
    }
    const { error: releaseError } = await supabase
      .from('ingest_jobs')
      .update({ next_attempt_at: null })
      .eq('id', job.id);
    if (releaseError) {
      await dropSource();
      throw new Error(`ingest job release failed: ${releaseError.message}`);
    }

    schedulePendingJob(job.id, user.id, locale, startedAt);
    return started(job);
  } catch (error) {
    console.error('[ingest] POST failed', { error });
    return errorResponse(500, 'INGEST_REQUEST_FAILED', 'Unable to start ingest job');
  }
}

async function loadJobForUser(
  supabase: SupabaseClient,
  jobId: string,
  ownerId: string,
): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from('ingest_jobs')
    .select(JOB_FIELDS)
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw new Error(`ingest job lookup failed: ${error.message}`);
  const job = (data as JobRow | null) ?? null;
  if (!job) return null;
  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .select('id')
    .eq('id', job.workspace_id)
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (workspaceError) throw new Error(`ingest job owner lookup failed: ${workspaceError.message}`);
  return workspace ? job : null;
}

export async function GET(request: NextRequest) {
  const locale = resolveUiLocaleFromRequest(request);
  const { supabase, user } = await getRequestUser(request);
  if (!user) return errorResponse(401, 'UNAUTHORIZED', 'Unauthorized');
  try {
    const jobIdRaw = request.nextUrl.searchParams.get('job_id');
    const workspaceIdRaw = request.nextUrl.searchParams.get('workspace_id');
    if (!jobIdRaw && !workspaceIdRaw) {
      return errorResponse(400, 'INGEST_QUERY_REQUIRED', 'job_id or workspace_id required');
    }

    if (jobIdRaw) {
      const parsedJobId = z.string().uuid().safeParse(jobIdRaw);
      if (!parsedJobId.success) return errorResponse(400, 'INVALID_JOB_ID', 'Invalid job_id');
      let job = await loadJobForUser(supabase, parsedJobId.data, user.id);
      if (!job) return errorResponse(404, INGEST_JOB_ERROR_CODES.notFound, 'Job not found');
      if (isDeadRunning(job.status, job.started_at, Date.now(), RUNNER_LEASE_MS)) {
        await recoverDeadIngestJobs(supabase, [job.workspace_id]);
        job = (await loadJobForUser(supabase, job.id, user.id)) ?? job;
      }
      if (job.status === 'pending') schedulePendingJob(job.id, user.id, locale);
      return NextResponse.json({ jobId: job.id, ...publicJob(job, locale) });
    }

    const parsedWorkspaceId = z.string().uuid().safeParse(workspaceIdRaw);
    if (!parsedWorkspaceId.success) return errorResponse(400, 'INVALID_WORKSPACE_ID', 'Invalid workspace_id');
    const workspace = await loadWorkspace(supabase, parsedWorkspaceId.data, user.id);
    if (!workspace) return errorResponse(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
    const ownerScope = request.nextUrl.searchParams.get('scope') === 'owner';
    const { data: owned, error: ownedError } = await supabase
      .from('workspaces')
      .select('id, name')
      .eq('owner_id', user.id);
    if (ownedError) throw new Error(`owned workspaces lookup failed: ${ownedError.message}`);
    const workspaceNames = new Map((owned ?? []).map((row) => [row.id as string, row.name as string]));
    const ownedIds = [...workspaceNames.keys()];
    const workspaceIds = ownerScope ? ownedIds : [workspace.id];

    // A client watching is one of two things keeping the queue moving; pg_cron is the other.
    await recoverDeadIngestJobs(supabase, ownedIds);
    for (const runnable of await loadRunnableIngestJobs(supabase, JOBS_STARTED_PER_POLL, ownedIds)) {
      schedulePendingJob(runnable.id, user.id, locale);
    }

    const { data: rows, error: jobsError } = await supabase
      .from('ingest_jobs')
      .select(JOB_FIELDS)
      .in('workspace_id', workspaceIds)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (jobsError) throw new Error(`workspace ingest jobs lookup failed: ${jobsError.message}`);
    const jobs = (rows ?? []) as JobRow[];
    const sourceIds =[...new Set(jobs.map((job) => job.source_id))];
    const sourceMap = new Map<string, { id: string; title: string | null; mime_type: string | null }>();
    if (sourceIds.length > 0) {
      const { data: sources, error: sourcesError } = await supabase
        .from('sources')
        .select('id, title, mime_type')
        .in('id', sourceIds)
        .in('workspace_id', workspaceIds);
      if (sourcesError) throw new Error(`workspace source lookup failed: ${sourcesError.message}`);
      for (const source of sources ?? []) {
        sourceMap.set(source.id, source as { id: string; title: string | null; mime_type: string | null });
      }
    }
    return NextResponse.json({
      workspace_id: workspace.id,
      jobs: jobs.map((job) => {
        const source = sourceMap.get(job.source_id) ?? null;
        return {
          ...publicJob(job, locale, workspaceNames.get(job.workspace_id)),
          source,
          source_title: source?.title ?? null,
          source_mime_type: source?.mime_type ?? null,
        };
      }),
    });
  } catch (error) {
    console.error('[ingest] GET failed', { error });
    return errorResponse(500, INGEST_JOB_ERROR_CODES.lookupFailed, 'Unable to load ingest jobs');
  }
}

export async function PATCH(request: NextRequest) {
  const locale = resolveUiLocaleFromRequest(request);
  const { supabase, user } = await getRequestUser(request);
  if (!user) return errorResponse(401, 'UNAUTHORIZED', 'Unauthorized');
  try {
    const contentLength = checkIngestContentLength(request.headers, 'json');
    if (!contentLength.ok) {
      return errorResponse(contentLength.status, contentLength.code, contentLength.message);
    }
    const body = await request.json().catch(() => null);
    const parsed = parseIngestJobAction(body, request.nextUrl.searchParams.get('job_id'));
    if (!parsed.ok) return errorResponse(400, parsed.code, parsed.message);
    const job = await loadJobForUser(supabase, parsed.data.jobId, user.id);
    if (!job) return errorResponse(404, INGEST_JOB_ERROR_CODES.notFound, 'Job not found');
    const transition = transitionIngestJob(job.status, parsed.data.action);
    if (!transition.ok) {
      return errorResponse(409, transition.code, 'Job state does not allow this action');
    }

    const values: Record<string, unknown> = { status: transition.status };
    if (parsed.data.action === 'resume' || parsed.data.action === 'retry') {
      // finished_at stays: it tells the claim that the previous runner has stopped.
      values.error = null;
      values.next_attempt_at = null;
      values.wait_reason = null;
    }
    if (parsed.data.action === 'retry') values.retry_count = 0;
    const { data: updated, error } = await supabase
      .from('ingest_jobs')
      .update(values)
      .eq('id', job.id)
      .eq('status', job.status)
      .select(JOB_FIELDS)
      .maybeSingle();
    if (error) throw new Error(`ingest job state update failed: ${error.message}`);
    if (!updated) {
      return errorResponse(409, INGEST_JOB_ERROR_CODES.invalidTransition, 'Job state changed; retry the action');
    }

    const result = updated as JobRow;
    if (parsed.data.action === 'resume' || parsed.data.action === 'retry') {
      schedulePendingJob(result.id, user.id, locale);
    }
    return NextResponse.json(
      { jobId: result.id, ...publicJob(result, locale) },
      { status: parsed.data.action === 'pause' ? 200 : 202 },
    );
  } catch (error) {
    console.error('[ingest] PATCH failed', { error });
    return errorResponse(500, INGEST_JOB_ERROR_CODES.updateFailed, 'Unable to update ingest job');
  }
}
