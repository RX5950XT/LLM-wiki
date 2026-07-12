-- Supabase security advisor 0029: broadcast_page_metadata_change is a
-- SECURITY DEFINER trigger function that anon/authenticated could invoke
-- directly via /rest/v1/rpc/. Triggers fire without a runtime EXECUTE check
-- (verified against production inside a rolled-back transaction), so revoking
-- direct RPC access is safe.
-- NOTE: owns_workspace(uuid) must KEEP its authenticated EXECUTE — RLS
-- policies evaluate it as the querying role (see Phase 12 audit).
revoke execute on function public.broadcast_page_metadata_change() from anon, authenticated;
