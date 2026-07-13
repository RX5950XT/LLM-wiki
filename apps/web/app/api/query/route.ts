import { NextRequest } from 'next/server';
import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { z } from 'zod';
import { findFile, readDriveFile } from '@/lib/drive/client';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';
import { createLLMClient } from '@/lib/ai/client';
import { buildWikiTools, type ActionProposal } from '@/lib/ai/tools';
import { resolveUiLocaleFromRequest } from '@/lib/i18n/ui-locale';
import { getDefaultPrompt } from '@llm-wiki/prompts';

export const maxDuration = 120;

const MessagesSchema = z
  .array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().max(100_000),
    }),
  )
  .min(1)
  .max(60);

export async function POST(request: NextRequest) {
  const locale = resolveUiLocaleFromRequest(request);
  const { supabase, user } = await getRequestUser(request);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const body = await request.json().catch(() => null);
  const workspaceIdResult = z.string().uuid().safeParse(body?.workspace_id);
  const messagesResult = MessagesSchema.safeParse(body?.messages);
  if (!workspaceIdResult.success || !messagesResult.success) {
    return new Response('Bad request', { status: 400 });
  }
  const messages: ModelMessage[] = messagesResult.data;
  const workspace_id = workspaceIdResult.data;
  const currentSlugResult = z.string().max(500).optional().safeParse(body?.current_slug);
  const currentSlug = currentSlugResult.success ? currentSlugResult.data : undefined;
  const contextWorkspacesResult = z
    .array(z.string().uuid())
    .max(5)
    .optional()
    .safeParse(body?.context_workspace_ids);
  const contextWorkspaceIds = (contextWorkspacesResult.success ? contextWorkspacesResult.data ?? [] : [])
    .filter((id) => id !== workspace_id);
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  const question =
    typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, drive_folder_id, query_profile_id, default_profile_id')
    .eq('id', workspace_id)
    .eq('owner_id', user.id)
    .single();
  if (!workspace) return new Response('Workspace not found', { status: 404 });

  // Allow client-side profile override with ownership check
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
    profileId = workspace.query_profile_id ?? workspace.default_profile_id ?? null;
  }

  if (!profileId) {
    // Workspaces usually have no *_profile_id bound at all, so fall back to the
    // owner's default profile instead of 422-ing a client that didn't send one.
    const { data: defaultProfile } = await supabase
      .from('llm_profiles')
      .select('id')
      .eq('owner_id', user.id)
      .eq('is_default', true)
      .maybeSingle();
    profileId = defaultProfile?.id ?? null;
  }

  if (!profileId) return new Response('No LLM profile configured', { status: 422 });

  const { data: profile } = await supabase
    .from('llm_profiles')
    .select('id, name, base_url, model, api_key_encrypted, extra_headers, extra_headers_encrypted, owner_id')
    .eq('id', profileId)
    .eq('owner_id', user.id)
    .single();
  if (!profile) return new Response('LLM profile not found', { status: 404 });

  let drive: Awaited<ReturnType<typeof createDriveClientForUser>>;
  try {
    drive = await createDriveClientForUser(user.id);
  } catch (error) {
    if (isGoogleDriveAuthError(error)) {
      return new Response(error.message || GOOGLE_DRIVE_REAUTH_MESSAGE, { status: 403 });
    }
    throw error;
  }

  const wikiFolderId = await findFile(
    drive,
    'wiki',
    workspace.drive_folder_id,
    'application/vnd.google-apps.folder',
  );
  if (!wikiFolderId) return new Response('Wiki folder not found', { status: 500 });

  const schemaFolderId = await findFile(
    drive,
    '_schema',
    workspace.drive_folder_id,
    'application/vnd.google-apps.folder',
  );
  let systemPrompt = getDefaultPrompt('query', locale);
  if (schemaFolderId) {
    const queryFileId = await findFile(drive, 'query.md', schemaFolderId);
    if (queryFileId) systemPrompt = await readDriveFile(drive, queryFileId);
  }

  // Destructive-action confirmation preference (default: confirm required)
  const confirmDestructive = user.user_metadata?.ai_confirm_destructive !== false;

  // Track pages read during this query (for citations) + destructive proposals
  const readSlugs = new Set<string>();
  const proposals: ActionProposal[] = [];
  const tools = buildWikiTools({
    supabase,
    drive,
    workspaceId: workspace_id,
    wikiFolderId,
    userId: user.id,
    crossWorkspace: true,
    confirmDestructive,
    locale,
    onProposal: (proposal) => proposals.push(proposal),
    onPageRead: (slug: string) => readSlugs.add(slug),
  });

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

  const contextSections: string[] = [
    `Current wiki index:\n\`\`\`\n${indexContent}\n\`\`\``,
  ];

  // Page the user is currently viewing — the default subject of the conversation
  if (currentSlug && currentSlug !== 'index.md') {
    const { data: currentPage } = await supabase
      .from('pages')
      .select('drive_file_id, title')
      .eq('workspace_id', workspace_id)
      .eq('slug', currentSlug)
      .maybeSingle();
    if (currentPage) {
      try {
        const pageContent = await readDriveFile(drive, currentPage.drive_file_id);
        contextSections.push(
          `The user is currently viewing the page "${currentSlug}"${currentPage.title ? ` (${currentPage.title})` : ''}. ` +
            `Unless they specify otherwise, assume their questions refer to this page:\n\`\`\`\n${pageContent.slice(0, 20_000)}\n\`\`\``,
        );
      } catch {
        // page unreadable — skip context, don't fail the query
      }
    }
  }

  // @-tagged workspaces: inject their index + tell the model their ids
  if (contextWorkspaceIds.length > 0) {
    const { data: taggedWorkspaces } = await supabase
      .from('workspaces')
      .select('id, name')
      .in('id', contextWorkspaceIds)
      .eq('owner_id', user.id);
    for (const tagged of taggedWorkspaces ?? []) {
      const { data: taggedIndex } = await supabase
        .from('pages')
        .select('drive_file_id')
        .eq('workspace_id', tagged.id)
        .eq('slug', 'index.md')
        .maybeSingle();
      let taggedContent = '(empty wiki)';
      if (taggedIndex) {
        try {
          taggedContent = await readDriveFile(drive, taggedIndex.drive_file_id);
        } catch {
          taggedContent = '(index unreadable)';
        }
      }
      contextSections.push(
        `The user tagged the workspace "${tagged.name}" (workspace_id: ${tagged.id}) as extra context. ` +
          `Pass this workspace_id to tools to read or modify its pages. Its wiki index:\n\`\`\`\n${taggedContent}\n\`\`\``,
      );
    }
  }

  const augmentedMessages: ModelMessage[] = [
    { role: 'user', content: contextSections.join('\n\n') },
    { role: 'assistant', content: 'Understood. I have the wiki context. Go ahead.' },
    ...messages,
  ];

  // Server-enforced capability note — appended after any user-customized
  // _schema/query.md so cross-workspace tooling always stays documented.
  const capabilityNote = [
    '',
    '## Cross-workspace capabilities',
    'You can manage the user\'s workspaces with tools: listWorkspaces, createWorkspace, renameWorkspace, deleteWorkspace, reorderWorkspaces, movePageToWorkspace.',
    'Page tools (readPage, writePage, searchPages, listPages, deletePage, movePage) accept an optional workspace_id to operate on other workspaces the user owns.',
    'When the conversation surfaces durable knowledge worth keeping, write it into wiki pages with writePage.',
    confirmDestructive
      ? 'Destructive actions (deletePage, deleteWorkspace) require user confirmation: the tool returns a pending proposal and the UI shows a confirmation card. Never claim the deletion already happened.'
      : 'Destructive actions execute immediately; double-check targets before deleting.',
  ].join('\n');
  systemPrompt += `\n${capabilityNote}`;

  const result = streamText({
    model,
    system: systemPrompt,
    messages: augmentedMessages,
    tools,
    stopWhen: stepCountIs(20),
    onFinish: async ({ text }) => {
      const citations = Array.from(readSlugs).filter((s) => s !== 'index.md');
      await supabase.from('logs').insert({
        workspace_id,
        kind: 'query',
        summary: String(question).slice(0, 120),
        payload: {
          question: String(question),
          answer_preview: text.slice(0, 200),
          cited_slugs: citations,
        },
      });
    },
  });

  // Custom streaming response: plain text + trailing citation JSON block
  const textStream = result.textStream;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      for await (const chunk of textStream) {
        controller.enqueue(encoder.encode(chunk));
      }
      // Append citation + pending-action metadata after text ends
      const citations = Array.from(readSlugs).filter((s) => s !== 'index.md');
      if (citations.length > 0) {
        const citationBlock = `\n\x00CITATIONS\x00${JSON.stringify(citations)}`;
        controller.enqueue(encoder.encode(citationBlock));
      }
      if (proposals.length > 0) {
        const actionBlock = `\n\x00ACTIONS\x00${JSON.stringify(proposals)}`;
        controller.enqueue(encoder.encode(actionBlock));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
