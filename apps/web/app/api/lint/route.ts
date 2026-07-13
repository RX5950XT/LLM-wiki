import { NextRequest, NextResponse, after } from 'next/server';
import { z } from 'zod';
import { generateText, stepCountIs } from 'ai';
import { createAdminClient } from '@/lib/supabase/admin';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';

export const maxDuration = 300;
import { findFile, readDriveFile } from '@/lib/drive/client';
import { createLLMClient } from '@/lib/ai/client';
import { buildWikiTools } from '@/lib/ai/tools';
import { resolveUiLocaleFromRequest } from '@/lib/i18n/ui-locale';
import { getDefaultPrompt } from '@llm-wiki/prompts';

const PostSchema = z.object({ workspace_id: z.string().uuid() });

// A running job older than this can no longer be alive (maxDuration 300s + buffer)
const STALE_JOB_MS = 8 * 60 * 1000;

type LintSetup = {
  drive: Awaited<ReturnType<typeof createDriveClientForUser>>;
  wikiFolderId: string;
  systemPrompt: string;
  indexContent: string;
  profileRow: Parameters<typeof createLLMClient>[0];
};

type LintSetupResult =
  | { ok: true; setup: LintSetup }
  | { ok: false; status: number; error: string };

/** Load everything the lint pass needs (workspace, profile, Drive, prompt). */
async function setupLint(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  userId: string,
  locale: string,
): Promise<LintSetupResult> {
  const { data: workspace } = await admin
    .from('workspaces')
    .select('id, drive_folder_id, lint_profile_id, default_profile_id')
    .eq('id', workspaceId)
    .eq('owner_id', userId)
    .single();
  if (!workspace) return { ok: false, status: 404, error: 'Workspace not found' };

  const profileId = workspace.lint_profile_id ?? workspace.default_profile_id;
  if (!profileId) return { ok: false, status: 422, error: 'No LLM profile' };

  const { data: profile } = await admin
    .from('llm_profiles')
    .select('id, name, base_url, model, api_key_encrypted, extra_headers, extra_headers_encrypted, owner_id')
    .eq('id', profileId)
    .eq('owner_id', userId)
    .single();
  if (!profile) return { ok: false, status: 404, error: 'Profile not found' };

  let drive: Awaited<ReturnType<typeof createDriveClientForUser>>;
  try {
    drive = await createDriveClientForUser(userId);
  } catch (error) {
    if (isGoogleDriveAuthError(error)) {
      return { ok: false, status: 403, error: (error as Error).message || GOOGLE_DRIVE_REAUTH_MESSAGE };
    }
    throw error;
  }

  const wikiFolderId = await findFile(
    drive, 'wiki', workspace.drive_folder_id, 'application/vnd.google-apps.folder',
  );
  if (!wikiFolderId) return { ok: false, status: 500, error: 'Wiki folder missing' };

  // Load lint prompt (user may have customized _schema/lint.md)
  const schemaFolderId = await findFile(
    drive, '_schema', workspace.drive_folder_id, 'application/vnd.google-apps.folder',
  );
  let systemPrompt = getDefaultPrompt('lint', locale);
  if (schemaFolderId) {
    const lintFileId = await findFile(drive, 'lint.md', schemaFolderId);
    if (lintFileId) systemPrompt = await readDriveFile(drive, lintFileId);
  }

  const { data: indexPage } = await admin
    .from('pages')
    .select('drive_file_id')
    .eq('workspace_id', workspaceId)
    .eq('slug', 'index.md')
    .single();
  const indexContent = indexPage ? await readDriveFile(drive, indexPage.drive_file_id) : '';

  return {
    ok: true,
    setup: {
      drive,
      wikiFolderId,
      systemPrompt,
      indexContent,
      profileRow: profile as Parameters<typeof createLLMClient>[0],
    },
  };
}

/** Run the lint LLM pass and return the report page slug it produced (if any). */
async function executeLint(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  setup: LintSetup,
): Promise<string | null> {
  const tools = buildWikiTools({
    supabase: admin,
    drive: setup.drive,
    workspaceId,
    wikiFolderId: setup.wikiFolderId,
  });

  const model = createLLMClient(setup.profileRow);
  const today = new Date().toISOString().slice(0, 10);
  await generateText({
    model,
    system: setup.systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Today is ${today}.\n\nWiki index:\n\`\`\`\n${setup.indexContent}\n\`\`\``,
      },
    ],
    tools,
    stopWhen: stepCountIs(20),
  });

  await admin.from('logs').insert({
    workspace_id: workspaceId,
    kind: 'lint',
    summary: 'Lint pass completed',
    payload: {},
  });

  // The report slug is chosen by the LLM — look it up instead of guessing
  const { data: lintPage } = await admin
    .from('pages')
    .select('slug')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'lint')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return lintPage?.slug ?? null;
}

export async function POST(request: NextRequest) {
  const locale = resolveUiLocaleFromRequest(request);
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = PostSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Missing or invalid workspace_id' }, { status: 400 });
  }

  const admin = createAdminClient();

  // Self-heal stale runs first, then enforce one maintenance job at a time per
  // owner (shared with organize — both live in agent_jobs).
  await supabase
    .from('agent_jobs')
    .update({ status: 'failed', error: 'Lint timed out', finished_at: new Date().toISOString() })
    .eq('owner_id', user.id)
    .eq('status', 'running')
    .lt('started_at', new Date(Date.now() - STALE_JOB_MS).toISOString());

  const { data: runningJob } = await supabase
    .from('agent_jobs')
    .select('id')
    .eq('owner_id', user.id)
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runningJob) {
    return NextResponse.json(
      { error: 'A maintenance job is already running', jobId: runningJob.id },
      { status: 409 },
    );
  }

  // Setup synchronously so config errors return a proper status (no dangling job)
  const setupResult = await setupLint(admin, parsed.data.workspace_id, user.id, locale);
  if (!setupResult.ok) {
    return NextResponse.json({ error: setupResult.error }, { status: setupResult.status });
  }

  const { data: job } = await supabase
    .from('agent_jobs')
    .insert({
      owner_id: user.id,
      kind: 'lint',
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (!job) return NextResponse.json({ error: 'Failed to create lint job' }, { status: 500 });

  // Run AFTER responding — clients poll GET /api/lint?job_id= instead of holding
  // a connection open for up to 300s (matches ingest / organize).
  after(async () => {
    try {
      const reportSlug = await executeLint(admin, parsed.data.workspace_id, setupResult.setup);
      await supabase
        .from('agent_jobs')
        .update({
          status: 'done',
          report_workspace_id: parsed.data.workspace_id,
          report_slug: reportSlug,
          finished_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    } catch (err) {
      await supabase
        .from('agent_jobs')
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

export async function GET(request: NextRequest) {
  // Client polling path: GET ?job_id= (user-authenticated, cookie or bearer)
  const jobIdRaw = request.nextUrl.searchParams.get('job_id');
  if (jobIdRaw) {
    const { supabase, user } = await getRequestUser(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const jobIdParsed = z.string().uuid().safeParse(jobIdRaw);
    if (!jobIdParsed.success) return NextResponse.json({ error: 'Invalid job_id' }, { status: 400 });

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
      const error = 'Lint timed out';
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

  // Cron path: Vercel Cron injects Authorization: Bearer CRON_SECRET
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'Cron not configured' }, { status: 500 });
  }
  const authHeader = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${cronSecret}`;
  const authBuf = Buffer.from(authHeader);
  const expectedBuf = Buffer.from(expected);
  const { timingSafeEqual } = await import('crypto');
  if (authBuf.length !== expectedBuf.length || !timingSafeEqual(authBuf, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: workspaces } = await admin.from('workspaces').select('id, owner_id');
  if (!workspaces) return NextResponse.json({ ran: 0 });

  for (const ws of workspaces) {
    try {
      const setupResult = await setupLint(admin, ws.id, ws.owner_id, 'zh-TW');
      if (setupResult.ok) await executeLint(admin, ws.id, setupResult.setup);
    } catch (error) {
      console.error('[lint cron]', ws.id, error);
    }
  }

  return NextResponse.json({ ran: workspaces.length });
}
