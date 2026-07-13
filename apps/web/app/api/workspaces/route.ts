import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveUiLocaleFromRequest } from '@/lib/i18n/ui-locale';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';
import { fetchOrderedWorkspaces } from '@/lib/workspaces/queries';
import { createWorkspaceForUser } from '@/lib/workspaces/manage';

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

  try {
    const drive = await createDriveClientForUser(user.id);
    const locale = resolveUiLocaleFromRequest(request);

    const result = await createWorkspaceForUser(drive, user.id, parsed.data.name, locale);
    if (!result.ok) throw new Error(result.error);

    return NextResponse.json({ id: result.id }, { status: 201 });
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
