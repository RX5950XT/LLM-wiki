import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get('workspace_id');
  const query = searchParams.get('q')?.trim();

  if (!workspaceId || !query) {
    return NextResponse.json({ error: 'Missing workspace_id or q' }, { status: 400 });
  }

  // Verify workspace ownership
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id')
    .eq('id', workspaceId)
    .eq('owner_id', user.id)
    .single();
  if (!workspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  // Use RPC for full-text search
  const { data: pages, error } = await supabase
    .rpc('search_pages', {
      p_workspace_id: workspaceId,
      p_query: query,
    });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ pages: pages ?? [] });
}
