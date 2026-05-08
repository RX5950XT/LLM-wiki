import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ensureFolder, writeDriveFile } from '@/lib/drive/client';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';
import { resolveUiLocaleFromRequest } from '@/lib/i18n/ui-locale';

const CreatePageSchema = z.object({
  zone: z.literal('notes'),
  title: z.string().min(1).max(120),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params;
  const locale = resolveUiLocaleFromRequest(request);
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = CreatePageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

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

  const notesFolderId = await ensureFolder(drive, 'notes', workspace.drive_folder_id);
  const title = parsed.data.title.trim();
  const slug = await resolveAvailableNoteSlug(supabase, workspaceId, slugify(title));
  const fileName = slug.split('/').at(-1) ?? 'note.md';
  const content = buildInitialNoteContent(title, locale);
  const fileId = await writeDriveFile(drive, content, {
    name: fileName,
    parentId: notesFolderId,
  });

  const now = new Date().toISOString();
  const { error } = await supabase.from('pages').insert({
    workspace_id: workspaceId,
    slug,
    title,
    kind: 'note',
    zone: 'notes',
    drive_file_id: fileId,
    content_hash: createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16),
    version: 1,
    updated_by: 'human',
    locked_by_human: true,
    updated_at: now,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    slug,
    title,
    kind: 'note',
    zone: 'notes',
    content,
    updated_by: 'human',
    locked_by_human: true,
    version: 1,
  });
}

function buildInitialNoteContent(title: string, locale: 'zh-TW' | 'en'): string {
  const created = new Date().toISOString().slice(0, 10);
  if (locale === 'en') {
    return `---
title: "${escapeYamlTitle(title)}"
kind: note
created: ${created}
---

# ${title}

`;
  }

  return `---
title: "${escapeYamlTitle(title)}"
kind: note
created: ${created}
---

# ${title}

`;
}

function escapeYamlTitle(value: string): string {
  return value.replace(/"/g, '\\"');
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

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `note-${stamp}`;
}

async function resolveAvailableNoteSlug(
  supabase: SupabaseClient,
  workspaceId: string,
  baseSlug: string,
): Promise<string> {
  for (let index = 0; index < 1000; index += 1) {
    const candidate = `notes/${index === 0 ? baseSlug : `${baseSlug}-${index + 1}`}.md`;
    const { data: existing } = await supabase
      .from('pages')
      .select('slug')
      .eq('workspace_id', workspaceId)
      .eq('slug', candidate)
      .maybeSingle();
    if (!existing) return candidate;
  }
  throw new Error('Unable to allocate note slug');
}
