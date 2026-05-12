-- Revoke PUBLIC execute on trigger-only/internal helper functions.
-- Keep EXECUTE only for postgres/service_role.
REVOKE EXECUTE ON FUNCTION public.assert_ingest_job_profile_owner() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.broadcast_page_metadata_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bump_workspace_sync_revision() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.owns_workspace(uuid) FROM PUBLIC;
