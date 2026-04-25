import { NextRequest, NextResponse } from 'next/server';
import { generateText, stepCountIs } from 'ai';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createDriveClient, getAccessToken, findFile, readDriveFile } from '@/lib/drive/client';
import { createLLMClient } from '@/lib/ai/client';
import { buildWikiTools } from '@/lib/ai/tools';
import { DEFAULT_PROMPTS } from '@llm-wiki/prompts';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { workspace_id } = await request.json().catch(() => ({}));
  if (!workspace_id) return NextResponse.json({ error: 'Missing workspace_id' }, { status: 400 });

  return runLint(workspace_id, user.id);
}

/** Called by the weekly cron. Iterates all workspaces. */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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

async function runLint(workspaceId: string, userId: string) {
  const admin = createAdminClient();
  const supabase = admin;

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, drive_folder_id, lint_profile_id, default_profile_id')
    .eq('id', workspaceId)
    .single();
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const profileId = workspace.lint_profile_id ?? workspace.default_profile_id;
  if (!profileId) return NextResponse.json({ error: 'No LLM profile' }, { status: 422 });

  const { data: profile } = await supabase
    .from('llm_profiles')
    .select('*')
    .eq('id', profileId)
    .single();
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });

  const { data: userData } = await admin.auth.admin.getUserById(userId);
  const refreshToken = userData?.user?.app_metadata?.google_refresh_token as string | undefined;
  if (!refreshToken) return NextResponse.json({ error: 'No Drive token' }, { status: 403 });

  const accessToken = await getAccessToken(refreshToken);
  const drive = createDriveClient(accessToken);

  const wikiFolderId = await findFile(
    drive, 'wiki', workspace.drive_folder_id, 'application/vnd.google-apps.folder',
  );
  if (!wikiFolderId) return NextResponse.json({ error: 'Wiki folder missing' }, { status: 500 });

  // Load lint prompt
  const schemaFolderId = await findFile(
    drive, '_schema', workspace.drive_folder_id, 'application/vnd.google-apps.folder',
  );
  let systemPrompt = DEFAULT_PROMPTS.lint;
  if (schemaFolderId) {
    const lintFileId = await findFile(drive, 'lint.md', schemaFolderId);
    if (lintFileId) systemPrompt = await readDriveFile(drive, lintFileId);
  }

  const { data: indexPage } = await supabase
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

  await generateText({
    model,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Wiki index:\n\`\`\`\n${indexContent}\n\`\`\`` }],
    tools,
    stopWhen: stepCountIs(20),
  });

  await supabase.from('logs').insert({
    workspace_id: workspaceId,
    kind: 'lint',
    summary: 'Weekly lint pass completed',
    payload: {},
  });

  return NextResponse.json({ ok: true });
}
