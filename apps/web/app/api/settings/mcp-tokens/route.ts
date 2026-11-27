import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { getRequestUser } from '@/lib/supabase/request';
import { MAX_MCP_TOKENS, generateMcpToken } from '@/lib/mcp/tokens';

/**
 * MCP token management. mcp_tokens is service-role only (no client GRANT), so
 * every query here filters by the signed-in user's id — that filter is the wall.
 */
const FIELDS = 'id, name, token_prefix, created_at, last_used_at';

export async function GET(request: NextRequest) {
  const { user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data, error } = await createAdminClient()
    .from('mcp_tokens')
    .select(FIELDS)
    .eq('owner_id', user.id)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[mcp-tokens] list failed', error.message);
    return NextResponse.json({ error: 'Could not load MCP tokens' }, { status: 500 });
  }
  return NextResponse.json({ tokens: data ?? [] });
}

const CreateSchema = z.object({ name: z.string().trim().min(1).max(80) });

export async function POST(request: NextRequest) {
  const { user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Name is required (max 80 characters)' }, { status: 400 });

  const admin = createAdminClient();
  const { count } = await admin.from('mcp_tokens').select('id', { count: 'exact', head: true }).eq('owner_id', user.id);
  if ((count ?? 0) >= MAX_MCP_TOKENS) {
    return NextResponse.json({ error: `At most ${MAX_MCP_TOKENS} tokens. Revoke one first.` }, { status: 409 });
  }

  const { token, hash, prefix } = generateMcpToken();
  const { data, error } = await admin
    .from('mcp_tokens')
    .insert({ owner_id: user.id, name: parsed.data.name, token_hash: hash, token_prefix: prefix })
    .select(FIELDS)
    .single();
  if (error) {
    console.error('[mcp-tokens] create failed', error.message);
    return NextResponse.json({ error: 'Could not create the token' }, { status: 500 });
  }
  // The only time the token itself leaves the server.
  return NextResponse.json({ token, record: data }, { status: 201 });
}

const DeleteSchema = z.object({ id: z.string().uuid() });

export async function DELETE(request: NextRequest) {
  const { user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = DeleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { data, error } = await createAdminClient()
    .from('mcp_tokens')
    .delete()
    .eq('id', parsed.data.id)
    .eq('owner_id', user.id)
    .select('id');
  if (error) {
    console.error('[mcp-tokens] revoke failed', error.message);
    return NextResponse.json({ error: 'Could not revoke the token' }, { status: 500 });
  }
  if (!data?.length) return NextResponse.json({ error: 'Token not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
