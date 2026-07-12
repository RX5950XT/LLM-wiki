import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  writeDriveFile,
  findFile,
  ensureFolder,
} from '@/lib/drive/client';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';

const SynthesisSchema = z.object({
  question: z.string().min(1).max(500),
  answer: z.string().min(1).max(2 * 1024 * 1024),
  // Slug charset only — these get interpolated into YAML frontmatter and [[wikilinks]]
  cited_slugs: z.array(z.string().max(200).regex(/^[\w/.-]+$/)).max(50).optional(),
});

function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '');
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = SynthesisSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { question, answer, cited_slugs = [] } = parsed.data;

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, drive_folder_id')
    .eq('id', workspaceId)
    .eq('owner_id', user.id)
    .single();
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

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
  if (!wikiFolderId) {
    return NextResponse.json({ error: 'Wiki folder not found' }, { status: 500 });
  }

  // Ensure synthesis/ subfolder exists
  const synthesisFolderId = await ensureFolder(drive, 'synthesis', wikiFolderId);

  // Build slug: synthesis/YYYYMMDD-HHmm-{question-slug}.md
  const now = new Date();
  const datePart = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const questionSlug = toSlug(question);
  const slug = `synthesis/${datePart}-${questionSlug}.md`;
  const title = question.length > 80 ? `${question.slice(0, 77)}…` : question;

  // Build page content
  const citationLinks =
    cited_slugs.length > 0
      ? '\n\n---\n**Sources:** ' + cited_slugs.map((s) => `[[${s}]]`).join(', ')
      : '';

  const content = [
    '---',
    `kind: synthesis`,
    `created: ${now.toISOString()}`,
    `question: "${question.replace(/"/g, '\\"')}"`,
    cited_slugs.length > 0 ? `sources: [${cited_slugs.join(', ')}]` : '',
    '---',
    '',
    `# ${title}`,
    '',
    answer,
    citationLinks,
    '',
    `---`,
    `*Saved from LLM Wiki query — ${now.toLocaleDateString()}*`,
  ]
    .filter((l) => l !== null)
    .join('\n');

  const { createHash } = await import('crypto');
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);

  const fileId = await writeDriveFile(drive, content, {
    name: `${datePart}-${questionSlug}.md`,
    parentId: synthesisFolderId,
  });

  await supabase.from('pages').insert({
    workspace_id: workspaceId,
    slug,
    kind: 'synthesis',
    zone: 'wiki',
    drive_file_id: fileId,
    content_hash: contentHash,
    title,
    updated_by: 'llm',
  });

  return NextResponse.json({ slug, title });
}
