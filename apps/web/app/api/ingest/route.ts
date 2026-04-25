import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createDriveClient, getAccessToken, writeDriveFile, findFile, readDriveFile } from '@/lib/drive/client';
import { urlToMarkdown } from '@/lib/fetch/url-to-markdown';
import { runIngestPipeline } from '@/lib/ai/ingest-pipeline';
import { DEFAULT_PROMPTS } from '@llm-wiki/prompts';

const IngestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string().url(), workspace_id: z.string().uuid() }),
  z.object({
    kind: z.literal('text'),
    title: z.string().min(1),
    content: z.string().min(1),
    workspace_id: z.string().uuid(),
  }),
]);

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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
    .single();
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  // Resolve LLM profile
  const profileId = workspace.ingest_profile_id ?? workspace.default_profile_id;
  if (!profileId) {
    return NextResponse.json(
      { error: 'No LLM profile configured. Go to Settings to add one.' },
      { status: 422 }
    );
  }

  const { data: profile } = await supabase
    .from('llm_profiles')
    .select('*')
    .eq('id', profileId)
    .single();
  if (!profile) return NextResponse.json({ error: 'LLM profile not found' }, { status: 404 });

  // Fetch source content
  let sourceContent: string;
  let sourceTitle: string;
  let sourceUrl: string | undefined;

  if (parsed.data.kind === 'url') {
    const article = await urlToMarkdown(parsed.data.url).catch((err) => {
      throw new Error(`Failed to fetch URL: ${(err as Error).message}`);
    });
    sourceContent = article.markdown;
    sourceTitle = article.title;
    sourceUrl = parsed.data.url;
  } else {
    sourceContent = parsed.data.content;
    sourceTitle = parsed.data.title;
  }

  const admin = createAdminClient();

  // Store raw source in Drive
  const { data: userData } = await admin.auth.admin.getUserById(user.id);
  const refreshToken = userData?.user?.app_metadata?.google_refresh_token as string | undefined;
  if (!refreshToken) {
    return NextResponse.json({ error: 'Google Drive not connected' }, { status: 403 });
  }

  const accessToken = await getAccessToken(refreshToken);
  const drive = createDriveClient(accessToken);

  // Find sources/ folder
  const sourcesFolderId = await findFile(
    drive,
    'sources',
    workspace.drive_folder_id,
    'application/vnd.google-apps.folder',
  );
  if (!sourcesFolderId) {
    return NextResponse.json({ error: 'Drive sources folder not found' }, { status: 500 });
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

  // Create ingest job
  const { data: job } = await supabase
    .from('ingest_jobs')
    .insert({
      workspace_id,
      source_id: source.id,
      status: 'pending',
      profile_id: profileId,
    })
    .select('id')
    .single();
  if (!job) return NextResponse.json({ error: 'Failed to create ingest job' }, { status: 500 });

  // Find wiki folder for tool context
  const wikiFolderId = await findFile(
    drive,
    'wiki',
    workspace.drive_folder_id,
    'application/vnd.google-apps.folder',
  );
  if (!wikiFolderId) {
    return NextResponse.json({ error: 'Drive wiki folder not found' }, { status: 500 });
  }

  // Load schema prompt from Drive _schema/ingest.md (user may have customized it)
  const schemaFolderId = await findFile(
    drive,
    '_schema',
    workspace.drive_folder_id,
    'application/vnd.google-apps.folder',
  );

  let systemPrompt = DEFAULT_PROMPTS.ingest;
  if (schemaFolderId) {
    const ingestFileId = await findFile(drive, 'ingest.md', schemaFolderId);
    if (ingestFileId) {
      systemPrompt = await readDriveFile(drive, ingestFileId);
    }
  }

  // Mark job as running
  await supabase
    .from('ingest_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', job.id);

  // Run pipeline (Vercel Fluid Compute — up to 300s)
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

    return NextResponse.json({ jobId: job.id, status: 'done' });
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

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
