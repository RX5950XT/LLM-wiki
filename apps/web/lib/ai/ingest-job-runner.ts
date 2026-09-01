import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import type { IngestStatus, LLMProfile } from '@llm-wiki/shared-types';
import { getDefaultPrompt } from '@llm-wiki/prompts';
import { findFile, readDriveFile } from '@/lib/drive/client';
import {
  createDriveClientForUser,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  IngestLeaseLostError,
  publicIngestError,
  runIngestPipeline,
} from './ingest-pipeline';
import {
  failureUpdate,
  nextAttemptCount,
} from './ingest-job-state';

const JOB_FIELDS =
  'id, workspace_id, source_id, profile_id, status, phase, checkpoint, touched_pages, attempt_count';
// Keep background source snapshots bounded to the same 2 MiB contract as uploads.
export const MAX_SOURCE_SNAPSHOT_BYTES = 2 * 1024 * 1024;

type JobRow = {
  id: string;
  workspace_id: string;
  source_id: string;
  profile_id: string | null;
  status: IngestStatus;
  phase: string;
  checkpoint: unknown;
  touched_pages: string[] | null;
  attempt_count: number;
};

type WorkspaceRow = {
  id: string;
  name: string;
  drive_folder_id: string;
  ingest_profile_id: string | null;
  default_profile_id: string | null;
};

type SourceRow = {
  id: string;
  workspace_id: string;
  title: string | null;
  drive_file_id: string | null;
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

export interface IngestRunnerDependencies {
  supabase?: SupabaseClient;
  createDrive?: typeof createDriveClientForUser;
  findDriveFile?: typeof findFile;
  readDrive?: typeof readDriveFile;
  runPipeline?: typeof runIngestPipeline;
}

export interface RunPendingIngestJobOptions {
  jobId: string;
  ownerId: string;
  locale?: string | null;
  dependencies?: IngestRunnerDependencies;
}

export interface ClaimPendingResult {
  claimed: boolean;
  reason: 'claimed' | 'not_pending' | 'workspace_busy';
  attemptCount?: number;
}

export interface RunPendingResult {
  claimed: boolean;
  status: IngestStatus | 'not_found';
  reason: ClaimPendingResult['reason'] | 'not_found';
}

function databaseError(operation: string, error: { message: string }): Error {
  return new Error(`${operation}: ${error.message}`);
}

function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23505';
}

/** Atomically claim one pending row. A competing workspace run leaves it pending. */
export async function claimPendingIngestJob(
  supabase: SupabaseClient,
  jobId: string,
  expectedAttemptCount: number,
): Promise<ClaimPendingResult> {
  const { data, error } = await supabase
    .from('ingest_jobs')
    .update({
      status: 'running',
      attempt_count: nextAttemptCount(expectedAttemptCount),
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
    })
    .eq('id', jobId)
    .eq('status', 'pending')
    .eq('attempt_count', expectedAttemptCount)
    .select('id, attempt_count')
    .maybeSingle();

  if (error) {
    if (isUniqueViolation(error)) return { claimed: false, reason: 'workspace_busy' };
    throw databaseError('ingest job claim failed', error);
  }
  return data
    ? { claimed: true, reason: 'claimed', attemptCount: Number(data.attempt_count) }
    : { claimed: false, reason: 'not_pending' };
}

async function loadJob(
  supabase: SupabaseClient,
  jobId: string,
): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from('ingest_jobs')
    .select(JOB_FIELDS)
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw databaseError('ingest job lookup failed', error);
  return (data as JobRow | null) ?? null;
}

async function loadWorkspace(
  supabase: SupabaseClient,
  workspaceId: string,
  ownerId: string,
): Promise<WorkspaceRow | null> {
  const { data, error } = await supabase
    .from('workspaces')
    .select('id, name, drive_folder_id, ingest_profile_id, default_profile_id')
    .eq('id', workspaceId)
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (error) throw databaseError('workspace lookup failed', error);
  return (data as WorkspaceRow | null) ?? null;
}

async function loadSource(
  supabase: SupabaseClient,
  sourceId: string,
  workspaceId: string,
): Promise<SourceRow | null> {
  const { data, error } = await supabase
    .from('sources')
    .select('id, workspace_id, title, drive_file_id')
    .eq('id', sourceId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw databaseError('source lookup failed', error);
  return (data as SourceRow | null) ?? null;
}

async function loadProfile(
  supabase: SupabaseClient,
  profileId: string,
  ownerId: string,
): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .from('llm_profiles')
    .select('id, name, base_url, model, api_key_encrypted, extra_headers, extra_headers_encrypted, owner_id')
    .eq('id', profileId)
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (error) throw databaseError('LLM profile lookup failed', error);
  return (data as ProfileRow | null) ?? null;
}

async function resolveProfile(
  supabase: SupabaseClient,
  job: JobRow,
  workspace: WorkspaceRow,
  ownerId: string,
): Promise<ProfileRow> {
  const profileId =
    job.profile_id ??
    workspace.ingest_profile_id ??
    workspace.default_profile_id;
  let resolvedId = profileId;
  if (!resolvedId) {
    const { data, error } = await supabase
      .from('llm_profiles')
      .select('id')
      .eq('owner_id', ownerId)
      .eq('is_default', true)
      .maybeSingle();
    if (error) throw databaseError('default LLM profile lookup failed', error);
    resolvedId = data?.id ?? null;
  }
  if (!resolvedId) throw new Error('No LLM profile configured. Go to Settings to add one.');
  const profile = await loadProfile(supabase, resolvedId, ownerId);
  if (!profile) throw new Error('LLM profile not found');
  return profile;
}

export async function markFailedIfActive(
  supabase: SupabaseClient,
  jobId: string,
  workspaceId: string,
  attemptToken: number,
  reason: unknown,
): Promise<void> {
  const { error, data } = await supabase
    .from('ingest_jobs')
    .update(failureUpdate(publicIngestError(reason), new Date().toISOString()))
    .eq('id', jobId)
    .eq('workspace_id', workspaceId)
    .eq('attempt_count', attemptToken)
    .eq('status', 'running')
    .select('id')
    .maybeSingle();
  if (error) throw databaseError('ingest job failure update failed', error);
  // No row means pause/retry/new attempt won the race. The old invocation must
  // not change the new attempt's state.
  if (!data) return;
}

async function runClaimedJob(
  supabase: SupabaseClient,
  job: JobRow,
  ownerId: string,
  locale: string | null | undefined,
  dependencies: IngestRunnerDependencies,
): Promise<void> {
  if (job.status !== 'running') return;
  const workspace = await loadWorkspace(supabase, job.workspace_id, ownerId);
  if (!workspace) throw new Error('Workspace not found');
  const source = await loadSource(supabase, job.source_id, workspace.id);
  if (!source?.drive_file_id) throw new Error('Source content is no longer available in Drive');
  const profile = await resolveProfile(supabase, job, workspace, ownerId);
  const createDrive = dependencies.createDrive ?? createDriveClientForUser;
  const drive = await createDrive(ownerId);
  const readDrive = dependencies.readDrive ?? readDriveFile;
  const findDriveFile = dependencies.findDriveFile ?? findFile;
  const sourceContent = await readDrive(drive, source.drive_file_id, {
    maxBytes: MAX_SOURCE_SNAPSHOT_BYTES,
  });
  const wikiFolderId = await findDriveFile(
    drive,
    'wiki',
    workspace.drive_folder_id,
    'application/vnd.google-apps.folder',
  );
  if (!wikiFolderId) throw new Error('Drive wiki folder not found');

  let systemPrompt = getDefaultPrompt('ingest', locale ?? 'zh-TW');
  const schemaFolderId = await findDriveFile(
    drive,
    '_schema',
    workspace.drive_folder_id,
    'application/vnd.google-apps.folder',
  );
  if (schemaFolderId) {
    const ingestFileId = await findDriveFile(drive, 'ingest.md', schemaFolderId);
    if (ingestFileId) systemPrompt = await readDrive(drive, ingestFileId);
  }

  const runPipeline = dependencies.runPipeline ?? runIngestPipeline;
  await runPipeline({
    supabase,
    drive,
    workspaceId: workspace.id,
    wikiFolderId,
    sourceContent,
    sourceTitle: source.title ?? 'Untitled',
    systemPrompt,
    profile: profile as LLMProfile,
    jobId: job.id,
    sourceId: source.id,
    attemptToken: job.attempt_count,
    pauseRequested: async () => {
      const { data, error } = await supabase
        .from('ingest_jobs')
        .select('status, attempt_count')
        .eq('id', job.id)
        .eq('workspace_id', workspace.id)
        .eq('attempt_count', job.attempt_count)
        .maybeSingle();
      if (error) throw databaseError('ingest pause check failed', error);
      return !data || data.status === 'paused';
    },
  });
}

/**
 * Start a pending job without trusting request-memory state. Every dependency
 * needed after `after()` is loaded again from Supabase and Drive.
 */
export async function runPendingIngestJob(
  options: RunPendingIngestJobOptions,
): Promise<RunPendingResult> {
  const dependencies = options.dependencies ?? {};
  const supabase = dependencies.supabase ?? createAdminClient();
  const initial = await loadJob(supabase, options.jobId);
  if (!initial) return { claimed: false, status: 'not_found', reason: 'not_found' };

  const workspace = await loadWorkspace(supabase, initial.workspace_id, options.ownerId);
  if (!workspace) return { claimed: false, status: 'not_found', reason: 'not_found' };
  if (initial.status !== 'pending') {
    return { claimed: false, status: initial.status, reason: 'not_pending' };
  }

  const claim = await claimPendingIngestJob(supabase, initial.id, initial.attempt_count);
  if (!claim.claimed) {
    return { claimed: false, status: 'pending', reason: claim.reason };
  }

  try {
    const claimed = await loadJob(supabase, initial.id);
    if (!claimed) throw new Error('Ingest job not found');
    await runClaimedJob(supabase, claimed, options.ownerId, options.locale, dependencies);
    const completed = await loadJob(supabase, initial.id);
    return { claimed: true, status: completed?.status ?? 'done', reason: 'claimed' };
  } catch (error) {
    if (error instanceof IngestLeaseLostError) {
      const current = await loadJob(supabase, options.jobId);
      return {
        claimed: true,
        status: current?.status ?? 'not_found',
        reason: current ? 'claimed' : 'not_found',
      };
    }
    if (isGoogleDriveAuthError(error)) {
      console.warn('[ingest] Google Drive reauthorization required', { jobId: options.jobId });
    } else {
      console.error('[ingest] pending job failed', { jobId: options.jobId, error });
    }
    await markFailedIfActive(supabase, options.jobId, workspace.id, claim.attemptCount!, error);
    const failed = await loadJob(supabase, options.jobId);
    return { claimed: true, status: failed?.status ?? 'failed', reason: 'claimed' };
  }
}

/** Move a newly-created source snapshot to Drive trash when its DB insert fails. */
export async function trashIngestSourceFile(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<void> {
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    fields: 'id',
  });
}
