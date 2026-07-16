import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/supabase/request';

export async function GET(request: NextRequest) {
  const { supabase, user } = await getRequestUser(request);
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

  // Try RPC first, fallback to basic ilike search
  const { data: pages, error } = await supabase
    .rpc('search_pages', {
      p_workspace_id: workspaceId,
      p_query: query,
    });

  if (error) {
    // Fallback if search_pages function doesn't exist yet.
    // Strip characters with meaning in PostgREST or-filter / like patterns
    // (same rule as searchPages in lib/ai/tools.ts).
    const safeQuery = query.replace(/[,()|%\\]/g, ' ').trim();
    if (!safeQuery) return NextResponse.json({ pages: [] });
    const { data: fallbackPages } = await supabase
      .from('pages')
      .select('slug, title, kind, updated_at')
      .eq('workspace_id', workspaceId)
      .or(`slug.ilike.%${safeQuery}%,title.ilike.%${safeQuery}%`)
      .order('updated_at', { ascending: false })
      .limit(20);

    return NextResponse.json({ pages: fallbackPages ?? [] });
  }

  return NextResponse.json({ pages: pages ?? [] });
}
