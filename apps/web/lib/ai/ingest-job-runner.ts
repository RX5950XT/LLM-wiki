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
  runIngestPipeline,
} from './ingest-pipeline';
import { isDeadRunning, nextAttemptCount } from './ingest-job-state';
import { runIntake } from './ingest-intake';
import {
  classifyIngestFailure,
  decideRetry,
  OUT_OF_TIME_MESSAGE,
  RUNNER_LEASE_MS,
} from './ingest-retry';

const JOB_FIELDS =
  'id, workspace_id, source_id, profile_id, status, phase, checkpoint, touched_pages, attempt_count, next_attempt_at, retry_count';
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
  next_attempt_at?: string | null;
  retry_count?: number;
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
  /** When the invocation began; the pipeline's time budget counts from here. */
  startedAt?: number;
}

export interface ClaimPendingResult {
  claimed: boolean;
  reason: 'claimed' | 'not_pending' | 'workspace_busy';
  attemptCount?: number;
}

export interface RunPendingResult {
  claimed: boolean;
  status: IngestStatus | 'not_found';
  reason: ClaimPendingResult['reason'] | 'not_found' | 'not_due';
}

function databaseError(operation: string, error: { message: string }): Error {
  return new Error(`${operation}: ${error.message}`);
}

function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23505';
}

const RUNNER_LIFETIME_MS = 300_000;

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
      next_attempt_at: null,
      wait_reason: null,
      error: null,
    })
    .eq('id', jobId)
    .eq('status', 'pending')
    .eq('attempt_count', expectedAttemptCount)
    // A runner paused mid-run may still be finishing its step. Claim only once it has
    // stopped (finished_at set) or can no longer be alive (Vercel's 300s limit).
    .or(`finished_at.not.is.null,started_at.is.null,started_at.lt."${new Date(Date.now() - RUNNER_LIFETIME_MS).toISOString()}"`)
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

async function loadClaimedJob(
  supabase: SupabaseClient,
  jobId: string,
  attemptCount: number,
): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from('ingest_jobs')
    .select(JOB_FIELDS)
    .eq('id', jobId)
    .eq('status', 'running')
    .eq('attempt_count', attemptCount)
    .maybeSingle();
  if (error) throw databaseError('claimed ingest job lookup failed', error);
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

const INVOCATION_GUARD_MS = 280_000;

/** Record that this attempt's runner stopped after a pause, so a resumed job may be claimed. */
async function markAttemptStopped(supabase: SupabaseClient, jobId: string, attemptToken: number): Promise<void> {
  const { error } = await supabase
    .from('ingest_jobs')
    .update({ finished_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('attempt_count', attemptToken)
    .in('status', ['paused', 'pending'])
    .is('finished_at', null)
    .select('id')
    .maybeSingle();
  if (error) console.warn('[ingest] stop marker failed', { jobId, error: error.message });
}

/**
 * Settle an attempt that did not finish: wait and try again, or fail for good. A failed
 * attempt keeps its checkpoint, so the next run continues from the committed pages.
 */
export async function settleFailedAttempt(
  supabase: SupabaseClient,
  jobId: string,
  workspaceId: string,
  attemptToken: number,
  reason: unknown,
): Promise<void> {
  const { data: current, error: lookupError } = await supabase
    .from('ingest_jobs')
    .select('retry_count')
    .eq('id', jobId)
    .maybeSingle();
  if (lookupError) throw databaseError('ingest job lookup failed', lookupError);
  const decision = decideRetry(classifyIngestFailure(reason), Number(current?.retry_count ?? 0));
  const now = new Date().toISOString();
  const values = decision.requeue
    ? {
        status: 'pending',
        error: decision.message,
        wait_reason: decision.waitReason,
        next_attempt_at: decision.nextAttemptAt,
        retry_count: decision.retryCount,
        finished_at: now,
      }
    : {
        status: 'failed',
        error: decision.message,
        wait_reason: null,
        next_attempt_at: null,
        finished_at: now,
      };
  const { error } = await supabase
    .from('ingest_jobs')
    .update(values)
    .eq('id', jobId)
    .eq('workspace_id', workspaceId)
    .eq('attempt_count', attemptToken)
    .eq('status', 'running');
  // No row matched means pause/retry/new attempt won the race. The old invocation
  // must not change the new attempt's state.
  if (error) throw databaseError('ingest job failure update failed', error);
}

async function runClaimedJob(
  supabase: SupabaseClient,
  job: JobRow,
  ownerId: string,
  locale: string | null | undefined,
  dependencies: IngestRunnerDependencies,
  startedAt?: number,
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
    startedAt,
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
  if (initial.next_attempt_at && Date.parse(initial.next_attempt_at) > Date.now()) {
    return { claimed: false, status: 'pending', reason: 'not_due' };
  }

  const startedAt = options.startedAt ?? Date.now();
  const claim = await claimPendingIngestJob(supabase, initial.id, initial.attempt_count);
  if (!claim.claimed) {
    return { claimed: false, status: 'pending', reason: claim.reason };
  }

  try {
    const claimed = await loadClaimedJob(supabase, initial.id, claim.attemptCount!);
    if (!claimed) {
      const current = await loadJob(supabase, options.jobId);
      return {
        claimed: true,
        status: current?.status ?? 'not_found',
        reason: current ? 'claimed' : 'not_found',
      };
    }
    // Vercel kills the invocation at 300s and runs no cleanup, leaving the row in `running`.
    // Settle it first; the checkpoint already holds every committed page, so the next run resumes.
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      guardTimer = setTimeout(
        () => reject(new Error(OUT_OF_TIME_MESSAGE)),
        Math.max(0, startedAt + INVOCATION_GUARD_MS - Date.now()),
      );
    });
    try {
      if (claimed.phase === 'intake') {
        const outcome = await Promise.race([runIntake(supabase, claimed, options.ownerId), guard]);
        // Now an ordinary queued job: start it in this same invocation when its workspace is free.
        if (outcome === 'queued') return await runPendingIngestJob({ ...options, startedAt });
      } else {
        await Promise.race([
          runClaimedJob(supabase, claimed, options.ownerId, options.locale, dependencies, startedAt),
          guard,
        ]);
      }
    } finally {
      clearTimeout(guardTimer);
    }
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
    await settleFailedAttempt(supabase, options.jobId, workspace.id, claim.attemptCount!, error);
    const failed = await loadJob(supabase, options.jobId);
    return { claimed: true, status: failed?.status ?? 'failed', reason: 'claimed' };
  } finally {
    await markAttemptStopped(supabase, options.jobId, claim.attemptCount!);
  }
}

interface ActiveJobRow {
  id: string;
  workspace_id: string;
  status: IngestStatus;
  phase: string;
  started_at: string | null;
  next_attempt_at: string | null;
  attempt_count: number;
  updated_at: string | null;
}

/**
 * A run that was killed never reports back. Past the lease it cannot be alive, so put
 * the job back in line instead of leaving it `running` forever.
 */
export async function recoverDeadIngestJobs(
  supabase: SupabaseClient,
  workspaceIds?: readonly string[],
  now = Date.now(),
): Promise<void> {
  let query = supabase
    .from('ingest_jobs')
    .select('id, workspace_id, status, started_at, attempt_count')
    .eq('status', 'running')
    .lt('started_at', new Date(now - RUNNER_LEASE_MS).toISOString());
  if (workspaceIds) query = query.in('workspace_id', [...workspaceIds]);
  const { data, error } = await query;
  if (error) throw databaseError('dead ingest job lookup failed', error);
  for (const job of (data ?? []) as ActiveJobRow[]) {
    if (!isDeadRunning(job.status, job.started_at, now, RUNNER_LEASE_MS)) continue;
    await settleFailedAttempt(supabase, job.id, job.workspace_id, job.attempt_count, new Error(OUT_OF_TIME_MESSAGE));
  }
}

/**
 * Oldest due job per workspace. An intake never writes to the wiki, so it does not wait
 * for a workspace that is busy, and it does not make one busy.
 */
export function pickRunnableIngestJobs<T extends Pick<ActiveJobRow, 'workspace_id' | 'status' | 'phase' | 'next_attempt_at' | 'updated_at'>>(
  jobs: readonly T[],
  limit: number,
  now = Date.now(),
): T[] {
  const isWriter = (job: T) => job.phase !== 'intake';
  const busy = new Set(jobs.filter((job) => job.status === 'running' && isWriter(job)).map((job) => job.workspace_id));
  const due = jobs
    .filter((job) => job.status === 'pending' && (!job.next_attempt_at || Date.parse(job.next_attempt_at) <= now))
    .sort((a, b) => Date.parse(a.updated_at ?? '') - Date.parse(b.updated_at ?? ''));
  const picked: T[] = [];
  for (const job of due) {
    if (picked.length >= limit) break;
    if (isWriter(job)) {
      if (busy.has(job.workspace_id)) continue;
      busy.add(job.workspace_id);
    }
    picked.push(job);
  }
  return picked;
}

/** The jobs to start now, optionally only among one user's workspaces. */
export async function loadRunnableIngestJobs(
  supabase: SupabaseClient,
  limit: number,
  workspaceIds?: readonly string[],
): Promise<Array<ActiveJobRow & { owner_id: string }>> {
  let query = supabase
    .from('ingest_jobs')
    .select('id, workspace_id, status, phase, started_at, next_attempt_at, attempt_count, updated_at, workspaces!inner(owner_id)')
    .in('status', ['pending', 'running']);
  if (workspaceIds) query = query.in('workspace_id', [...workspaceIds]);
  const { data, error } = await query;
  if (error) throw databaseError('active ingest jobs lookup failed', error);
  const rows = (data ?? []) as unknown as Array<ActiveJobRow & { workspaces: { owner_id: string } }>;
  return pickRunnableIngestJobs(rows, limit).map((row) => ({ ...row, owner_id: row.workspaces.owner_id }));
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
