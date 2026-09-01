import { createHash } from 'crypto';
import { NextRequest, NextResponse, after } from 'next/server';
import { z } from 'zod';
import { readDriveFile } from '@/lib/drive/client';
import { DriveReadError } from '@/lib/drive/errors';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';
import { runPendingIngestJob } from '@/lib/ai/ingest-job-runner';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveUiLocaleFromRequest } from '@/lib/i18n/ui-locale';

export const maxDuration = 300;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

type SourceRow = {
  id: string;
  workspace_id: string;
  title: string | null;
  drive_file_id: string | null;
  content_sha256: string | null;
  ingested_at: string | null;
};

type WorkspaceRow = {
  id: string;
  ingest_profile_id: string | null;
  default_profile_id: string | null;
};

type ProfileRow = { id: string };

function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function loadDefaultProfileId(supabase: SupabaseClient, ownerId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('llm_profiles')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('is_default', true)
    .maybeSingle();
  if (error) throw new Error(`default LLM profile lookup failed: ${error.message}`);
  return data?.id ?? null;
}

async function insertDoneJob(
  supabase: SupabaseClient,
  source: SourceRow,
  profileId: string,
  sourceSha256: string,
): Promise<{ id: string; status: string; result: string }> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('ingest_jobs')
    .insert({
      workspace_id: source.workspace_id,
      source_id: source.id,
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
    .select('id, status, result')
    .single();
  if (error || !data) throw new Error(`unchanged ingest job insert failed: ${error?.message ?? 'empty response'}`);
  return data as { id: string; status: string; result: string };
}

async function insertPendingJob(
  supabase: SupabaseClient,
  source: SourceRow,
  profileId: string,
  sourceSha256: string,
): Promise<{ id: string; status: string; result: string | null }> {
  const { data, error } = await supabase
    .from('ingest_jobs')
    .insert({
      workspace_id: source.workspace_id,
      source_id: source.id,
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
    .select('id, status, result')
    .single();
  if (error || !data) throw new Error(`ingest job insert failed: ${error?.message ?? 'empty response'}`);
  return data as { id: string; status: string; result: string | null };
}

function schedulePendingJob(jobId: string, ownerId: string, locale: string): void {
  after(async () => {
    try {
      await runPendingIngestJob({ jobId, ownerId, locale });
    } catch (error) {
      console.error('[reingest] unable to start pending job', { jobId, error });
    }
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const locale = resolveUiLocaleFromRequest(request);
  const { supabase, user } = await getRequestUser(request);
  if (!user) return errorResponse(401, 'UNAUTHORIZED', 'Unauthorized');

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return errorResponse(400, 'INVALID_SOURCE_ID', 'Invalid source id');
  }

  try {
    const { data: sourceData, error: sourceError } = await supabase
      .from('sources')
      .select('id, workspace_id, title, drive_file_id, content_sha256, ingested_at')
      .eq('id', id)
      .maybeSingle();
    if (sourceError) throw new Error(`source lookup failed: ${sourceError.message}`);
    const source = sourceData as SourceRow | null;
    if (!source) return errorResponse(404, 'SOURCE_NOT_FOUND', 'Source not found');

    const { data: workspaceData, error: workspaceError } = await supabase
      .from('workspaces')
      .select('id, ingest_profile_id, default_profile_id')
      .eq('id', source.workspace_id)
      .eq('owner_id', user.id)
      .maybeSingle();
    if (workspaceError) throw new Error(`workspace lookup failed: ${workspaceError.message}`);
    const workspace = workspaceData as WorkspaceRow | null;
    if (!workspace) return errorResponse(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
    if (!source.drive_file_id) return errorResponse(422, 'SOURCE_CONTENT_UNAVAILABLE', 'Source content is no longer available in Drive');

    const profileId =
      workspace.ingest_profile_id ??
      workspace.default_profile_id ??
      (await loadDefaultProfileId(supabase, user.id));
    if (!profileId) return errorResponse(422, 'LLM_PROFILE_REQUIRED', 'No LLM profile configured. Go to Settings to add one.');
    const { data: profile, error: profileError } = await supabase
      .from('llm_profiles')
      .select('id')
      .eq('id', profileId)
      .eq('owner_id', user.id)
      .maybeSingle();
    if (profileError) throw new Error(`LLM profile lookup failed: ${profileError.message}`);
    if (!(profile as ProfileRow | null)) return errorResponse(404, 'LLM_PROFILE_NOT_FOUND', 'LLM profile not found');

    let drive: Awaited<ReturnType<typeof createDriveClientForUser>>;
    try {
      drive = await createDriveClientForUser(user.id);
    } catch (error) {
      if (isGoogleDriveAuthError(error)) {
        return errorResponse(403, 'DRIVE_RECONNECT_REQUIRED', GOOGLE_DRIVE_REAUTH_MESSAGE);
      }
      throw error;
    }
    let sourceContent: string;
    try {
      sourceContent = await readDriveFile(drive, source.drive_file_id, {
        maxBytes: MAX_SOURCE_BYTES,
      });
    } catch (error) {
      console.error('[reingest] source snapshot read failed', { sourceId: source.id, error });
      if (error instanceof DriveReadError && error.code === 'DRIVE_FILE_TOO_LARGE') {
        return errorResponse(413, 'SOURCE_CONTENT_TOO_LARGE', 'Source content exceeds the 2 MiB limit');
      }
      return errorResponse(422, 'SOURCE_CONTENT_UNAVAILABLE', 'Source content is no longer available in Drive');
    }
    const sourceSha256 = hashContent(sourceContent);

    if (source.ingested_at && source.content_sha256 === sourceSha256) {
      const job = await insertDoneJob(supabase, source, profileId, sourceSha256);
      return NextResponse.json({ jobId: job.id, status: job.status, result: job.result }, { status: 202 });
    }

    const job = await insertPendingJob(supabase, source, profileId, sourceSha256);
    schedulePendingJob(job.id, user.id, locale);
    return NextResponse.json({ jobId: job.id, status: job.status, result: job.result }, { status: 202 });
  } catch (error) {
    console.error('[reingest] POST failed', { sourceId: id, error });
    return errorResponse(500, 'REINGEST_REQUEST_FAILED', 'Unable to start re-ingest job');
  }
}
