-- =========================================================================
-- Security fixes based on Supabase Security Advisor findings
-- =========================================================================

-- Fix 1: touch_updated_at — add immutable search_path to prevent search_path hijack
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Fix 2: assert_ingest_job_profile_owner — trigger-only function, not meant for RPC
-- Revoking from both roles is safe; triggers run as SECURITY DEFINER (function owner)
REVOKE EXECUTE ON FUNCTION public.assert_ingest_job_profile_owner() FROM anon;
REVOKE EXECUTE ON FUNCTION public.assert_ingest_job_profile_owner() FROM authenticated;

-- Fix 3: owns_workspace — internal RLS helper, anon must not call it
REVOKE EXECUTE ON FUNCTION public.owns_workspace(uuid) FROM anon;

-- Fix 4: search_pages — switch to SECURITY INVOKER so RLS scopes results to the caller.
-- Remove ILIKE fallback which caused full-table scans; rely on GIN index + FTS only.
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
SECURITY INVOKER
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
    AND to_tsvector('simple',
          COALESCE(p.search_text, '') || ' ' ||
          COALESCE(p.title, '') || ' ' ||
          p.slug
        ) @@ plainto_tsquery('simple', p_query)
  ORDER BY p.updated_at DESC
  LIMIT 20;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.search_pages(uuid, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.search_pages(uuid, text) TO authenticated;
