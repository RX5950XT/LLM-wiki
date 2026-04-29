import { NextRequest, NextResponse } from 'next/server';
import { createRequire } from 'module';
import { getOptionalEnv, getRequiredEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SUPABASE_DB_HOST = 'db.mjuciqffwayydobpxzcz.supabase.co';

const FULLTEXT_SEARCH_MIGRATION = `
ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS search_text TEXT;

CREATE INDEX IF NOT EXISTS pages_fts_idx
  ON public.pages
  USING GIN (to_tsvector('simple', COALESCE(search_text, '') || ' ' || COALESCE(title, '') || ' ' || slug));

CREATE OR REPLACE FUNCTION public.search_pages(
  p_workspace_id UUID,
  p_query TEXT
)
RETURNS TABLE (
  slug TEXT,
  title TEXT,
  kind TEXT,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.slug,
    p.title,
    p.kind,
    p.updated_at
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
`;

type PgClient = {
  connect: () => Promise<void>;
  query: (sql: string) => Promise<unknown>;
  end: () => Promise<void>;
};

type PgClientConstructor = new (config: Record<string, unknown>) => PgClient;

function loadPgClient(): PgClientConstructor {
  const require = createRequire(import.meta.url);
  return (require('pg') as { Client: PgClientConstructor }).Client;
}

export async function POST(request: NextRequest) {
  const cronSecret = getRequiredEnv('CRON_SECRET');
  if (request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const dbPassword =
    typeof body?.db_password === 'string'
      ? body.db_password
      : getOptionalEnv('SUPABASE_DB_PASSWORD');
  if (!dbPassword) {
    return NextResponse.json({ error: 'Missing db_password' }, { status: 400 });
  }

  const Client = loadPgClient();
  const client = new Client({
    host: SUPABASE_DB_HOST,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: dbPassword,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });

  try {
    await client.connect();
    await client.query(FULLTEXT_SEARCH_MIGRATION);
    return NextResponse.json({ ok: true, migration: '0004_fulltext_search' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown migration error';
    console.error('[api/migrate]', error);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await client.end().catch(() => undefined);
  }
}
