import { NextRequest, NextResponse, after } from 'next/server';
import { z } from 'zod';
import { writeDriveFile, findFile, readDriveFile } from '@/lib/drive/client';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';

export const maxDuration = 300;
import { urlToMarkdown } from '@/lib/fetch/url-to-markdown';
import { runIngestPipeline } from '@/lib/ai/ingest-pipeline';
import { getDefaultPrompt } from '@llm-wiki/prompts';
import { resolveUiLocaleFromRequest } from '@/lib/i18n/ui-locale';

// Matches the 2 MB client-side caps on web and Android file ingest
const MAX_TEXT_LENGTH = 2 * 1024 * 1024;

const IngestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    url: z.string().url().max(2048),
    workspace_id: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('text'),
    title: z.string().min(1).max(300),
    content: z.string().min(1).max(MAX_TEXT_LENGTH),
    workspace_id: z.string().uuid(),
  }),
]);

export async function POST(request: NextRequest) {
  const locale = resolveUiLocaleFromRequest(request);
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = IngestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { workspace_id } = parsed.data;

  // Verify workspace ownership
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, drive_folder_id, ingest_profile_id, default_profile_id')
    .eq('id', workspace_id)
    .eq('owner_id', user.id)
    .single();
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  // Resolve LLM profile (allow client-side override with ownership check)
  const profileIdOverride = z.string().uuid().safeParse(body?.profile_id);
  let profileId: string | null = null;

  if (profileIdOverride.success) {
    const { data: overriddenProfile } = await supabase
      .from('llm_profiles')
      .select('id')
      .eq('id', profileIdOverride.data)
      .eq('owner_id', user.id)
      .single();
    if (overriddenProfile) {
      profileId = overriddenProfile.id;
    }
  }

  if (!profileId) {
    profileId = workspace.ingest_profile_id ?? workspace.default_profile_id ?? null;
  }

  if (!profileId) {
    return NextResponse.json(
      { error: 'No LLM profile configured. Go to Settings to add one.' },
      { status: 422 }
    );
  }

  const { data: profile } = await supabase
    .from('llm_profiles')
    .select('id, name, base_url, model, api_key_encrypted, extra_headers, owner_id')
    .eq('id', profileId)
    .eq('owner_id', user.id)
    .single();
  if (!profile) return NextResponse.json({ error: 'LLM profile not found' }, { status: 404 });

  // Fetch source content
  let sourceContent: string;
  let sourceTitle: string;
  let sourceUrl: string | undefined;

  if (parsed.data.kind === 'url') {
    try {
      const article = await urlToMarkdown(parsed.data.url);
      sourceContent = article.markdown;
      sourceTitle = article.title;
      sourceUrl = parsed.data.url;
    } catch (err) {
      return NextResponse.json(
        { error: `Failed to fetch URL: ${err instanceof Error ? err.message : 'unknown error'}` },
        { status: 422 },
      );
    }
  } else {
    sourceContent = parsed.data.content;
    sourceTitle = parsed.data.title;
  }

  // Store raw source in Drive
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

  // Resolve Drive folders in parallel
  const [sourcesFolderId, wikiFolderId, schemaFolderId] = await Promise.all([
    findFile(drive, 'sources', workspace.drive_folder_id, 'application/vnd.google-apps.folder'),
    findFile(drive, 'wiki', workspace.drive_folder_id, 'application/vnd.google-apps.folder'),
    findFile(drive, '_schema', workspace.drive_folder_id, 'application/vnd.google-apps.folder'),
  ]);
  if (!sourcesFolderId) {
    return NextResponse.json({ error: 'Drive sources folder not found' }, { status: 500 });
  }
  if (!wikiFolderId) {
    return NextResponse.json({ error: 'Drive wiki folder not found' }, { status: 500 });
  }

  const sourceFileId = await writeDriveFile(drive, sourceContent, {
    name: `${Date.now()}.md`,
    parentId: sourcesFolderId,
  });

  // Create source record
  const { data: source } = await supabase
    .from('sources')
    .insert({
      workspace_id,
      kind: parsed.data.kind,
      title: sourceTitle,
      url: sourceUrl ?? null,
      drive_file_id: sourceFileId,
    })
    .select('id')
    .single();
  if (!source) return NextResponse.json({ error: 'Failed to create source record' }, { status: 500 });

  // Load schema prompt from Drive _schema/ingest.md (user may have customized it)
  let systemPrompt = getDefaultPrompt('ingest', locale);
  if (schemaFolderId) {
    const ingestFileId = await findFile(drive, 'ingest.md', schemaFolderId);
    if (ingestFileId) {
      systemPrompt = await readDriveFile(drive, ingestFileId);
    }
  }

  // Create ingest job already in 'running' state so a crash can never
  // leave an unsweepable 'pending' row without started_at
  const { data: job } = await supabase
    .from('ingest_jobs')
    .insert({
      workspace_id,
      source_id: source.id,
      status: 'running',
      profile_id: profileId,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (!job) return NextResponse.json({ error: 'Failed to create ingest job' }, { status: 500 });

  // Run the LLM pipeline AFTER responding — clients poll GET /api/ingest?job_id=
  // instead of holding a connection open for up to 300s (Vercel Fluid Compute
  // keeps the function alive until after() work completes).
  after(async () => {
    try {
      await runIngestPipeline({
        supabase,
        drive,
        workspaceId: workspace_id,
        wikiFolderId,
        sourceContent,
        sourceTitle,
        systemPrompt,
        profile: profile as Parameters<typeof runIngestPipeline>[0]['profile'],
        jobId: job.id,
      });

      await supabase
        .from('sources')
        .update({ ingested_at: new Date().toISOString() })
        .eq('id', source.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await supabase
        .from('ingest_jobs')
        .update({
          status: 'failed',
          error: message,
          finished_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    }
  });

  return NextResponse.json({ jobId: job.id, status: 'running' }, { status: 202 });
}

// A running job older than this can no longer be alive (maxDuration 300s + buffer)
const STALE_JOB_MS = 8 * 60 * 1000;

export async function GET(request: NextRequest) {
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const jobIdParsed = z.string().uuid().safeParse(request.nextUrl.searchParams.get('job_id'));
  if (!jobIdParsed.success) {
    return NextResponse.json({ error: 'job_id query param required' }, { status: 400 });
  }

  // RLS scopes ingest_jobs to workspaces owned by the requesting user
  const { data: job } = await supabase
    .from('ingest_jobs')
    .select('id, status, error, touched_pages, started_at, finished_at')
    .eq('id', jobIdParsed.data)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  if (
    (job.status === 'running' || job.status === 'pending') &&
    job.started_at &&
    Date.now() - new Date(job.started_at).getTime() > STALE_JOB_MS
  ) {
    const error = 'Ingest timed out';
    await supabase
      .from('ingest_jobs')
      .update({ status: 'failed', error, finished_at: new Date().toISOString() })
      .eq('id', job.id);
    return NextResponse.json({ jobId: job.id, status: 'failed', error, touched_pages: [] });
  }

  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    error: job.error,
    touched_pages: job.touched_pages ?? [],
  });
}
