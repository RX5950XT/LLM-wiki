-- Remove pages table from postgres_changes (supabase_realtime publication).
-- Run this ONLY after verifying the new Broadcast subscription is working correctly.
-- Uses a safe DO block to avoid failure if pages is not in the publication.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname    = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename  = 'pages'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.pages;
  END IF;
END $$;
