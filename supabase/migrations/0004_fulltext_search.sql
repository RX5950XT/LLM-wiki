-- =========================================================================
-- Full-text search support for wiki pages
-- =========================================================================

-- Add search_text column to cache a snippet of page content for indexing
ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS search_text TEXT;

-- Create GIN index for full-text search on title + slug + search_text
CREATE INDEX IF NOT EXISTS pages_fts_idx
  ON public.pages
  USING GIN (to_tsvector('simple', COALESCE(search_text, '') || ' ' || COALESCE(title, '') || ' ' || slug));

-- Helper function: full-text search pages
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
