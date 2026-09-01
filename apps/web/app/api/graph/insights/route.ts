import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { analyzeGraphInsights, type GraphPage, type GraphPageLink } from '@/lib/graph/insights';
import { getRequestUser } from '@/lib/supabase/request';

const WorkspaceIdSchema = z.string().uuid();
export const MAX_GRAPH_PAGES = 2_000;
export const MAX_GRAPH_LINKS = 20_000;

type ApiError = {
  code: string;
  message: string;
};

function envelope<T>(status: number, data: T | null, error: ApiError | null) {
  return NextResponse.json(
    {
      success: status >= 200 && status < 300,
      status,
      data,
      error,
    },
    { status },
  );
}

export function validateGraphInputSize(pageCount: number, linkCount: number): ApiError | null {
  if (pageCount > MAX_GRAPH_PAGES || linkCount > MAX_GRAPH_LINKS) {
    return { code: 'GRAPH_TOO_LARGE', message: 'Graph exceeds the supported size' };
  }
  return null;
}

export async function GET(request: NextRequest) {
  const requestId = randomUUID();

  try {
    const { supabase, user } = await getRequestUser(request);
    if (!user) return envelope(401, null, { code: 'AUTH_REQUIRED', message: 'Authentication required' });

    const workspaceId = new URL(request.url).searchParams.get('workspace_id');
    const parsedWorkspaceId = WorkspaceIdSchema.safeParse(workspaceId);
    if (!parsedWorkspaceId.success) {
      return envelope(400, null, { code: 'INVALID_WORKSPACE_ID', message: 'Valid workspace_id is required' });
    }

    const { data: workspace, error: workspaceError } = await supabase
      .from('workspaces')
      .select('id')
      .eq('id', parsedWorkspaceId.data)
      .eq('owner_id', user.id)
      .maybeSingle();
    if (workspaceError) {
      console.error('[GET /api/graph/insights] workspace lookup failed', { requestId, error: workspaceError });
      return envelope(500, null, { code: 'INTERNAL_ERROR', message: 'Unable to load graph insights' });
    }
    if (!workspace) return envelope(404, null, { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' });

    const [pagesResult, linksResult] = await Promise.all([
      supabase
        .from('pages')
        .select('slug, title')
        .eq('workspace_id', parsedWorkspaceId.data)
        .eq('zone', 'wiki')
        .limit(MAX_GRAPH_PAGES + 1),
      supabase
        .from('page_links')
        .select('from_slug, to_slug')
        .eq('workspace_id', parsedWorkspaceId.data)
        .limit(MAX_GRAPH_LINKS + 1),
    ]);

    if (pagesResult.error || linksResult.error) {
      console.error('[GET /api/graph/insights] graph query failed', {
        requestId,
        pagesError: pagesResult.error,
        linksError: linksResult.error,
      });
      return envelope(500, null, { code: 'INTERNAL_ERROR', message: 'Unable to load graph insights' });
    }

    const pages = (pagesResult.data ?? []) as GraphPage[];
    const links = (linksResult.data ?? []) as GraphPageLink[];
    const sizeError = validateGraphInputSize(pages.length, links.length);
    if (sizeError) return envelope(413, null, sizeError);

    const insights = analyzeGraphInsights(pages, links);
    return envelope(200, insights, null);
  } catch (error) {
    console.error('[GET /api/graph/insights] unexpected error', { requestId, error });
    return envelope(500, null, { code: 'INTERNAL_ERROR', message: 'Unable to load graph insights' });
  }
}
