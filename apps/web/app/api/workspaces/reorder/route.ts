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
    .select('id, sort_order, created_at')
    .eq('owner_id', user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const requestedIds = [...new Set(parsed.data.workspace_ids)];
  const ownedWorkspaceRows = ownedWorkspaces ?? [];
  const ownedIds = new Set(ownedWorkspaceRows.map((workspace) => workspace.id));
  if (requestedIds.length !== parsed.data.workspace_ids.length) {
    return NextResponse.json({ error: 'Workspace order contains duplicate ids' }, { status: 400 });
  }

  if (requestedIds.some((workspaceId) => !ownedIds.has(workspaceId))) {
    return NextResponse.json({ error: 'Workspace order contains a workspace you do not own' }, { status: 400 });
  }

  const requestedIdSet = new Set(requestedIds);
  const missingOwnedIds = ownedWorkspaceRows
    .filter((workspace) => !requestedIdSet.has(workspace.id))
    .sort((left, right) => {
      const leftSort = left.sort_order ?? Number.MAX_SAFE_INTEGER;
      const rightSort = right.sort_order ?? Number.MAX_SAFE_INTEGER;
      if (leftSort !== rightSort) return leftSort - rightSort;
      return (left.created_at ?? '').localeCompare(right.created_at ?? '');
    })
    .map((workspace) => workspace.id);

  const finalOrder = [...requestedIds, ...missingOwnedIds];
  if (finalOrder.length !== ownedWorkspaceRows.length) {
    return NextResponse.json({ error: 'Workspace order must include all owned workspaces' }, { status: 400 });
  }

  for (const [index, workspaceId] of finalOrder.entries()) {
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
