import { NextRequest, NextResponse, after } from 'next/server';
import { z } from 'zod';
import { findFile, readDriveFile } from '@/lib/drive/client';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';
import { runIngestPipeline } from '@/lib/ai/ingest-pipeline';
import { getDefaultPrompt } from '@llm-wiki/prompts';
import { resolveUiLocaleFromRequest } from '@/lib/i18n/ui-locale';

export const maxDuration = 300;

/**
 * Re-run the ingest pipeline for an already-imported source (e.g. one whose
 * first pass failed on a transient provider error). The original source text is
 * read back from Drive, so no re-fetch or duplicate source row is created — a
 * fresh ingest_job is opened and polled via GET /api/ingest?job_id=.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const locale = resolveUiLocaleFromRequest(request);
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid source id' }, { status: 400 });
  }

  const { data: source } = await supabase
    .from('sources')
    .select('id, workspace_id, title, drive_file_id')
    .eq('id', id)
    .single();
  if (!source) return NextResponse.json({ error: 'Source not found' }, { status: 404 });

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, drive_folder_id, ingest_profile_id, default_profile_id')
    .eq('id', source.workspace_id)
    .eq('owner_id', user.id)
    .single();
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const profileId = workspace.ingest_profile_id ?? workspace.default_profile_id ?? null;
  if (!profileId) {
    return NextResponse.json(
      { error: 'No LLM profile configured. Go to Settings to add one.' },
      { status: 422 },
    );
  }

  const { data: profile } = await supabase
    .from('llm_profiles')
    .select('id, name, base_url, model, api_key_encrypted, extra_headers, extra_headers_encrypted, owner_id')
    .eq('id', profileId)
    .eq('owner_id', user.id)
    .single();
  if (!profile) return NextResponse.json({ error: 'LLM profile not found' }, { status: 404 });

  let drive: Awaited<ReturnType<typeof createDriveClientForUser>>;
  try {
    drive = await createDriveClientForUser(user.id);
  } catch (error) {
    if (isGoogleDriveAuthError(error)) {
      return NextResponse.json(
        { error: error.message || GOOGLE_DRIVE_REAUTH_MESSAGE },
        { status: 403 },
      );
    }
    throw error;
  }

  let sourceContent: string;
  try {
    sourceContent = await readDriveFile(drive, source.drive_file_id);
  } catch {
    return NextResponse.json({ error: 'Source content is no longer available in Drive' }, { status: 422 });
  }

  const [wikiFolderId, schemaFolderId] = await Promise.all([
    findFile(drive, 'wiki', workspace.drive_folder_id, 'application/vnd.google-apps.folder'),
    findFile(drive, '_schema', workspace.drive_folder_id, 'application/vnd.google-apps.folder'),
  ]);
  if (!wikiFolderId) return NextResponse.json({ error: 'Drive wiki folder not found' }, { status: 500 });

  let systemPrompt = getDefaultPrompt('ingest', locale);
  if (schemaFolderId) {
    const ingestFileId = await findFile(drive, 'ingest.md', schemaFolderId);
    if (ingestFileId) systemPrompt = await readDriveFile(drive, ingestFileId);
  }

  const { data: job } = await supabase
    .from('ingest_jobs')
    .insert({
      workspace_id: workspace.id,
      source_id: source.id,
      status: 'running',
      profile_id: profileId,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (!job) return NextResponse.json({ error: 'Failed to create ingest job' }, { status: 500 });

  after(async () => {
    try {
      await runIngestPipeline({
        supabase,
        drive,
        workspaceId: workspace.id,
        wikiFolderId,
        sourceContent,
        sourceTitle: source.title ?? 'Untitled',
        systemPrompt,
        profile: profile as Parameters<typeof runIngestPipeline>[0]['profile'],
        jobId: job.id,
      });
      await supabase
        .from('sources')
        .update({ ingested_at: new Date().toISOString() })
        .eq('id', source.id);
    } catch (err) {
      await supabase
        .from('ingest_jobs')
        .update({
          status: 'failed',
          error: err instanceof Error ? err.message : 'Unknown error',
          finished_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    }
  });

  return NextResponse.json({ jobId: job.id, status: 'running' }, { status: 202 });
}
