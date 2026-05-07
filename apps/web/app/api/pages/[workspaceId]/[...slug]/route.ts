import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { readDriveFile, writeDriveFile } from '@/lib/drive/client';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';

const LockSchema = z.object({ locked_by_human: z.boolean() });
const ContentSchema = z.object({ content: z.string() });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; slug: string[] }> }
) {
  const { workspaceId, slug } = await params;
  const slugStr = slug.join('/');

  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await supabase
    .from('pages')
    .select('slug, title, kind, zone, drive_file_id, updated_by, locked_by_human, version')
    .eq('workspace_id', workspaceId)
    .eq('slug', slugStr)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

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
  const content = await readDriveFile(drive, page.drive_file_id);

  return NextResponse.json({ ...page, content });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; slug: string[] }> },
) {
  const { workspaceId, slug: slugParts } = await params;
  const slug = slugParts.join('/');

  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsedLock = LockSchema.safeParse(body);
  const parsedContent = ContentSchema.safeParse(body);
  if (!parsedLock.success && !parsedContent.success) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const { data: ws } = await supabase
    .from('workspaces')
    .select('id')
    .eq('id', workspaceId)
    .eq('owner_id', user.id)
    .single();
  if (!ws) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const { data: page } = await supabase
    .from('pages')
    .select('id, slug, title, kind, zone, drive_file_id, version, updated_by, locked_by_human')
    .eq('workspace_id', workspaceId)
    .eq('slug', slug)
    .single();
  if (!page) return NextResponse.json({ error: 'Page not found' }, { status: 404 });

  if (parsedLock.success) {
    const { error } = await supabase
      .from('pages')
      .update({ locked_by_human: parsedLock.data.locked_by_human })
      .eq('workspace_id', workspaceId)
      .eq('slug', slug);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  }

  if (page.zone === 'wiki') {
    return NextResponse.json({ error: 'Wiki pages are not editable from this UI' }, { status: 403 });
  }

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

  const content = parsedContent.data!.content;
  await writeDriveFile(drive, content, {
    fileId: page.drive_file_id,
    name: slugParts.at(-1) ?? slug,
    parentId: '',
  });

  const title = deriveTitleFromContent(content, page.title);
  const values = {
    title,
    content_hash: await hashContent(content),
    version: page.version + 1,
    updated_by: 'human',
    updated_at: new Date().toISOString(),
  };

  const { error: updateError } = await supabase
    .from('pages')
    .update(values)
    .eq('id', page.id);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  return NextResponse.json({
    slug: page.slug,
    title,
    kind: page.kind,
    zone: page.zone,
    content,
    updated_by: 'human',
    locked_by_human: page.locked_by_human,
    version: page.version + 1,
  });
}

function deriveTitleFromContent(content: string, fallback: string | null): string | null {
  const frontmatterTitle = content.match(/^title:\s*"?(.*?)"?$/m)?.[1]?.trim();
  if (frontmatterTitle) return frontmatterTitle;

  const heading = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('# '));
  if (heading) return heading.replace(/^#\s+/, '').trim();

  return fallback;
}

async function hashContent(content: string): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}
