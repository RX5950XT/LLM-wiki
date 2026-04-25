import { NextRequest } from 'next/server';
import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createDriveClient, getAccessToken, findFile, readDriveFile } from '@/lib/drive/client';
import { createLLMClient } from '@/lib/ai/client';
import { buildWikiTools } from '@/lib/ai/tools';
import { DEFAULT_PROMPTS } from '@llm-wiki/prompts';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  // AI SDK useChat sends: { messages: ModelMessage[], workspace_id: string }
  const body = await request.json().catch(() => null);
  const workspaceIdResult = z.string().uuid().safeParse(body?.workspace_id);
  const messages: ModelMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  if (!workspaceIdResult.success || messages.length === 0) {
    return new Response('Bad request', { status: 400 });
  }
  const workspace_id = workspaceIdResult.data;
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  const question = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, drive_folder_id, query_profile_id, default_profile_id')
    .eq('id', workspace_id)
    .single();
  if (!workspace) return new Response('Workspace not found', { status: 404 });

  const profileId = workspace.query_profile_id ?? workspace.default_profile_id;
  if (!profileId) return new Response('No LLM profile configured', { status: 422 });

  const { data: profile } = await supabase
    .from('llm_profiles')
    .select('*')
    .eq('id', profileId)
    .single();
  if (!profile) return new Response('LLM profile not found', { status: 404 });

  const admin = createAdminClient();
  const { data: userData } = await admin.auth.admin.getUserById(user.id);
  const refreshToken = userData?.user?.app_metadata?.google_refresh_token as string | undefined;
  if (!refreshToken) return new Response('Google Drive not connected', { status: 403 });

  const accessToken = await getAccessToken(refreshToken);
  const drive = createDriveClient(accessToken);

  const wikiFolderId = await findFile(
    drive, 'wiki', workspace.drive_folder_id, 'application/vnd.google-apps.folder',
  );
  if (!wikiFolderId) return new Response('Wiki folder not found', { status: 500 });

  const schemaFolderId = await findFile(
    drive, '_schema', workspace.drive_folder_id, 'application/vnd.google-apps.folder',
  );
  let systemPrompt = DEFAULT_PROMPTS.query;
  if (schemaFolderId) {
    const queryFileId = await findFile(drive, 'query.md', schemaFolderId);
    if (queryFileId) systemPrompt = await readDriveFile(drive, queryFileId);
  }

  const tools = buildWikiTools({ supabase, drive, workspaceId: workspace_id, wikiFolderId });
  const model = createLLMClient(profile as Parameters<typeof createLLMClient>[0]);

  const { data: indexPage } = await supabase
    .from('pages')
    .select('drive_file_id')
    .eq('workspace_id', workspace_id)
    .eq('slug', 'index.md')
    .single();
  const indexContent = indexPage
    ? await readDriveFile(drive, indexPage.drive_file_id)
    : '(empty wiki)';

  const augmentedMessages: ModelMessage[] = [
    {
      role: 'user',
      content: `Current wiki index:\n\`\`\`\n${indexContent}\n\`\`\``,
    },
    { role: 'assistant', content: 'Understood. I have the wiki index. Go ahead.' },
    ...messages,
  ];

  const result = streamText({
    model,
    system: systemPrompt,
    messages: augmentedMessages,
    tools,
    stopWhen: stepCountIs(15),
    onFinish: async ({ text }) => {
      await supabase.from('logs').insert({
        workspace_id,
        kind: 'query',
        summary: String(question).slice(0, 120),
        payload: { question: String(question), answer_preview: text.slice(0, 200) },
      });
    },
  });

  return result.toTextStreamResponse();
}
