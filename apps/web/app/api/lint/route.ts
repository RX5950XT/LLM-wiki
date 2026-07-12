import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { generateText, stepCountIs } from 'ai';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
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

export async function POST(request: NextRequest) {
  const locale = resolveUiLocaleFromRequest(request);
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = PostSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Missing or invalid workspace_id' }, { status: 400 });
  }

  return runLint(parsed.data.workspace_id, user.id, locale);
}

/** Called directly by Vercel Cron (which injects Authorization: Bearer CRON_SECRET). */
export async function GET(request: NextRequest) {
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
  const { data: workspaces } = await admin
    .from('workspaces')
    .select('id, owner_id');

  if (!workspaces) return NextResponse.json({ ran: 0 });

  for (const ws of workspaces) {
    await runLint(ws.id, ws.owner_id).catch(console.error);
  }

  return NextResponse.json({ ran: workspaces.length });
}

async function runLint(workspaceId: string, userId: string, locale: string = 'zh-TW') {
  const admin = createAdminClient();

  // Verify the workspace belongs to the requesting user before using admin client
  const { data: workspace } = await admin
    .from('workspaces')
    .select('id, drive_folder_id, lint_profile_id, default_profile_id')
    .eq('id', workspaceId)
    .eq('owner_id', userId)
    .single();
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const profileId = workspace.lint_profile_id ?? workspace.default_profile_id;
  if (!profileId) return NextResponse.json({ error: 'No LLM profile' }, { status: 422 });

  const { data: profile } = await admin
    .from('llm_profiles')
    .select('id, name, base_url, model, api_key_encrypted, extra_headers, owner_id')
    .eq('id', profileId)
    .eq('owner_id', userId)
    .single();
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });

  let drive: Awaited<ReturnType<typeof createDriveClientForUser>>;
  try {
    drive = await createDriveClientForUser(userId);
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
    drive, 'wiki', workspace.drive_folder_id, 'application/vnd.google-apps.folder',
  );
  if (!wikiFolderId) return NextResponse.json({ error: 'Wiki folder missing' }, { status: 500 });

  // Load lint prompt (user may have customized it)
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

  const tools = buildWikiTools({
    supabase: admin,
    drive,
    workspaceId,
    wikiFolderId,
  });

  const model = createLLMClient(profile as Parameters<typeof createLLMClient>[0]);

  const today = new Date().toISOString().slice(0, 10);
  await generateText({
    model,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Today is ${today}.\n\nWiki index:\n\`\`\`\n${indexContent}\n\`\`\``,
      },
    ],
    tools,
    stopWhen: stepCountIs(20),
  });

  await admin.from('logs').insert({
    workspace_id: workspaceId,
    kind: 'lint',
    summary: 'Weekly lint pass completed',
    payload: {},
  });

  // Report slug is chosen by the LLM — look it up instead of letting clients guess
  const { data: lintPage } = await admin
    .from('pages')
    .select('slug')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'lint')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ ok: true, reportSlug: lintPage?.slug ?? null });
}
