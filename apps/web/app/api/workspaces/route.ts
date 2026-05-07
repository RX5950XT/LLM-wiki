import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { initWorkspaceDrive } from '@/lib/drive/workspace-init';
import { ensureWorkspaceSystemPages } from '@/lib/drive/system-pages';
import { resolveUiLocaleFromRequest } from '@/lib/i18n/ui-locale';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';
import {
  fetchOrderedWorkspaces,
  getNextWorkspaceSortOrder,
  isMissingSortOrderError,
} from '@/lib/workspaces/queries';

const CreateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
});

export async function POST(request: NextRequest) {
  const { user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = CreateWorkspaceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const admin = createAdminClient();

  try {
    const drive = await createDriveClientForUser(user.id);
    const workspaceId = crypto.randomUUID();
    const locale = resolveUiLocaleFromRequest(request);

    const { driveFolderId } = await initWorkspaceDrive(drive, workspaceId, locale);

    const nextSortOrder = await getNextWorkspaceSortOrder(admin, user.id);

    const workspaceRecord = {
      id: workspaceId,
      owner_id: user.id,
      name: parsed.data.name,
      drive_folder_id: driveFolderId,
      ...(nextSortOrder == null ? {} : { sort_order: nextSortOrder }),
    };

    let { error: workspaceError } = await admin.from('workspaces').insert(workspaceRecord);
    if (isMissingSortOrderError(workspaceError)) {
      const { sort_order: _sortOrder, ...legacyWorkspaceRecord } = workspaceRecord as typeof workspaceRecord & {
        sort_order?: number;
      };
      const retry = await admin.from('workspaces').insert(legacyWorkspaceRecord);
      workspaceError = retry.error;
    }
    if (workspaceError) throw new Error(`Failed to create workspace record: ${workspaceError.message}`);

    await ensureWorkspaceSystemPages(drive, workspaceId, driveFolderId, locale);

    // Auto-bind user's default LLM profile
    const { data: defaultProfile } = await admin
      .from('llm_profiles')
      .select('id')
      .eq('owner_id', user.id)
      .eq('is_default', true)
      .maybeSingle();

    if (defaultProfile) {
      const { error: bindError } = await admin
        .from('workspaces')
        .update({ default_profile_id: defaultProfile.id })
        .eq('id', workspaceId);
      if (bindError) throw new Error(`Failed to bind default profile: ${bindError.message}`);
    }

    return NextResponse.json({ id: workspaceId }, { status: 201 });
  } catch (err) {
    if (isGoogleDriveAuthError(err)) {
      return NextResponse.json(
        { error: err.message || GOOGLE_DRIVE_REAUTH_MESSAGE },
        { status: 403 },
      );
    }
    console.error('[POST /api/workspaces]', err);
    return NextResponse.json({ error: 'Failed to create workspace' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: workspaces, error } = await fetchOrderedWorkspaces(supabase, {
    select: 'id, name, description, created_at, sort_order',
    ownerId: user.id,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ workspaces });
}
