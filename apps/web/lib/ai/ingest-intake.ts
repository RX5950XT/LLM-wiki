import { createHash } from 'crypto';
import { generateText } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LLMProfile } from '@llm-wiki/shared-types';
import { findFile, writeDriveFile } from '@/lib/drive/client';
import { toPublicUrlFetchFailure, urlToMarkdown } from '@/lib/fetch/url-to-markdown';
import { createDriveClientForUser } from '@/lib/google/drive-auth';
import { extractDocument, type ImageToDescribe } from '@/lib/ingest/document-parser';
import { createLLMClient } from './client';
import { IntakeRejectedError, RUNNER_LEASE_MS } from './ingest-retry';
import { routeToWorkspace } from './route-workspace';

export interface IntakeJob {
  id: string;
  workspace_id: string;
  source_id: string;
  profile_id: string | null;
  attempt_count: number;
}

interface IntakeRow {
  job_id: string;
  kind: 'url' | 'text' | 'file';
  url: string | null;
  title: string | null;
  content: string | null;
  file_base64: string | null;
  filename: string | null;
  mime: string | null;
  auto_route: boolean;
  locale: string | null;
}

interface SourceFields {
  title: string;
  content: string;
  url: string | null;
  mime: string;
  byteSize: number;
  metadata: Record<string, unknown>;
}

interface WorkspaceRow {
  id: string;
  drive_folder_id: string;
  ingest_profile_id: string | null;
  default_profile_id: string | null;
}

interface ExistingSource {
  id: string;
  drive_file_id: string | null;
  ingested_at: string | null;
}

export type IntakeOutcome = 'queued' | 'unchanged' | 'lost_lease';

const ACTIVE_STATUSES = ['pending', 'running', 'paused'];
const EARLIER_INTAKE_WAIT_MS = 120_000;
const EARLIER_INTAKE_POLL_MS = 2_000;

function failure(operation: string, error: { message: string } | null): Error {
  return new Error(`${operation}: ${error?.message ?? 'empty response'}`);
}

function buildImageDescriber(profile: LLMProfile) {
  const model = createLLMClient(profile);
  return async (image: ImageToDescribe): Promise<string> => {
    const result = await generateText({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image accurately in concise plain text for a personal knowledge wiki.' },
            { type: 'image', image: `data:${image.mime};base64,${Buffer.from(image.data).toString('base64')}` },
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

async function loadProfile(supabase: SupabaseClient, id: string, ownerId: string): Promise<LLMProfile> {
  const { data, error } = await supabase
    .from('llm_profiles')
    .select('id, name, base_url, model, api_key_encrypted, extra_headers, extra_headers_encrypted, owner_id')
    .eq('id', id)
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (error) throw failure('LLM profile lookup failed', error);
  if (!data) throw new IntakeRejectedError('No LLM profile configured');
  return data as unknown as LLMProfile;
}

async function resolveProfileId(
  supabase: SupabaseClient,
  job: IntakeJob,
  workspace: WorkspaceRow,
  ownerId: string,
): Promise<string> {
  const chosen = job.profile_id ?? workspace.ingest_profile_id ?? workspace.default_profile_id;
  if (chosen) return chosen;
  const { data, error } = await supabase
    .from('llm_profiles')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('is_default', true)
    .maybeSingle();
  if (error) throw failure('default LLM profile lookup failed', error);
  if (!data?.id) throw new IntakeRejectedError('No LLM profile configured');
  return data.id as string;
}

async function loadWorkspace(supabase: SupabaseClient, id: string, ownerId: string): Promise<WorkspaceRow> {
  const { data, error } = await supabase
    .from('workspaces')
    .select('id, drive_folder_id, ingest_profile_id, default_profile_id')
    .eq('id', id)
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (error) throw failure('workspace lookup failed', error);
  if (!data) throw new IntakeRejectedError('Workspace not found');
  return data as WorkspaceRow;
}

/** Turn the raw request into text. Everything slow or fallible here used to run inside the POST. */
async function readSource(intake: IntakeRow, profile: () => Promise<LLMProfile>): Promise<SourceFields> {
  if (intake.kind === 'url') {
    const url = intake.url ?? '';
    try {
      const article = await urlToMarkdown(url);
      return {
        title: article.title,
        content: article.markdown,
        url,
        mime: 'text/markdown',
        byteSize: Buffer.byteLength(article.markdown, 'utf8'),
        metadata: {},
      };
    } catch (error) {
      console.warn('[ingest] url fetch failed:', error instanceof Error ? error.message : error);
      throw new IntakeRejectedError(toPublicUrlFetchFailure(error).message);
    }
  }
  if (intake.kind === 'text') {
    const content = intake.content ?? '';
    return {
      title: intake.title ?? 'Untitled',
      content,
      url: null,
      mime: 'text/plain',
      byteSize: Buffer.byteLength(content, 'utf8'),
      metadata: {},
    };
  }

  const filename = intake.filename ?? 'file';
  const mime = intake.mime ?? 'application/octet-stream';
  const bytes = Buffer.from(intake.file_base64 ?? '', 'base64');
  const extracted = await extractDocument({
    filename,
    mime,
    data: new Uint8Array(bytes),
    describeImage: buildImageDescriber(await profile()),
  });
  if (!extracted.ok) throw new IntakeRejectedError(extracted.error.message);
  if (extracted.text.includes('[Image description unavailable]')) {
    throw new IntakeRejectedError('The image could not be described.');
  }
  if (!extracted.text.trim()) throw new IntakeRejectedError('The document has no readable text.');
  return {
    title: filename.replace(/\.[^.]+$/, '') || filename,
    content: extracted.text,
    url: null,
    mime,
    byteSize: bytes.byteLength,
    metadata: { filename, mime, byte_size: bytes.byteLength },
  };
}

async function findSourceByHash(
  supabase: SupabaseClient,
  workspaceId: string,
  sha256: string,
): Promise<ExistingSource | null> {
  const { data, error } = await supabase
    .from('sources')
    .select('id, drive_file_id, ingested_at')
    .eq('workspace_id', workspaceId)
    .eq('content_sha256', sha256)
    .maybeSingle();
  if (error) throw failure('source duplicate lookup failed', error);
  return (data as ExistingSource | null) ?? null;
}

async function hasOtherActiveJob(supabase: SupabaseClient, sourceId: string, jobId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('ingest_jobs')
    .select('id')
    .eq('source_id', sourceId)
    .neq('id', jobId)
    .in('status', ACTIVE_STATUSES)
    .limit(1);
  if (error) throw failure('source job lookup failed', error);
  return (data ?? []).length > 0;
}

/**
 * Fenced on the attempt: a retry that took over must not have its state overwritten.
 * Returns false when this attempt no longer owns the job.
 */
async function updateJob(
  supabase: SupabaseClient,
  job: IntakeJob,
  values: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('ingest_jobs')
    .update(values)
    .eq('id', job.id)
    .eq('attempt_count', job.attempt_count)
    .eq('status', 'running')
    .select('id')
    .maybeSingle();
  if (error) throw failure('ingest job update failed', error);
  return Boolean(data);
}

/** Point the job at a source that already exists, then drop the placeholder created at POST. */
async function adoptExistingSource(
  supabase: SupabaseClient,
  job: IntakeJob,
  existing: ExistingSource,
  values: Record<string, unknown>,
): Promise<boolean> {
  const updated = await updateJob(supabase, job, { source_id: existing.id, ...values });
  if (!updated) return false;
  // Jobs cascade from sources, so this must come after the job moved away.
  const { error } = await supabase.from('sources').delete().eq('id', job.source_id);
  if (error) console.warn('[ingest] placeholder source cleanup failed', { sourceId: job.source_id, error: error.message });
  return true;
}

/**
 * Whether an earlier intake can still open a workspace soon. A dead run, or a job parked until a
 * quota reset, must not hold up everything behind it. Pending jobs get a little over the 60s hold
 * that POST /api/ingest sets, since a job in that hold is about to run.
 */
export function isLiveIntake(
  job: { status: string; started_at: string | null; next_attempt_at: string | null },
  now: number,
): boolean {
  if (job.status === 'running') {
    return job.started_at !== null && now - Date.parse(job.started_at) < RUNNER_LEASE_MS;
  }
  return job.status === 'pending' && (job.next_attempt_at === null || Date.parse(job.next_attempt_at) - now < 70_000);
}

async function hasEarlierLiveIntake(supabase: SupabaseClient, job: IntakeJob, ownerId: string): Promise<boolean> {
  const { data: workspaces, error: workspaceError } = await supabase
    .from('workspaces')
    .select('id')
    .eq('owner_id', ownerId);
  if (workspaceError) throw failure('ingest workspace lookup failed', workspaceError);

  const { data: rows, error: jobError } = await supabase
    .from('ingest_jobs')
    .select('id, source_id, status, started_at, next_attempt_at')
    .eq('phase', 'intake')
    .in('status', ['pending', 'running'])
    .in('workspace_id', (workspaces ?? []).map((w) => w.id))
    .neq('id', job.id);
  if (jobError) throw failure('ingest queue lookup failed', jobError);
  const live = (rows ?? []).filter((row) => isLiveIntake(row, Date.now()));
  if (live.length === 0) return false;

  // The source row is written first in POST, so its timestamp is the file's place in line.
  const { data: sources, error: sourceError } = await supabase
    .from('sources')
    .select('id, created_at')
    .in('id', [job.source_id, ...live.map((row) => row.source_id)]);
  if (sourceError) throw failure('ingest source lookup failed', sourceError);
  const createdAt = new Map((sources ?? []).map((s) => [s.id as string, s.created_at as string]));
  const place = (id: string, sourceId: string) => `${createdAt.get(sourceId) ?? ''}|${id}`;
  const mine = place(job.id, job.source_id);
  const earlier = live.filter((row) => place(row.id, row.source_id) < mine).map((row) => row.id);
  if (earlier.length === 0) return false;

  // Only auto-routed files can open a workspace.
  const { data: routed, error: intakeError } = await supabase
    .from('ingest_intakes')
    .select('job_id')
    .eq('auto_route', true)
    .in('job_id', earlier)
    .limit(1);
  if (intakeError) throw failure('ingest intake lookup failed', intakeError);
  return (routed ?? []).length > 0;
}

/** Past the limit the job goes back in the queue and resumes shortly, keeping its place in line. */
async function waitForEarlierIntakes(supabase: SupabaseClient, job: IntakeJob, ownerId: string): Promise<void> {
  const deadline = Date.now() + EARLIER_INTAKE_WAIT_MS;
  while (await hasEarlierLiveIntake(supabase, job, ownerId)) {
    if (Date.now() > deadline) throw new Error('Ingest ran out of time.');
    await new Promise((resolve) => setTimeout(resolve, EARLIER_INTAKE_POLL_MS));
  }
}

/**
 * First stage of a job: read the source, choose its workspace, store it on Drive,
 * then hand it to the writing queue as an ordinary `analysis` job. Everything it
 * needs lives in `ingest_intakes`, so a killed run simply starts this stage over.
 */
export async function runIntake(
  supabase: SupabaseClient,
  job: IntakeJob,
  ownerId: string,
): Promise<IntakeOutcome> {
  const { data: intakeData, error: intakeError } = await supabase
    .from('ingest_intakes')
    .select('job_id, kind, url, title, content, file_base64, filename, mime, auto_route, locale')
    .eq('job_id', job.id)
    .maybeSingle();
  if (intakeError) throw failure('ingest intake lookup failed', intakeError);
  if (!intakeData) throw new IntakeRejectedError('The source content could not be found.');
  const intake = intakeData as IntakeRow;
  const locale = intake.locale ?? 'zh-TW';

  const gate = await loadWorkspace(supabase, job.workspace_id, ownerId);
  const gateProfile = async () => loadProfile(supabase, await resolveProfileId(supabase, job, gate, ownerId), ownerId);
  const source = await readSource(intake, gateProfile);
  const sha256 = createHash('sha256').update(source.content, 'utf8').digest('hex');

  const drive = await createDriveClientForUser(ownerId);
  let workspace = gate;
  if (intake.auto_route) {
    const routing = await routeToWorkspace(
      supabase,
      drive,
      ownerId,
      await gateProfile(),
      source.title,
      source.content,
      gate.id,
      locale,
      () => waitForEarlierIntakes(supabase, job, ownerId),
    );
    workspace = await loadWorkspace(supabase, routing.workspaceId, ownerId);
  }
  const profileId = await resolveProfileId(supabase, job, workspace, ownerId);
  const now = new Date().toISOString();

  const finishUnchanged = async (existing: ExistingSource): Promise<IntakeOutcome> => {
    const moved = await adoptExistingSource(supabase, job, existing, {
      workspace_id: workspace.id,
      profile_id: profileId,
      status: 'done',
      phase: 'done',
      result: 'unchanged',
      source_sha256: sha256,
      finished_at: now,
      error: null,
    });
    if (!moved) return 'lost_lease';
    await supabase.from('ingest_intakes').delete().eq('job_id', job.id);
    return 'unchanged';
  };
  const queuedValues = {
    workspace_id: workspace.id,
    profile_id: profileId,
    status: 'pending',
    phase: 'analysis',
    source_sha256: sha256,
    // Lets the next claim start at once: this run is done with the job.
    finished_at: now,
    error: null,
    retry_count: 0,
  };
  const adopt = async (existing: ExistingSource): Promise<IntakeOutcome> => {
    if (existing.ingested_at || !existing.drive_file_id || (await hasOtherActiveJob(supabase, existing.id, job.id))) {
      return finishUnchanged(existing);
    }
    // The same text was imported before and failed: carry on with that source.
    const moved = await adoptExistingSource(supabase, job, existing, queuedValues);
    if (!moved) return 'lost_lease';
    await supabase.from('ingest_intakes').delete().eq('job_id', job.id);
    return 'queued';
  };

  const existing = await findSourceByHash(supabase, workspace.id, sha256);
  if (existing && existing.id !== job.source_id) return adopt(existing);

  const sourcesFolderId = await findFile(drive, 'sources', workspace.drive_folder_id, 'application/vnd.google-apps.folder');
  if (!sourcesFolderId) throw new Error('Drive sources folder not found');
  const fileId = await writeDriveFile(drive, source.content, { name: `${Date.now()}.md`, parentId: sourcesFolderId });

  const { error: sourceError } = await supabase
    .from('sources')
    .update({
      workspace_id: workspace.id,
      title: source.title,
      url: source.url,
      drive_file_id: fileId,
      content_sha256: sha256,
      mime_type: source.mime,
      byte_size: source.byteSize,
      metadata: { ...source.metadata, content_sha256: sha256 },
    })
    .eq('id', job.source_id);
  if (sourceError) {
    await drive.files.update({ fileId, requestBody: { trashed: true }, fields: 'id' }).catch((error: unknown) => {
      console.error('[ingest] failed to trash orphan source file', { fileId, error });
    });
    if (sourceError.code !== '23505') throw failure('source update failed', sourceError);
    const raced = await findSourceByHash(supabase, workspace.id, sha256);
    if (!raced) throw failure('source update failed', sourceError);
    return adopt(raced);
  }

  const moved = await updateJob(supabase, job, queuedValues);
  if (!moved) return 'lost_lease';
  const { error: cleanupError } = await supabase.from('ingest_intakes').delete().eq('job_id', job.id);
  if (cleanupError) console.warn('[ingest] intake cleanup failed', { jobId: job.id, error: cleanupError.message });
  return 'queued';
}
