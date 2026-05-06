import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { getRequestUser } from '@/lib/supabase/request';

const ReorderSchema = z.object({
  workspace_ids: z.array(z.string().uuid()).min(1),
});

export async function PATCH(request: NextRequest) {
  const { user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = ReorderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid workspace order payload' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: ownedWorkspaces, error } = await admin
    .from('workspaces')
    .select('id')
    .eq('owner_id', user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ownedIds = new Set((ownedWorkspaces ?? []).map((workspace) => workspace.id));
  const requestedIds = parsed.data.workspace_ids;
  if (
    requestedIds.length !== ownedIds.size ||
    requestedIds.some((workspaceId) => !ownedIds.has(workspaceId))
  ) {
    return NextResponse.json({ error: 'Workspace order must include all owned workspaces' }, { status: 400 });
  }

  for (const [index, workspaceId] of requestedIds.entries()) {
    const { error: updateError } = await admin
      .from('workspaces')
      .update({ sort_order: index, updated_at: new Date().toISOString() })
      .eq('id', workspaceId)
      .eq('owner_id', user.id);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
