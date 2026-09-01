import { createHash } from 'crypto';
import { NextRequest, NextResponse, after } from 'next/server';
import { z } from 'zod';
import { generateText } from 'ai';
import { writeDriveFile, findFile } from '@/lib/drive/client';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';
import { createLLMClient } from '@/lib/ai/client';
import { routeToWorkspace } from '@/lib/ai/route-workspace';
import {
  runPendingIngestJob,
  trashIngestSourceFile,
} from '@/lib/ai/ingest-job-runner';
import {
  failureUpdate,
  INGEST_JOB_ERROR_CODES,
  isStaleRunning,
  transitionIngestJob,
} from '@/lib/ai/ingest-job-state';
import { resolveUiLocaleFromRequest } from '@/lib/i18n/ui-locale';
import { toPublicUrlFetchFailure, urlToMarkdown } from '@/lib/fetch/url-to-markdown';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  extractDocument,
  MAX_INPUT_BYTES,
  type ImageToDescribe,
} from '@/lib/ingest/document-parser';
import type { LLMProfile } from '@llm-wiki/shared-types';

export const maxDuration = 300;

const MAX_TEXT_LENGTH = 2 * 1024 * 1024;
const REQUEST_OVERHEAD_BYTES = 64 * 1024;
const MAX_JSON_REQUEST_BYTES = MAX_TEXT_LENGTH + REQUEST_OVERHEAD_BYTES;
const MAX_MULTIPART_REQUEST_BYTES = MAX_INPUT_BYTES + REQUEST_OVERHEAD_BYTES;
const STALE_JOB_MS = 8 * 60 * 1000;

const TargetFields = {
  workspace_id: z.string().uuid().optional(),
  auto_route: z.boolean().optional(),
  fallback_workspace_id: z.string().uuid().optional(),
  profile_id: z.string().uuid().nullish(),
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
});

export type MultipartIngestFields = {
  file: File;
  workspace_id?: string;
  fallback_workspace_id?: string;
  auto_route?: boolean;
  profile_id?: string;
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
  'id, workspace_id, source_id, status, phase, result, attempt_count, error, touched_pages, started_at, finished_at, updated_at';

type WorkspaceRow = {
  id: string;
  name: string;
  drive_folder_id: string;
  ingest_profile_id: string | null;
  default_profile_id: string | null;
};

type ProfileRow = {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_key_encrypted: string;
  extra_headers: Record<string, string>;
  extra_headers_encrypted?: string | null;
  owner_id: string;
};

type SourceRow = {
  id: string;
  workspace_id: string;
  title: string | null;
  ingested_at: string | null;
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
};

function buildImageDescriber(profile: ProfileRow) {
  const model = createLLMClient(profile as LLMProfile);
  return async (image: ImageToDescribe): Promise<string> => {
    const result = await generateText({
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Describe this image accurately in concise plain text for a personal knowledge wiki.',
            },
            {
              type: 'image',
              image: `data:${image.mime};base64,${Buffer.from(image.data).toString('base64')}`,
            },
          ],
        },
      ],
      abortSignal: image.signal,
    });
    const text = result.text.trim();
    if (!text) throw new Error('Image model returned no description');
    return text;
  };
}

function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
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

async function loadProfile(
  supabase: SupabaseClient,
  id: string,
  ownerId: string,
): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .from('llm_profiles')
    .select('id, name, base_url, model, api_key_encrypted, extra_headers, extra_headers_encrypted, owner_id')
    .eq('id', id)
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (error) throw new Error(`LLM profile lookup failed: ${error.message}`);
  return (data as ProfileRow | null) ?? null;
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

async function loadSourceByHash(
  supabase: SupabaseClient,
  workspaceId: string,
  sourceSha256: string,
  ingestedOnly = false,
): Promise<SourceRow | null> {
  let query = supabase
    .from('sources')
    .select('id, workspace_id, title, ingested_at')
    .eq('workspace_id', workspaceId)
    .eq('content_sha256', sourceSha256);
  if (ingestedOnly) query = query.not('ingested_at', 'is', null);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`source duplicate lookup failed: ${error.message}`);
  return (data as SourceRow | null) ?? null;
}

async function loadLatestSourceJob(
  supabase: SupabaseClient,
  sourceId: string,
): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from('ingest_jobs')
    .select(JOB_FIELDS)
    .eq('source_id', sourceId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`source job lookup failed: ${error.message}`);
  return (data as JobRow | null) ?? null;
}

async function insertDoneJob(
  supabase: SupabaseClient,
  workspaceId: string,
  sourceId: string,
  profileId: string | null,
  sourceSha256: string,
): Promise<JobRow> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('ingest_jobs')
    .insert({
      workspace_id: workspaceId,
      source_id: sourceId,
      profile_id: profileId,
      status: 'done',
      phase: 'done',
      result: 'unchanged',
      source_sha256: sourceSha256,
      checkpoint: { written_pages: [] },
      touched_pages: [],
      attempt_count: 0,
      started_at: now,
      finished_at: now,
    })
    .select(JOB_FIELDS)
    .single();
  if (error || !data) {
    throw new Error(`unchanged ingest job insert failed: ${error?.message ?? 'empty response'}`);
  }
  return data as JobRow;
}

async function insertPendingJob(
  supabase: SupabaseClient,
  workspaceId: string,
  sourceId: string,
  profileId: string,
  sourceSha256: string,
): Promise<JobRow> {
  const { data, error } = await supabase
    .from('ingest_jobs')
    .insert({
      workspace_id: workspaceId,
      source_id: sourceId,
      profile_id: profileId,
      status: 'pending',
      phase: 'analysis',
      result: null,
      source_sha256: sourceSha256,
      checkpoint: { written_pages: [] },
      touched_pages: [],
      attempt_count: 0,
      started_at: null,
      finished_at: null,
    })
    .select(JOB_FIELDS)
    .single();
  if (error || !data) throw new Error(`ingest job insert failed: ${error?.message ?? 'empty response'}`);
  return data as JobRow;
}

async function trashBestEffort(
  drive: Awaited<ReturnType<typeof createDriveClientForUser>>,
  fileId: string,
): Promise<void> {
  try {
    await trashIngestSourceFile(drive, fileId);
  } catch (error) {
    console.error('[ingest] failed to trash orphan source file', { fileId, error });
  }
}

function schedulePendingJob(jobId: string, ownerId: string, locale: string): void {
  after(async () => {
    try {
      await runPendingIngestJob({ jobId, ownerId, locale });
    } catch (error) {
      console.error('[ingest] unable to start pending job', { jobId, error });
    }
  });
}

function publicJob(job: JobRow) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    result: job.result,
    attempt_count: job.attempt_count,
    error: job.error,
    touched_pages: job.touched_pages ?? [],
    source_id: job.source_id,
    workspace_id: job.workspace_id,
    started_at: job.started_at,
    finished_at: job.finished_at,
    updated_at: job.updated_at,
  };
}

export async function POST(request: NextRequest) {
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

    let sourceContent: string;
    let sourceTitle: string;
    let sourceUrl: string | undefined;
    let sourceKind: 'url' | 'text' | 'file';
    let sourceMimeType: string;
    let sourceByteSize: number;
    let sourceMetadata: Record<string, unknown> | null = null;
    if (input.kind === 'file') {
      const file = input.file;
      const parserProfileId =
        overrideProfileId ??
        gateWorkspace.ingest_profile_id ??
        gateWorkspace.default_profile_id ??
        (await loadDefaultProfileId(supabase, user.id));
      if (!parserProfileId) {
        return errorResponse(422, 'LLM_PROFILE_REQUIRED', 'No LLM profile configured. Go to Settings to add one.');
      }
      const parserProfile = await loadProfile(supabase, parserProfileId, user.id);
      if (!parserProfile) return errorResponse(404, 'LLM_PROFILE_NOT_FOUND', 'LLM profile not found');
      const extracted = await extractDocument({
        filename: file.name,
        mime: file.type,
        data: new Uint8Array(await file.arrayBuffer()),
        describeImage: buildImageDescriber(parserProfile),
      });
      if (!extracted.ok) return errorResponse(422, `DOCUMENT_${extracted.error.code}`, extracted.error.message);
      if (extracted.text.includes('[Image description unavailable]')) {
        return errorResponse(422, 'IMAGE_DESCRIPTION_FAILED', 'The image could not be described.');
      }
      sourceContent = extracted.text;
      if (!sourceContent.trim()) return errorResponse(422, 'EMPTY_DOCUMENT', 'The document has no readable text.');
      sourceTitle = file.name.replace(/\.[^.]+$/, '') || file.name;
      sourceKind = 'file';
      sourceMimeType = file.type;
      sourceByteSize = file.size;
      sourceMetadata = {
        filename: file.name,
        mime: file.type,
        byte_size: file.size,
      };
    } else if (input.kind === 'url') {
      try {
        const article = await urlToMarkdown(input.url);
        sourceContent = article.markdown;
        sourceTitle = article.title;
        sourceUrl = input.url;
      } catch (error) {
        const failure = toPublicUrlFetchFailure(error);
        return errorResponse(
          failure.status,
          failure.code,
          failure.message,
        );
      }
      sourceKind = 'url';
      sourceMimeType = 'text/markdown';
      sourceByteSize = Buffer.byteLength(sourceContent, 'utf8');
    } else {
      sourceContent = input.content;
      sourceTitle = input.title;
      sourceKind = 'text';
      sourceMimeType = 'text/plain';
      sourceByteSize = Buffer.byteLength(sourceContent, 'utf8');
    }
    const sourceSha256 = hashContent(sourceContent);
    if (sourceMetadata) sourceMetadata = { ...sourceMetadata, content_sha256: sourceSha256 };

    let drive: Awaited<ReturnType<typeof createDriveClientForUser>> | null = null;
    let workspace: WorkspaceRow = gateWorkspace;
    let routedWorkspaceName: string | undefined;
    let routedWorkspaceCreated = false;

    if (autoRoute) {
      try {
        drive = await createDriveClientForUser(user.id);
      } catch (error) {
        if (isGoogleDriveAuthError(error)) {
          return errorResponse(403, 'DRIVE_RECONNECT_REQUIRED', GOOGLE_DRIVE_REAUTH_MESSAGE);
        }
        throw error;
      }
      const routingProfileId =
        overrideProfileId ??
        gateWorkspace.ingest_profile_id ??
        gateWorkspace.default_profile_id ??
        (await loadDefaultProfileId(supabase, user.id));
      if (!routingProfileId) {
        return errorResponse(422, 'LLM_PROFILE_REQUIRED', 'No LLM profile configured. Go to Settings to add one.');
      }
      const routingProfile = await loadProfile(supabase, routingProfileId, user.id);
      if (!routingProfile) return errorResponse(404, 'LLM_PROFILE_NOT_FOUND', 'LLM profile not found');
      const routing = await routeToWorkspace(
        supabase,
        drive,
        user.id,
        routingProfile as Parameters<typeof createLLMClient>[0],
        sourceTitle,
        sourceContent,
        gateWorkspace.id,
        locale,
      );
      const routed = await loadWorkspace(supabase, routing.workspaceId, user.id);
      if (!routed) return errorResponse(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
      workspace = routed;
      routedWorkspaceCreated = routing.created;
      if (routing.decided) routedWorkspaceName = workspace.name;
    }

    const profileId =
      overrideProfileId ??
      workspace.ingest_profile_id ??
      workspace.default_profile_id ??
      gateWorkspace.ingest_profile_id ??
      gateWorkspace.default_profile_id ??
      (await loadDefaultProfileId(supabase, user.id));
    const duplicate = await loadSourceByHash(supabase, workspace.id, sourceSha256, true);
    if (duplicate) {
      const job = await insertDoneJob(supabase, workspace.id, duplicate.id, profileId, sourceSha256);
      return NextResponse.json(
        {
          jobId: job.id,
          status: job.status,
          result: job.result,
          ...(routedWorkspaceName
            ? {
                routed_workspace_id: workspace.id,
                routed_workspace_name: routedWorkspaceName,
                routed_workspace_created: routedWorkspaceCreated,
              }
            : {}),
        },
        { status: 202 },
      );
    }

    if (!profileId) {
      return errorResponse(422, 'LLM_PROFILE_REQUIRED', 'No LLM profile configured. Go to Settings to add one.');
    }
    const profile = await loadProfile(supabase, profileId, user.id);
    if (!profile) return errorResponse(404, 'LLM_PROFILE_NOT_FOUND', 'LLM profile not found');

    if (!drive) {
      try {
        drive = await createDriveClientForUser(user.id);
      } catch (error) {
        if (isGoogleDriveAuthError(error)) {
          return errorResponse(403, 'DRIVE_RECONNECT_REQUIRED', GOOGLE_DRIVE_REAUTH_MESSAGE);
        }
        throw error;
      }
    }
    const sourcesFolderId = await findFile(
      drive,
      'sources',
      workspace.drive_folder_id,
      'application/vnd.google-apps.folder',
    );
    if (!sourcesFolderId) return errorResponse(500, 'DRIVE_SOURCES_FOLDER_NOT_FOUND', 'Drive sources folder not found');

    const sourceFileId = await writeDriveFile(drive, sourceContent, {
      name: `${Date.now()}.md`,
      parentId: sourcesFolderId,
    });
    const { data: insertedSource, error: sourceError } = await supabase
      .from('sources')
      .insert({
        workspace_id: workspace.id,
        kind: sourceKind,
        title: sourceTitle,
        url: sourceUrl ?? null,
        drive_file_id: sourceFileId,
        content_sha256: sourceSha256,
        mime_type: sourceMimeType,
        byte_size: sourceByteSize,
        metadata: sourceMetadata ?? {},
      })
      .select('id')
      .single();
    if (sourceError || !insertedSource) {
      await trashBestEffort(drive, sourceFileId);
      if (isUniqueViolation(sourceError)) {
        const racedSource = await loadSourceByHash(supabase, workspace.id, sourceSha256);
        if (racedSource?.ingested_at) {
          const job = await insertDoneJob(supabase, workspace.id, racedSource.id, profile.id, sourceSha256);
          return NextResponse.json({ jobId: job.id, status: job.status, result: job.result }, { status: 202 });
        }
        if (racedSource) {
          const existingJob = await loadLatestSourceJob(supabase, racedSource.id);
          if (existingJob && ['pending', 'running', 'paused'].includes(existingJob.status)) {
            return NextResponse.json(
              { jobId: existingJob.id, status: existingJob.status, result: existingJob.result },
              { status: 202 },
            );
          }
          const job = await insertPendingJob(supabase, workspace.id, racedSource.id, profile.id, sourceSha256);
          schedulePendingJob(job.id, user.id, locale);
          return NextResponse.json({ jobId: job.id, status: job.status, result: job.result }, { status: 202 });
        }
      }
      throw new Error(`source insert failed: ${sourceError?.message ?? 'empty response'}`);
    }
    const source = insertedSource as { id: string };

    let job: JobRow;
    try {
      job = await insertPendingJob(supabase, workspace.id, source.id, profile.id, sourceSha256);
    } catch (error) {
      await trashBestEffort(drive, sourceFileId);
      const { error: cleanupError } = await supabase
        .from('sources')
        .delete()
        .eq('id', source.id)
        .eq('workspace_id', workspace.id);
      if (cleanupError) console.error('[ingest] orphan source row cleanup failed', cleanupError);
      throw error;
    }

    schedulePendingJob(job.id, user.id, locale);
    return NextResponse.json(
      {
        jobId: job.id,
        status: job.status,
        result: job.result,
        ...(routedWorkspaceName
          ? {
              routed_workspace_id: workspace.id,
              routed_workspace_name: routedWorkspaceName,
              routed_workspace_created: routedWorkspaceCreated,
            }
          : {}),
      },
      { status: 202 },
    );
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

async function updateStaleJob(supabase: SupabaseClient, job: JobRow, ownerId: string): Promise<JobRow> {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - STALE_JOB_MS).toISOString();
  const { data, error } = await supabase
    .from('ingest_jobs')
    .update(failureUpdate('Ingest timed out', now))
    .eq('id', job.id)
    .eq('workspace_id', job.workspace_id)
    .eq('status', 'running')
    .lt('updated_at', cutoff)
    .select(JOB_FIELDS)
    .maybeSingle();
  if (error) throw new Error(`stale ingest job update failed: ${error.message}`);
  if (data) return data as JobRow;
  return (await loadJobForUser(supabase, job.id, ownerId)) ?? job;
}

export function findStaleRunningJobs<T extends Pick<JobRow, 'status' | 'updated_at'>>(
  jobs: readonly T[],
  now = Date.now(),
): T[] {
  return jobs.filter((job) => isStaleRunning(job.status, job.updated_at, now, STALE_JOB_MS));
}

async function sweepStaleJobs(
  supabase: SupabaseClient,
  workspaceIds: readonly string[],
  ownerId: string,
): Promise<void> {
  if (workspaceIds.length === 0) return;
  const cutoff = new Date(Date.now() - STALE_JOB_MS).toISOString();
  const { data, error } = await supabase
    .from('ingest_jobs')
    .select(JOB_FIELDS)
    .in('workspace_id', workspaceIds)
    .eq('status', 'running')
    .lt('updated_at', cutoff);
  if (error) throw new Error(`stale ingest jobs lookup failed: ${error.message}`);
  for (const job of findStaleRunningJobs((data ?? []) as JobRow[])) {
    await updateStaleJob(supabase, job, ownerId);
  }
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
      if (isStaleRunning(job.status, job.updated_at)) job = await updateStaleJob(supabase, job, user.id);
      if (job.status === 'pending') schedulePendingJob(job.id, user.id, locale);
      return NextResponse.json({ jobId: job.id, ...publicJob(job) });
    }

    const parsedWorkspaceId = z.string().uuid().safeParse(workspaceIdRaw);
    if (!parsedWorkspaceId.success) return errorResponse(400, 'INVALID_WORKSPACE_ID', 'Invalid workspace_id');
    const workspace = await loadWorkspace(supabase, parsedWorkspaceId.data, user.id);
    if (!workspace) return errorResponse(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
    const ownerScope = request.nextUrl.searchParams.get('scope') === 'owner';
    let workspaceIds = [workspace.id];
    if (ownerScope) {
      const { data, error } = await supabase
        .from('workspaces')
        .select('id')
        .eq('owner_id', user.id);
      if (error) throw new Error(`owned workspaces lookup failed: ${error.message}`);
      workspaceIds = (data ?? []).map((row) => row.id);
    }
    await sweepStaleJobs(supabase, workspaceIds, user.id);
    const { data: rows, error: jobsError } = await supabase
      .from('ingest_jobs')
      .select(JOB_FIELDS)
      .in('workspace_id', workspaceIds)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (jobsError) throw new Error(`workspace ingest jobs lookup failed: ${jobsError.message}`);
    const jobs = (rows ?? []) as JobRow[];
    const sourceIds = [...new Set(jobs.map((job) => job.source_id))];
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
          ...publicJob(job),
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
      values.error = null;
      values.finished_at = null;
    }
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
      { jobId: result.id, ...publicJob(result) },
      { status: parsed.data.action === 'pause' ? 200 : 202 },
    );
  } catch (error) {
    console.error('[ingest] PATCH failed', { error });
    return errorResponse(500, INGEST_JOB_ERROR_CODES.updateFailed, 'Unable to update ingest job');
  }
}
