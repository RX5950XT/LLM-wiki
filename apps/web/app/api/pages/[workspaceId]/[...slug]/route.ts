import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { readDriveFile } from '@/lib/drive/client';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';

const LockSchema = z.object({ locked_by_human: z.boolean() });

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
    .select('slug, title, drive_file_id, updated_by, locked_by_human, version')
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
  const parsed = LockSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const { data: ws } = await supabase
    .from('workspaces')
    .select('id')
    .eq('id', workspaceId)
    .eq('owner_id', user.id)
    .single();
  if (!ws) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const { error } = await supabase
    .from('pages')
    .update({ locked_by_human: parsed.data.locked_by_human })
    .eq('workspace_id', workspaceId)
    .eq('slug', slug);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
