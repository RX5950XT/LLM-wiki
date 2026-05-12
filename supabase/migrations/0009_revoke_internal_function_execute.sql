-- Revoke RPC execute on trigger-only/internal helper functions.
-- Safe because triggers still run as the function owner.
REVOKE EXECUTE ON FUNCTION public.broadcast_page_metadata_change() FROM anon;
REVOKE EXECUTE ON FUNCTION public.broadcast_page_metadata_change() FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.bump_workspace_sync_revision() FROM anon;
REVOKE EXECUTE ON FUNCTION public.bump_workspace_sync_revision() FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.owns_workspace(uuid) FROM authenticated;
