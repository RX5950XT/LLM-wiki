import { NextRequest, NextResponse, after } from 'next/server';
import { z } from 'zod';
import { findFile } from '@/lib/drive/client';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';
import { runOrganizePipeline } from '@/lib/ai/organize-pipeline';
import { resolveUiLocaleFromRequest } from '@/lib/i18n/ui-locale';

export const maxDuration = 300;

const OrganizeSchema = z.object({
  // Workspace the user triggered from — hosts the report page
  workspace_id: z.string().uuid(),
  profile_id: z.string().uuid().nullish(),
});

export async function POST(request: NextRequest) {
  const locale = resolveUiLocaleFromRequest(request);
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = OrganizeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, drive_folder_id, default_profile_id')
    .eq('id', parsed.data.workspace_id)
    .eq('owner_id', user.id)
    .single();
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  // Self-heal stale runs first: a job whose after() was killed leaves a
  // 'running' row that would otherwise 409 every future run forever.
  await supabase
    .from('agent_jobs')
    .update({ status: 'failed', error: 'Organize timed out', finished_at: new Date().toISOString() })
    .eq('owner_id', user.id)
    .eq('status', 'running')
    .lt('started_at', new Date(Date.now() - STALE_JOB_MS).toISOString());

  // One organize run at a time per user (after the stale sweep above).
  // limit(1) so 2+ concurrent rows don't make maybeSingle() error → null → pass.
  const { data: runningJob } = await supabase
    .from('agent_jobs')
    .select('id')
    .eq('owner_id', user.id)
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runningJob) {
    return NextResponse.json({ error: 'An organize job is already running', jobId: runningJob.id }, { status: 409 });
  }

  let profileId: string | null = null;
  if (parsed.data.profile_id) {
    const { data: overriddenProfile } = await supabase
      .from('llm_profiles')
      .select('id')
      .eq('id', parsed.data.profile_id)
      .eq('owner_id', user.id)
      .single();
    if (overriddenProfile) profileId = overriddenProfile.id;
  }
  if (!profileId) profileId = workspace.default_profile_id ?? null;
  if (!profileId) {
    const { data: defaultProfile } = await supabase
      .from('llm_profiles')
      .select('id')
      .eq('owner_id', user.id)
      .eq('is_default', true)
      .maybeSingle();
    profileId = defaultProfile?.id ?? null;
  }
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

  const wikiFolderId = await findFile(
    drive,
    'wiki',
    workspace.drive_folder_id,
    'application/vnd.google-apps.folder',
  );
  if (!wikiFolderId) return NextResponse.json({ error: 'Wiki folder not found' }, { status: 500 });

  const { data: job } = await supabase
    .from('agent_jobs')
    .insert({
      owner_id: user.id,
      kind: 'organize',
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (!job) return NextResponse.json({ error: 'Failed to create organize job' }, { status: 500 });

  const confirmDestructive = user.user_metadata?.ai_confirm_destructive !== false;

  after(async () => {
    try {
      await runOrganizePipeline({
        supabase,
        drive,
        userId: user.id,
        workspaceId: workspace.id,
        wikiFolderId,
        confirmDestructive,
        locale,
        profile: profile as Parameters<typeof runOrganizePipeline>[0]['profile'],
        jobId: job.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await supabase
        .from('agent_jobs')
        .update({ status: 'failed', error: message, finished_at: new Date().toISOString() })
        .eq('id', job.id);
    }
  });

  return NextResponse.json({ jobId: job.id, status: 'running' }, { status: 202 });
}

const STALE_JOB_MS = 8 * 60 * 1000;

export async function GET(request: NextRequest) {
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const jobIdParsed = z.string().uuid().safeParse(request.nextUrl.searchParams.get('job_id'));
  if (!jobIdParsed.success) {
    return NextResponse.json({ error: 'job_id query param required' }, { status: 400 });
  }

  const { data: job } = await supabase
    .from('agent_jobs')
    .select('id, status, error, progress, report_workspace_id, report_slug, started_at')
    .eq('id', jobIdParsed.data)
    .eq('owner_id', user.id)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  if (
    job.status === 'running' &&
    job.started_at &&
    Date.now() - new Date(job.started_at).getTime() > STALE_JOB_MS
  ) {
    const error = 'Organize timed out';
    await supabase
      .from('agent_jobs')
      .update({ status: 'failed', error, finished_at: new Date().toISOString() })
      .eq('id', job.id);
    return NextResponse.json({ jobId: job.id, status: 'failed', error, progress: job.progress ?? [] });
  }

  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    error: job.error,
    progress: job.progress ?? [],
    report_workspace_id: job.report_workspace_id,
    report_slug: job.report_slug,
  });
}
