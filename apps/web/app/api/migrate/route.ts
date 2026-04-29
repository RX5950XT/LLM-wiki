import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret');
  
  // Simple protection
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const client = new Client({
    host: 'mjuciqffwayydobpxzcz.supabase.co',
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: 'VzPQWDcumLC6m20m',
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    
    await client.query(`
      ALTER TABLE public.pages ADD COLUMN IF NOT EXISTS search_text TEXT;
      
      CREATE INDEX IF NOT EXISTS pages_fts_idx
        ON public.pages
        USING GIN (to_tsvector('simple', COALESCE(search_text, '') || ' ' || COALESCE(title, '') || ' ' || slug));
      
      CREATE OR REPLACE FUNCTION public.search_pages(
        p_workspace_id UUID,
        p_query TEXT
      )
      RETURNS TABLE (slug TEXT, title TEXT, kind TEXT, updated_at TIMESTAMPTZ)
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
      AS $$
      BEGIN
        RETURN QUERY
        SELECT p.slug, p.title, p.kind, p.updated_at
        FROM public.pages p
        WHERE p.workspace_id = p_workspace_id
          AND p.zone = 'wiki'
          AND (
            to_tsvector('simple', COALESCE(p.search_text, '') || ' ' || COALESCE(p.title, '') || ' ' || p.slug)
            @@ plainto_tsquery('simple', p_query)
            OR p.slug ILIKE '%' || p_query || '%'
            OR p.title ILIKE '%' || p_query || '%'
          )
        ORDER BY p.updated_at DESC
        LIMIT 20;
      END;
      $$;
    `);
    
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  } finally {
    await client.end();
  }
}
