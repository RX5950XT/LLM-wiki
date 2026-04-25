import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

const LockSchema = z.object({ locked_by_human: z.boolean() });

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; slug: string[] }> },
) {
  const { workspaceId, slug: slugParts } = await params;
  const slug = slugParts.join('/');

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = LockSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const { error } = await supabase
    .from('pages')
    .update({ locked_by_human: parsed.data.locked_by_human })
    .eq('workspace_id', workspaceId)
    .eq('slug', slug);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
