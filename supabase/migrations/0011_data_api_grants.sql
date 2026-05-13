-- =========================================================================
-- Migration 0011: Data API GRANTs
--
-- Supabase 新預設（May 30 new projects / Oct 30 all projects）：
-- public schema 新表不再自動暴露給 Data API（PostgREST / supabase-js）。
-- 此 migration 為所有既有表補上顯式 GRANT，確保 Data API 角色
--（anon / authenticated / service_role）能正常訪問。
--
-- 實際行為由 RLS policy 控制；GRANT 只確保 PostgREST 不拒絕 42501。
-- =========================================================================

-- workspaces
grant select, insert, update, delete on public.workspaces to authenticated;
grant select, insert, update, delete on public.workspaces to service_role;
grant select on public.workspaces to anon;

-- pages
grant select, insert, update, delete on public.pages to authenticated;
grant select, insert, update, delete on public.pages to service_role;
grant select on public.pages to anon;

-- sources
grant select, insert, update, delete on public.sources to authenticated;
grant select, insert, update, delete on public.sources to service_role;
grant select on public.sources to anon;

-- page_links
grant select, insert, update, delete on public.page_links to authenticated;
grant select, insert, update, delete on public.page_links to service_role;
grant select on public.page_links to anon;

-- llm_profiles
grant select, insert, update, delete on public.llm_profiles to authenticated;
grant select, insert, update, delete on public.llm_profiles to service_role;
grant select on public.llm_profiles to anon;

-- ingest_jobs
grant select, insert, update, delete on public.ingest_jobs to authenticated;
grant select, insert, update, delete on public.ingest_jobs to service_role;
grant select on public.ingest_jobs to anon;

-- logs
grant select, insert, update, delete on public.logs to authenticated;
grant select, insert, update, delete on public.logs to service_role;
grant select on public.logs to anon;

-- google_oauth_tokens
grant select, insert, update, delete on public.google_oauth_tokens to authenticated;
grant select, insert, update, delete on public.google_oauth_tokens to service_role;
grant select on public.google_oauth_tokens to anon;

-- workspace_sync_state
grant select, insert, update, delete on public.workspace_sync_state to authenticated;
grant select, insert, update, delete on public.workspace_sync_state to service_role;
grant select on public.workspace_sync_state to anon;

-- Functions that must be callable via Data API (RPC)
grant execute on function public.search_pages(uuid, text) to authenticated;
grant execute on function public.search_pages(uuid, text) to service_role;
grant execute on function public.owns_workspace(uuid) to authenticated;
grant execute on function public.owns_workspace(uuid) to service_role;
grant execute on function public.broadcast_page_metadata_change() to authenticated;
grant execute on function public.broadcast_page_metadata_change() to service_role;

-- =========================================================================
-- Schema-level GRANT (future-proof: ensures default privileges apply to
-- new tables created by migrations after the Oct 30 enforcement date)
-- =========================================================================

alter default privileges in schema public
  grant select, insert, update, delete on tables
  to authenticated;

alter default privileges in schema public
  grant select, insert, update, delete on tables
  to service_role;

alter default privileges in schema public
  grant select on tables
  to anon;

alter default privileges in schema public
  grant execute on functions
  to authenticated;

alter default privileges in schema public
  grant execute on functions
  to service_role;

-- =========================================================================
-- Table creation helper: any future table should copy this pattern.
-- GRANT must happen immediately after CREATE TABLE, before ENABLE RLS.
