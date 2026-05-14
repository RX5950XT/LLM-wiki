import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { readDriveFile, writeDriveFile } from '@/lib/drive/client';
import { DriveReadError } from '@/lib/drive/errors';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';

const LockSchema = z.object({ locked_by_human: z.boolean() });
const ContentSchema = z.object({ content: z.string() });
const RenameSchema = z.object({ title: z.string().min(1).max(120) });

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; slug: string[] }> }
) {
  const requestId = randomUUID();
  let workspaceId = 'unknown';
  let slugStr = 'unknown';

  try {
    const { workspaceId: rawWorkspaceId, slug } = await params;
    workspaceId = rawWorkspaceId;
    slugStr = slug.join('/');

    const { supabase, user } = await getRequestUser(request);
    if (!user) {
      return jsonError(401, 'AUTH_REQUIRED', 'Authentication required', requestId);
    }

    const { data: page } = await supabase
      .from('pages')
      .select('slug, title, kind, zone, drive_file_id, updated_by, locked_by_human, version')
      .eq('workspace_id', workspaceId)
      .eq('slug', slugStr)
      .single();

    if (!page) {
      return jsonError(404, 'PAGE_NOT_FOUND', 'Page not found', requestId);
    }

    let drive: Awaited<ReturnType<typeof createDriveClientForUser>>;
    try {
      drive = await createDriveClientForUser(user.id);
    } catch (error) {
      if (isGoogleDriveAuthError(error)) {
        return jsonError(
          403,
          'DRIVE_RECONNECT_REQUIRED',
          'Reconnect Google Drive required',
          requestId,
          { reconnectRequired: true },
        );
      }
      throw error;
    }

    const content = await readDriveFile(drive, page.drive_file_id);
    return NextResponse.json({ ...page, content });
  } catch (error) {
    if (error instanceof DriveReadError) {
      console.error('[GET /api/pages] drive read failed', {
        requestId,
        workspaceId,
        slug: slugStr,
        code: error.code,
        ...error.logMeta,
      });
      return jsonError(
        error.statusCode,
        error.code,
        error.publicMessage,
        requestId,
        error.publicMeta,
      );
    }

    console.error('[GET /api/pages] unexpected error', {
      requestId,
      workspaceId,
      slug: slugStr,
      error,
    });
    return jsonError(500, 'INTERNAL_ERROR', 'Failed to load page content', requestId);
  }
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
  const parsedRename = RenameSchema.safeParse(body);
  if (!parsedLock.success && !parsedContent.success && !parsedRename.success) {
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

  if (parsedRename.success) {
    if (page.zone !== 'notes' || page.slug === 'notes/guide.md') {
      return NextResponse.json({ error: 'Only user notes can be renamed' }, { status: 403 });
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

    const title = parsedRename.data.title.trim();
    const currentContent = await readDriveFile(drive, page.drive_file_id);
    const content = renameNoteContent(currentContent, title);
    await writeDriveFile(drive, content, {
      fileId: page.drive_file_id,
      name: `${slugify(title)}.md`,
      parentId: '',
    });
    await drive.files.update({
      fileId: page.drive_file_id,
      requestBody: { name: `${slugify(title)}.md` },
      fields: 'id',
    });

    const { error: updateError } = await supabase
      .from('pages')
      .update({
        title,
        content_hash: await hashContent(content),
        version: page.version + 1,
        updated_by: 'human',
        updated_at: new Date().toISOString(),
      })
      .eq('id', page.id);
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    return NextResponse.json({
      slug: page.slug,
      title,
      kind: page.kind,
      zone: page.zone,
      updated_by: 'human',
      locked_by_human: page.locked_by_human,
      version: page.version + 1,
      content,
    });
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

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; slug: string[] }> },
) {
  const { workspaceId, slug: slugParts } = await params;
  const slug = slugParts.join('/');

  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: ws } = await supabase
    .from('workspaces')
    .select('id')
    .eq('id', workspaceId)
    .eq('owner_id', user.id)
    .single();
  if (!ws) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const { data: page } = await supabase
    .from('pages')
    .select('id, slug, zone, drive_file_id')
    .eq('workspace_id', workspaceId)
    .eq('slug', slug)
    .single();
  if (!page) return NextResponse.json({ error: 'Page not found' }, { status: 404 });

  if (page.zone !== 'notes' || page.slug === 'notes/guide.md') {
    return NextResponse.json({ error: 'Only user notes can be deleted' }, { status: 403 });
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

  await drive.files.update({
    fileId: page.drive_file_id,
    requestBody: { trashed: true },
    fields: 'id',
  });

  const { error: outgoingLinksError } = await supabase
    .from('page_links')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('from_slug', page.slug);
  if (outgoingLinksError) return NextResponse.json({ error: outgoingLinksError.message }, { status: 500 });

  const { error: incomingLinksError } = await supabase
    .from('page_links')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('to_slug', page.slug);
  if (incomingLinksError) return NextResponse.json({ error: incomingLinksError.message }, { status: 500 });

  const { error: deleteError } = await supabase.from('pages').delete().eq('id', page.id);
  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

  return NextResponse.json({ ok: true });
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

function slugify(text: string): string {
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (ascii) return ascii.slice(0, 40);
  return `note-${Date.now()}`;
}

function renameNoteContent(content: string, title: string): string {
  if (/^title:\s*.*$/m.test(content)) {
    return content.replace(/^title:\s*.*$/m, `title: "${escapeYamlTitle(title)}"`);
  }

  if (/^#\s+.+$/m.test(content)) {
    return content.replace(/^#\s+.+$/m, `# ${title}`);
  }

  return `# ${title}\n\n${content}`;
}

function escapeYamlTitle(value: string): string {
  return value.replace(/"/g, '\\"');
}

function jsonError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  publicMeta: Record<string, unknown> = {},
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        requestId,
        ...publicMeta,
      },
    },
    { status },
  );
}
